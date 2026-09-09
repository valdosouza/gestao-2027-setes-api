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
function mockRest(conn: any, principalPaid = 0) {
  conn.query
    .mockResolvedValueOnce([[{ principalPaid }]])                // Q-A7: baixas vivas do título (teto)
    .mockResolvedValueOnce([[{ nextEvent: 1 }]])                 // event
    .mockResolvedValueOnce([{}])                                 // insert payment
    .mockResolvedValueOnce([{}])                                 // update stage
    .mockResolvedValueOnce([[{ cre: 0, deb: 0 }]])                // plano do vínculo
    .mockResolvedValueOnce([[{ nextId: 5 }]])                    // statement id
    .mockResolvedValueOnce([{}])                                 // insert statement
}

describe('settleBatchTx — teto da baixa (D-A7 / TITLE_EXCEEDS_BALANCE)', () => {
  const batch = (titles: any[]) => ({ titles, bankAccountId: 0, dtPayment: '2026-09-09' } as any)
  it('2ª baixa em título QUITADO → 409 e nada gravado', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])   // Q-A18: lock da institution (regra 7)
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])                                  // sem boleto
      .mockResolvedValueOnce([[{ principalPaid: 100 }]])            // já pago inteiro
    await expect(settleBatchTx(conn as any, batch([{ orderId: 10, parcel: 1, paidValue: 100, interestValue: 0, lateValue: 0, discountAliquot: 0 }]), 'setes_setes', 1, 7))
      .rejects.toMatchObject({ statusCode: 409, code: 'TITLE_EXCEEDS_BALANCE', fields: [{ field: 'paidValue', message: 'Máximo 0.00' }] })
    expect(conn.query.mock.calls.some(c => /INSERT INTO/.test(String(c[0])))).toBe(false)
    // Q-G21: peça única — principal coberto = paid − juros − multa + desconto (tag × aliq/100)
    expect(String(conn.query.mock.calls[4][0])).toMatch(/SUM\(paid_value - COALESCE\(interest_value, 0\) - COALESCE\(late_value, 0\)[\s\S]*\? \* COALESCE\(discount_aliquot, 0\) \/ 100\)[\s\S]*status = 'N'[\s\S]*FOR UPDATE/)
    expect(conn.query.mock.calls[4][1]).toEqual([100, 1, 10, 1])
  })
  it('Q-G21: baixa COM desconto quita — 90 com 10 % passa; depois 2ª baixa de 10 → 409 (saldo 0)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])   // Q-A18: lock da institution (regra 7)
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
    mockRest(conn, 0)
    await expect(settleBatchTx(conn as any, batch([{ orderId: 10, parcel: 1, paidValue: 90, interestValue: 0, lateValue: 0, discountAliquot: 10 }]), 'setes_setes', 1, 7))
      .resolves.toBeDefined()
    const conn2 = fakeConn()
    conn2.query
      .mockResolvedValueOnce([{}])   // Q-A18: lock da institution (regra 7)
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ principalPaid: 100 }]])   // 90 − 0 − 0 + 100×10 % = 100 → quitado
    await expect(settleBatchTx(conn2 as any, batch([{ orderId: 10, parcel: 1, paidValue: 10, interestValue: 0, lateValue: 0, discountAliquot: 0 }]), 'setes_setes', 1, 7))
      .rejects.toMatchObject({ code: 'TITLE_EXCEEDS_BALANCE' })
  })
  it('baixa PARCIAL (60) e depois o resto COM juros informados (40 + 5) → passa; 46 → 409', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])   // Q-A18: lock da institution (regra 7)
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
    mockRest(conn, 60)                                              // principal já pago: 60
    await expect(settleBatchTx(conn as any, batch([{ orderId: 10, parcel: 1, paidValue: 45, interestValue: 5, lateValue: 0, discountAliquot: 0 }]), 'setes_setes', 1, 7))
      .resolves.toBeDefined()
    const conn2 = fakeConn()
    conn2.query
      .mockResolvedValueOnce([{}])   // Q-A18: lock da institution (regra 7)
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ principalPaid: 60 }]])
    await expect(settleBatchTx(conn2 as any, batch([{ orderId: 10, parcel: 1, paidValue: 46, interestValue: 5, lateValue: 0, discountAliquot: 0 }]), 'setes_setes', 1, 7))
      .rejects.toMatchObject({ code: 'TITLE_EXCEEDS_BALANCE' })
  })
})

describe('settleBatchTx — guarda D-B1 (título com boleto vigente)', () => {
  it('baixa manual (sem allowedBankSlipId) bloqueada por boleto vigente -> 409 TITLE_HAS_OPEN_SLIP', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])   // Q-A18: lock da institution (regra 7)
      .mockResolvedValueOnce([[{ nextCode: 1 }]])                          // settled_code
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]]) // título
      .mockResolvedValueOnce([[{ id: 9, lastKind: 'E' }]])                 // openSlips: boleto vigente
    await expect(settleBatchTx(conn as any, baseInput(), 'setes_setes', 1, 7))
      .rejects.toMatchObject({ statusCode: 409, code: 'TITLE_HAS_OPEN_SLIP' })
  })

  it('boleto CANCELADO ou LIQUIDADO não bloqueia (não conta como vigente)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])   // Q-A18: lock da institution (regra 7)
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
      .mockResolvedValueOnce([{}])   // Q-A18: lock da institution (regra 7)
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
      .mockResolvedValueOnce([{}])   // Q-A18: lock da institution (regra 7)
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[{ id: 9, lastKind: 'E' }]])
    await expect(settleBatchTx(conn as any, baseInput({ allowedBankSlipId: 5 }), 'setes_setes', 1, 7))
      .rejects.toMatchObject({ statusCode: 409, code: 'TITLE_HAS_OPEN_SLIP' })
  })

  it('sem nenhum boleto vinculado ao título -> passa normalmente', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])   // Q-A18: lock da institution (regra 7)
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
    mockRest(conn)
    const r = await settleBatchTx(conn as any, baseInput(), 'setes_setes', 1, 7)
    expect(r.settledCode).toBe(1)
  })
})
