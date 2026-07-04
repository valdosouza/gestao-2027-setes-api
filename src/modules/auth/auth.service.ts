import { createHash } from 'crypto'
import jwt from 'jsonwebtoken'
import { findUserByEmail, getInstitutionsForUser, UserInstitution } from './auth.repository'
import { InstitutionPayload } from '@shared/types/express'
import { SETES_INSTITUTION_ID } from '@shared/auth/roles'
import { HttpError } from '@shared/errors/http-error'

const FINAL_TOKEN_TTL     = '24h'                 // decisão 19: TTL 24h, sem refresh
const SELECTION_TOKEN_TTL = '5m'
const SELECTION_SCOPE     = 'select-institution'

interface SelectionPayload {
  userId: number
  scope:  string
}

export interface LoginResult {
  status:        'ok' | 'select'
  token:         string
  institutions?: UserInstitution[]
}

// MD5 aplicado no backend, nunca na query (decisão 2)
function md5(value: string): string {
  return createHash('md5').update(value).digest('hex').toUpperCase()
}

function secret(): string {
  return process.env.JWT_SECRET!
}

// 'super' fora da institution da Setes é ignorado (decisão 14)
function resolveRole(link: UserInstitution): string {
  const kind = link.profile ?? 'user'
  if (kind === 'super' && link.institutionId !== SETES_INSTITUTION_ID) return 'user'
  return kind
}

function signFinalToken(userId: number, link: UserInstitution): string {
  const payload: InstitutionPayload = {
    institutionId: link.institutionId,
    userId,
    role:          resolveRole(link),
    schemaName:    link.schemaName,
  }
  return jwt.sign(payload, secret(), { expiresIn: FINAL_TOKEN_TTL })
}

// Passo 1-3 do fluxo: autentica e decide pela quantidade de institutions
export async function login(email: string, password: string): Promise<LoginResult> {
  const user = await findUserByEmail(email)
  if (!user || !user.password || user.password.toUpperCase() !== md5(password)) {
    throw new HttpError(401, 'Email ou senha inválidos')
  }
  if (user.active !== 'S') throw new HttpError(401, 'Usuário inativo')

  const institutions = await getInstitutionsForUser(user.id)

  if (institutions.length === 0) {
    throw new HttpError(403, 'Usuário sem institution ativa')
  }

  if (institutions.length === 1) {
    return { status: 'ok', token: signFinalToken(user.id, institutions[0]) }
  }

  const selection: SelectionPayload = { userId: user.id, scope: SELECTION_SCOPE }
  const selectionToken = jwt.sign(selection, secret(), { expiresIn: SELECTION_TOKEN_TTL })
  return { status: 'select', token: selectionToken, institutions }
}

// Passo 4: valida o token de seleção e o vínculo antes de emitir o JWT final
export async function selectInstitution(selectionToken: string, institutionId: number): Promise<string> {
  let payload: SelectionPayload
  try {
    payload = jwt.verify(selectionToken, secret()) as SelectionPayload
  } catch {
    throw new HttpError(401, 'Token de seleção inválido ou expirado')
  }
  if (payload.scope !== SELECTION_SCOPE || !payload.userId) {
    throw new HttpError(401, 'Token de seleção inválido')
  }
  return issueForInstitution(payload.userId, institutionId)
}

// Passo 5: troca de institution com JWT final válido
export async function switchInstitution(userId: number, institutionId: number): Promise<string> {
  return issueForInstitution(userId, institutionId)
}

// Nunca confia no body: revalida o vínculo no banco
async function issueForInstitution(userId: number, institutionId: number): Promise<string> {
  const institutions = await getInstitutionsForUser(userId)
  const link = institutions.find(i => i.institutionId === institutionId)
  if (!link) throw new HttpError(403, 'Usuário sem vínculo ativo com esta institution')
  return signFinalToken(userId, link)
}
