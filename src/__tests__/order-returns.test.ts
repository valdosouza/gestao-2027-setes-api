/// <reference types="jest" />
// Módulo order-returns — devolução de mercadoria (parecer 2026-08-24):
// abertura a partir da venda FATURADA com pré-carga POR PRODUTO (saldo
// devolvível derivado), edição de quantidade com teto, cancelamento.
import pool from '../shared/db/connection'
import {
  openReturn, updateItemQuantity, cancelReturn, getReturnableProducts,
} from '../modules/order-returns/order-returns.repository'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

// as agregações da peça são testadas em commission-return.test.ts — aqui
// o módulo é orquestração: mocka a peça inteira
jest.mock('../shared/order-return', () => ({
  QTY_EPSILON: 1e-6,
  getSaleOrderInfo: jest.fn(),
  getReturnedQuantityByProduct: jest.fn().mockResolvedValue(new Map()),
  getOpenReturnQuantityByProduct: jest.fn().mockResolvedValue(new Map()),
}))

// Q-A4: condições de cobrança herdadas da venda — a peça é testada em
// order-billing.test.ts; aqui só o contrato (default: venda sem condições)
jest.mock('../shared/order-billing', () => ({
  __esModule: true,
  ...jest.requireActual('../shared/order-billing'),   // normalizeDeadline real
  getOrderBilling: jest.fn().mockResolvedValue(null),
  upsertOrderBilling: jest.fn().mockResolvedValue(undefined),
}))

const mockQuery = (pool as any).query as jest.Mock
const piece = jest.requireMock('../shared/order-return') as any
const billing = jest.requireMock('../shared/order-billing') as any

