/// <reference types="jest" />
// D-G7 / D-G7a do cancelamento de nota (Valdo 2026-09-09): baixa feita COM
// CHEQUE é estornada pela tela de Baixas SEMPRE — a peça do cheque desfaz a
// baixa e cancela (X) o R/P dos cheques ainda em custódia; cheque que já
// TRANSITOU não interfere em momento algum (fica como está — checksKept).
// Q-G13: settlements reexecuta em deadlock (vítima → retry).
import pool from '../shared/db/connection'
import { reverseSettlement, settleBatch } from '../modules/settlements/settlements.repository'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn() },
}))
jest.mock('../shared/financial-settlement/settlement-batch', () => ({
  __esModule: true,
  reverseOnePayment: jest.fn(),
  createPaCompensation: jest.fn(),
  generatePartnershipOrders: jest.fn(),
  settleBatchTx: jest.fn(),
}))
jest.mock('../shared/check', () => ({
  __esModule: true,
  reversePaymentWithChecks: jest.fn(),
}))
jest.mock('../shared/logger/logger', () => ({
  __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))
const batch = jest.requireMock('../shared/financial-settlement/settlement-batch') as any
const chk = jest.requireMock('../shared/check') as any

function fakeConn() {
  return {
    beginTransaction: jest.fn(), query: jest.fn(),
    commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
}
const input = { orderId: 10, parcel: 1, event: 1, reason: 'engano' } as any
beforeEach(() => jest.clearAllMocks())

describe('reverseSettlement — baixa com cheque (D-G7/D-G7a)', () => {
  it('baixa com cheques → a peça desfaz a baixa, cancela os em custódia e mantém os que transitaram', async () => {
    const conn = fakeConn()
    ;(pool as any).getConnection.mockResolvedValue(conn)
    chk.reversePaymentWithChecks.mockResolvedValueOnce({
      core: { reversalEvent: 2, settledCode: 900 }, checksReversed: [5], checksKept: [6],
    })
    conn.query.mockResolvedValueOnce([[]]) // PA orders

    const r = await reverseSettlement(input, 'setes_setes', 1, 7)

    expect(r).toEqual({ reversalEvent: 2, settledCode: 900, checksReversed: [5], checksKept: [6], paReversed: 0, paCompensated: 0 })
    expect(chk.reversePaymentWithChecks).toHaveBeenCalledWith(conn, 'setes_setes', 1, 7,
      { orderId: 10, parcel: 1, paymentEvent: 1, reason: 'engano' })
    expect(batch.reverseOnePayment).not.toHaveBeenCalled()   // a peça já desfez a baixa
    expect(conn.commit).toHaveBeenCalled()
  })

  it('baixa SEM cheque (peça devolve null) → caminho normal: reverseOnePayment', async () => {
    const conn = fakeConn()
    ;(pool as any).getConnection.mockResolvedValue(conn)
    chk.reversePaymentWithChecks.mockResolvedValueOnce(null)
    batch.reverseOnePayment.mockResolvedValueOnce({ reversalEvent: 3, settledCode: 901 })
    conn.query.mockResolvedValueOnce([[]]) // PA orders
    const r = await reverseSettlement(input, 'setes_setes', 1, 7)
    expect(r).toEqual({ reversalEvent: 3, settledCode: 901, checksReversed: [], checksKept: [], paReversed: 0, paCompensated: 0 })
    expect(batch.reverseOnePayment).toHaveBeenCalledWith(conn, 'setes_setes', 1, 7, 10, 1, 1, 'engano')
  })

  it('Q-G13: vítima de deadlock (1213) → rollback e REEXECUTA a transação; 2ª tentativa comita', async () => {
    const conn = fakeConn()
    ;(pool as any).getConnection.mockResolvedValue(conn)
    chk.reversePaymentWithChecks
      .mockRejectedValueOnce(Object.assign(new Error('Deadlock'), { code: 'ER_LOCK_DEADLOCK' }))
      .mockResolvedValueOnce(null)
    batch.reverseOnePayment.mockResolvedValueOnce({ reversalEvent: 5, settledCode: 902 })
    conn.query.mockResolvedValueOnce([[]])                       // 2ª: PA orders
    const r = await reverseSettlement(input, 'setes_setes', 1, 7)
    expect(r.settledCode).toBe(902)
    expect(conn.beginTransaction).toHaveBeenCalledTimes(2)
    expect(conn.rollback).toHaveBeenCalledTimes(1)
    expect(conn.commit).toHaveBeenCalledTimes(1)
    expect(conn.release).toHaveBeenCalledTimes(2)
  })
})

describe('reverseSettlement — cadeia PA (H2 da Rodada 3: D-G7a em TODAS as portas)', () => {
  it('baixa viva do título PA paga com cheque de terceiro (P) → a cadeia usa a peça do cheque, não reverseOnePayment direto', async () => {
    const conn = fakeConn()
    ;(pool as any).getConnection.mockResolvedValue(conn)
    chk.reversePaymentWithChecks
      .mockResolvedValueOnce(null)                                                        // baixa de origem sem cheque
      .mockResolvedValueOnce({ core: { reversalEvent: 9, settledCode: 950 }, checksReversed: [], checksKept: [77] }) // PA pago com cheque P depositado
    batch.reverseOnePayment.mockResolvedValueOnce({ reversalEvent: 3, settledCode: 901 })  // origem
    conn.query
      .mockResolvedValueOnce([[{ id: 500 }]])                        // ordem PA gerada pela baixa de origem
      .mockResolvedValueOnce([[{ parcel: 1, event: 1 }]])            // baixa viva do PA
      .mockResolvedValueOnce([[]])                                   // payables vivos do PA (compensação)
    const r = await reverseSettlement(input, 'setes_setes', 1, 7)
    expect(chk.reversePaymentWithChecks).toHaveBeenNthCalledWith(2, conn, 'setes_setes', 1, 7,
      { orderId: 500, parcel: 1, paymentEvent: 1, reason: 'Estorno em cadeia: engano' })
    expect(batch.reverseOnePayment).toHaveBeenCalledTimes(1)        // só a origem (sem cheque)
    expect(r.paReversed).toBe(1)
    expect(r.checksKept).toEqual([77])
  })
})

describe('settleBatch — retry em deadlock (Q-G13)', () => {
  it('settleBatchTx que morre em 1213 uma vez → reexecuta e devolve o resultado da 2ª', async () => {
    const conn = fakeConn()
    ;(pool as any).getConnection.mockResolvedValue(conn)
    batch.settleBatchTx
      .mockRejectedValueOnce(Object.assign(new Error('Deadlock'), { code: 'ER_LOCK_DEADLOCK' }))
      .mockResolvedValueOnce({ settledCode: 77, titles: 1 })
    const r = await settleBatch({ titles: [{ orderId: 10, parcel: 1, paidValue: 5 }] } as any, 'setes_setes', 1, 7)
    expect(r).toEqual({ settledCode: 77, titles: 1 })
    expect(batch.settleBatchTx).toHaveBeenCalledTimes(2)
    expect(conn.rollback).toHaveBeenCalledTimes(1)
    expect(conn.commit).toHaveBeenCalledTimes(1)
  })
  it('lock wait (1205) NÃO reexecuta — propaga para a borda mapear 409 (Q-A3)', async () => {
    const conn = fakeConn()
    ;(pool as any).getConnection.mockResolvedValue(conn)
    batch.settleBatchTx.mockRejectedValueOnce(Object.assign(new Error('Lock wait'), { code: 'ER_LOCK_WAIT_TIMEOUT' }))
    await expect(settleBatch({ titles: [] } as any, 'setes_setes', 1, 7)).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' })
    expect(batch.settleBatchTx).toHaveBeenCalledTimes(1)
  })
})
