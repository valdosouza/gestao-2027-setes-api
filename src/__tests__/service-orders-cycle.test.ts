/// <reference types="jest" />
// D-G11 (migration 047): o CICLO da OS vive em tb_service_order — a identidade
// da OS é a existência do ciclo. Fecha o vazamento apontado pelo setes-conceito:
// venda web com item de serviço (natureza sem ciclo) NÃO é alcançada pelo
// módulo de OS (DELETE/itens/faturar → 404), e a lista/abertura só olham o ciclo.
import pool from '../shared/db/connection'
import { cancelOrder, listOrders, openOrder, addItem, updateItem } from '../modules/service-orders/service-orders.repository'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn() },
}))
jest.mock('../shared/invoice', () => ({ __esModule: true, issueInvoice: jest.fn() }))
jest.mock('../shared/order-billing', () => ({ __esModule: true, upsertOrderBilling: jest.fn() }))
jest.mock('../shared/order-installment', () => ({
  __esModule: true, ...jest.requireActual('../shared/order-installment'), assertPaymentRules: jest.fn(),
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
const mockQuery = (pool as any).query as jest.Mock

function mockConn() {
  const conn = {
    beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]),
    commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
  return conn
}
beforeEach(() => jest.clearAllMocks())

describe('identidade da OS = ciclo (tb_service_order)', () => {
  it('venda com item de serviço (natureza sem ciclo) → 404 no módulo de OS, nada gravado', async () => {
    const conn = mockConn()
    conn.query.mockResolvedValueOnce([[]])   // lockOpenOrder: JOIN tb_service_order não acha
    await expect(cancelOrder(6800, 'setes_setes', 1)).rejects.toMatchObject({ statusCode: 404 })
    expect(String(conn.query.mock.calls[0][0])).toMatch(/INNER JOIN `setes_setes`\.tb_service_order c[\s\S]*FOR UPDATE/)
    expect(conn.query).toHaveBeenCalledTimes(1)
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('lista parte do CICLO e lê o tomador da natureza', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    await listOrders('A', { filter: '', page: 1, pageSize: 25, offset: 0 } as any, 'setes_setes', 1)
    const sql = String(mockQuery.mock.calls[0][0])
    expect(sql).toMatch(/FROM `setes_setes`\.tb_service_order c[\s\S]*INNER JOIN `setes_setes`\.tb_order_service s/)
    expect(sql).toMatch(/c\.number/)
    expect(sql).toMatch(/WHERE c\.tb_institution_id = \? AND c\.deleted = 'N'/)
  })

  it('Q-A17: item da OS com produto de MERCADORIA → 422 SERVICE_ORDER_ITEM_NOT_SERVICE, nada gravado', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]])       // lockOpenOrder (ciclo vivo)
      .mockResolvedValueOnce([[{ kind: 'M', active: 'S' }]])   // produto existe, mas é mercadoria
    await expect(addItem(300, { productId: 16, quantity: 1, unitValue: 10 } as any, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 422, code: 'SERVICE_ORDER_ITEM_NOT_SERVICE' })
    expect(conn.query.mock.calls.some(c => /INSERT INTO/.test(String(c[0])))).toBe(false)
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('Q-A17b: item da OS com valor 0 → 422 SERVICE_ORDER_ITEM_VALUE_REQUIRED', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]])
      .mockResolvedValueOnce([[{ kind: 'S', active: 'S' }]])
    await expect(addItem(300, { productId: 1, quantity: 1, unitValue: 0 } as any, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 422, code: 'SERVICE_ORDER_ITEM_VALUE_REQUIRED' })
    expect(conn.query.mock.calls.some(c => /INSERT INTO/.test(String(c[0])))).toBe(false)
  })

  it('Q-A20: PUT do item passa pela MESMA guarda — produto inativo → 400, mercadoria → 422, nada gravado', async () => {
    const conn = mockConn()
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]]).mockResolvedValueOnce([[{ kind: 'S', active: 'N' }]])
    await expect(updateItem(300, 1, { productId: 15, quantity: 1, unitValue: 10 } as any, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 400, code: 'ROLE_MISSING' })
    const conn2 = mockConn()
    conn2.query.mockResolvedValueOnce([[{ status: 'A' }]]).mockResolvedValueOnce([[{ kind: 'M', active: 'S' }]])
    await expect(updateItem(300, 1, { productId: 16, quantity: 1, unitValue: 10 } as any, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 422, code: 'SERVICE_ORDER_ITEM_NOT_SERVICE' })
    expect(conn2.query.mock.calls.some(c => /UPDATE `setes_setes`\.tb_order_item/.test(String(c[0])))).toBe(false)
  })

  it('abrir OS: trava D5 conferida no UNIQUE do ciclo (gap lock) e 3 INSERTs — backbone, natureza (sem nº), ciclo (nº + trava)', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([{}])                      // Q-A12: lockInstitutionCounters (1º lock)
      .mockResolvedValueOnce([[{ 1: 1 }]])              // cliente existe
      .mockResolvedValueOnce([[]])                      // nenhuma OS aberta do cliente (open_lock = '1-209')
      .mockResolvedValueOnce([[{ nextId: 7 }]])
      .mockResolvedValueOnce([[{ nextNumber: 3 }]])
    await expect(openOrder({ customerId: 209 }, 'setes_setes', 1, 7)).resolves.toBe(7)
    const calls = conn.query.mock.calls.map(c => [String(c[0]), c[1]] as const)
    expect(calls[0][0]).toMatch(/setes_central\.tb_institution WHERE id = \? FOR UPDATE/)   // Q-A12: 1º lock
    expect(calls[2][0]).toMatch(/FROM `setes_setes`\.tb_service_order[\s\S]*open_lock = CONCAT\(\?, '-', \?\)[\s\S]*FOR UPDATE/)
    expect(calls[2][1]).toEqual([1, 1, 209])
    expect(calls[4][0]).toMatch(/MAX\(number\)[\s\S]*tb_service_order[\s\S]*FOR UPDATE/)
    const nat = calls.find(c => /INSERT INTO `setes_setes`\.tb_order_service/.test(c[0]))!
    expect(nat[0]).not.toMatch(/open_lock|number/)
    expect(nat[1]).toEqual([7, 1, 209])
    const cyc = calls.find(c => /INSERT INTO `setes_setes`\.tb_service_order/.test(c[0]))!
    expect(cyc[1]).toEqual([7, 1, 3, 1, 209])
  })
})
