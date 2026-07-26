import { randomInt } from 'crypto'
import jwt from 'jsonwebtoken'
import {
  findUserByEmail, getInstitutionsForUser, UserInstitution,
  setActivationKey, getActivationInfo, updatePassword,
} from './auth.repository'
import { InstitutionPayload } from '@shared/types/express'
import { SETES_INSTITUTION_ID } from '@shared/auth/roles'
import { SessionContext, getSessionContext } from '@shared/session-context'
import { md5Password } from '@shared/auth/password'
import { HttpError } from '@shared/errors/http-error'
import { sendMail, isMailerConfigured } from '@shared/mailer/mailer'
import logger from '@shared/logger/logger'

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
  /** Estado de sessão derivado (decisão 17) — só acompanha o token FINAL. */
  context?:      SessionContext
}

/** Token final + bloco context (decisão 17): toda emissão de JWT final
 *  devolve também os fatos derivados de sessão para o app. */
export interface IssuedSession {
  token:   string
  context: SessionContext
}

// MD5 aplicado no backend, nunca na query (decisão 2) — função compartilhada
// com o cadastro de Usuário (@shared/auth/password).
const md5 = md5Password

function secret(): string {
  return process.env.JWT_SECRET!
}

// 'super' fora da institution da Setes é ignorado (decisão 14)
function resolveRole(link: UserInstitution): string {
  const kind = link.profile ?? 'user'
  if (kind === 'super' && link.institutionId !== SETES_INSTITUTION_ID) return 'user'
  return kind
}

async function signFinalToken(userId: number, link: UserInstitution): Promise<IssuedSession> {
  const payload: InstitutionPayload = {
    institutionId: link.institutionId,
    userId,
    role:          resolveRole(link),
    schemaName:    link.schemaName,
  }
  // JWT segue IDENTIDADE MÍNIMA (invariante da Fase 2); fatos derivados vão
  // FORA do token, no bloco context (decisão 17 — fim das GB_* do Delphi).
  const token   = jwt.sign(payload, secret(), { expiresIn: FINAL_TOKEN_TTL })
  const context = await getSessionContext(payload)
  return { token, context }
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
    const issued = await signFinalToken(user.id, institutions[0])
    return { status: 'ok', token: issued.token, context: issued.context }
  }

  const selection: SelectionPayload = { userId: user.id, scope: SELECTION_SCOPE }
  const selectionToken = jwt.sign(selection, secret(), { expiresIn: SELECTION_TOKEN_TTL })
  return { status: 'select', token: selectionToken, institutions }
}

// Passo 4: valida o token de seleção e o vínculo antes de emitir o JWT final
export async function selectInstitution(selectionToken: string, institutionId: number): Promise<IssuedSession> {
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
export async function switchInstitution(userId: number, institutionId: number): Promise<IssuedSession> {
  return issueForInstitution(userId, institutionId)
}

// Nunca confia no body: revalida o vínculo no banco
async function issueForInstitution(userId: number, institutionId: number): Promise<IssuedSession> {
  const institutions = await getInstitutionsForUser(userId)
  const link = institutions.find(i => i.institutionId === institutionId)
  if (!link) throw new HttpError(403, 'Usuário sem vínculo ativo com esta institution')
  return signFinalToken(userId, link)
}

// ---------------------------------------------------------------------
// Recuperação e alteração de senha (fluxo do weberpsetes)
// ---------------------------------------------------------------------

const RECOVERY_CODE_TTL_MINUTES = 15

// Passo 1: gera código de 6 dígitos, grava em activation_key e envia por
// email (SMTP via .env; sem SMTP → código no LOG para dev).
// Resposta é SEMPRE genérica (não revela se o email existe).
export async function recoveryPassword(email: string): Promise<void> {
  const user = await findUserByEmail(email)
  if (!user || user.active !== 'S') return // silencioso: sem enumeração de usuários

  const code = String(randomInt(100000, 1000000)) // 6 dígitos
  await setActivationKey(user.id, code)

  const changeUrl = process.env.APP_CHANGE_PASSWORD_URL ?? 'http://localhost:5050/#/change-password'
  try {
    await sendMail({
      to: email,
      subject: 'Setes — código de recuperação de senha',
      text: `Seu código de recuperação é ${code} (válido por 15 minutos). Acesse ${changeUrl} para definir a nova senha.`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#1B3A5F">Recuperação de senha</h2>
          <p>Use o código abaixo para definir sua nova senha no Setes ERP.
             Ele é válido por <strong>15 minutos</strong>.</p>
          <p style="font-size:32px;font-weight:bold;letter-spacing:8px;
                    color:#2E6DA4;text-align:center">${code}</p>
          <p style="text-align:center">
            <a href="${changeUrl}"
               style="background:#3E9B4F;color:#fff;padding:12px 24px;
                      border-radius:24px;text-decoration:none;display:inline-block">
              Definir nova senha</a>
          </p>
          <p style="color:#8793B2;font-size:12px">Se você não solicitou esta
             recuperação, ignore este email — sua senha permanece a mesma.</p>
        </div>`,
    })
  } catch (err) {
    logger.error('Falha no envio do email de recuperação', { email, err })
    // segue: o código está gravado; em dev sai no log abaixo
  }

  if (!isMailerConfigured()) {
    logger.info('Código de recuperação de senha (modo dev, SMTP ausente)', { email, code })
  }
}

// Passo 2: valida email + código (janela de 15 min) e troca a senha.
// MD5 aplicado AQUI no backend (decisão 2) — o app envia texto puro por HTTPS.
export async function changePassword(email: string, code: string, newPassword: string): Promise<void> {
  if (newPassword.length < 5) throw new HttpError(400, 'A nova senha deve ter pelo menos 5 caracteres')

  const user = await findUserByEmail(email)
  if (!user) throw new HttpError(401, 'Código inválido ou expirado')

  const info = await getActivationInfo(user.id)
  if (!info || !info.activationKey || info.activationKey !== code) {
    throw new HttpError(401, 'Código inválido ou expirado')
  }
  if (info.ageMinutes > RECOVERY_CODE_TTL_MINUTES) {
    throw new HttpError(401, 'Código inválido ou expirado')
  }

  await updatePassword(user.id, md5(newPassword))
}
