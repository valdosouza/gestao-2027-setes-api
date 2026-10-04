/// <reference types="jest" />
// Pesquisa avançada — Onda 3 (Infra-IA/prompts/prompt_pesquisa_avancada.md §13, D-BA34): os lookups
// NOVOS de cliente das telas de venda (pedidos e devoluções) respeitam a carteira travada do vendedor
// — a carteira é da PESSOA (D-BA17), pela peça @shared/customer-wallet.
import pool from '../shared/db/connection'
import * as wallet from '../shared/customer-wallet'
import { fetchCustomerLookup as ordersCustomerLookup } from '../modules/orders/orders.service'
import { fetchCustomerLookup as returnsCustomerLookup } from '../modules/order-returns/order-returns.service'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn() } }))
jest.mock('../shared/customer-wallet')
const mockQuery = (pool as any).query as jest.Mock
const scope = { schemaName: 'setes_acme', institutionId: 7, userId: 42, role: 'user' }

beforeEach(() => jest.clearAllMocks())

describe.each([
  ['pedidos', ordersCustomerLookup],
  ['devoluções', returnsCustomerLookup],
] as const)('lookup de cliente — %s', (_n, lookup) => {
  it('vendedor TRAVADO: a query recebe o vendedor da carteira', async () => {
    ;(wallet.walletSalesmanId as jest.Mock).mockResolvedValue(42)
    mockQuery.mockResolvedValueOnce([[]])
    await lookup('k2', scope)
    expect(wallet.walletSalesmanId).toHaveBeenCalledWith(expect.objectContaining({ institutionId: 7, userId: 42, role: 'user' }))
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/\(\? IS NULL OR cu\.tb_salesman_id = \?\)/)
    expect(params).toEqual([7, '%k2%', '%k2%', '%k2%', 42, 42])
  })

  it('sem trava: NULL (todos os clientes da institution)', async () => {
    ;(wallet.walletSalesmanId as jest.Mock).mockResolvedValue(null)
    mockQuery.mockResolvedValueOnce([[]])
    await lookup('', scope)
    expect(mockQuery.mock.calls[0][1]).toEqual([7, null, null, null, null, null])
  })
})
