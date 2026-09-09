/// <reference types="jest" />
// Q-G10 (Valdo 2026-09-09: "retry resolve" aceito com teste de cobertura):
// o cancelamento reexecuta a transação inteira em deadlock (1213) e NÃO
// reexecuta em lock wait (1205) — que vira 409 RESOURCE_BUSY na borda HTTP
// (Q-A3, transversal) e aqui só propaga.
import pool from '../shared/db/connection'
import { cancelOrderInvoice } from '../modules/billing/billing.service'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
jest.mock('../shared/tax-rule', () => ({ ...jest.requireActual('../shared/tax-rule'), findTaxRule: jest.fn(), loadPieces: jest.fn() }))
jest.mock('../modules/state-tax-rates/state-tax-rates.repository', () => ({
  resolveMvaAliq: jest.fn().mockResolvedValue(null), resolveFcpAliq: jest.fn().mockResolvedValue(null),
}))
jest.mock('../shared/interface-config', () => ({ getConfigContent: jest.fn().mockResolvedValue(null) }))
jest.mock('../shared/financial-settlement', () => ({
  tryAutoSettleByContract: jest.fn(), findOpenCashierIdTx: jest.fn(),
}))
jest.mock('../shared/order-return', () => ({
  buildReturnPlan: jest.fn(), getSaleOrderInfo: jest.fn(), getAnchor: jest.fn(),
  assertReturnableInTx: jest.fn(), persistReturn: jest.fn(),
}))
jest.mock('../shared/invoice', () => ({
  __esModule: true,
  issueInvoice: jest.fn(),
  cancelInvoice: jest.fn(),
}))
jest.mock('../shared/commission', () => ({
  resolveCommissionAliq: jest.fn(), getPostedItemCommissions: jest.fn(), insertCommissions: jest.fn(),
}))
jest.mock('../shared/logger/logger', () => ({
  __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))
const inv = jest.requireMock('../shared/invoice') as any

function mockConn() {
  const conn = {
    beginTransaction: jest.fn(), query: jest.fn(),
    commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
  return conn
}
const institution = { schemaName: 'setes_setes', institutionId: 1, userId: 7 } as any
beforeEach(() => jest.clearAllMocks())

describe('cancelOrderInvoice × contenção', () => {
  it('deadlock na 1ª tentativa → rollback e REEXECUTA a transação inteira; 2ª tentativa comita', async () => {
    const conn = mockConn()
    inv.cancelInvoice
      .mockRejectedValueOnce(Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK' }))
      .mockResolvedValueOnce({ orderId: 100, invoiceNumber: '7', event: 2, checksReversed: [], bankSlipsCancelled: [], releasedTitles: [], commissionsCompensated: 0 })
    const r = await cancelOrderInvoice(institution, { orderId: 100, reason: 'x' })
    expect(r.event).toBe(2)
    expect(inv.cancelInvoice).toHaveBeenCalledTimes(2)
    expect(conn.beginTransaction).toHaveBeenCalledTimes(2)
    expect(conn.rollback).toHaveBeenCalledTimes(1)
    expect(conn.commit).toHaveBeenCalledTimes(1)
    expect(conn.release).toHaveBeenCalledTimes(2)
  })

  it('deadlock persistente → desiste na 3ª tentativa e propaga o erro do banco', async () => {
    const conn = mockConn()
    inv.cancelInvoice.mockRejectedValue(Object.assign(new Error('Deadlock'), { code: 'ER_LOCK_DEADLOCK' }))
    await expect(cancelOrderInvoice(institution, { orderId: 100, reason: 'x' })).rejects.toMatchObject({ code: 'ER_LOCK_DEADLOCK' })
    expect(inv.cancelInvoice).toHaveBeenCalledTimes(3)
    expect(conn.rollback).toHaveBeenCalledTimes(3)
  })

  it('lock wait (1205) NÃO reexecuta — propaga cru para a borda HTTP mapear 409 RESOURCE_BUSY (Q-A3)', async () => {
    const conn = mockConn()
    inv.cancelInvoice.mockRejectedValueOnce(Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT' }))
    await expect(cancelOrderInvoice(institution, { orderId: 100, reason: 'x' })).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' })
    expect(inv.cancelInvoice).toHaveBeenCalledTimes(1)
    expect(conn.rollback).toHaveBeenCalledTimes(1)
  })
})
