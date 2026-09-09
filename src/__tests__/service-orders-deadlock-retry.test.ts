/// <reference types="jest" />
// Q-A5 (3ª rodada adversarial do cancelamento, 2026-09-09): o módulo
// service-orders reexecuta em deadlock (os locks da Rodada 2 — trava D5 no
// plano do cancelamento e MAX(number_seq) na sequência 'SE' — cruzam com ele)
// e a trava D5 ocupada na hora do INSERT vira 409, nunca 500.
import pool from '../shared/db/connection'
import { openOrder, generateInvoice } from '../modules/service-orders/service-orders.repository'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
jest.mock('../shared/invoice', () => ({
  __esModule: true,
  issueInvoice: jest.fn(),
}))
jest.mock('../shared/order-billing', () => ({
  __esModule: true,
  upsertOrderBilling: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../shared/order-installment', () => ({
  __esModule: true,
  ...jest.requireActual('../shared/order-installment'),
  assertPaymentRules: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../shared/logger/logger', () => ({
  __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))
const inv = jest.requireMock('../shared/invoice') as any
const dead = () => Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK' })

function mockConn() {
  const conn = {
    beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]),
    commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
  return conn
}
beforeEach(() => jest.clearAllMocks())

describe('openOrder × contenção (Q-A5)', () => {
  it('deadlock na consulta da OS aberta → rollback e REEXECUTA; 2ª tentativa abre a OS', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([{}])                      // 1ª: lock da institution (Q-A12)
      .mockResolvedValueOnce([[{ 1: 1 }]])              // 1ª: cliente existe
      .mockRejectedValueOnce(dead())                    // 1ª: SELECT … FOR UPDATE morre (vítima)
      .mockResolvedValueOnce([{}])                      // 2ª: lock da institution
      .mockResolvedValueOnce([[{ 1: 1 }]])              // 2ª: cliente
      .mockResolvedValueOnce([[]])                      // 2ª: nenhuma OS aberta
      .mockResolvedValueOnce([[{ nextId: 7 }]])         // MAX+1 tb_order
      .mockResolvedValueOnce([[{ nextNumber: 3 }]])     // MAX+1 número da OS
    await expect(openOrder({ customerId: 209 }, 'setes_setes', 1, 7)).resolves.toBe(7)
    expect(conn.beginTransaction).toHaveBeenCalledTimes(2)
    expect(conn.rollback).toHaveBeenCalledTimes(1)
    expect(conn.commit).toHaveBeenCalledTimes(1)
    expect(conn.release).toHaveBeenCalledTimes(2)
  })

  it('trava D5 ocupada na hora do INSERT (ER_DUP_ENTRY em uk_open_per_customer) → 409 ORDER_OPEN_EXISTS, sem retry', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([{}])                      // lock da institution (Q-A12)
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ nextId: 7 }]])
      .mockResolvedValueOnce([[{ nextNumber: 3 }]])
      .mockResolvedValueOnce([{}])                      // INSERT tb_order
      .mockResolvedValueOnce([{}])                      // INSERT natureza tb_order_service
      .mockRejectedValueOnce(Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' }))  // INSERT ciclo: trava ocupada
    await expect(openOrder({ customerId: 209 }, 'setes_setes', 1, 7))
      .rejects.toMatchObject({ statusCode: 409, code: 'ORDER_OPEN_EXISTS' })
    expect(conn.beginTransaction).toHaveBeenCalledTimes(1)
    expect(conn.rollback).toHaveBeenCalledTimes(1)
  })
})

describe('generateInvoice × contenção (Q-A5)', () => {
  function attempt(conn: any) {
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]])                                                       // lockOpenOrder
      .mockResolvedValueOnce([[{ itemsQtde: 1, productQtde: 1, productValue: 150, discountValue: 0 }]]) // sums
      .mockResolvedValueOnce([{}])                                                                      // totalizer
      .mockResolvedValueOnce([[{ n: 1 }]])                                                              // itens vivos
      .mockResolvedValueOnce([[{ n: 0 }]])                                                              // Q-A20: itens válidos
      .mockResolvedValueOnce([[{ customerId: 55 }]])                                                    // cliente
  }
  const input = { dtExpiration: '2026-10-05', paymentTypeId: 6, parcels: 1 }

  it('deadlock na numeração (issueInvoice) → reexecuta a transação inteira; 2ª tentativa fatura', async () => {
    const conn = mockConn()
    attempt(conn); attempt(conn)
    inv.issueInvoice.mockRejectedValueOnce(dead()).mockResolvedValueOnce({ invoiceNumber: '12', event: 1 })
    const r = await generateInvoice(300, input, 'setes_setes', 1, 7)
    expect(r.invoiceNumber).toBe('12')
    expect(inv.issueInvoice).toHaveBeenCalledTimes(2)
    expect(conn.rollback).toHaveBeenCalledTimes(1)
    expect(conn.commit).toHaveBeenCalledTimes(1)
  })

  it('lock wait (1205) NÃO reexecuta — propaga cru para a borda mapear 409 RESOURCE_BUSY', async () => {
    const conn = mockConn()
    attempt(conn)
    inv.issueInvoice.mockRejectedValueOnce(Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT' }))
    await expect(generateInvoice(300, input, 'setes_setes', 1, 7)).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' })
    expect(inv.issueInvoice).toHaveBeenCalledTimes(1)
    expect(conn.rollback).toHaveBeenCalledTimes(1)
  })
})
