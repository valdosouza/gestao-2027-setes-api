/// <reference types="jest" />
import * as adminRepo from '../modules/admin/admin.repository'
import * as runner    from '../migrations/runner'
import { onboardInstitution } from '../modules/admin/admin.service'

jest.mock('../modules/admin/admin.repository')
jest.mock('../migrations/runner')

const mockInsertInstitution  = adminRepo.insertInstitution        as jest.Mock
const mockInsertDefaultFlags = adminRepo.insertDefaultFlags       as jest.Mock
const mockSchemaExists       = adminRepo.institutionSchemaExists  as jest.Mock
const mockRunMigrations      = runner.runMigrationsForSchema      as jest.Mock

describe('onboardInstitution', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSchemaExists.mockResolvedValue(false)
    mockInsertInstitution.mockResolvedValue(2)
    mockInsertDefaultFlags.mockResolvedValue(undefined)
    mockRunMigrations.mockResolvedValue(undefined)
  })

  it('cria institution com sucesso e retorna os dados', async () => {
    const result = await onboardInstitution({ name: 'Empresa Setes', schemaName: 'setes_alpha' })

    expect(result.name).toBe('Empresa Setes')
    expect(result.schemaName).toBe('setes_alpha')
    expect(result.institutionId).toBe(2)
    expect(mockInsertInstitution).toHaveBeenCalledTimes(1)
    expect(mockInsertDefaultFlags).toHaveBeenCalledWith(2)
    expect(mockRunMigrations).toHaveBeenCalledWith('setes_alpha')
  })

  it('lanca 409 se o schemaName ja existe', async () => {
    mockSchemaExists.mockResolvedValue(true)

    await expect(
      onboardInstitution({ name: 'Duplicado', schemaName: 'setes_alpha' })
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('lanca 400 se schemaName nao tem prefixo setes_', async () => {
    await expect(
      onboardInstitution({ name: 'Sem Prefixo', schemaName: 'gestao_pipoteca' })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('lanca 400 se schemaName tem caracteres invalidos', async () => {
    await expect(
      onboardInstitution({ name: 'Invalido', schemaName: 'setes_Invalido!' })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('chama runMigrationsForSchema com o schemaName correto', async () => {
    await onboardInstitution({ name: 'Empresa Delta', schemaName: 'setes_delta' })
    expect(mockRunMigrations).toHaveBeenCalledWith('setes_delta')
  })
})
