/// <reference types="jest" />
// Peças da rodada 2026-08-24 (Q1–Q5): @shared/commission (lançamento
// imutável por item — devolução = value NEGATIVO) e @shared/order-return
// (equivalente web da TB_ITENS_DEV — saldo devolvível DERIVADO).
import pool from '../shared/db/connection'
import {
  resolveCommissionAliq, insertCommission, insertCommissions, getPostedItemCommissions,
} from '../shared/commission'
import { buildReturnPlan, persistReturn, assertReturnableInTx } from '../shared/order-return'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockQuery = (pool as any).query as jest.Mock

beforeEach(() => jest.clearAllMocks())

// ---------------------------------------------------------------------
// @shared/commission
// ---------------------------------------------------------------------

describe('resolveCommissionAliq', () => {
  it('kickback_product=S usa a alíquota do PRODUTO (tb_price da lista do item)', async () => {
    mockQuery.mockResolvedValueOnce([[{ aliq: 3, byProduct: 'S' }]]) // tb_salesman
    mockQuery.mockResolvedValueOnce([[{ aliq: 7.5 }]])               // tb_price
    expect(await resolveCommissionAliq('setes_setes', 1, 9, 100, 2)).toBe(7.5)
  })

  it('kickback_product=S sem linha de preço cai na alíquota do VENDEDOR', async () => {
    mockQuery.mockResolvedValueOnce([[{ aliq: 3, byProduct: 'S' }]])
    mockQuery.mockResolvedValueOnce([[]])
    expect(await resolveCommissionAliq('setes_setes', 1, 9, 100, 2)).toBe(3)
  })

  it('kickback_product=N usa direto a alíquota do vendedor (sem consultar preço)', async () => {
    mockQuery.mockResolvedValueOnce([[{ aliq: 4, byProduct: 'N' }]])
    expect(await resolveCommissionAliq('setes_setes', 1, 9, 100, 2)).toBe(4)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('item sem lista de preço não consulta tb_price mesmo com byProduct=S', async () => {
    mockQuery.mockResolvedValueOnce([[{ aliq: 4, byProduct: 'S' }]])
    expect(await resolveCommissionAliq('setes_setes', 1, 9, 100, null)).toBe(4)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('vendedor inexistente/deletado -> 0 (sem lançamento)', async () => {
    mockQuery.mockResolvedValueOnce([[]])
    expect(await resolveCommissionAliq('setes_setes', 1, 9, 100, 2)).toBe(0)
  })

  it('clamp: alíquota corrompida no cadastro nunca vira comissão negativa nem > 100% (MEDIUM adversarial)', async () => {
    mockQuery.mockResolvedValueOnce([[{ aliq: 3, byProduct: 'S' }]])
    mockQuery.mockResolvedValueOnce([[{ aliq: 150 }]])   // tb_price corrompida
    expect(await resolveCommissionAliq('setes_setes', 1, 9, 100, 2)).toBe(100)

    mockQuery.mockResolvedValueOnce([[{ aliq: -5, byProduct: 'N' }]]) // vendedor corrompido
    expect(await resolveCommissionAliq('setes_setes', 1, 9, 100, 2)).toBe(0)
  })
})

describe('insertCommission', () => {
  it('id MAX+1 sob FOR UPDATE e value NEGATIVO preservado (estorno nunca vira UPDATE)', async () => {
    const conn = { query: jest.fn() }
    conn.query.mockResolvedValueOnce([[{ nextId: 8 }]])
    conn.query.mockResolvedValueOnce([{}])

    const id = await insertCommission(conn as any, 'setes_setes', 1, {
      kind: 'F', orderId: 10, orderItemId: 1, orderItemKind: 'Adjust',
      customerId: 55, salesmanId: 9, baseValue: 100, aliq: 10, value: -10,
    })

    expect(id).toBe(8)
    expect(conn.query.mock.calls[0][0]).toContain('FOR UPDATE')
    const insert = conn.query.mock.calls[1]
    expect(insert[0]).toContain('INSERT INTO')
    expect(insert[1]).toContain(-10)
    expect(insert[1]).toContain('F')
  })

  it('lote: MAX+1 reservado UMA vez, ids sequenciais (R6 socrático)', async () => {
    const conn = { query: jest.fn().mockResolvedValue([{}]) }
    conn.query.mockResolvedValueOnce([[{ nextId: 5 }]])
    const base = {
      kind: 'F' as const, orderId: 10, orderItemKind: 'Sale',
      customerId: 55, salesmanId: 9, baseValue: 100, aliq: 5, value: 5,
    }
    const ids = await insertCommissions(conn as any, 'setes_setes', 1, [
      { ...base, orderItemId: 1 }, { ...base, orderItemId: 2 }, { ...base, orderItemId: 3 },
    ])
    expect(ids).toEqual([5, 6, 7])
    const forUpdates = conn.query.mock.calls.filter(c => (c[0] as string).includes('FOR UPDATE'))
    expect(forUpdates).toHaveLength(1)
  })

  it('lote vazio: nenhuma query (nem o lock)', async () => {
    const conn = { query: jest.fn() }
    expect(await insertCommissions(conn as any, 'setes_setes', 1, [])).toEqual([])
    expect(conn.query).not.toHaveBeenCalled()
  })
})

describe('getPostedItemCommissions', () => {
  it('só lê lançamentos POSITIVOS vivos (estorno não é fonte de alíquota)', async () => {
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 33, orderItemKind: 'Sale', salesmanId: 9, customerId: 55, aliq: 10,
    }]])
    const rows = await getPostedItemCommissions('setes_setes', 1, 77)
    expect(rows).toEqual([{
      orderItemId: 33, orderItemKind: 'Sale', salesmanId: 9, customerId: 55, aliq: 10,
    }])
    expect(mockQuery.mock.calls[0][0]).toContain('value > 0')
  })
})

