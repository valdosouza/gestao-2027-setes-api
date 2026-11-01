/// <reference types="jest" />
// Re-gate socrático da costura A1 (M1, 2026-11-01): reativar um estabelecimento pela EDIÇÃO passa pelo mesmo provisionamento do onboarding
// — as migrations que chegaram com ele inativo (a 075: sem as views do veredito toda guarda e o menu daquele cliente dariam 500).
import * as repo   from '../modules/institutions/institutions.repository'
import * as runner from '../migrations/runner'
import { editInstitution } from '../modules/institutions/institutions.service'
import { InstitutionInput } from '../modules/institutions/institutions.interface'

jest.mock('../modules/institutions/institutions.repository')
jest.mock('../migrations/runner')
jest.mock('../shared/user')

const mockExists     = repo.institutionExists          as jest.Mock
const mockActivation = repo.getInstitutionActivation   as jest.Mock
const mockUpdate     = repo.updateInstitutionCascade   as jest.Mock
const mockMigrations = runner.runMigrationsForSchema   as jest.Mock

const base: InstitutionInput = {
  entity: { nameCompany: 'Cliente LTDA', nickTrade: 'Cliente' }, personType: 'J', company: { cnpj: '12345678000199' },
  addresses: [], phones: [], socialMedia: [],
}

describe('editInstitution — a volta a ATIVO provisiona o schema', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockExists.mockResolvedValue(true)
    mockUpdate.mockResolvedValue(undefined)
    mockMigrations.mockResolvedValue(undefined)
  })

  it("N → S: roda as migrations do schema ANTES de gravar", async () => {
    mockActivation.mockResolvedValue({ schemaName: 'setes_cliente', active: 'N' })
    await editInstitution(7, { ...base, active: 'S' }, 1)
    expect(mockMigrations).toHaveBeenCalledWith('setes_cliente')
    expect(mockMigrations.mock.invocationCallOrder[0]).toBeLessThan(mockUpdate.mock.invocationCallOrder[0])
    expect(mockUpdate).toHaveBeenCalledWith(7, { ...base, active: 'S' }, 1)
  })

  it('provisionamento falhou: 500 com a frase, NADA gravado (segue inativo)', async () => {
    mockActivation.mockResolvedValue({ schemaName: 'setes_cliente', active: 'N' })
    mockMigrations.mockRejectedValue(new Error('075 quebrou'))
    const err = await editInstitution(7, { ...base, active: 'S' }).catch(e => e)
    expect(err.statusCode).toBe(500)
    expect(err.message).toMatch(/setes_cliente.*permanece INATIVO.*nada foi gravado/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('já ativo, inativando ou sem mexer no ativo: nenhuma migration', async () => {
    mockActivation.mockResolvedValue({ schemaName: 'setes_cliente', active: 'S' })
    await editInstitution(7, { ...base, active: 'S' })
    await editInstitution(7, { ...base, active: 'N' })
    await editInstitution(7, base)
    expect(mockMigrations).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalledTimes(3)
  })
})
