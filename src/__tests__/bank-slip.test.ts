/// <reference types="jest" />
// Peça compartilhada do BOLETO (migration 039 — prompt_boleto_emitido.md
// D1–D11): estado derivado, emissão (gates 400/404/409, nosso número da
// carteira, vínculos + evento E), liquidação (rateio + settleBatchTx),
// cancelamento, estorno e gancho do faturamento (0/1/n carteiras).
import {
  stateFromLastEvent, issueBankSlip, settleBankSlip, cancelBankSlip,
  reverseBankSlipSettlement, tryIssueBankSlipsOnBilling,
} from '../shared/bank-slip'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
jest.mock('../shared/financial-settlement/settlement-batch', () => ({
  settleBatchTx: jest.fn().mockResolvedValue({ settledCode: 77, statementId: 90, totalValue: 0, titles: 0, paOrders: 0 }),
  reverseOnePayment: jest.fn().mockResolvedValue({ reversalEvent: 2, settledCode: 78 }),
}))
const batch = jest.requireMock('../shared/financial-settlement/settlement-batch') as any

function fakeConn() { return { query: jest.fn() } }

const DAY = 86400000
/** D-G36: a liquidação não acontece no futuro — datas dos testes são relativas a HOJE. */
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)
const TODAY = iso(0)

beforeEach(() => jest.clearAllMocks())

const AGREEMENT = {
  id: 3, bankAccountId: 1, chargeKindId: null, accept: 'N', aliqDiscount: null,
  aliqInterest: 1, aliqLate: 2, valueLateMin: null, valueFine: null, aliqFine: 2,
  valueRate: null, instruction: 'Pagar até o vencimento', protest: 'S', dayProtest: 5,
  ourNumberNext: 1000, active: 'S',
}
const TITLE = (over: Record<string, any> = {}) => ({
  orderId: 10, parcel: 1, tagValue: 100, principalPaid: 0, paymentTypeId: 6,
  dtExpiration: '2026-10-10', operation: 'C', customerId: 209, ...over,
})

describe('stateFromLastEvent', () => {
  it('E/X/vazio = open; L = settled; C = cancelled', () => {
    expect(stateFromLastEvent('E')).toBe('open')
    expect(stateFromLastEvent('X')).toBe('open')
    expect(stateFromLastEvent(null)).toBe('open')
    expect(stateFromLastEvent('L')).toBe('settled')
    expect(stateFromLastEvent('C')).toBe('cancelled')
  })
})

