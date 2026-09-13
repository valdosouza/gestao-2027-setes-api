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
    // Q-G21/D-G28: peça única — principal coberto = paid − juros − multa + discount_value (valor gravado)
    expect(String(conn.query.mock.calls[4][0])).toMatch(/SUM\(paid_value - COALESCE\(interest_value, 0\) - COALESCE\(late_value, 0\)[\s\S]*\+ COALESCE\(discount_value, 0\)\)[\s\S]*status = 'N'[\s\S]*FOR UPDATE/)
    expect(conn.query.mock.calls[4][1]).toEqual([1, 10, 1])
  })
  it('L1: regra na PEÇA — baixa sem principal (juros + multa = pago) → 409 SETTLEMENT_NO_PRINCIPAL, qualquer porta', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ principalPaid: 0 }]])
    await expect(settleBatchTx(conn as any, batch([{ orderId: 10, parcel: 1, paidValue: 10, interestValue: 6, lateValue: 4, discountAliquot: 0 }]), 'setes_setes', 1, 7))
      .rejects.toMatchObject({ statusCode: 409, code: 'SETTLEMENT_NO_PRINCIPAL' })
  })

  it('D-G28: desconto sobre o SALDO em aberto — 2ª parcial de 40 a 10 % tem teto 36 e grava discount_value 4; 40 → 409', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
    mockRest(conn, 60)                                              // 1ª parcial já cobriu 60
    await expect(settleBatchTx(conn as any, batch([{ orderId: 10, parcel: 1, paidValue: 36, interestValue: 0, lateValue: 0, discountAliquot: 10 }]), 'setes_setes', 1, 7))
      .resolves.toBeDefined()
    const ins = conn.query.mock.calls.find(c => /INSERT INTO[\s\S]*tb_financial_payment/.test(String(c[0])))!
    expect(String(ins[0])).toMatch(/discount_value\)/)
    expect(ins[1][ins[1].length - 1]).toBe(4)                        // 40 × 10 % — não 100 × 10 %
    const conn2 = fakeConn()
    conn2.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ principalPaid: 60 }]])
    await expect(settleBatchTx(conn2 as any, batch([{ orderId: 10, parcel: 1, paidValue: 40, interestValue: 0, lateValue: 0, discountAliquot: 10 }]), 'setes_setes', 1, 7))
      .rejects.toMatchObject({ code: 'TITLE_EXCEEDS_BALANCE', fields: [{ field: 'paidValue', message: 'Máximo 36.00' }] })
  })
  it('Q-A27: juros 9,995 sobre 10 (o banco gravaria 10,00) → 409 SETTLEMENT_NO_PRINCIPAL na PEÇA', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ principalPaid: 0 }]])
    await expect(settleBatchTx(conn as any, batch([{ orderId: 10, parcel: 1, paidValue: 10, interestValue: 9.995, lateValue: 0, discountAliquot: 0 }]), 'setes_setes', 1, 7))
      .rejects.toMatchObject({ statusCode: 409, code: 'SETTLEMENT_NO_PRINCIPAL' })
    expect(conn.query.mock.calls.some(c => /INSERT INTO/.test(String(c[0])))).toBe(false)
  })
  it('Q-A27: o que valida é o que grava — INSERT recebe os valores em 2 casas (10,004 → 10,00; 0,006 → 0,01)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
    mockRest(conn, 0)
    await expect(settleBatchTx(conn as any, batch([{ orderId: 10, parcel: 1, paidValue: 10.004, interestValue: 0.006, lateValue: 0, discountAliquot: 0 }]), 'setes_setes', 1, 7))
      .resolves.toBeDefined()
    const ins = conn.query.mock.calls.find(c => /INSERT INTO[\s\S]*tb_financial_payment/.test(String(c[0])))!
    expect(ins[1][4]).toBe(0.01)   // interest_value
    expect(ins[1][7]).toBe(10)     // paid_value
  })

  it('M1 (socrático R6): linha do agrupado com caixa 0,00 coberta pelo DESCONTO passa — a regra é principal > 0, não dinheiro > 0', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 0.01, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
    mockRest(conn, 0)
    await expect(settleBatchTx(conn as any, batch([{ orderId: 10, parcel: 1, paidValue: 0, interestValue: 0, lateValue: 0, discountAliquot: 0, discountValue: 0.01 }]), 'setes_setes', 1, 7))
      .resolves.toBeDefined()
    const conn2 = fakeConn()
    conn2.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ principalPaid: 0 }]])
    await expect(settleBatchTx(conn2 as any, batch([{ orderId: 10, parcel: 1, paidValue: -1, interestValue: 0, lateValue: 0, discountAliquot: 10 }]), 'setes_setes', 1, 7))
      .rejects.toMatchObject({ code: 'SETTLEMENT_NO_PRINCIPAL' })
  })

  it('D-A28 (DECIDIDA — manter): o desconto incide sobre o SALDO de CADA ato; baixas parciais concedem desconto a cada vez (intencional, não é bug)', async () => {
    // 1ª parcial de 0,01 em título de 100 com 10 %: concede 10 % do SALDO (10,00), cobre 10,01
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
    mockRest(conn, 0)
    await expect(settleBatchTx(conn as any, batch([{ orderId: 10, parcel: 1, paidValue: 0.01, interestValue: 0, lateValue: 0, discountAliquot: 10 }]), 'setes_setes', 1, 7))
      .resolves.toBeDefined()
    const ins = conn.query.mock.calls.find(c => /INSERT INTO[\s\S]*tb_financial_payment/.test(String(c[0])))!
    expect(ins[1][ins[1].length - 1]).toBe(10)

    // 2ª parcial no MESMO título (principal já coberto 10,01): 10 % do saldo NOVO (89,99) = 9,00
    const conn2 = fakeConn()
    conn2.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextCode: 2 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
    mockRest(conn2, 10.01)
    await expect(settleBatchTx(conn2 as any, batch([{ orderId: 10, parcel: 1, paidValue: 0.01, interestValue: 0, lateValue: 0, discountAliquot: 10 }]), 'setes_setes', 1, 7))
      .resolves.toBeDefined()
    const ins2 = conn2.query.mock.calls.find(c => /INSERT INTO[\s\S]*tb_financial_payment/.test(String(c[0])))!
    expect(ins2[1][ins2[1].length - 1]).toBe(9)
    // quem contém o risco é a AUTORIDADE (teto por config + privilégio DESCONTO), não a aritmética
  })

  it('M-3 (adversarial R6): desconto que NÃO cabe no saldo → 409 DISCOUNT_EXCEEDS_BALANCE no campo discountAliquot com expected', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 10, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ principalPaid: 0 }]])
    await expect(settleBatchTx(conn as any, batch([{ orderId: 10, parcel: 1, paidValue: 0.02, interestValue: 0, lateValue: 0, discountAliquot: 99.99 }]), 'setes_setes', 1, 7))
      .rejects.toMatchObject({
        statusCode: 409, code: 'DISCOUNT_EXCEEDS_BALANCE',
        fields: [{ field: 'discountAliquot', expected: 99.9 }],
      })
    expect(conn.query.mock.calls.some(c => /INSERT INTO/.test(String(c[0])))).toBe(false)
  })

  it('D-G30: discountValue (boleto) prevalece sobre o % e é gravado; acima do saldo é limitado ao saldo', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
    mockRest(conn, 0)
    await expect(settleBatchTx(conn as any, batch([{ orderId: 10, parcel: 1, paidValue: 90, interestValue: 0, lateValue: 0, discountAliquot: 10, discountValue: 10 }]), 'setes_setes', 1, 7))
      .resolves.toBeDefined()
    const ins = conn.query.mock.calls.find(c => /INSERT INTO[\s\S]*tb_financial_payment/.test(String(c[0])))!
    expect(ins[1][ins[1].length - 1]).toBe(10)   // discount_value gravado = o VALOR congelado
    const conn2 = fakeConn()
    conn2.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 100, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ principalPaid: 95 }]])   // saldo 5; o boleto pede desconto de 10 (o título mudou embaixo dele)
    await expect(settleBatchTx(conn2 as any, batch([{ orderId: 10, parcel: 1, paidValue: 1, interestValue: 0, lateValue: 0, discountAliquot: 0, discountValue: 10 }]), 'setes_setes', 1, 7))
      .rejects.toMatchObject({ code: 'DISCOUNT_EXCEEDS_BALANCE', fields: [{ field: 'discountAliquot' }] })
  })

  it('D-G35 na PEÇA: 99,99 % de 10,00 (9,999 → 10,00 no DECIMAL) é RECUSADO — o desconto por alíquota nunca cobre o saldo', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 10, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ principalPaid: 0 }]])
    await expect(settleBatchTx(conn as any, batch([{ orderId: 10, parcel: 1, paidValue: 0.01, interestValue: 0, lateValue: 0, discountAliquot: 99.99 }]), 'setes_setes', 1, 7))
      .rejects.toMatchObject({ code: 'DISCOUNT_EXCEEDS_BALANCE', fields: [{ field: 'discountAliquot', expected: 99.9 }] })
  })

  it('D-G35: a MAIOR alíquota que cabe (99,9 % de 10,00 = 9,99) passa e quita com 0,01', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ tagValue: 10, paymentTypeId: 6, kind: 'V', operation: 'C' }]])
      .mockResolvedValueOnce([[]])
    mockRest(conn, 0)
    await expect(settleBatchTx(conn as any, batch([{ orderId: 10, parcel: 1, paidValue: 0.01, interestValue: 0, lateValue: 0, discountAliquot: 99.9 }]), 'setes_setes', 1, 7))
      .resolves.toBeDefined()
    const ins = conn.query.mock.calls.find(c => /INSERT INTO[\s\S]*tb_financial_payment/.test(String(c[0])))!
    expect(ins[1][ins[1].length - 1]).toBe(9.99)
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
