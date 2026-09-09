/// <reference types="jest" />
// Composição @shared/invoice/invoice-cancel (prompt_cancelamento_nota.md
// D1–D17 + Q-P1..Q-P8, 2026-09-08): travar → planejar → executar.
import { cancelInvoice, buildCancelPlan } from '../shared/invoice'

jest.mock('../shared/financial-settlement', () => ({
  __esModule: true,
  findOpenCashierIdTx: jest.fn(),
}))
jest.mock('../shared/bank-slip', () => ({
  __esModule: true,
  cancelBankSlip: jest.fn(),
  LAST_EVENT_KIND_SQL: (s: string, a = 'bs') => `(SELECT 'E')`,
  stateFromLastEvent: (k: string | null) => (k === 'L' ? 'settled' : k === 'C' ? 'cancelled' : 'open'),
}))
jest.mock('../shared/check', () => ({
  __esModule: true,
  reverseCheckEvent: jest.fn(),
  isCheckEventCurrent: jest.fn(),
}))
jest.mock('../shared/commission', () => ({
  __esModule: true,
  insertCommissions: jest.fn(),
  getCommissionBalanceByItem: jest.fn(),
}))

const fs = jest.requireMock('../shared/financial-settlement') as any
const slip = jest.requireMock('../shared/bank-slip') as any
const chk = jest.requireMock('../shared/check') as any
const com = jest.requireMock('../shared/commission') as any

function fakeConn() { return { query: jest.fn() } }
beforeEach(() => {
  jest.clearAllMocks()
  com.getCommissionBalanceByItem.mockResolvedValue([])
  chk.isCheckEventCurrent.mockResolvedValue(true)
  chk.reverseCheckEvent.mockResolvedValue({ event: 1, affectedCheckIds: [42] })
  com.insertCommissions.mockResolvedValue([1])
  fs.findOpenCashierIdTx.mockResolvedValue(5)
})

/** Sequência base do plano: pedido F, nota viva com E, sem cheques/baixas/boletos/devoluções. */
const PLAN_QUERIES = 10
function planQueries(conn: any, opts: {
  status?: string; invoice?: any[]; last?: any[]; anchor?: any[]; serviceOrder?: any[]; receipts?: any[]; payments?: any[];
  slips?: any[]; released?: any[]; returns?: any[];
} = {}) {
  conn.query
    .mockResolvedValueOnce([[{ status: opts.status ?? 'F' }]])                       // lock pedido
    .mockResolvedValueOnce([opts.invoice ?? [{ id: 100, number: '7', serie: '1', model: '55', value: '250.00', status: '0' }]])
    .mockResolvedValueOnce([opts.last ?? [{ event: 1, kind: 'E' }]])                   // último evento
    .mockResolvedValueOnce([opts.anchor ?? []])                                        // H1: âncora de devolução?
    .mockResolvedValueOnce([opts.serviceOrder ?? []])                                  // Q-G3: é ordem de serviço?
    .mockResolvedValueOnce([[]])                                                       // C1: lock tb_financial
    .mockResolvedValueOnce([opts.receipts ?? []])                                      // cheques R vigentes (ANTES das baixas — ordem cheque → baixa, M-1)
    .mockResolvedValueOnce([opts.payments ?? []])                                      // payments vivos
  conn.query
    .mockResolvedValueOnce([opts.slips ?? []])                                         // boletos
  if (opts.released) conn.query.mockResolvedValueOnce([opts.released])                 // D-G9: só com boleto agrupado
  conn.query.mockResolvedValueOnce([opts.returns ?? []])                               // devoluções
}

const scope = ['setes_setes', 1, 7] as const