describe('issueBankSlip', () => {
  const base = { agreementId: 3, titles: [{ orderId: 10, parcel: 1 }] }

  it('sem títulos -> 400; título repetido -> 400 (antes do banco)', async () => {
    const conn = fakeConn()
    await expect(issueBankSlip(conn as any, 'setes_setes', 1, 7, { agreementId: 3, titles: [] }))
      .rejects.toMatchObject({ statusCode: 400, code: 'BANK_SLIP_NO_TITLES' })
    await expect(issueBankSlip(conn as any, 'setes_setes', 1, 7, {
      agreementId: 3, titles: [{ orderId: 10, parcel: 1 }, { orderId: 10, parcel: 1 }] }))
      .rejects.toMatchObject({ statusCode: 400, code: 'BANK_SLIP_DUPLICATE_TITLE' })
    expect(conn.query).not.toHaveBeenCalled()
  })

  it('carteira inexistente -> 404; inativa -> 409 (D8)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]])
    await expect(issueBankSlip(conn as any, 'setes_setes', 1, 7, base))
      .rejects.toMatchObject({ statusCode: 404, code: 'AGREEMENT_NOT_FOUND' })
    const conn2 = fakeConn()
    conn2.query.mockResolvedValueOnce([[{ ...AGREEMENT, active: 'N' }]])
    await expect(issueBankSlip(conn2 as any, 'setes_setes', 1, 7, base))
      .rejects.toMatchObject({ statusCode: 409, code: 'AGREEMENT_INACTIVE' })
  })

  it('título a PAGAR -> 409 TITLE_NOT_RECEIVABLE; quitado -> 409 TITLE_SETTLED', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[AGREEMENT]]).mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[TITLE({ operation: 'D' })]])
    await expect(issueBankSlip(conn as any, 'setes_setes', 1, 7, base))
      .rejects.toMatchObject({ statusCode: 409, code: 'TITLE_NOT_RECEIVABLE' })
    const conn2 = fakeConn()
    conn2.query
      .mockResolvedValueOnce([[AGREEMENT]]).mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[TITLE({ principalPaid: 100 })]])
    await expect(issueBankSlip(conn2 as any, 'setes_setes', 1, 7, base))
      .rejects.toMatchObject({ statusCode: 409, code: 'TITLE_SETTLED' })
  })

  it('título com boleto VIGENTE -> 409 TITLE_HAS_OPEN_SLIP (cancelado não conta); leitura TRAVANTE após o lock do título', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[AGREEMENT]]).mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[TITLE()]])
      .mockResolvedValueOnce([[{ id: 5, lastKind: 'C' }, { id: 6, lastKind: 'E' }]])
    await expect(issueBankSlip(conn as any, 'setes_setes', 1, 7, base))
      .rejects.toMatchObject({ statusCode: 409, code: 'TITLE_HAS_OPEN_SLIP' })
    expect(conn.query.mock.calls[3][0]).toContain('FOR UPDATE')
  })

  it('agrupado: clientes diferentes -> 409; sem vencimento -> 400 (D9)', async () => {
    const two = { agreementId: 3, titles: [{ orderId: 10, parcel: 1 }, { orderId: 11, parcel: 1 }] }
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[AGREEMENT]]).mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[TITLE()]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[TITLE({ orderId: 11, customerId: 300 })]]).mockResolvedValueOnce([[]])
    await expect(issueBankSlip(conn as any, 'setes_setes', 1, 7, two))
      .rejects.toMatchObject({ statusCode: 409, code: 'BANK_SLIP_MIXED_CUSTOMERS' })
    const conn2 = fakeConn()
    conn2.query
      .mockResolvedValueOnce([[AGREEMENT]]).mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[TITLE()]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[TITLE({ orderId: 11 })]]).mockResolvedValueOnce([[]])
    await expect(issueBankSlip(conn2 as any, 'setes_setes', 1, 7, two))
      .rejects.toMatchObject({ statusCode: 400, code: 'BANK_SLIP_EXPIRATION_REQUIRED' })
  })

  it('individual: nosso número da FAIXA da carteira (D3), doc = pedido-parcela, venc. do título, taxas congeladas, evento E', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[AGREEMENT]])          // carteira FOR UPDATE
      .mockResolvedValueOnce([[{ 1: 1 }]])           // conta existe
      .mockResolvedValueOnce([[TITLE({ tagValue: 150, principalPaid: 50 })]]) // título
      .mockResolvedValueOnce([[]])                   // sem boleto vigente
      .mockResolvedValueOnce([[{ nextId: 12 }]])     // id MAX+1
      .mockResolvedValueOnce([{}])                   // UPDATE our_number_next
      .mockResolvedValueOnce([{}])                   // INSERT slip
      .mockResolvedValueOnce([{}])                   // INSERT title
      .mockResolvedValueOnce([[{ nextEvent: 1 }]])   // event MAX+1
      .mockResolvedValueOnce([{}])                   // INSERT event E
    const r = await issueBankSlip(conn as any, 'setes_setes', 1, 7, base)
    expect(r).toEqual({
      id: 12, ourNumber: '1000', documentNumber: '10-1', value: 100,
      dtExpiration: '2026-10-10', titles: 1,
    })
    expect(conn.query.mock.calls[5][0]).toContain('our_number_next = our_number_next + 1')
    const slipParams = conn.query.mock.calls[6][1]
    expect(slipParams).toContain('Pagar até o vencimento') // instrução congelada
    expect(slipParams).toContain(5)                        // protest_days
    expect(conn.query.mock.calls[7][1]).toContain(100)     // value do vínculo = saldo
    expect(conn.query.mock.calls[9][1]).toContain('E')
  })

  it('HIGH adversarial R5: face do boleto = saldo pela PEÇA (principal coberto inclui juros/multa/desconto), não tag − Σ pago', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[AGREEMENT]])
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[TITLE({ tagValue: 100, principalPaid: 60 })]]) // parcial 50 @ 10 % → principal 60
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ nextId: 13 }]])
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]).mockResolvedValueOnce([{}])
    const r = await issueBankSlip(conn as any, 'setes_setes', 1, 7, base)
    expect(r.value).toBe(40)
    const titleSql = String(conn.query.mock.calls[2][0])
    expect(titleSql).toMatch(/COALESCE\(p\.discount_value, 0\)/)
    expect(titleSql).not.toMatch(/SUM\(p\.paid_value\), 0\)/)
  })

  it('carteira SEM faixa: nosso número = id; agrupado: doc = id, valor = soma dos saldos', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ ...AGREEMENT, ourNumberNext: null }]])
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[TITLE()]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[TITLE({ orderId: 11, tagValue: 50 })]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ nextId: 13 }]])
      .mockResolvedValueOnce([{}]) // INSERT slip (sem UPDATE de faixa)
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]) // 2 vínculos
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]).mockResolvedValueOnce([{}])
    const r = await issueBankSlip(conn as any, 'setes_setes', 1, 7, {
      agreementId: 3, titles: [{ orderId: 10, parcel: 1 }, { orderId: 11, parcel: 1 }],
      dtExpiration: '2026-11-05',
    })
    expect(r).toMatchObject({ id: 13, ourNumber: '13', documentNumber: '13', value: 150, titles: 2 })
    expect(conn.query.mock.calls.some(c => String(c[0]).includes('our_number_next = our_number_next'))).toBe(false)
  })
})

