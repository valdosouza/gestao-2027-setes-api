/// <reference types="jest" />
import fs from 'fs'
import { createPrivateKey, createPublicKey } from 'crypto'
import jwt from 'jsonwebtoken'
import { testToken } from '../test-setup/test-token'
import * as authRepo from '../modules/auth/auth.repository'
import * as sessionRepo from '../shared/session-context/session-context.repository'
import { login, selectInstitution, switchInstitution } from '../modules/auth/auth.service'

jest.mock('../modules/auth/auth.repository')
jest.mock('../shared/session-context/session-context.repository')

const mockFindUser         = authRepo.findUserByEmail        as jest.Mock
const mockGetInstitutions  = authRepo.getInstitutionsForUser as jest.Mock
const mockExistsSalesman   = sessionRepo.existsSalesman      as jest.Mock
mockExistsSalesman.mockResolvedValue(false)

// D-F13 (F2a, etapa A2): os tokens saem em RS256 com o kid de assinatura — conferidos com a chave PÚBLICA de teste
const PUBLIC = createPublicKey(createPrivateKey(fs.readFileSync(process.env.JWT_PRIVATE_KEY_PATH!, 'utf8')))
function verifyRs256(token: string): any {
  const { header } = jwt.decode(token, { complete: true }) as any
  expect(header).toMatchObject({ alg: 'RS256', kid: process.env.JWT_KID })
  return jwt.verify(token, PUBLIC, { algorithms: ['RS256'] })
}

// md5('12345') — mesmo hash do seed
const MD5_12345 = '827CCB0EEA8A706C4C34A16891F84E7B'

const setesLink = { institutionId: 1, schemaName: 'setes_setes', name: 'GESTAO COMPUTACIONAL SETES', profile: 'super' }
const alphaLink = { institutionId: 2, schemaName: 'setes_alpha', name: 'Empresa Alpha', profile: 'admin' }