describe('cancelInvoice — travar', () => {
  it('motivo vazio → 400 INVOICE_REASON_REQUIRED antes de qualquer leitura', async () => {
    const conn = fakeConn()
    await expect(cancelInvoice(conn as any, ...scope, { orderId: 100, reason: '   ' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVOICE_REASON_REQUIRED' })
    expect(conn.query).not.toHaveBeenCalled()
  })
  it('pedido não faturado → 409 INVOICE_NOT_CANCELLABLE', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])
    await expect(cancelInvoice(conn as any, ...scope, { orderId: 100, reason: 'erro' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_NOT_CANCELLABLE' })
  })
  it('nota sem evento (sincronizada) → 409 "cancele na origem" (Q-P1)', async () => {
    const conn = fakeConn()
    planQueries(conn, { last: [] })
    await expect(cancelInvoice(conn as any, ...scope, { orderId: 100, reason: 'erro' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_NOT_CANCELLABLE', message: expect.stringMatching(/origem/) })
  })
  it('H1/Q-G1: nota de DEVOLUÇÃO faturada (ordem adjust com âncora) → 409 INVOICE_NOT_CANCELLABLE', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{ status: 'F' }]])
      .mockResolvedValueOnce([[{ id: 6700, number: '9', serie: '1', model: '55', value: '30.00', status: '0' }]])
      .mockResolvedValueOnce([[{ event: 1, kind: 'E' }]])
      .mockResolvedValueOnce([[{ 1: 1 }]]) // âncora existe
    await expect(cancelInvoice(conn as any, ...scope, { orderId: 6700, reason: 'erro' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_NOT_CANCELLABLE', message: expect.stringMatching(/devolu/) })
    expect(conn.query).toHaveBeenCalledTimes(4) // parou antes de travar o financeiro
  })
  it('nota já cancelada (último evento C) → 409', async () => {
    const conn = fakeConn()
    planQueries(conn, { last: [{ event: 2, kind: 'C' }] })
    await expect(cancelInvoice(conn as any, ...scope, { orderId: 100, reason: 'erro' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_NOT_CANCELLABLE' })
  })
})

describe('buildCancelPlan — bloqueios num único código (Q-P4)', () => {
  it('título baixado (D2), boleto liquidado (D9), cheque que TRANSITOU (D-G7a) e devolução (D10) → listados; o cheque não interfere, a BAIXA bloqueia', async () => {
    const conn = fakeConn()
    chk.isCheckEventCurrent.mockResolvedValueOnce(false)
    planQueries(conn, {
      receipts: [{ checkId: 42, event: 1, parcel: 1, paymentEvent: 1, settledCode: 106, number: 'PASS-1' }],
      payments: [{ parcel: 1, event: 1, paidValue: '40.00' }, { parcel: 2, event: 1, paidValue: '30.00' }],
      slips: [{ id: 9, lastKind: 'L' }, { id: 10, lastKind: 'E' }],
      returns: [{ id: 6700 }],
    })
    const err = await cancelInvoice(conn as any, ...scope, { orderId: 100, reason: 'erro' }).catch(e => e)
    expect(err).toMatchObject({ statusCode: 409, code: 'INVOICE_CANCEL_BLOCKED' })
    const fields = err.fields.map((f: any) => `${f.field}:${f.ref}`)
    // D-G7a: nenhum bloco 'check' — a parcela 1 bloqueia pelo TÍTULO, apontando a tela de Baixas
    expect(fields).toEqual(['title:100/1', 'title:100/2', 'bankSlip:9', 'return:6700'])
    expect(err.fields[0].message).toMatch(/cheque que já transitou \(PASS-1\)[\s\S]*tela de Baixas/)
    expect(slip.cancelBankSlip).not.toHaveBeenCalled()
    expect(chk.reverseCheckEvent).not.toHaveBeenCalled()
  })

  it('D-G7a: grupo de 2 cheques na mesma baixa com UM que transitou → nada estornado pelo cancel; título bloqueia citando o cheque', async () => {
    const conn = fakeConn()
    chk.isCheckEventCurrent.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    planQueries(conn, {
      receipts: [
        { checkId: 42, event: 1, parcel: 1, paymentEvent: 1, settledCode: 106, number: 'A' },
        { checkId: 43, event: 1, parcel: 1, paymentEvent: 1, settledCode: 106, number: 'B' },
      ],
      payments: [{ parcel: 1, event: 1, paidValue: '70.00' }],
    })
    const plan = await buildCancelPlan(conn as any, 'setes_setes', 1, 100)
    expect(plan.checksToReverse).toEqual([])
    expect(plan.blocks).toEqual([expect.objectContaining({ field: 'title', ref: '100/1', message: expect.stringMatching(/transitou \(B\)/) })])
  })

  it('Q-A6/D-G7a: R já ESTORNADO por outra porta enquanto o plano esperava o lock (baixa morta) → pulado, sem bloqueio', async () => {
    const conn = fakeConn()
    chk.isCheckEventCurrent.mockResolvedValueOnce(false)
    planQueries(conn, {
      receipts: [{ checkId: 42, event: 1, parcel: 1, paymentEvent: 1, settledCode: 106, number: 'RACE' }],
      payments: [],                                   // a Baixas venceu: payment já 'E'
    })
    const plan = await buildCancelPlan(conn as any, 'setes_setes', 1, 100)
    expect(plan.blocks).toEqual([])
    expect(plan.checksToReverse).toEqual([])
    expect(plan.touchesCash).toBe(false)
  })

  it('D-G7a: R em custódia cuja baixa já morreu (legado) → nada a estornar, sem bloqueio — a vida do cheque segue no módulo', async () => {
    const conn = fakeConn()
    planQueries(conn, {
      receipts: [{ checkId: 42, event: 1, parcel: 1, paymentEvent: 1, settledCode: 106, number: 'HERD' }],
      payments: [], // a baixa do R (1|1) não está viva
    })
    const plan = await buildCancelPlan(conn as any, 'setes_setes', 1, 100)
    expect(plan.blocks).toEqual([])
    expect(plan.checksToReverse).toEqual([])
    expect(plan.touchesCash).toBe(false)
  })

  it('D-G9: boleto ABERTO agrupado com título de OUTRO pedido → cancela e LISTA os títulos liberados (nada em silêncio)', async () => {
    const conn = fakeConn()
    planQueries(conn, {
      slips: [{ id: 19, lastKind: 'E', otherOrders: 1 }, { id: 20, lastKind: 'E', otherOrders: 0 }],
      // 2ª leitura só quando há boleto agrupado: títulos vizinhos (FOR UPDATE)
      released: [{ bankSlipId: 19, orderId: 6661, parcel: 1 }, { bankSlipId: 19, orderId: 6661, parcel: 2 }],
    })
    const plan = await buildCancelPlan(conn as any, 'setes_setes', 1, 100)
    expect(plan.blocks).toEqual([])
    expect(plan.bankSlipsToCancel).toEqual([19, 20])
    expect(plan.releasedTitles).toEqual([
      { bankSlipId: 19, orderId: 6661, parcel: 1 }, { bankSlipId: 19, orderId: 6661, parcel: 2 },
    ])
    // a consulta de boletos conta os títulos de outros pedidos e trava
    expect(String(conn.query.mock.calls[8][0])).toMatch(/otherOrders[\s\S]*FOR UPDATE/)
    expect(conn.query.mock.calls[8][1]).toEqual([100, 1, 100])
    const rel = conn.query.mock.calls[9]
    expect(String(rel[0])).toMatch(/tb_bank_slip_title[\s\S]*tb_bank_slip_id IN \(\?\) AND tb_order_id <> \?[\s\S]*FOR UPDATE/)
    expect(rel[1]).toEqual([1, [19], 100])
  })

  it('Q-A2: nota com status fora de \'0\' (escrito fora da peça) → 409 mesmo com último evento E, sem ler mais nada', async () => {
    const conn = fakeConn()
    planQueries(conn, { invoice: [{ id: 100, number: '7', serie: '1', model: '55', value: '250.00', status: 'A' }] })
    await expect(buildCancelPlan(conn as any, 'setes_setes', 1, 100))
      .rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_NOT_CANCELLABLE', message: expect.stringMatching(/status 'A'/) })
    expect(conn.query).toHaveBeenCalledTimes(3)   // pedido, nota, último evento — nada além
  })

  it('Q-G3: ordem de SERVIÇO cujo cliente já tem OUTRA OS aberta → bloqueio serviceOrder (trava D5), sob lock', async () => {
    const conn = fakeConn()
    // a peça faz 2 leituras (OS + trava) — sequência explícita em vez do helper
    conn.query
      .mockResolvedValueOnce([[{ status: 'F' }]])
      .mockResolvedValueOnce([[{ id: 100, number: '9', serie: '1', model: 'SE', value: '100.00', status: '0' }]])
      .mockResolvedValueOnce([[{ event: 1, kind: 'E' }]])
      .mockResolvedValueOnce([[]])                          // âncora
      .mockResolvedValueOnce([[{ customerId: 55 }]])        // tb_order_service FOR UPDATE
      .mockResolvedValueOnce([[{ id: 7001 }]])              // trava '1-55' ocupada por outra OS
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
    const plan = await buildCancelPlan(conn as any, 'setes_setes', 1, 100)
    expect(plan.serviceOrder).toEqual({ openLock: '1-55' })
    expect(plan.blocks).toEqual([expect.objectContaining({ field: 'serviceOrder', ref: '7001' })])
    expect(String(conn.query.mock.calls[4][0])).toMatch(/tb_service_order c[\s\S]*FOR UPDATE/)
    expect(String(conn.query.mock.calls[5][0])).toMatch(/tb_service_order[\s\S]*open_lock = \?[\s\S]*FOR UPDATE/)
    expect(conn.query.mock.calls[5][1]).toEqual([1, '1-55', 100])
  })

  it('Q-G3: cancelar a nota da OS REABRE a ordem (open_lock restaurado) como último passo', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ status: 'F' }]])
      .mockResolvedValueOnce([[{ id: 100, number: '9', serie: '1', model: 'SE', value: '100.00', status: '0' }]])
      .mockResolvedValueOnce([[{ event: 1, kind: 'E' }]])
      .mockResolvedValueOnce([[]])                          // âncora
      .mockResolvedValueOnce([[{ customerId: 55 }]])        // OS
      .mockResolvedValueOnce([[]])                          // trava livre
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
    for (let i = 0; i < 11; i++) conn.query.mockResolvedValueOnce([{}])
    conn.query.mockResolvedValueOnce([[{ nextEvent: 2 }]]).mockResolvedValueOnce([{}])
    conn.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}])
    const r = await cancelInvoice(conn as any, ...scope, { orderId: 100, reason: 'OS errada' })
    expect(r.releasedTitles).toEqual([])
    const sqls = conn.query.mock.calls.map(c => String(c[0]))
    expect(sqls[sqls.length - 2]).toMatch(/UPDATE `setes_setes`.tb_order SET status = 'A'/)
    expect(sqls[sqls.length - 1]).toMatch(/UPDATE `setes_setes`.tb_service_order SET open_lock = \?/)
    expect(conn.query.mock.calls[conn.query.mock.calls.length - 1][1]).toEqual(['1-55', 100, 1])
  })

  it('cheque em custódia livra a baixa do R (payment do cheque não bloqueia) e vai para estorno; 1 por GRUPO', async () => {
    const conn = fakeConn()
    planQueries(conn, {
      receipts: [
        { checkId: 42, event: 1, parcel: 1, paymentEvent: 1, settledCode: 106, number: 'A' },
        { checkId: 43, event: 1, parcel: 1, paymentEvent: 1, settledCode: 106, number: 'B' },
      ],
      payments: [{ parcel: 1, event: 1, paidValue: '45.00' }],
    })
    const plan = await buildCancelPlan(conn as any, 'setes_setes', 1, 100)
    expect(plan.blocks).toEqual([])
    expect(plan.checksToReverse).toEqual([{ checkId: 42, event: 1, number: 'A' }])
    expect(plan.touchesCash).toBe(true)
  })
})

