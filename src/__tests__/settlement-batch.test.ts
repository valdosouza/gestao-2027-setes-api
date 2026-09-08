/// <reference types="jest" />
// Núcleo compartilhado da baixa em lote (@shared/financial-settlement/
// settlement-batch) — foco na guarda D-B1 (Rodada 2 do boleto, 2026-09-04):
// título com boleto VIGENTE não baixa por outro meio, exceto quando é a
// PRÓPRIA liquidação do boleto (allowedBankSlipId).
import { settleBatchTx } from '../shared/financial-settlement/settlement-batch'

function fakeConn() { return { query: jest.fn() } }

const baseInput = (over: Record<string, any> = {}) => ({
  titles: [{ orderId: 10, parcel: 1, interestValue: 0, lateValue: 0, discountAliquot: 0, paidValue: 100 }],
  bankAccountId: 0,
  dtPayment: '2026-09-04',
  ...over,
})

// sequência da baixa: (conta — pulada p/ bankAccountId=0), settled_code,
// [título, openSlips] por título, event, insert payment, update stage,
// [plano do vínculo — só se plan 0], statement id, insert statement
function mockRest(conn: any) {
  conn.query
    .mockResolvedValueOnce([[{ nextEvent: 1 }]])                 // event
    .mockResolvedValueOnce([{}])                                 // insert payment
    .mockResolvedValueOnce([{}])                                 // update stage
    .mockResolvedValueOnce([[{ cre: 0, deb: 0 }]])                // plano do vínculo
    .mockResolvedValueOnce([[{ nextId: 5 }]])                    // statement id
    .mockResolvedValueOnce([{}])                                 // insert statement
}

describe('settleBatchTx — guarda D-B1 (título com boleto vigente)', () => {
  it('baixa manual (sem allowedBankSlipId) bloqueada por boleto vigente -> 409 TITLE_HAS_OPEN_SLIP', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ nextCode: 1 }]])                          // settled_code
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]]) // título
      .mockResolvedValueOnce([[{ id: 9, lastKind: 'E' }]])                 // openSlips: boleto vigente
    await expect(settleBatchTx(conn as any, baseInput(), 'setes_setes', 1, 7))
      .rejects.toMatchObject({ statusCode: 409, code: 'TITLE_HAS_OPEN_SLIP' })
  })

  it('boleto CANCELADO ou LIQUIDADO não bloqueia (não conta como vigente)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[{ id: 9, lastKind: 'C' }, { id: 8, lastKind: 'L' }]])
    mockRest(conn)
    const r = await settleBatchTx(conn as any, baseInput(), 'setes_setes', 1, 7)
    expect(r.settledCode).toBe(1)
  })

  it('allowedBankSlipId = o próprio boleto vigente -> passa (liquidação do boleto)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[{ id: 9, lastKind: 'E' }]])
    mockRest(conn)
    const r = await settleBatchTx(conn as any, baseInput({ allowedBankSlipId: 9 }), 'setes_setes', 1, 7)
    expect(r.settledCode).toBe(1)
  })

  it('allowedBankSlipId de OUTRO boleto ainda bloqueia (2 boletos vigentes no mesmo título)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[{ id: 9, lastKind: 'E' }]])
    await expect(settleBatchTx(conn as any, baseInput({ allowedBankSlipId: 5 }), 'setes_setes', 1, 7))
      .rejects.toMatchObject({ statusCode: 409, code: 'TITLE_HAS_OPEN_SLIP' })
  })

  it('sem nenhum boleto vinculado ao título -> passa normalmente', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
    mockRest(conn)
    const r = await settleBatchTx(conn as any, baseInput(), 'setes_setes', 1, 7)
    expect(r.settledCode).toBe(1)
  })
})
