/// <reference types="jest" />
// O onboarding foi absorvido pelo cadastro de Estabelecimento (decisão do
// Valdo, 2026-07-11): POST /api/institutions cria a cadeia fiscal, provisiona
// o schema e ativa a institution. Este teste cobre o fluxo do service.
// A2 (2026-08-15): o onboarding também concede as telas ESTRUTURAIS e cria o
// PRIMEIRO ADMIN — cliente nunca existe sem dono nem com menu vazio.
import * as repo   from '../modules/institutions/institutions.repository'
import * as runner from '../migrations/runner'
import * as userPiece from '../shared/user'
import { createInstitution } from '../modules/institutions/institutions.service'
import {
  InstitutionInput, InstitutionAdminInput,
} from '../modules/institutions/institutions.interface'

jest.mock('../modules/institutions/institutions.repository')
jest.mock('../migrations/runner')
jest.mock('../shared/user')

const mockSchemaExists       = repo.schemaNameExists           as jest.Mock
const mockInsertCascade      = repo.insertInstitutionCascade   as jest.Mock
const mockInsertDefaultFlags = repo.insertDefaultFlags         as jest.Mock
const mockGrantStructural    = repo.grantStructuralInterfaces  as jest.Mock
const mockSetActive          = repo.setInstitutionActive       as jest.Mock
const mockRunMigrations      = runner.runMigrationsForSchema   as jest.Mock
const mockFindEmailOwner     = userPiece.findLoginEmailOwner   as jest.Mock
const mockInsertUser         = userPiece.insertUserCascade     as jest.Mock

const input: InstitutionInput = {
  entity:      { nameCompany: 'Empresa Setes LTDA', nickTrade: 'Setes' },
  personType:  'J',
  company:     { cnpj: '12345678000199' },
  addresses:   [],
  phones:      [],
  socialMedia: [],
}

const admin: InstitutionAdminInput = {
  nameCompany: 'Fulano de Tal',
  nickTrade:   'Fulano',
  email:       'admin@cliente.com.br',
  password:    'segredo',
}

describe('createInstitution (POST /api/institutions absorve o onboarding)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSchemaExists.mockResolvedValue(false)
    mockInsertCascade.mockResolvedValue(2)
    mockInsertDefaultFlags.mockResolvedValue(undefined)
    mockGrantStructural.mockResolvedValue(3)
    mockSetActive.mockResolvedValue(undefined)
    mockRunMigrations.mockResolvedValue(undefined)
    mockFindEmailOwner.mockResolvedValue(null)
    mockInsertUser.mockResolvedValue(77)
  })

  it('cria a cadeia, provisiona o schema, contrata as estruturais, cria o admin e ativa', async () => {
    const result = await createInstitution(input, 'setes_alpha', admin)

    expect(result).toEqual({
      id: 2, schemaName: 'setes_alpha', active: 'S', adminUserId: 77,
    })
    // 3º arg = updatedBy (rastro do last-write-wins — Fase 3, decisão 1)
    expect(mockInsertCascade).toHaveBeenCalledWith(input, 'setes_alpha', null)
    expect(mockInsertDefaultFlags).toHaveBeenCalledWith(2)
    expect(mockRunMigrations).toHaveBeenCalledWith('setes_alpha')
    // Depois das migrations: a tabela do contrato vive no schema do cliente.
    expect(mockGrantStructural).toHaveBeenCalledWith('setes_alpha', 2)
    expect(mockSetActive).toHaveBeenCalledWith(2, 'S')
  })

  it('o admin nasce vinculado com kind=admin e senha HASHEADA', async () => {
    await createInstitution(input, 'setes_alpha', admin)

    const [payload, hash, link] = mockInsertUser.mock.calls[0]
    expect(payload).toMatchObject({ email: admin.email, active: 'S' })
    expect(link).toEqual({ institutionId: 2, kind: 'admin' })
    expect(hash).not.toBe(admin.password)   // md5Password aplicado no service
    expect(hash).toMatch(/^[0-9A-F]{32}$/)
  })

  it('e-mail do admin já usado como login → 409 ANTES de qualquer escrita', async () => {
    mockFindEmailOwner.mockResolvedValue(9)

    await expect(createInstitution(input, 'setes_alpha', admin))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(mockInsertCascade).not.toHaveBeenCalled()
  })

  it('falha ao criar o admin: institution permanece active=N', async () => {
    mockInsertUser.mockRejectedValue(new Error('login duplicado na corrida'))

    await expect(createInstitution(input, 'setes_alpha', admin))
      .rejects.toMatchObject({ statusCode: 500 })
    expect(mockSetActive).not.toHaveBeenCalled()
  })

  it('lanca 409 se o schemaName ja existe', async () => {
    mockSchemaExists.mockResolvedValue(true)

    await expect(createInstitution(input, 'setes_alpha', admin))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(mockInsertCascade).not.toHaveBeenCalled()
  })

  it('migracao falhou: institution permanece active=N e o erro volta ao app', async () => {
    mockRunMigrations.mockRejectedValue(new Error('DDL quebrou'))

    await expect(createInstitution(input, 'setes_beta', admin))
      .rejects.toMatchObject({ statusCode: 500 })
    expect(mockSetActive).not.toHaveBeenCalled() // permanece 'N'
    expect(mockInsertUser).not.toHaveBeenCalled()
  })

  it('ER_DUP_ENTRY na cascade vira 409 legivel', async () => {
    mockInsertCascade.mockRejectedValue(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }))

    await expect(createInstitution(input, 'setes_gamma', admin))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(mockRunMigrations).not.toHaveBeenCalled()
  })
})
