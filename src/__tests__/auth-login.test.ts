/// <reference types="jest" />
import jwt from 'jsonwebtoken'
import * as authRepo from '../modules/auth/auth.repository'
import { login, selectInstitution, switchInstitution } from '../modules/auth/auth.service'

jest.mock('../modules/auth/auth.repository')

const mockFindUser         = authRepo.findUserByEmail        as jest.Mock
const mockGetInstitutions  = authRepo.getInstitutionsForUser as jest.Mock

const SECRET = process.env.JWT_SECRET ?? 'sua_chave_secreta_aqui'
process.env.JWT_SECRET = SECRET

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
    const payload = jwt.verify(result.token, SECRET) as any
    expect(payload.institutionId).toBe(1)
    expect(payload.userId).toBe(1)
    expect(payload.role).toBe('super')
    expect(payload.schemaName).toBe('setes_setes')
  })

  it('N institutions: retorna lista + token de seleção (sem institutionId)', async () => {
    mockGetInstitutions.mockResolvedValue([setesLink, alphaLink])
    const result = await login('valdo@setes.com.br', '12345')

    expect(result.status).toBe('select')
    expect(result.institutions).toHaveLength(2)
    const payload = jwt.verify(result.token, SECRET) as any
    expect(payload.scope).toBe('select-institution')
    expect(payload.institutionId).toBeUndefined()   // não passa no auth.middleware
  })

  it("'super' fora da institution 1 é rebaixado para 'user' (decisão 14)", async () => {
    mockGetInstitutions.mockResolvedValue([{ ...alphaLink, profile: 'super' }])
    const result = await login('valdo@setes.com.br', '12345')

    const payload = jwt.verify(result.token, SECRET) as any
    expect(payload.institutionId).toBe(2)
    expect(payload.role).toBe('user')
  })
})

describe('auth.service — select/switch institution', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetInstitutions.mockResolvedValue([setesLink, alphaLink])
  })

  function makeSelectionToken(userId = 1) {
    return jwt.sign({ userId, scope: 'select-institution' }, SECRET, { expiresIn: '5m' })
  }

  it('seleção com vínculo válido emite JWT final', async () => {
    const token = await selectInstitution(makeSelectionToken(), 2)
    const payload = jwt.verify(token, SECRET) as any
    expect(payload.institutionId).toBe(2)
    expect(payload.schemaName).toBe('setes_alpha')
    expect(payload.role).toBe('admin')
  })

  it('seleção de institution sem vínculo retorna 403', async () => {
    await expect(selectInstitution(makeSelectionToken(), 99)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('token de seleção inválido retorna 401', async () => {
    await expect(selectInstitution('token.invalido.aqui', 2)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('JWT final não serve como token de seleção (scope errado)', async () => {
    const finalToken = jwt.sign({ institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' }, SECRET)
    await expect(selectInstitution(finalToken, 2)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('switch-institution revalida o vínculo no banco', async () => {
    const token = await switchInstitution(1, 2)
    const payload = jwt.verify(token, SECRET) as any
    expect(payload.institutionId).toBe(2)

    await expect(switchInstitution(1, 99)).rejects.toMatchObject({ statusCode: 403 })
  })
})
