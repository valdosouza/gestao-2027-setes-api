/// <reference types="jest" />
// D-G7a — reversePaymentWithChecks: a baixa é desfeita UMA vez; cada cheque
// do grupo em custódia ganha X do seu R/P; o que já transitou fica como está.
import { reversePaymentWithChecks } from '../shared/check'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn() },
}))
jest.mock('../shared/financial-settlement/settlement-batch', () => ({
  __esModule: true,
  reverseOnePayment: jest.fn(),
}))
jest.mock('../shared/financial-settlement/statement-reversal', () => ({
  __esModule: true,
  reverseStatementLines: jest.fn(),
}))
const batch = jest.requireMock('../shared/financial-settlement/settlement-batch') as any

function fakeConn() { return { query: jest.fn() } }
const check = (id: number) => [[{ id, bankId: 1, agency: '1', account: '2', number: `C${id}`, value: 70 }]]
beforeEach(() => jest.clearAllMocks())

describe('reversePaymentWithChecks', () => {
  it('baixa sem cheque → null, sem tocar a baixa', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]])
    expect(await reversePaymentWithChecks(conn as any, 'setes_setes', 1, 7, { orderId: 10, parcel: 1, paymentEvent: 1, reason: 'x' })).toBeNull()
    expect(batch.reverseOnePayment).not.toHaveBeenCalled()
    const sql = String(conn.query.mock.calls[0][0])
    expect(sql).toMatch(/e\.payment_event = \?[\s\S]*e\.kind IN \('R', 'P'\)[\s\S]*NOT EXISTS/)
    expect(sql).not.toMatch(/FOR UPDATE/)   // descoberta simples; a vigência é decidida sob lock
    expect(conn.query.mock.calls[0][1]).toEqual([1, 10, 1, 1])
  })

  it('grupo de 2 cheques: um em custódia ganha X, o depositado fica; a baixa é desfeita uma vez', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ checkId: 5, event: 1, kind: 'R' }, { checkId: 6, event: 1, kind: 'R' }]]) // membros
      .mockResolvedValueOnce(check(5)).mockResolvedValueOnce([[{ event: 1, kind: 'R', originKind: null }]]) // lockCheck 5
      .mockResolvedValueOnce([[]])                                                                       // isCheckEventCurrent 5: nada depois → em custódia
      .mockResolvedValueOnce(check(6)).mockResolvedValueOnce([[{ event: 2, kind: 'B', originKind: null }]]) // lockCheck 6
      .mockResolvedValueOnce([[{ event: 2, kind: 'B', originEvent: null }]])                                // isCheckEventCurrent 6: B vigente → transitou
      .mockResolvedValueOnce([[{ nextEvent: 2 }]]).mockResolvedValueOnce([{}])                              // X do cheque 5
    batch.reverseOnePayment.mockResolvedValueOnce({ reversalEvent: 2, settledCode: 900 })

    const r = await reversePaymentWithChecks(conn as any, 'setes_setes', 1, 7, { orderId: 10, parcel: 1, paymentEvent: 1, reason: 'engano' })

    expect(r).toEqual({ core: { reversalEvent: 2, settledCode: 900 }, checksReversed: [5], checksKept: [6] })
    expect(batch.reverseOnePayment).toHaveBeenCalledTimes(1)
    expect(batch.reverseOnePayment).toHaveBeenCalledWith(conn, 'setes_setes', 1, 7, 10, 1, 1, 'engano')
    const ins = conn.query.mock.calls.find(c => /INSERT INTO `setes_setes`\.tb_check_event/.test(String(c[0])))!
    expect(ins[1]).toEqual(expect.arrayContaining([5, 'X', 900, 1]))
    // ordem canônica: cheque (tb_check FOR UPDATE) antes de qualquer decisão
    expect(String(conn.query.mock.calls[1][0])).toMatch(/FROM `setes_setes`\.tb_check[\s\S]*FOR UPDATE/)
  })
})
