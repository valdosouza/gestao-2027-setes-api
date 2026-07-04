/// <reference types="jest" />
import * as adminRepo from '../modules/admin/admin.repository'
import * as runner    from '../migrations/runner'
import { onboardTenant } from '../modules/admin/admin.service'

jest.mock('../modules/admin/admin.repository')
jest.mock('../migrations/runner')

const mockInsertTenant       = adminRepo.insertTenant       as jest.Mock
const mockInsertDefaultFlags = adminRepo.insertDefaultFlags as jest.Mock
const mockSchemaExists       = adminRepo.tenantSchemaExists as jest.Mock
const mockRunMigrations      = runner.runMigrationsForSchema as jest.Mock

describe('onboardTenant', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSchemaExists.mockResolvedValue(false)
    mockInsertTenant.mockResolvedValue(undefined)
    mockInsertDefaultFlags.mockResolvedValue(undefined)
    mockRunMigrations.mockResolvedValue(undefined)
  })

  it('cria tenant com sucesso e retorna os dados', async () => {
    const result = await onboardTenant({ name: 'Empresa Setes', schemaName: 'gestao_setes' })

    expect(result.name).toBe('Empresa Setes')
    expect(result.schemaName).toBe('gestao_setes')
    expect(result.tenantId).toBeTruthy()
    expect(mockInsertTenant).toHaveBeenCalledTimes(1)
    expect(mockInsertDefaultFlags).toHaveBeenCalledTimes(1)
    expect(mockRunMigrations).toHaveBeenCalledWith('gestao_setes')
  })

  it('lanca 409 se o schemaName ja existe', async () => {
    mockSchemaExists.mockResolvedValue(true)

    await expect(
      onboardTenant({ name: 'Duplicado', schemaName: 'gestao_setes' })
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('lanca 400 se schemaName nao tem prefixo gestao_', async () => {
    await expect(
      onboardTenant({ name: 'Sem Prefixo', schemaName: 'setes_pipoteca' })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('lanca 400 se schemaName tem caracteres invalidos', async () => {
    await expect(
      onboardTenant({ name: 'Invalido', schemaName: 'gestao_Invalido!' })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('chama runMigrationsForSchema com o schemaName correto', async () => {
    await onboardTenant({ name: 'Empresa Delta', schemaName: 'gestao_delta' })
    expect(mockRunMigrations).toHaveBeenCalledWith('gestao_delta')
  })
})
