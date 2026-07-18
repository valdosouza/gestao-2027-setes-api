/// <reference types="jest" />
// Piloto do Framework de Configurações (decisão 15): filtro de carteira do
// vendedor no módulo customers — restrict_customer_to_salesman='S' +
// usuário-vendedor (tb_salesman) prende lista e GET :id à própria carteira.
import * as customersRepo from '../modules/customers/customers.repository'
import * as configRepo from '../shared/interface-config/interface-config.repository'
import * as fieldConfigRepo from '../shared/field-config/field-config.repository'
import * as sessionRepo from '../shared/session-context/session-context.repository'
import { invalidateInterfaceConfig } from '../shared/interface-config/interface-config.service'
import { invalidateSessionContext } from '../shared/session-context/session-context.service'
import { fetchCustomers, fetchCustomer, CustomerScope } from '../modules/customers/customers.service'

jest.mock('../modules/customers/customers.repository')
jest.mock('../shared/interface-config/interface-config.repository')
jest.mock('../shared/field-config/field-config.repository')
jest.mock('../shared/session-context/session-context.repository')

const mockList          = customersRepo.listCustomers as jest.Mock
const mockGet           = customersRepo.getCustomer   as jest.Mock
const mockConfigCatalog = configRepo.listCatalogConfigs as jest.Mock
const mockConfigValues  = configRepo.listConfigValues   as jest.Mock
const mockFindByKey     = fieldConfigRepo.findInterfaceIdByKey as jest.Mock
const mockIsSalesman    = sessionRepo.existsSalesman as jest.Mock

const scope: CustomerScope = {
  schemaName: 'setes_acme', institutionId: 7, userId: 42, role: 'user',
}

const RESTRICT_CONFIG = [{
  name: 'restrict_customer_to_salesman', description: 'Carteira',
  kind: 'Boolean', options: null, defaultContent: 'N', scope: 'I',
}]

function setRestriction(on: boolean) {
  mockConfigCatalog.mockResolvedValue(RESTRICT_CONFIG)
  mockConfigValues.mockResolvedValue(
    on ? [{ name: 'restrict_customer_to_salesman', tbUserId: 0, content: 'S' }] : []
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  invalidateInterfaceConfig(7, 9)
  invalidateSessionContext(7, 42)
  mockFindByKey.mockResolvedValue(9)
  mockList.mockResolvedValue([])
})

describe('filtro de carteira (decisão 15)', () => {
  it('config desligada: lista sem filtro de vendedor', async () => {
    setRestriction(false)
    mockIsSalesman.mockResolvedValue(true)

    await fetchCustomers('', scope)
    expect(mockList).toHaveBeenCalledWith('', 'setes_acme', 7, null)
  })

  it('config ligada + usuário-vendedor: lista PRESA à carteira (salesmanId = userId)', async () => {
    setRestriction(true)
    mockIsSalesman.mockResolvedValue(true)

    await fetchCustomers('', scope)
    expect(mockList).toHaveBeenCalledWith('', 'setes_acme', 7, 42)
  })

  it('config ligada + usuário NÃO vendedor: sem restrição', async () => {
    setRestriction(true)
    mockIsSalesman.mockResolvedValue(false)

    await fetchCustomers('', scope)
    expect(mockList).toHaveBeenCalledWith('', 'setes_acme', 7, null)
  })

  it('GET :id fora da carteira devolve 404 (não vaza existência)', async () => {
    setRestriction(true)
    mockIsSalesman.mockResolvedValue(true)
    mockGet.mockResolvedValue({ id: 10, tbSalesmanId: 99 })

    await expect(fetchCustomer(10, scope)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('GET :id da própria carteira passa', async () => {
    setRestriction(true)
    mockIsSalesman.mockResolvedValue(true)
    mockGet.mockResolvedValue({ id: 10, tbSalesmanId: 42 })

    await expect(fetchCustomer(10, scope)).resolves.toMatchObject({ id: 10 })
  })
})
