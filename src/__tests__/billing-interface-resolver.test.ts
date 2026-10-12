/// <reference types="jest" />
// Q-G29 (Valdo 2026-09-10): a interface do RAMO do pedido decide onde o privilégio
// (FATURAR/CANCELAR) precisa existir — OS (ciclo) → service-orders; devolução (âncora)
// → order-returns; senão orders.
// D-F32 (F2a, etapa A2 — prompt_apis_fiscais_isoladas.md §22.9): a regra mora na VIEW de política `vw_order_interface`
// (065/068) — a MESMA da nfse-api. O resolver só a lê; a equivalência com a regra antiga (ciclo de OS → âncora
// mesmo soft-deletada → venda) foi provada nos dados reais (`scripts/prove-policy-views.ts`).
import { resolveOrderInterface, resolveFromBody, resolveFromParam } from '../modules/billing/billing.interface-resolver'
import pool from '../shared/db/connection'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn() } }))
const query = pool.query as unknown as jest.Mock

beforeEach(() => jest.clearAllMocks())

describe('resolveOrderInterface — pela view vw_order_interface (D-F32)', () => {
  it('lê a view do schema do cliente, pela chave do pedido (institution, pedido, terminal 0) — nenhuma regra própria', async () => {
    query.mockResolvedValueOnce([[{ k: 'service-orders' }]])
    expect(await resolveOrderInterface('setes_setes', 1, 7492)).toBe('service-orders')
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0]
    expect(String(sql)).toMatch(/FROM `setes_setes`\.vw_order_interface/)
    expect(String(sql)).toMatch(/tb_institution_id = \? AND tb_order_id = \? AND terminal = 0/)
    expect(String(sql)).not.toMatch(/tb_service_order|tb_order_stock_adjust_return/)
    expect(params).toEqual([1, 7492])
  })
  it('devolução (a view diz order-returns) → order-returns', async () => {
    query.mockResolvedValueOnce([[{ k: 'order-returns' }]])
    expect(await resolveOrderInterface('setes_setes', 1, 7600)).toBe('order-returns')
  })
  it('venda → orders; pedido sem linha na view → orders (o default de quem lê a view)', async () => {
    query.mockResolvedValueOnce([[{ k: 'orders' }]]).mockResolvedValueOnce([[]])
    expect(await resolveOrderInterface('setes_setes', 1, 7490)).toBe('orders')
    expect(await resolveOrderInterface('setes_setes', 1, 999999)).toBe('orders')
  })
  it('valor fora do domínio vindo da view → orders (nunca uma interface inventada)', async () => {
    query.mockResolvedValueOnce([[{ k: 'super' }]])
    expect(await resolveOrderInterface('setes_setes', 1, 7490)).toBe('orders')
  })
  it('orderId inválido → orders sem consultar nada', async () => {
    for (const id of [0, -3, 1.5, NaN]) expect(await resolveOrderInterface('setes_setes', 1, id)).toBe('orders')
    expect(query).not.toHaveBeenCalled()
  })
  it('schema fora do padrão → recusa antes do SQL (assertSchema)', async () => {
    await expect(resolveOrderInterface('x`; DROP', 1, 7490)).rejects.toThrow()
    expect(query).not.toHaveBeenCalled()
  })
  it('resolveFromBody lê orderId do corpo e o escopo do req.institution; resolveFromParam, da URL', async () => {
    query.mockResolvedValueOnce([[{ k: 'order-returns' }]]).mockResolvedValueOnce([[{ k: 'service-orders' }]])
    const inst = { schemaName: 'setes_setes', institutionId: 1 }
    expect(await resolveFromBody({ body: { orderId: '7600' }, institution: inst } as any)).toBe('order-returns')
    expect(await resolveFromParam({ params: { orderId: '7492' }, institution: inst } as any)).toBe('service-orders')
    expect(query.mock.calls.map(c => c[1])).toEqual([[1, 7600], [1, 7492]])
  })
})