describe('cancelInvoice — executar', () => {
  it('D16: cheque a estornar sem caixa aberto → 409 NO_OPEN_CASHIER antes de gravar', async () => {
    const conn = fakeConn()
    fs.findOpenCashierIdTx.mockResolvedValueOnce(null)
    planQueries(conn, {
      receipts: [{ checkId: 42, event: 1, parcel: 1, paymentEvent: 1, settledCode: 106, number: 'A' }],
      payments: [{ parcel: 1, event: 1, paidValue: '45.00' }],
    })
    await expect(cancelInvoice(conn as any, ...scope, { orderId: 100, reason: 'erro' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'NO_OPEN_CASHIER' })
    expect(chk.reverseCheckEvent).not.toHaveBeenCalled()
    expect(conn.query).toHaveBeenCalledTimes(PLAN_QUERIES) // só o plano
  })

  it('caminho completo: cancela boleto aberto, estorna cheque, compensa comissão, soft-delete, evento C, nota S, pedido A', async () => {
    const conn = fakeConn()
    com.getCommissionBalanceByItem.mockResolvedValueOnce([
      { orderItemId: 1, orderItemKind: 'M', salesmanId: 3, customerId: 209, aliq: 5, balance: 12.5 },
    ])
    planQueries(conn, {
      receipts: [{ checkId: 42, event: 1, parcel: 1, paymentEvent: 1, settledCode: 106, number: 'A' }],
      payments: [{ parcel: 1, event: 1, paidValue: '45.00' }],
      slips: [{ id: 10, lastKind: 'E' }, { id: 11, lastKind: 'C' }],
    })
    // execução: financial S, bills S, 7 snapshots S, 2 ramos S, MAX(event)+1, INSERT C, nota S, pedido A
    for (let i = 0; i < 9; i++) conn.query.mockResolvedValueOnce([{}])
    conn.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}])
    conn.query.mockResolvedValueOnce([[{ nextEvent: 2 }]]).mockResolvedValueOnce([{}])
    conn.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}])

    const r = await cancelInvoice(conn as any, ...scope, { orderId: 100, reason: 'cliente desistiu' })
    expect(r).toEqual({
      orderId: 100, invoiceNumber: '7', event: 2, checksReversed: [42],
      bankSlipsCancelled: [10], releasedTitles: [], commissionsCompensated: 1,
    })
    expect(slip.cancelBankSlip).toHaveBeenCalledTimes(1)
    expect(slip.cancelBankSlip.mock.calls[0][4]).toBe(10)
    expect(chk.reverseCheckEvent).toHaveBeenCalledWith(conn, 'setes_setes', 1, 7,
      expect.objectContaining({ checkId: 42, event: 1 }))
    expect(com.insertCommissions.mock.calls[0][3]).toEqual([expect.objectContaining({
      kind: 'F', orderId: 100, orderItemId: 1, value: -12.5, aliq: 5,
    })])
    const sqls = conn.query.mock.calls.map(c => String(c[0]))
    // C1: o plano toma o MESMO lock dos escritores (tb_financial → payments → boletos)
    expect(sqls[4]).toMatch(/tb_service_order c[\s\S]*FOR UPDATE/)        // Q-G3/D-G11: tem CICLO de OS? (venda → vazio)
    expect(sqls[5]).toMatch(/FROM `setes_setes`.tb_financial[\s\S]*FOR UPDATE/)
    expect(sqls[6]).toMatch(/tb_check_event e[\s\S]*NOT EXISTS[\s\S]*x\.kind = 'X' AND x\.origin_event = e\.event[\s\S]*FOR UPDATE/)
    expect(sqls[7]).toMatch(/tb_financial_payment[\s\S]*FOR UPDATE/)
    expect(sqls[8]).toMatch(/tb_bank_slip_title[\s\S]*FOR UPDATE/)
    const after = sqls.slice(PLAN_QUERIES)
    expect(after[0]).toMatch(/UPDATE `setes_setes`.tb_financial SET deleted = 'S'/)
    expect(after[1]).toMatch(/tb_financial_bills SET deleted = 'S'/)
    expect(after.filter(q => /tb_order_item_(icms|icms_fcp|ipi|ii|pis|cofins|issqn) SET deleted = 'S'/.test(q))).toHaveLength(7)
    expect(after.some(q => /tb_invoice_merchandise SET deleted = 'S'/.test(q))).toBe(true)
    expect(after.some(q => /tb_invoice_service SET deleted = 'S'/.test(q))).toBe(true)
    // o vínculo de regra tributária é do PEDIDO — nunca tocado (parecer §3)
    expect(sqls.some(q => /tb_order_item_tax_rule/.test(q))).toBe(false)
    const evIns = conn.query.mock.calls.find(c => /INSERT INTO `setes_setes`.tb_invoice_event/.test(String(c[0])))!
    expect(evIns[1].slice(3, 4)).toEqual(['C'])
    expect(evIns[1][9]).toBe(1)                 // origin_event = E
    expect(evIns[1][10]).toBe('cliente desistiu')
    expect(sqls[sqls.length - 2]).toMatch(/UPDATE `setes_setes`.tb_invoice SET deleted = 'S'/)
    expect(sqls[sqls.length - 1]).toMatch(/UPDATE `setes_setes`.tb_order SET status = 'A'/)
  })

  it('sem cheque: não consulta o caixa (D16 só quando toca dinheiro)', async () => {
    const conn = fakeConn()
    planQueries(conn)
    for (let i = 0; i < 11; i++) conn.query.mockResolvedValueOnce([{}])
    conn.query.mockResolvedValueOnce([[{ nextEvent: 2 }]]).mockResolvedValueOnce([{}])
    conn.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}])
    const r = await cancelInvoice(conn as any, ...scope, { orderId: 100, reason: 'erro' })
    expect(r.checksReversed).toEqual([])
    expect(fs.findOpenCashierIdTx).not.toHaveBeenCalled()
  })
})
