/// <reference types="jest" />
// Q-G29 (Valdo 2026-09-10): a interface do RAMO do pedido decide onde o privilégio
// (FATURAR/CANCELAR) precisa existir — OS (ciclo) → service-orders; devolução (âncora)
// → order-returns; senão orders.
import { resolveOrderInterface, resolveFromBody } from '../modules/billing/billing.interface-resolver'
import { hasServiceOrderCycle } from '../shared/service-order'
import { getAnchor } from '../shared/order-return'

jest.mock('../shared/service-order', () => ({ __esModule: true, hasServiceOrderCycle: jest.fn() }))
jest.mock('../shared/order-return', () => ({ __esModule: true, getAnchor: jest.fn() }))
const cycle = hasServiceOrderCycle as jest.Mock
const anchor = getAnchor as jest.Mock

beforeEach(() => jest.clearAllMocks())

describe('resolveOrderInterface', () => {
  it('pedido com ciclo de OS → service-orders (sem consultar a âncora)', async () => {
    cycle.mockResolvedValueOnce(true)
    expect(await resolveOrderInterface('setes_setes', 1, 7492)).toBe('service-orders')
    expect(anchor).not.toHaveBeenCalled()
  })
  it('devolução (âncora tb_order_stock_adjust_return) → order-returns', async () => {
    cycle.mockResolvedValueOnce(false)
    anchor.mockResolvedValueOnce({ orderIdOri: 7490 })
    expect(await resolveOrderInterface('setes_setes', 1, 7600)).toBe('order-returns')
  })
  it('venda → orders; orderId inválido → orders sem consultar nada', async () => {
    cycle.mockResolvedValueOnce(false)
    anchor.mockResolvedValueOnce(null)
    expect(await resolveOrderInterface('setes_setes', 1, 7490)).toBe('orders')
    expect(await resolveOrderInterface('setes_setes', 1, 0)).toBe('orders')
    expect(cycle).toHaveBeenCalledTimes(1)
  })
  it('resolveFromBody lê orderId do corpo e o escopo do req.institution', async () => {
    cycle.mockResolvedValueOnce(false)
    anchor.mockResolvedValueOnce({ orderIdOri: 1 })
    const req: any = { body: { orderId: '7600' }, institution: { schemaName: 'setes_setes', institutionId: 1 } }
    expect(await resolveFromBody(req)).toBe('order-returns')
    expect(anchor).toHaveBeenCalledWith('setes_setes', 1, 7600, { includeDeleted: true })
  })
  it('D-A31: âncora SOFT-DELETADA com a ordem viva ainda decide o ramo → order-returns (nunca ajuste solto)', async () => {
    cycle.mockResolvedValueOnce(false)
    anchor.mockResolvedValueOnce({ orderIdOri: 7543, deleted: 'S' })
    expect(await resolveOrderInterface('setes_setes', 1, 7544)).toBe('order-returns')
  })
})