function mockConn() {
  const conn = {
    beginTransaction: jest.fn(),
    // default serve os INSERTs (resultado ignorado) e o SELECT do
    // recalcTotalizer (zeros)
    query: jest.fn().mockResolvedValue([[{ itemsQtde: 0, productQtde: 0, productValue: 0 }]]),
    commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
  return conn
}

beforeEach(() => {
  jest.clearAllMocks()
  piece.getReturnedQuantityByProduct.mockResolvedValue(new Map())
  piece.getOpenReturnQuantityByProduct.mockResolvedValue(new Map())
})

const originItem = (over: any = {}) => ({
  id: 33, productId: 100, quantity: 5, unitValue: 50, ...over,
})

describe('getReturnableProducts', () => {
  it('agrega POR PRODUTO: vendido − consumado − aberto; unit do item MAIS RECENTE', async () => {
    mockQuery.mockResolvedValueOnce([[
      originItem({ id: 30, quantity: 3, unitValue: 40 }),
      originItem({ id: 33, quantity: 5, unitValue: 50 }),
    ]])
    piece.getReturnedQuantityByProduct.mockResolvedValueOnce(new Map([[100, 2]]))
    piece.getOpenReturnQuantityByProduct.mockResolvedValueOnce(new Map([[100, 1]]))

    const result = await getReturnableProducts('setes_setes', 1, 77)
    expect(result).toEqual([
      { productId: 100, available: 5, unitValue: 50 }, // 8−2−1
    ])
  })

  it('produto com saldo zerado sai da lista', async () => {
    mockQuery.mockResolvedValueOnce([[originItem({ quantity: 2 })]])
    piece.getReturnedQuantityByProduct.mockResolvedValueOnce(new Map([[100, 2]]))
    expect(await getReturnableProducts('setes_setes', 1, 77)).toEqual([])
  })
})

describe('openReturn', () => {
  it('venda não faturada -> 422 ORIGIN_NOT_INVOICED', async () => {
    piece.getSaleOrderInfo.mockResolvedValueOnce(
      { salesmanId: 9, customerId: 55, status: 'A' })
    await expect(openReturn(77, 'setes_setes', 1, 7))
      .rejects.toMatchObject({ statusCode: 422, code: 'ORIGIN_NOT_INVOICED' })
  })

  it('venda inexistente -> 404', async () => {
    piece.getSaleOrderInfo.mockResolvedValueOnce(null)
    await expect(openReturn(77, 'setes_setes', 1, 7))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('sem saldo devolvível -> 422 NOTHING_RETURNABLE', async () => {
    piece.getSaleOrderInfo.mockResolvedValueOnce(
      { salesmanId: 9, customerId: 55, status: 'F' })
    mockQuery.mockResolvedValueOnce([[]]) // origem sem itens de mercadoria
    await expect(openReturn(77, 'setes_setes', 1, 7))
      .rejects.toMatchObject({ statusCode: 422, code: 'NOTHING_RETURNABLE' })
  })

  it('feliz: backbone + ramo E + ÂNCORA + itens pré-carregados em UMA transação', async () => {
    piece.getSaleOrderInfo.mockResolvedValueOnce(
      { salesmanId: 9, customerId: 55, status: 'F' })
    mockQuery.mockResolvedValueOnce([[originItem()]]) // origem: 5 un devolvíveis

    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([{}])                   // N2: lock da institution (1º)
      .mockResolvedValueOnce([[{ status: 'F' }]])    // Q-A1: venda relida FOR UPDATE dentro da tx
      .mockResolvedValueOnce([[{ nextId: 42 }]])     // MAX+1 tb_order
      .mockResolvedValueOnce([[{ nextNumber: 3 }]])  // MAX+1 number do ajuste
    billing.getOrderBilling.mockResolvedValueOnce({ paymentTypeId: 6, plots: 1, deadline: '030' })

    const id = await openReturn(77, 'setes_setes', 1, 7)

    expect(id).toBe(42)
    expect(conn.commit).toHaveBeenCalled()
    expect(String(conn.query.mock.calls[0][0])).toMatch(/setes_central\.tb_institution WHERE id = \? FOR UPDATE/)   // N2
    expect(String(conn.query.mock.calls[1][0])).toMatch(/FROM `setes_setes`\.tb_order[\s\S]*FOR UPDATE/)
    expect(conn.query.mock.calls[1][1]).toEqual([77, 1])
    // Q-A4: herda forma + prazo da venda para a ordem de devolução
    expect(billing.getOrderBilling).toHaveBeenCalledWith(conn, 'setes_setes', 1, 77)
    expect(billing.upsertOrderBilling).toHaveBeenCalledWith(conn, 'setes_setes', 1, 42,
      { paymentTypeId: 6, deadline: '030', plots: 1 })
    const sqls = conn.query.mock.calls.map(c => c[0] as string)
    expect(sqls.some(s => s.includes('INSERT') && s.includes('.tb_order\n'))).toBe(true)
    const adjustInsert = conn.query.mock.calls.find(c =>
      (c[0] as string).includes('INSERT') &&
      (c[0] as string).includes('tb_order_stock_adjust\n'))
    expect(adjustInsert).toBeDefined()
    expect((adjustInsert![0] as string)).toContain(`'E'`)   // direction gravada na abertura
    expect(adjustInsert![1]).toContain(55)                  // cliente DERIVADO da origem
    const anchorInsert = conn.query.mock.calls.find(c =>
      (c[0] as string).includes('INSERT') &&
      (c[0] as string).includes('tb_order_stock_adjust_return'))
    expect(anchorInsert![1]).toEqual([42, 1, 77])
    const itemInsert = conn.query.mock.calls.find(c =>
      (c[0] as string).includes('tb_order_item\n'))
    expect(itemInsert![1]).toEqual([1, 1, 42, 'Adjust', 100, 5, 50])
  })
})

describe('openReturn — Q-A1 / Q-A4 (gate adversarial do cancelamento, Valdo 2026-09-09)', () => {
  it('venda CANCELADA entre a triagem e a transação → 422 ORIGIN_NOT_INVOICED, sem INSERT, com rollback', async () => {
    piece.getSaleOrderInfo.mockResolvedValueOnce({ salesmanId: 9, customerId: 55, status: 'F' }) // triagem viu 'F'
    mockQuery.mockResolvedValueOnce([[originItem()]])
    const conn = mockConn()
    conn.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([[{ status: 'A' }]])  // lock da institution; sob lock: a nota já foi cancelada
    await expect(openReturn(77, 'setes_setes', 1, 7))
      .rejects.toMatchObject({ statusCode: 422, code: 'ORIGIN_NOT_INVOICED' })
    expect(conn.query).toHaveBeenCalledTimes(2)
    expect(conn.rollback).toHaveBeenCalled()
    expect(billing.upsertOrderBilling).not.toHaveBeenCalled()
  })

  it('prazo legado NÃO canônico na venda → não herda (Q-G15): devolução nasce sem condições', async () => {
    piece.getSaleOrderInfo.mockResolvedValueOnce({ salesmanId: 9, customerId: 55, status: 'F' })
    mockQuery.mockResolvedValueOnce([[originItem()]])
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([{}])                   // N2: lock da institution
      .mockResolvedValueOnce([[{ status: 'F' }]])
      .mockResolvedValueOnce([[{ nextId: 44 }]])
      .mockResolvedValueOnce([[{ nextNumber: 5 }]])
    billing.getOrderBilling.mockResolvedValueOnce({ paymentTypeId: 6, plots: 2, deadline: '30 DDL' })
    expect(await openReturn(77, 'setes_setes', 1, 7)).toBe(44)
    expect(billing.upsertOrderBilling).not.toHaveBeenCalled()
  })

  it('venda sem condições de cobrança (legado) → devolução nasce sem também (billing avisa depois)', async () => {
    piece.getSaleOrderInfo.mockResolvedValueOnce({ salesmanId: 9, customerId: 55, status: 'F' })
    mockQuery.mockResolvedValueOnce([[originItem()]])
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([{}])                   // N2: lock da institution
      .mockResolvedValueOnce([[{ status: 'F' }]])
      .mockResolvedValueOnce([[{ nextId: 43 }]])
      .mockResolvedValueOnce([[{ nextNumber: 4 }]])
    expect(await openReturn(77, 'setes_setes', 1, 7)).toBe(43)
    expect(billing.upsertOrderBilling).not.toHaveBeenCalled()
  })
})

describe('updateItemQuantity', () => {
  // R2 socrático: cortesia (item + teto) roda FORA da transação, via pool

  it('quantidade acima do teto (saldo excluindo esta devolução) -> 422 SEM abrir transação', async () => {
    mockQuery.mockResolvedValueOnce([[{ productId: 100, orderIdOri: 77 }]]) // item (pool)
    mockQuery.mockResolvedValueOnce([[originItem()]])                       // origem (pool)

    await expect(updateItemQuantity(42, 1, 6, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 422, code: 'RETURN_INVALID' }) // 6 > 5
    expect((pool as any).getConnection).not.toHaveBeenCalled()
  })

  it('devolução já faturada -> 409 ORDER_INVOICED', async () => {
    mockQuery.mockResolvedValueOnce([[{ productId: 100, orderIdOri: 77 }]])
    mockQuery.mockResolvedValueOnce([[originItem()]])
    const conn = mockConn()
    conn.query.mockResolvedValueOnce([[{ status: 'F' }]]) // lockOpenReturn
    await expect(updateItemQuantity(42, 1, 2, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'ORDER_INVOICED' })
  })

  it('feliz: atualiza e recalcula o totalizador', async () => {
    mockQuery.mockResolvedValueOnce([[{ productId: 100, orderIdOri: 77 }]])
    mockQuery.mockResolvedValueOnce([[originItem()]])
    const conn = mockConn()
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])  // lockOpenReturn
    conn.query.mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE
    conn.query.mockResolvedValueOnce([[{ itemsQtde: 1, productQtde: 3, productValue: 150 }]])

    await updateItemQuantity(42, 1, 3, 'setes_setes', 1)
    expect(conn.commit).toHaveBeenCalled()
    const sqls = conn.query.mock.calls.map(c => c[0] as string)
    expect(sqls.some(s => s.includes('tb_order_totalizer'))).toBe(true)
  })
})

describe('cancelReturn', () => {
  it('soft-deleta âncora + ramo + backbone na mesma transação', async () => {
    const conn = mockConn()
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])
    await cancelReturn(42, 'setes_setes', 1)
    expect(conn.commit).toHaveBeenCalled()
    const sqls = conn.query.mock.calls.map(c => c[0] as string)
    expect(sqls.some(s => s.includes('tb_order_stock_adjust_return') && s.includes("deleted = 'S'"))).toBe(true)
    expect(sqls.some(s => s.includes('tb_order_stock_adjust\n') && s.includes("deleted = 'S'"))).toBe(true)
    expect(sqls.some(s => s.includes('.tb_order SET') && s.includes("deleted = 'S'"))).toBe(true)
  })
})