describe('settleBankSlip', () => {
  const slipRow = [{ id: 12, bankAccountId: 1, ourNumber: '1000', value: 150, discountValue: 0, dtDiscountUntil: null }]
  it('boleto não aberto -> 409 BANK_SLIP_NOT_OPEN; valor <= 0, 0.004 (arredonda a 0) ou > teto -> 400 antes do banco', async () => {
    const conn = fakeConn()
    for (const paidValue of [0, 0.004, -1, 1e12]) {
      await expect(settleBankSlip(conn as any, 'setes_setes', 1, 7, { slipId: 12, paidValue, dtPayment: TODAY }))
        .rejects.toMatchObject({ statusCode: 400, code: 'BANK_SLIP_INVALID_VALUE' })
    }
    expect(conn.query).not.toHaveBeenCalled()
    conn.query.mockResolvedValueOnce([slipRow]).mockResolvedValueOnce([[{ event: 2, kind: 'L', settledCode: 5 }]])
    await expect(settleBankSlip(conn as any, 'setes_setes', 1, 7, { slipId: 12, paidValue: 150, dtPayment: TODAY }))
      .rejects.toMatchObject({ statusCode: 409, code: 'BANK_SLIP_NOT_OPEN' })
  })

  it('rateia o valor RECEBIDO (líquido) na proporção do vínculo, sobra informada como juros no último, 1 settled_code, doc_reference = nosso número, evento L', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([slipRow])
      .mockResolvedValueOnce([[{ event: 1, kind: 'E', settledCode: null }]])
      .mockResolvedValueOnce([[{ orderId: 10, parcel: 1, value: 100 }, { orderId: 11, parcel: 1, value: 50 }]])
      .mockResolvedValueOnce([[{ nextEvent: 2 }]]).mockResolvedValueOnce([{}])
    const r = await settleBankSlip(conn as any, 'setes_setes', 1, 7, { slipId: 12, paidValue: 153, dtPayment: TODAY })
    expect(r).toEqual({ settledCode: 77, statementId: 90, event: 2, titles: 2 })
    const input = batch.settleBatchTx.mock.calls[0][1]
    expect(input.bankAccountId).toBe(1)
    expect(input.docReference).toBe('1000')
    expect(input.history).toContain('RECEBIMENTO BOLETO 1000')
    expect(input.allowedBankSlipId).toBe(12) // D-B1: a própria liquidação é a exceção autorizada
    // 153 rateados 100:50 -> 102 + 51 (o extrato soma 153 — juros DENTRO do statement)
    expect(input.titles).toEqual([
      // H1 (Rodada 3 do cancelamento): principal = FACE de cada título; a sobra (3) é juros
      // RATEADA (2 + 1) — cada título passa no teto D-A7 (saldo + juros informados)
      { orderId: 10, parcel: 1, interestValue: 2, lateValue: 0, discountAliquot: 0, discountValue: 0, paidValue: 102 },
      { orderId: 11, parcel: 1, interestValue: 1, lateValue: 0, discountAliquot: 0, discountValue: 0, paidValue: 51 },
    ])
    const ev = conn.query.mock.calls[4][1]
    expect(ev).toContain('L')
    expect(ev).toContain(77)
    expect(ev).toContain(153)
  })

  it('D-G30: pagar a face MENOS o desconto congelado grava o desconto na baixa (rateado) e quita — não é parcial', async () => {
    const conn = fakeConn()
    const discounted = [{ id: 13, bankAccountId: 1, ourNumber: '1001', value: 150, discountValue: 15, aliqDiscount: 10, dtDiscountUntil: iso(5) }]
    conn.query
      .mockResolvedValueOnce([discounted])
      .mockResolvedValueOnce([[{ event: 1, kind: 'E', settledCode: null }]])
      .mockResolvedValueOnce([[{ orderId: 10, parcel: 1, value: 100 }, { orderId: 11, parcel: 1, value: 50 }]])
      .mockResolvedValueOnce([[{ nextEvent: 2 }]]).mockResolvedValueOnce([{}])
    await settleBankSlip(conn as any, 'setes_setes', 1, 7, { slipId: 13, paidValue: 135, dtPayment: TODAY })
    const input = batch.settleBatchTx.mock.calls[0][1]
    // 135 pagos rateados 90 + 45; desconto honrado 15 rateado 10 + 5 → principal coberto = face
    expect(input.titles).toEqual([
      { orderId: 10, parcel: 1, interestValue: 0, lateValue: 0, discountAliquot: 10, discountValue: 10, paidValue: 90 },
      { orderId: 11, parcel: 1, interestValue: 0, lateValue: 0, discountAliquot: 10, discountValue: 5, paidValue: 45 },
    ])
  })

  it('D-G36: liquidação com dtPayment no FUTURO → 422 antes de tocar o banco (retro/pós-datar ressuscitava desconto vencido)', async () => {
    const conn = fakeConn()
    const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)
    await expect(settleBankSlip(conn as any, 'setes_setes', 1, 7, { slipId: 12, paidValue: 100, dtPayment: future }))
      .rejects.toMatchObject({ statusCode: 422, code: 'BANK_SLIP_FUTURE_PAYMENT' })
    expect(conn.query).not.toHaveBeenCalled()
  })

  it('HIGH adversarial R6: rateio com centavos (33,35 + 66,65) mantém principal + desconto = FACE em TODO título', async () => {
    const conn = fakeConn()
    const slip = [{ id: 14, bankAccountId: 1, ourNumber: '1002', value: 100, discountValue: 10, aliqDiscount: 10, dtDiscountUntil: null }]
    conn.query
      .mockResolvedValueOnce([slip])
      .mockResolvedValueOnce([[{ event: 1, kind: 'E', settledCode: null }]])
      .mockResolvedValueOnce([[{ orderId: 10, parcel: 1, value: 33.35 }, { orderId: 11, parcel: 1, value: 66.65 }]])
      .mockResolvedValueOnce([[{ nextEvent: 2 }]]).mockResolvedValueOnce([{}])
    await settleBankSlip(conn as any, 'setes_setes', 1, 7, { slipId: 14, paidValue: 90, dtPayment: TODAY })
    const titles = batch.settleBatchTx.mock.calls[0][1].titles
    const faces = [33.35, 66.65]
    titles.forEach((t: any, i: number) => {
      expect(Math.round((t.paidValue - t.interestValue + t.discountValue) * 100) / 100).toBe(faces[i])
    })
    expect(Math.round(titles.reduce((s: number, t: any) => s + t.paidValue, 0) * 100) / 100).toBe(90)
    expect(Math.round(titles.reduce((s: number, t: any) => s + t.discountValue, 0) * 100) / 100).toBe(10)
  })

  it('HIGH adversarial R6 (propriedade): para todo par (v, 100−v) em centavos, principal + desconto = face e as somas fecham', async () => {
    for (let cents = 5; cents <= 9995; cents += 7) {
      const a = Math.round(cents) / 100
      const b = Math.round(10000 - cents) / 100
      const conn = fakeConn()
      conn.query
        .mockResolvedValueOnce([[{ id: 15, bankAccountId: 1, ourNumber: '1003', value: 100, discountValue: 10, aliqDiscount: 10, dtDiscountUntil: null }]])
        .mockResolvedValueOnce([[{ event: 1, kind: 'E', settledCode: null }]])
        .mockResolvedValueOnce([[{ orderId: 10, parcel: 1, value: a }, { orderId: 11, parcel: 1, value: b }]])
        .mockResolvedValueOnce([[{ nextEvent: 2 }]]).mockResolvedValueOnce([{}])
      batch.settleBatchTx.mockClear()
      await settleBankSlip(conn as any, 'setes_setes', 1, 7, { slipId: 15, paidValue: 90, dtPayment: TODAY })
      const titles = batch.settleBatchTx.mock.calls[0][1].titles
      const faces = [a, b]
      titles.forEach((t: any, i: number) => {
        expect(Math.round((t.paidValue - t.interestValue + t.discountValue) * 100) / 100).toBe(faces[i])
        expect(t.discountValue).toBeGreaterThanOrEqual(0)
      })
      expect(Math.round(titles.reduce((s: number, t: any) => s + t.paidValue, 0) * 100) / 100).toBe(90)
    }
  })

  it('D-G30: fora do prazo do desconto (D-B2) nada é honrado — abaixo da face é 409 antes de baixar', async () => {
    const conn = fakeConn()
    const discounted = [{ id: 13, bankAccountId: 1, ourNumber: '1001', value: 150, discountValue: 15, aliqDiscount: 10, dtDiscountUntil: iso(-5) }]
    conn.query.mockResolvedValueOnce([discounted]).mockResolvedValueOnce([[{ event: 1, kind: 'E', settledCode: null }]])
    await expect(settleBankSlip(conn as any, 'setes_setes', 1, 7, { slipId: 13, paidValue: 135, dtPayment: TODAY }))
      .rejects.toMatchObject({ statusCode: 409, code: 'BANK_SLIP_BELOW_MINIMUM' })
    expect(batch.settleBatchTx).not.toHaveBeenCalled()
  })
})