// ---------------------------------------------------------------------
// @shared/order-return
// ---------------------------------------------------------------------

const adjustItem = (over: any = {}) => ({
  id: 1, kind: 'Adjust', productId: 100, quantity: 2, unitValue: 50, ...over,
})

function mockOriginalSale(over: {
  sale?: any[]; items?: any[]; returned?: any[]
} = {}) {
  mockQuery.mockResolvedValueOnce([over.sale ?? [{ salesmanId: 9, customerId: 55, status: 'F' }]])
  mockQuery.mockResolvedValueOnce([over.items ?? [
    { id: 33, kind: 'Sale', productId: 100, quantity: 5, unitValue: 50, priceListId: 2 },
  ]])
  mockQuery.mockResolvedValueOnce([over.returned ?? []])
}

describe('buildReturnPlan', () => {
  it('pedido original inexistente/não-venda -> issue única, sem plano', async () => {
    mockQuery.mockResolvedValueOnce([[]])
    const { issues, plan } = await buildReturnPlan('setes_setes', 1, 77, 55, [adjustItem()])
    expect(plan).toBeNull()
    expect(issues).toHaveLength(1)
    expect(issues[0].field).toBe('returnedOrderId')
  })

  it('origem NÃO faturada -> issue (decisão 2026-08-24: devolução exige nota emitida)', async () => {
    mockOriginalSale({ sale: [{ salesmanId: 9, customerId: 55, status: 'A' }] })
    const { issues, plan } = await buildReturnPlan('setes_setes', 1, 77, 55, [adjustItem()])
    expect(plan).toBeNull()
    expect(issues.some(i => i.field === 'returnedOrderId'
      && i.message.includes('não foi faturado'))).toBe(true)
  })

  it('cliente do ajuste diferente do pedido original -> issue (legado: mesma empresa)', async () => {
    mockOriginalSale()
    const { issues, plan } = await buildReturnPlan('setes_setes', 1, 77, 999, [adjustItem()])
    expect(plan).toBeNull()
    expect(issues.some(i => i.field === 'returnedOrderId')).toBe(true)
  })

  it('produto que não consta no pedido original -> issue por item', async () => {
    mockOriginalSale()
    const { issues, plan } = await buildReturnPlan(
      'setes_setes', 1, 77, 55, [adjustItem({ productId: 777 })])
    expect(plan).toBeNull()
    expect(issues.some(i => i.itemId === 1 && i.field === 'product')).toBe(true)
  })

  it('quantidade > saldo devolvível ACUMULADO (desconta devoluções anteriores) -> issue', async () => {
    // vendidos 5, já devolvidos 4 → saldo 1; devolver 2 estoura
    mockOriginalSale({ returned: [{ productId: 100, returned: 4 }] })
    const { issues, plan } = await buildReturnPlan(
      'setes_setes', 1, 77, 55, [adjustItem({ quantity: 2 })])
    expect(plan).toBeNull()
    expect(issues.some(i => i.itemId === 1 && i.field === 'quantity')).toBe(true)
  })

  it('valor unitário maior que o da origem -> issue (legado: nunca devolve mais caro)', async () => {
    mockOriginalSale()
    const { issues, plan } = await buildReturnPlan(
      'setes_setes', 1, 77, 55, [adjustItem({ unitValue: 60 })])
    expect(plan).toBeNull()
    expect(issues.some(i => i.itemId === 1 && i.field === 'unitValue')).toBe(true)
  })

  it('feliz: plano liga cada item ao item MAIS RECENTE do produto (ITF_CODIGO DESC)', async () => {
    mockOriginalSale({ items: [
      { id: 30, kind: 'Sale', productId: 100, quantity: 3, unitValue: 50, priceListId: 2 },
      { id: 33, kind: 'Sale', productId: 100, quantity: 2, unitValue: 50, priceListId: 2 },
    ] })
    const { issues, plan } = await buildReturnPlan(
      'setes_setes', 1, 77, 55, [adjustItem({ quantity: 4 })]) // 4 ≤ 3+2 agregado
    expect(issues).toEqual([])
    expect(plan).toEqual({
      orderIdOri: 77, salesmanId: 9, customerId: 55,
      links: [{ itemId: 1, itemKind: 'Adjust', quantity: 4, itemIdOri: 33,
        kindOri: 'Sale', productId: 100, priceListIdOri: 2 }],
    })
  })

  it('R1 socrático: itens IRMÃOS do mesmo plano acumulam — 7+7 contra venda de 10 reprova', async () => {
    mockOriginalSale({ items: [
      { id: 33, kind: 'Sale', productId: 100, quantity: 10, unitValue: 50, priceListId: 2 },
    ] })
    const { issues, plan } = await buildReturnPlan('setes_setes', 1, 77, 55, [
      adjustItem({ id: 1, quantity: 7 }),
      adjustItem({ id: 2, quantity: 7 }),
    ])
    expect(plan).toBeNull()
    expect(issues.some(i => i.itemId === 2 && i.field === 'quantity')).toBe(true)
  })

  it('epsilon: soma fracionada em float não rejeita devolução total legítima (R5)', async () => {
    // 10 × 0.1 somados em float = 0.9999999999999999 — devolver 1.0 deve passar
    mockOriginalSale({ items: Array.from({ length: 10 }, (_, i) => (
      { id: 30 + i, kind: 'Sale', productId: 100, quantity: 0.1, unitValue: 50, priceListId: 2 }
    )) })
    const { issues, plan } = await buildReturnPlan(
      'setes_setes', 1, 77, 55, [adjustItem({ quantity: 1.0 })])
    expect(issues).toEqual([])
    expect(plan).not.toBeNull()
  })
})

