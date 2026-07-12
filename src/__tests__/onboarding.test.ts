/// <reference types="jest" />
// O onboarding foi absorvido pelo cadastro de Estabelecimento (decisão do
// Valdo, 2026-07-11): POST /api/institutions cria a cadeia fiscal, provisiona
// o schema e ativa a institution. Este teste cobre o fluxo do service.
import * as repo   from '../modules/institutions/institutions.repository'
import * as runner from '../migrations/runner'
import { createInstitution } from '../modules/institutions/institutions.service'
import { InstitutionInput } from '../modules/institutions/institutions.interface'

jest.mock('../modules/institutions/institutions.repository')
jest.mock('../migrations/runner')

const mockSchemaExists       = repo.schemaNameExists           as jest.Mock
const mockInsertCascade      = repo.insertInstitutionCascade   as jest.Mock
const mockInsertDefaultFlags = repo.insertDefaultFlags         as jest.Mock
const mockSetActive          = repo.setInstitutionActive       as jest.Mock
const mockRunMigrations      = runner.runMigrationsForSchema   as jest.Mock

const input: InstitutionInput = {
  entity:      { nameCompany: 'Empresa Setes LTDA', nickTrade: 'Setes' },
  personType:  'J',
  company:     { cnpj: '12345678000199' },
  addresses:   [],
  phones:      [],
  socialMedia: [],
}

describe('createInstitution (POST /api/institutions absorve o onboarding)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSchemaExists.mockResolvedValue(false)
    mockInsertCascade.mockResolvedValue(2)
    mockInsertDefaultFlags.mockResolvedValue(undefined)
    mockSetActive.mockResolvedValue(undefined)
    mockRunMigrations.mockResolvedValue(undefined)
  })

  it('cria a cadeia, provisiona o schema e ativa a institution', async () => {
    const result = await createInstitution(input, 'setes_alpha')

    expect(result).toEqual({ id: 2, schemaName: 'setes_alpha', active: 'S' })
    expect(mockInsertCascade).toHaveBeenCalledWith(input, 'setes_alpha')
    expect(mockInsertDefaultFlags).toHaveBeenCalledWith(2)
    expect(mockRunMigrations).toHaveBeenCalledWith('setes_alpha')
    expect(mockSetActive).toHaveBeenCalledWith(2, 'S')
  })

  it('lanca 409 se o schemaName ja existe', async () => {
    mockSchemaExists.mockResolvedValue(true)

    await expect(createInstitution(input, 'setes_alpha'))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(mockInsertCascade).not.toHaveBeenCalled()
  })

  it('migracao falhou: institution permanece active=N e o erro volta ao app', async () => {
    mockRunMigrations.mockRejectedValue(new Error('DDL quebrou'))

    await expect(createInstitution(input, 'setes_beta'))
      .rejects.toMatchObject({ statusCode: 500 })
    expect(mockSetActive).not.toHaveBeenCalled() // permanece 'N'
  })

  it('ER_DUP_ENTRY na cascade vira 409 legivel', async () => {
    mockInsertCascade.mockRejectedValue(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }))

    await expect(createInstitution(input, 'setes_gamma'))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(mockRunMigrations).not.toHaveBeenCalled()
  })
})
