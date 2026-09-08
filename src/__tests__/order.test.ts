/// <reference types="jest" />
// Peça @shared/order (backbone mínimo — parecer 2026-09-06): base financeira
// do PEDIDO (espelho de TControllerPedido.valorFinanceiro — itens
// set_financial + frete, SEM impostos/despesas) e lock agnóstico ao ramo.
import { getOrderFinancialBase, lockOpenOrder } from '../shared/order'

function fakeConn() { return { query: jest.fn() } }

describe('getOrderFinancialBase', () => {
  it('soma itens set_financial ≠ N (link ausente = conta), arredonda por item, soma o frete do pedido', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[
        { quantity: 2, unitValue: 10, discountValue: 0.5, setFinancial: 'S' },   // 19.50
        { quantity: 1, unitValue: 100, discountValue: 0, setFinancial: 'N' },    // fora (sem financeiro)
        { quantity: 3, unitValue: '1.10', discountValue: '0', setFinancial: 'S' }, // 3.30 (strings do driver)
      ]])
      .mockResolvedValueOnce([[{ freight: '5.00' }]])
    expect(await getOrderFinancialBase(conn as any, 'setes_setes', 1, 10))
      .toEqual({ itemsValue: 22.8, freight: 5, base: 27.8 })
    const [sql] = conn.query.mock.calls[0]
    expect(sql).toContain('tb_order_item_tax_rule')
    expect(sql).toContain("COALESCE(l.set_financial, 'S')")
    // Achado do smoke (2026-09-06): tb_order_item.kind e tb_order_item_tax_rule.kind
    // têm collations diferentes no dev (unicode_ci × general_ci) — sem o COLLATE
    // explícito o JOIN dava ER_CANT_AGGREGATE_2COLLATIONS (500). Só o banco real pega.
    expect(sql).toContain('l.kind COLLATE utf8mb4_unicode_ci = i.kind COLLATE utf8mb4_unicode_ci')
    expect(sql).not.toContain('expenses') // despesas ficam fora (fiel ao legado)
  })
  it('pedido sem itens → base 0', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ freight: 0 }]])
    expect(await getOrderFinancialBase(conn as any, 'setes_setes', 1, 10))
      .toEqual({ itemsValue: 0, freight: 0, base: 0 })
  })
})

describe('lockOpenOrder (agnóstico ao ramo)', () => {
  it('inexistente → 404 ORDER_NOT_FOUND; faturado → 409 ORDER_INVOICED; aberto → ok', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]])
    await expect(lockOpenOrder(conn as any, 'setes_setes', 1, 10))
      .rejects.toMatchObject({ statusCode: 404, code: 'ORDER_NOT_FOUND' })
    conn.query.mockResolvedValueOnce([[{ status: 'F' }]])
    await expect(lockOpenOrder(conn as any, 'setes_setes', 1, 10))
      .rejects.toMatchObject({ statusCode: 409, code: 'ORDER_INVOICED' })
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])
    expect(await lockOpenOrder(conn as any, 'setes_setes', 1, 10)).toEqual({ status: 'A' })
    expect(conn.query.mock.calls[2][0]).toContain('FOR UPDATE')
    expect(conn.query.mock.calls[2][0]).not.toContain('tb_order_sale')
  })
})