describe('assertReturnableInTx', () => {
  const plan = {
    orderIdOri: 77, salesmanId: 9, customerId: 55,
    links: [
      { itemId: 1, itemKind: 'Adjust', quantity: 7, itemIdOri: 33, kindOri: 'Sale',
        productId: 100, priceListIdOri: 2 },
      { itemId: 2, itemKind: 'Adjust', quantity: 7, itemIdOri: 33, kindOri: 'Sale',
        productId: 100, priceListIdOri: 2 },
    ],
  }

  // itens VIVOS da devolução sob o lock — batem com o plano (R1)
  const liveMatching = [
    { id: 1, kind: 'Adjust', quantity: 7 },
    { id: 2, kind: 'Adjust', quantity: 7 },
  ]

  it('tranca o pedido ORIGINAL (FOR UPDATE) e estoura 422 quando o saldo já foi consumido', async () => {
    const conn = { query: jest.fn() }
    conn.query.mockResolvedValueOnce([[{ id: 77, status: 'F' }]])          // lock origem
    conn.query.mockResolvedValueOnce([liveMatching])                       // itens vivos
    conn.query.mockResolvedValueOnce([[{ productId: 100, qty: 10 }]])      // vendidos
    conn.query.mockResolvedValueOnce([[{ productId: 100, returned: 0 }]])  // devolvidos
    await expect(assertReturnableInTx(conn as any, 'setes_setes', 1, 10, plan))
      .rejects.toMatchObject({ statusCode: 422, code: 'RETURN_INVALID' })  // 14 > 10
    expect(conn.query.mock.calls[0][0]).toContain('FOR UPDATE')
    expect(conn.query.mock.calls[0][1]).toEqual([77, 1])
  })

  it('passa quando o saldo sob lock comporta o plano', async () => {
    const conn = { query: jest.fn() }
    conn.query.mockResolvedValueOnce([[{ id: 77, status: 'F' }]])
    conn.query.mockResolvedValueOnce([liveMatching])
    conn.query.mockResolvedValueOnce([[{ productId: 100, qty: 20 }]])
    conn.query.mockResolvedValueOnce([[{ productId: 100, returned: 4 }]])
    await expect(assertReturnableInTx(conn as any, 'setes_setes', 1, 10, plan))
      .resolves.toBeUndefined()                                            // 14 ≤ 20-4
  })

  it('R1 socrático: PUT commitado entre o plano e o lock -> 422 REQUIRES_VALIDATION', async () => {
    const conn = { query: jest.fn() }
    conn.query.mockResolvedValueOnce([[{ id: 77, status: 'F' }]])
    conn.query.mockResolvedValueOnce([[                                    // item 1 mudou p/ 3
      { id: 1, kind: 'Adjust', quantity: 3 },
      { id: 2, kind: 'Adjust', quantity: 7 },
    ]])
    await expect(assertReturnableInTx(conn as any, 'setes_setes', 1, 10, plan))
      .rejects.toMatchObject({ statusCode: 422, code: 'REQUIRES_VALIDATION' })
  })

  it('R1 socrático: item removido entre o plano e o lock -> 422 REQUIRES_VALIDATION', async () => {
    const conn = { query: jest.fn() }
    conn.query.mockResolvedValueOnce([[{ id: 77, status: 'F' }]])
    conn.query.mockResolvedValueOnce([[{ id: 1, kind: 'Adjust', quantity: 7 }]]) // só 1 vivo
    await expect(assertReturnableInTx(conn as any, 'setes_setes', 1, 10, plan))
      .rejects.toMatchObject({ statusCode: 422, code: 'REQUIRES_VALIDATION' })
  })

  it('origem sumiu entre o plano e a transação -> 422', async () => {
    const conn = { query: jest.fn() }
    conn.query.mockResolvedValueOnce([[]])
    await expect(assertReturnableInTx(conn as any, 'setes_setes', 1, 10, plan))
      .rejects.toMatchObject({ statusCode: 422, code: 'RETURN_INVALID' })
  })

  it('origem deixou de estar faturada sob lock -> 422 (decisão 2026-08-24)', async () => {
    const conn = { query: jest.fn() }
    conn.query.mockResolvedValueOnce([[{ id: 77, status: 'A' }]])
    await expect(assertReturnableInTx(conn as any, 'setes_setes', 1, 10, plan))
      .rejects.toMatchObject({ statusCode: 422, code: 'RETURN_INVALID' })
  })
})