describe('settleBankSlip — D-B2: mínimo aceito = face menos desconto congelado', () => {
  const slipRow = (over: Record<string, any> = {}) =>
    [{ id: 12, bankAccountId: 1, ourNumber: '1000', value: 150, discountValue: 10, dtDiscountUntil: iso(-1), ...over }]

  it('abaixo do mínimo (dentro do prazo do desconto) -> 409 BANK_SLIP_BELOW_MINIMUM', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([slipRow()]).mockResolvedValueOnce([[{ event: 1, kind: 'E', settledCode: null }]])
    await expect(settleBankSlip(conn as any, 'setes_setes', 1, 7, { slipId: 12, paidValue: 139, dtPayment: iso(-5) }))
      .rejects.toMatchObject({ statusCode: 409, code: 'BANK_SLIP_BELOW_MINIMUM' })
  })

  it('exatamente face menos desconto, dentro do prazo -> aceita', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([slipRow()]).mockResolvedValueOnce([[{ event: 1, kind: 'E', settledCode: null }]])
      .mockResolvedValueOnce([[{ orderId: 10, parcel: 1, value: 150 }]])
      .mockResolvedValueOnce([[{ nextEvent: 2 }]]).mockResolvedValueOnce([{}])
    const r = await settleBankSlip(conn as any, 'setes_setes', 1, 7, { slipId: 12, paidValue: 140, dtPayment: iso(-5) })
    expect(r.settledCode).toBe(77)
  })

  it('desconto vencido (dtPayment após dt_discount_until) -> mínimo volta a ser a face cheia', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([slipRow()]).mockResolvedValueOnce([[{ event: 1, kind: 'E', settledCode: null }]])
    await expect(settleBankSlip(conn as any, 'setes_setes', 1, 7, { slipId: 12, paidValue: 140, dtPayment: TODAY }))
      .rejects.toMatchObject({ statusCode: 409, code: 'BANK_SLIP_BELOW_MINIMUM' })
  })

  it('sem desconto congelado (discountValue 0) -> mínimo é a face inteira', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([slipRow({ discountValue: 0, dtDiscountUntil: null })])
      .mockResolvedValueOnce([[{ event: 1, kind: 'E', settledCode: null }]])
    await expect(settleBankSlip(conn as any, 'setes_setes', 1, 7, { slipId: 12, paidValue: 149, dtPayment: iso(-5) }))
      .rejects.toMatchObject({ statusCode: 409, code: 'BANK_SLIP_BELOW_MINIMUM' })
  })
})