describe('auth.service — login', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFindUser.mockResolvedValue({ id: 1, password: MD5_12345, active: 'S' })
  })

  it('senha errada retorna 401', async () => {
    await expect(login('valdo@setes.com.br', 'errada')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('email inexistente retorna 401', async () => {
    mockFindUser.mockResolvedValue(null)
    await expect(login('nao@existe.com', '12345')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('usuário sem institution ativa retorna 403', async () => {
    mockGetInstitutions.mockResolvedValue([])
    await expect(login('valdo@setes.com.br', '12345')).rejects.toMatchObject({ statusCode: 403 })
  })

  it('1 institution: emite JWT final direto com institutionId/schemaName', async () => {
    mockGetInstitutions.mockResolvedValue([setesLink])
    const result = await login('valdo@setes.com.br', '12345')

    expect(result.status).toBe('ok')
    const payload = verifyRs256(result.token)
    expect(payload.institutionId).toBe(1)
    expect(payload.userId).toBe(1)
    expect(payload.role).toBe('super')
    expect(payload.schemaName).toBe('setes_setes')
    // decisão 17: bloco context acompanha o token final — e NÃO entra no JWT
    expect(result.context).toEqual({ isSalesman: false })
    expect(payload.isSalesman).toBeUndefined()
  })

  it('N institutions: retorna lista + token de seleção (sem institutionId)', async () => {
    mockGetInstitutions.mockResolvedValue([setesLink, alphaLink])
    const result = await login('valdo@setes.com.br', '12345')

    expect(result.status).toBe('select')
    expect(result.institutions).toHaveLength(2)
    const payload = verifyRs256(result.token)
    expect(payload.scope).toBe('select-institution')
    expect(payload.institutionId).toBeUndefined()   // não passa no auth.middleware
  })

  // Costura A1 da auth-api (D-AU3/D-AU6, 2026-10-31): o rebaixamento da decisão 14 é da VIEW `setes_central.vw_user_link` (o ÚNICO
  // intérprete de `tb_institution_has_user.kind` — 'super' só na institution 1; a semântica da view é provada ao vivo em banco
  // descartável por `scripts/prove-user-access-views.ts`). O login não reinterpreta nada: o repositório lê o `profile` da view e o
  // service o repassa ao token.
  it("'super' fora da institution 1 é rebaixado para 'user' (decisão 14) — pela VIEW; o login repassa o perfil da linha", async () => {
    // (1) o repositório REAL lê o vínculo e o perfil da view (nunca `tb_institution_has_user.kind` cru)
    const realRepo = jest.requireActual('../modules/auth/auth.repository') as typeof authRepo
    const pool = (jest.requireActual('../shared/db/connection') as any).default
    const spy = jest.spyOn(pool, 'query').mockResolvedValueOnce([
      [{ institutionId: 2, schemaName: 'setes_alpha', name: 'Empresa Alpha', profile: 'user' }], [],
    ] as any)
    try {
      const links = await realRepo.getInstitutionsForUser(1)
      const [sql, params] = spy.mock.calls[0] as [string, any[]]
      const flat = sql.replace(/\s+/g, ' ')
      expect(flat).toMatch(/FROM setes_central\.vw_user_link l/)
      expect(flat).toMatch(/\bl\.profile\b/)
      expect(flat).not.toMatch(/tb_institution_has_user/)
      expect(params).toEqual([1])
      expect(links).toEqual([{ institutionId: 2, schemaName: 'setes_alpha', name: 'Empresa Alpha', profile: 'user' }])
    } finally {
      spy.mockRestore()
    }

    // (2) a linha que a view devolve para o vínculo 'super' com a institution 2 (perfil já rebaixado) → token com 'user'
    mockGetInstitutions.mockResolvedValue([{ ...alphaLink, profile: 'user' }])
    const result = await login('valdo@setes.com.br', '12345')
    const payload = verifyRs256(result.token)
    expect(payload.institutionId).toBe(2)
    expect(payload.role).toBe('user')

    // (3) o service não tem regra própria de perfil: repassa o que a linha traz (a regra mora UMA vez, na view)
    mockGetInstitutions.mockResolvedValue([{ ...alphaLink, profile: 'admin' }])
    expect(verifyRs256((await login('valdo@setes.com.br', '12345')).token).role).toBe('admin')
    mockGetInstitutions.mockResolvedValue([{ ...alphaLink, profile: null }])
    expect(verifyRs256((await login('valdo@setes.com.br', '12345')).token).role).toBe('user')
  })
})

describe('auth.service — select/switch institution', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetInstitutions.mockResolvedValue([setesLink, alphaLink])
  })

  function makeSelectionToken(userId = 1) {
    return testToken({ userId, scope: 'select-institution' }, { expiresIn: '5m' })
  }

  it('seleção com vínculo válido emite JWT final (+ context — decisão 17)', async () => {
    const issued = await selectInstitution(makeSelectionToken(), 2)
    const payload = verifyRs256(issued.token)
    expect(payload.institutionId).toBe(2)
    expect(payload.schemaName).toBe('setes_alpha')
    expect(payload.role).toBe('admin')
    expect(issued.context).toEqual({ isSalesman: false })
  })

  it('seleção de institution sem vínculo retorna 403', async () => {
    await expect(selectInstitution(makeSelectionToken(), 99)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('token de seleção inválido retorna 401', async () => {
    await expect(selectInstitution('token.invalido.aqui', 2)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('JWT final não serve como token de seleção (scope errado)', async () => {
    const finalToken = testToken({ institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' })
    await expect(selectInstitution(finalToken, 2)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('D-F13: seleção em HS256, de outra chave, sem kid ou carregando institutionId → 401', async () => {
    for (const t of [
      jwt.sign({ userId: 1, scope: 'select-institution' }, 'qualquer-segredo', { expiresIn: '5m', keyid: process.env.JWT_KID }),
      testToken({ userId: 1, scope: 'select-institution' }, { keyPath: process.env.TEST_JWT_OTHER_KEY_PATH }),
      testToken({ userId: 1, scope: 'select-institution' }, { kid: null }),
      testToken({ userId: 1, scope: 'select-institution', institutionId: 2 }),
      testToken({ userId: 0, scope: 'select-institution' }),
      testToken({ userId: 1, scope: 'select-institution' }, { expiresIn: -5 }),
    ]) {
      await expect(selectInstitution(t, 2)).rejects.toMatchObject({ statusCode: 401 })
    }
  })

  it('switch-institution revalida o vínculo no banco', async () => {
    const issued = await switchInstitution(1, 2)
    const payload = verifyRs256(issued.token)
    expect(payload.institutionId).toBe(2)

    await expect(switchInstitution(1, 99)).rejects.toMatchObject({ statusCode: 403 })
  })
})