describe('persistReturn', () => {
  const plan = {
    orderIdOri: 77, salesmanId: 9, customerId: 55,
    links: [
      { itemId: 1, itemKind: 'Adjust', quantity: 2, itemIdOri: 33, kindOri: 'Sale',
        productId: 100, priceListIdOri: 2 },
      { itemId: 2, itemKind: 'Adjust', quantity: 1, itemIdOri: 30, kindOri: 'Sale',
        productId: 101, priceListIdOri: 2 },
    ],
  }

  it('valida a âncora (nascida na ABERTURA) e grava um elo por item — nunca insere âncora', async () => {
    const conn = { query: jest.fn().mockResolvedValue([{}]) }
    conn.query.mockResolvedValueOnce([[{ orderIdOri: 77 }]]) // âncora existente
    await persistReturn(conn as any, 'setes_setes', 1, 10, plan)
    const sqls = conn.query.mock.calls.map(c => c[0] as string)
    expect(sqls[0]).toContain('tb_order_stock_adjust_return')
    expect(sqls[0]).toContain('SELECT')
    expect(sqls.filter(s => s.includes('INSERT') && s.includes('tb_order_stock_adjust_return')))
      .toHaveLength(0)
    expect(sqls.filter(s => s.includes('tb_order_item_return'))).toHaveLength(2)
    expect(conn.query.mock.calls[0][1]).toEqual([10, 1])
  })

  it('âncora ausente ou apontando OUTRO pedido -> 422 (fonte única, sem insert-se-ausente)', async () => {
    const missing = { query: jest.fn().mockResolvedValueOnce([[]]) }
    await expect(persistReturn(missing as any, 'setes_setes', 1, 10, plan))
      .rejects.toMatchObject({ statusCode: 422, code: 'RETURN_INVALID' })

    const mismatch = { query: jest.fn().mockResolvedValueOnce([[{ orderIdOri: 99 }]]) }
    await expect(persistReturn(mismatch as any, 'setes_setes', 1, 10, plan))
      .rejects.toMatchObject({ statusCode: 422, code: 'RETURN_INVALID' })
  })
})