describe('tryIssueBankSlipsOnBilling — D-B4: source automático', () => {
  it('emissão pelo faturamento grava source A (não M)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[AGREEMENT]])
      .mockResolvedValueOnce([[{ id: 6, kind: 'B' }]])
      .mockResolvedValueOnce([[AGREEMENT]]).mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[TITLE()]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ nextId: 30 }]]).mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]).mockResolvedValueOnce([{}])
    const r = await tryIssueBankSlipsOnBilling(conn as any, 'setes_setes', 1, 7, {
      orderId: 10, parcels: [{ parcel: 1, paymentTypeId: 6 }],
    })
    expect(r).toEqual({ issued: 1, slipIds: [30] })
    const eventParams = conn.query.mock.calls[11][1]
    expect(eventParams).toContain('A')
  })
})

describe('cancelBankSlip / reverseBankSlipSettlement', () => {
  const slipRow = [{ id: 12, bankAccountId: 1, ourNumber: '1000', value: 150 }]
  it('cancelar boleto liquidado -> 409; aberto -> evento C', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([slipRow]).mockResolvedValueOnce([[{ event: 2, kind: 'L', settledCode: 5 }]])
    await expect(cancelBankSlip(conn as any, 'setes_setes', 1, 7, 12, 'x'))
      .rejects.toMatchObject({ statusCode: 409, code: 'BANK_SLIP_NOT_OPEN' })
    const conn2 = fakeConn()
    conn2.query.mockResolvedValueOnce([slipRow]).mockResolvedValueOnce([[{ event: 1, kind: 'E', settledCode: null }]])
      .mockResolvedValueOnce([[{ nextEvent: 2 }]]).mockResolvedValueOnce([{}])
    expect(await cancelBankSlip(conn2 as any, 'setes_setes', 1, 7, 12, 'reemitir')).toBe(2)
    expect(conn2.query.mock.calls[3][1]).toContain('C')
  })

  it('estorno só quando o último evento é L (D10); inverte todos os payments do código e grava X com origin_event', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([slipRow]).mockResolvedValueOnce([[{ event: 1, kind: 'E', settledCode: null }]])
    await expect(reverseBankSlipSettlement(conn as any, 'setes_setes', 1, 7, 12, 'erro'))
      .rejects.toMatchObject({ statusCode: 409, code: 'BANK_SLIP_NOT_SETTLED' })
    const conn2 = fakeConn()
    conn2.query.mockResolvedValueOnce([slipRow]).mockResolvedValueOnce([[{ event: 2, kind: 'L', settledCode: 77 }]])
      .mockResolvedValueOnce([[{ orderId: 10, parcel: 1 }, { orderId: 11, parcel: 1 }]]) // vínculos
      .mockResolvedValueOnce([[{ id: 12, lastKind: 'L' }]])                              // hasOpenSlip 10/1 (só este)
      .mockResolvedValueOnce([[{ id: 12, lastKind: 'L' }]])                              // hasOpenSlip 11/1
      .mockResolvedValueOnce([[{ orderId: 10, parcel: 1, event: 1 }, { orderId: 11, parcel: 1, event: 1 }]])
      .mockResolvedValueOnce([[{ nextEvent: 3 }]]).mockResolvedValueOnce([{}])
    const r = await reverseBankSlipSettlement(conn2 as any, 'setes_setes', 1, 7, 12, 'erro')
    expect(r).toEqual({ event: 3, reversed: 2, settledCode: 78 })
    expect(batch.reverseOnePayment).toHaveBeenCalledTimes(2)
    const ev = conn2.query.mock.calls[7][1]
    expect(ev).toContain('X')
    expect(ev).toContain(2) // origin_event = evento L
  })

  it('gate adversarial: título do boleto já reemitido em OUTRO boleto vigente -> 409 BANK_SLIP_TITLE_REISSUED', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([slipRow]).mockResolvedValueOnce([[{ event: 2, kind: 'L', settledCode: 77 }]])
      .mockResolvedValueOnce([[{ orderId: 10, parcel: 1 }]])
      .mockResolvedValueOnce([[{ id: 12, lastKind: 'L' }, { id: 15, lastKind: 'E' }]])
    await expect(reverseBankSlipSettlement(conn as any, 'setes_setes', 1, 7, 12, 'erro'))
      .rejects.toMatchObject({ statusCode: 409, code: 'BANK_SLIP_TITLE_REISSUED' })
    expect(batch.reverseOnePayment).not.toHaveBeenCalled()
  })
})

describe('tryIssueBankSlipsOnBilling (gate 0/1/n — D18)', () => {
  const input = { orderId: 10, parcels: [{ parcel: 1, paymentTypeId: 6 }, { parcel: 2, paymentTypeId: 1 }] }
  it('0 carteiras -> NO_AGREEMENT; 2 -> MULTIPLE_AGREEMENTS (tela emite depois)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]])
    expect(await tryIssueBankSlipsOnBilling(conn as any, 'setes_setes', 1, 7, input))
      .toEqual({ issued: 0, reason: 'NO_AGREEMENT', slipIds: [] })
    const conn2 = fakeConn()
    conn2.query.mockResolvedValueOnce([[AGREEMENT, { ...AGREEMENT, id: 4 }]])
    expect(await tryIssueBankSlipsOnBilling(conn2 as any, 'setes_setes', 1, 7, input))
      .toEqual({ issued: 0, reason: 'MULTIPLE_AGREEMENTS', slipIds: [] })
  })
  it('1 carteira: só parcelas com forma kind=B viram boleto (1 por parcela)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[AGREEMENT]])                          // carteiras ativas
      .mockResolvedValueOnce([[{ id: 6, kind: 'B' }, { id: 1, kind: 'E' }]]) // kinds
      // issueBankSlip da parcela 1:
      .mockResolvedValueOnce([[AGREEMENT]]).mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[TITLE()]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ nextId: 20 }]]).mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]).mockResolvedValueOnce([{}])
    const r = await tryIssueBankSlipsOnBilling(conn as any, 'setes_setes', 1, 7, input)
    expect(r).toEqual({ issued: 1, slipIds: [20] })
  })
  it('nenhuma parcela em boleto -> NO_BANK_SLIP_PARCELS', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[AGREEMENT]]).mockResolvedValueOnce([[{ id: 6, kind: 'O' }, { id: 1, kind: 'E' }]])
    expect(await tryIssueBankSlipsOnBilling(conn as any, 'setes_setes', 1, 7, input))
      .toEqual({ issued: 0, reason: 'NO_BANK_SLIP_PARCELS', slipIds: [] })
  })
})
