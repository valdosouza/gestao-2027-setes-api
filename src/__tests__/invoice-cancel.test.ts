/// <reference types="jest" />
// Composição @shared/invoice/invoice-cancel (prompt_cancelamento_nota.md
// D1–D17 + Q-P1..Q-P8, 2026-09-08): travar → planejar → executar.
import { cancelInvoice, buildCancelPlan } from '../shared/invoice'
import { rawServiceRow } from '../test-setup/fiscal-voice-rows'

jest.mock('../shared/financial-settlement', () => ({
  __esModule: true,
  findOpenCashierIdTx: jest.fn(),
}))
// D-F130: a porta da voz grava o ALARME quando a voz está ilegível — aqui na fronteira, sem banco
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFCANC1'), recordCrash: jest.fn().mockResolvedValue(undefined),
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
const PLAN_QUERIES = 11   // +1 (Onda 3): a voz do fisco — bloco `fiscal` (F2a A3: LINHAS da view do fiscal_api pela porta, na MESMA conexão)
function planQueries(conn: any, opts: {
  status?: string; invoice?: any[]; last?: any[]; anchor?: any[]; serviceOrder?: any[]; receipts?: any[]; payments?: any[];
  slips?: any[]; released?: any[]; returns?: any[]; fiscal?: any[];
} = {}) {
  conn.query
    .mockResolvedValueOnce([[{ status: opts.status ?? 'F' }]])                       // lock pedido
    .mockResolvedValueOnce([opts.invoice ?? [{ id: 100, number: '7', serie: '1', model: '55', value: '250.00', status: '0' }]])
    .mockResolvedValueOnce([opts.last ?? [{ lifeEvent: 1, lastEvent: 1, lastKind: 'E' }]])                   // último evento
    .mockResolvedValueOnce([opts.anchor ?? []])                                        // H1: âncora de devolução?
    .mockResolvedValueOnce([opts.serviceOrder ?? []])                                  // Q-G3: é ordem de serviço?
    .mockResolvedValueOnce([[]])                                                       // C1: lock tb_financial
    .mockResolvedValueOnce([opts.receipts ?? []])                                      // cheques R vigentes (ANTES das baixas — ordem cheque → baixa, M-1)
    .mockResolvedValueOnce([opts.payments ?? []])                                      // payments vivos
  conn.query
    .mockResolvedValueOnce([opts.slips ?? []])                                         // boletos
  if (opts.released) conn.query.mockResolvedValueOnce([opts.released])                 // D-G9: só com boleto agrupado
  conn.query.mockResolvedValueOnce([opts.returns ?? []])                               // devoluções
  conn.query.mockResolvedValueOnce([opts.fiscal ?? []])                                // Onda 3: última transmissão ao fisco (bloco fiscal)
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
      .mockResolvedValueOnce([[{ lifeEvent: 1, lastEvent: 1, lastKind: 'E' }]])
      .mockResolvedValueOnce([[{ 1: 1 }]]) // âncora existe
    await expect(cancelInvoice(conn as any, ...scope, { orderId: 6700, reason: 'erro' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_NOT_CANCELLABLE', message: expect.stringMatching(/devolu/) })
    expect(conn.query).toHaveBeenCalledTimes(4) // parou antes de travar o financeiro
  })
  it('nota já cancelada (último evento C) → 409', async () => {
    const conn = fakeConn()
    planQueries(conn, { last: [{ lifeEvent: 1, lastEvent: 2, lastKind: 'C' }] })
    await expect(cancelInvoice(conn as any, ...scope, { orderId: 100, reason: 'erro' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_NOT_CANCELLABLE' })
  })
})

describe('buildCancelPlan — bloqueios num único código (Q-P4)', () => {
  // D28 (Q-P7 da fase Primeiro Cliente, Valdo 2026-09-19 — MANTER): a mensalidade
  // que nasceu BAIXADA pela regra de recebimento bloqueia o cancelamento igual à
  // baixa manual — o plano não distingue (nem deve) baixa automática de manual, e
  // NÃO estorna em cascata como faz com o cheque em custódia. Conhecimento
  // negativo: este teste existe para ninguém "consertar" isso depois.
  it('D28: nota com baixa AUTOMÁTICA (título nasceu baixado) → bloqueio legível pelo título, nada estornado', async () => {
    const conn = fakeConn()
    planQueries(conn, {
      payments: [{ parcel: 1, event: 1, paidValue: '55.50' }],   // baixa por regra de recebimento: mesma linha de uma baixa manual
    })
    const plan = await buildCancelPlan(conn as any, 'setes_setes', 1, 7927)
    expect(plan.blocks).toEqual([expect.objectContaining({
      field: 'title', ref: '7927/1',
      message: 'Título 7927/1 tem baixa de 55.50 — estorne a baixa antes',
    })])
    expect(plan.checksToReverse).toEqual([])
    expect(plan.bankSlipsToCancel).toEqual([])
    expect(plan.commissionEntries).toEqual([])
  })

  it('H-2 (adversarial R6): devolução com âncora SOFT-DELETADA e ordem viva NÃO cancela — a guarda lê a âncora morta também', async () => {
    const conn = fakeConn()
    planQueries(conn, { anchor: [{ 1: 1 }] })
    await expect(buildCancelPlan(conn as any, 'setes_setes', 1, 7622))
      .rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_NOT_CANCELLABLE' })
    const anchorSql = String(conn.query.mock.calls[3][0])
    expect(anchorSql).toMatch(/tb_order_stock_adjust_return/)
    expect(anchorSql).not.toMatch(/deleted = 'N'/)
  })

  it('título baixado (D2), boleto liquidado (D9), cheque que TRANSITOU (D-G7a) e devolução (D10) → listados; o cheque não interfere, a BAIXA bloqueia', async () => {
    const conn = fakeConn()
    chk.isCheckEventCurrent.mockResolvedValueOnce(false)
    planQueries(conn, {
      receipts: [{ checkId: 42, event: 1, parcel: 1, paymentEvent: 1, settledCode: 106, number: 'PASS-1' }],
      payments: [{ parcel: 1, event: 1, paidValue: '40.00' }, { parcel: 2, event: 1, paidValue: '30.00' }],
      slips: [{ id: 9, lastKind: 'L' }, { id: 10, lastKind: 'E' }],
      returns: [{ id: 6700, number: '412' }],
    })
    const err = await cancelInvoice(conn as any, ...scope, { orderId: 100, reason: 'erro' }).catch(e => e)
    expect(err).toMatchObject({ statusCode: 409, code: 'INVOICE_CANCEL_BLOCKED' })
    const fields = err.fields.map((f: any) => `${f.field}:${f.ref}`)
    // D-G7a: nenhum bloco 'check' — a parcela 1 bloqueia pelo TÍTULO, apontando a tela de Baixas
    expect(fields).toEqual(['title:100/1', 'title:100/2', 'bankSlip:9', 'return:6700'])
    // passeio logado de 2026-10-14 (D-F187): a frase cita o NÚMERO da devolução que a tela mostra, não o id interno (ref segue o id)
    const ret = err.fields.find((f: any) => f.field === 'return')
    expect(ret.message).toContain('Devolução 412 aponta')
    expect(ret.message).not.toContain('6700')
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
      .mockResolvedValueOnce([[{ lifeEvent: 1, lastEvent: 1, lastKind: 'E' }]])
      .mockResolvedValueOnce([[]])                          // âncora
      .mockResolvedValueOnce([[{ customerId: 55 }]])        // tb_order_service FOR UPDATE
      .mockResolvedValueOnce([[{ id: 7001, number: '6500' }]])   // trava '1-55' ocupada por outra OS (id interno ≠ número da tela)
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])                          // Onda 3: última transmissão ao fisco
    const plan = await buildCancelPlan(conn as any, 'setes_setes', 1, 100)
    expect(plan.serviceOrder).toEqual({ openLock: '1-55' })
    expect(plan.blocks).toEqual([expect.objectContaining({ field: 'serviceOrder', ref: '7001' })])
    // passeio logado de 2026-10-14: a frase citava o id interno (8010) onde a lista mostra a OS 7373 — o NÚMERO que a tela mostra (D-F187)
    expect(plan.blocks[0].message).toContain('ordem de serviço 6500 aberta')
    expect(plan.blocks[0].message).not.toContain('7001')
    expect(String(conn.query.mock.calls[4][0])).toMatch(/tb_service_order c[\s\S]*FOR UPDATE/)
    expect(String(conn.query.mock.calls[5][0])).toMatch(/tb_service_order[\s\S]*open_lock = \?[\s\S]*FOR UPDATE/)
    expect(conn.query.mock.calls[5][1]).toEqual([1, '1-55', 100])
  })

  it('Q-G3: cancelar a nota da OS REABRE a ordem (open_lock restaurado) como último passo', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ status: 'F' }]])
      .mockResolvedValueOnce([[{ id: 100, number: '9', serie: '1', model: 'SE', value: '100.00', status: '0' }]])
      .mockResolvedValueOnce([[{ lifeEvent: 1, lastEvent: 1, lastKind: 'E' }]])
      .mockResolvedValueOnce([[]])                          // âncora
      .mockResolvedValueOnce([[{ customerId: 55 }]])        // OS
      .mockResolvedValueOnce([[]])                          // trava livre
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])                          // Onda 3: última transmissão ao fisco
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

/**
 * F2a, etapa A3 (D-F11/D-F28/D-F29/D-F109, §22.2): o bloco fiscal LÊ a voz do fisco no banco fiscal_api — a porta
 * `@shared/fiscal-voice` usa o leitor do núcleo (`readFamilyTransmissions`) na MESMA conexão da transação, depois da trava da nota,
 * escopado pela vida que o lockInvoice devolveu. O mock da conexão devolve LINHAS CRUAS da view (aliases do SELECT publicado,
 * `authority_recorded` 'S'/'N') e o mapa REAL da família as converte — a projeção também está sob teste (nota (5)).
 */
const row = (over: any = {}) => rawServiceRow({ invoiceId: 100, lifeEvent: 1, attempt: 2, ...over })
const noVoice = { lastEvent: null, lastKind: null, lastCode: null, lastSource: null, lastDh: null, lastEventAt: null }
const unrec = (over: any = {}) => row({ accessKey: null, authorityRecorded: 'N', nfseNumber: null, dhProc: null, ...over })

describe('buildCancelPlan — bloco fiscal pela voz do fiscal_api (F2a A3)', () => {
  it('NFS-e AUTORIZADA em produção → bloqueio `fiscal` (cancele no fisco primeiro); a voz é lida da VIEW do fiscal_api, na vida da nota, SEM trava e DEPOIS da trava da nota', async () => {
    const conn = fakeConn()
    planQueries(conn, { fiscal: [row()] })
    await expect(cancelInvoice(conn as any, ...scope, { orderId: 100, reason: 'erro' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_CANCEL_BLOCKED', fields: [expect.objectContaining({ field: 'fiscal', ref: '2', message: expect.stringMatching(/cancele a NFS-e no fisco primeiro/) })] })
    expect(slip.cancelBankSlip).not.toHaveBeenCalled()
    const calls = conn.query.mock.calls.map((c: any) => String(c[0]))
    const fiscalAt = calls.findIndex(q => /fiscal_api`\.vw_invoice_service_transmission/.test(q))
    expect(fiscalAt).toBe(PLAN_QUERIES - 1)
    expect(calls[fiscalAt]).toMatch(/v\.life_event = \?/)                          // D-F119: escopado pela VIDA
    expect(calls[fiscalAt]).not.toMatch(/FOR UPDATE|LOCK IN SHARE MODE/)            // o leitor do núcleo não trava (D-F121)
    expect(conn.query.mock.calls[fiscalAt][1]).toEqual(expect.arrayContaining([1, 100, 0]))
    const lockAt = calls.findIndex(q => /FROM `setes_setes`\.tb_invoice\s+WHERE id = \?[\s\S]*FOR UPDATE/.test(q))
    expect(lockAt).toBeGreaterThanOrEqual(0); expect(lockAt).toBeLessThan(fiscalAt)  // D-F121: a trava da nota vem ANTES
    expect(calls.some(q => /tb_invoice_service_transmission t\b|setes_setes`\.tb_invoice_service_transmission/.test(q))).toBe(false)   // nada das tabelas do ERP
  })
  it('Q-CA5b: NFS-e autorizada em HOMOLOGAÇÃO não bloqueia — cancelamento local direto, caminho da pendente', async () => {
    const conn = fakeConn()
    planQueries(conn, { fiscal: [row({ environment: 'H' })] })
    const plan = await buildCancelPlan(conn as any, 'setes_setes', 1, 100)
    expect(plan.blocks).toEqual([])
    expect(plan.fiscalRecord).toBe(false)
  })
  it('Q-CA5b: cancelamento em VOO (K) continua bloqueando mesmo em homologação', async () => {
    const conn = fakeConn()
    planQueries(conn, { fiscal: [row({ environment: 'H', lastKind: 'K', lastSource: 'P' })] })
    expect((await buildCancelPlan(conn as any, 'setes_setes', 1, 100)).blocks)
      .toEqual([expect.objectContaining({ field: 'fiscal', message: expect.stringMatching(/cancelamento ao fisco sem resposta/) })])
  })
  it('D-N17: N (pedido de cancelamento não consta — segue autorizada) bloqueia como A', async () => {
    const conn = fakeConn()
    planQueries(conn, { fiscal: [row({ lastKind: 'N', lastSource: 'Q' })] })
    expect((await buildCancelPlan(conn as any, 'setes_setes', 1, 100)).blocks)
      .toEqual([expect.objectContaining({ field: 'fiscal', message: expect.stringMatching(/cancele a NFS-e no fisco primeiro/) })])
  })
  it('reserva SEM voz (em voo) e S (enviado) → bloqueio `fiscal` "em andamento"', async () => {
    for (const over of [noVoice, { lastKind: 'S', lastSource: 'P', lastCode: null }]) {
      const conn = fakeConn()
      planQueries(conn, { fiscal: [unrec(over)] })
      expect((await buildCancelPlan(conn as any, 'setes_setes', 1, 100)).blocks)
        .toEqual([expect.objectContaining({ field: 'fiscal', message: expect.stringMatching(/em andamento/) })])
    }
  })
  it('R, F do envio, C do fisco e nunca transmitida → sem bloqueio fiscal (cancela local; a voz C É o caminho do efeito — D-F28)', async () => {
    for (const r of [unrec({ lastKind: 'R', lastSource: 'P' }), unrec({ lastKind: 'F', lastSource: 'P' }), row({ lastKind: 'C', lastCode: '101101', lastSource: 'P' })]) {
      const conn = fakeConn()
      planQueries(conn, { fiscal: [r] })
      expect((await buildCancelPlan(conn as any, 'setes_setes', 1, 100)).blocks).toEqual([])
    }
    const conn = fakeConn()
    planQueries(conn)
    expect((await buildCancelPlan(conn as any, 'setes_setes', 1, 100)).blocks).toEqual([])
  })
  it('D-F29/D-F109: F por CONSULTA em produção SEM o E2404 posterior → bloqueio "reconfira" (o setes-api nunca pergunta ao fisco — D-F4)', async () => {
    const conn = fakeConn()
    planQueries(conn, { fiscal: [unrec({ lastKind: 'F', lastSource: 'Q', lastEventAt: '2026-10-10 12:10:00' })] })
    expect((await buildCancelPlan(conn as any, 'setes_setes', 1, 100)).blocks)
      .toEqual([expect.objectContaining({ field: 'fiscal', message: expect.stringMatching(/reconfira a NFS-e no fisco[\s\S]*|sem-e2404/) })])
  })
  it('nota (5) — caso POSITIVO com linha real: F por consulta em produção COM o E2404 posterior à última apresentação → PROVADA, cancela local', async () => {
    const conn = fakeConn()
    planQueries(conn, { fiscal: [unrec({ lastKind: 'F', lastSource: 'Q', createdAt: '2026-10-10 12:00:00', lastEventAt: '2026-10-10 12:10:00', nfseNotGeneratedAt: '2026-10-11 08:00:00' })] })
    const plan = await buildCancelPlan(conn as any, 'setes_setes', 1, 100)
    expect(plan.blocks).toEqual([])
    expect(plan.fiscalRecord).toBe(false)
  })
  it('E2404 ANTERIOR a uma reapresentação do mesmo Id na vida (D-F97) → "reconfira" (apresentada-depois)', async () => {
    const conn = fakeConn()
    planQueries(conn, { fiscal: [
      unrec({ attempt: 1, lastKind: 'F', lastSource: 'Q', createdAt: '2026-10-10 12:00:00', lastEventAt: '2026-10-10 12:10:00', nfseNotGeneratedAt: '2026-10-10 13:00:00' }),
      unrec({ attempt: 2, lastKind: 'R', lastSource: 'P', createdAt: '2026-10-10 14:00:00', lastEventAt: '2026-10-10 14:00:05' }),
    ] })
    expect((await buildCancelPlan(conn as any, 'setes_setes', 1, 100)).blocks)
      .toEqual([expect.objectContaining({ field: 'fiscal', message: expect.stringMatching(/apresentada-depois/) })])
  })
  it('F por consulta em HOMOLOGAÇÃO não exige prova (Q-CA5b) → cancela local', async () => {
    const conn = fakeConn()
    planQueries(conn, { fiscal: [unrec({ environment: 'H', lastKind: 'F', lastSource: 'Q', lastEventAt: '2026-10-10 12:10:00' })] })
    expect((await buildCancelPlan(conn as any, 'setes_setes', 1, 100)).blocks).toEqual([])
  })
  it('irmã VIVA na vida (a vigente é a última F, mas há tentativa em voo) → "em andamento" ANTES da prova (nota (1) da F2a)', async () => {
    const conn = fakeConn()
    planQueries(conn, { fiscal: [unrec({ attempt: 1, ...noVoice }), unrec({ attempt: 2, lastKind: 'F', lastSource: 'Q', lastEventAt: '2026-10-10 12:10:00', nfseNotGeneratedAt: '2026-10-11 08:00:00' })] })
    expect((await buildCancelPlan(conn as any, 'setes_setes', 1, 100)).blocks)
      .toEqual([expect.objectContaining({ field: 'fiscal', ref: '1', message: expect.stringMatching(/em andamento/) })])
  })
  it('linha de OUTRA vida vinda da view (filtro perdido / view torta) → falha ALTO, nunca entra na decisão (D-F119)', async () => {
    const conn = fakeConn()
    planQueries(conn, { fiscal: [row({ lifeEvent: 9 })] })
    await expect(buildCancelPlan(conn as any, 'setes_setes', 1, 100)).rejects.toThrow()
  })
  it('view SEM authority_recorded (migration da família não aplicada) → falha ALTO no mapa da família (nunca "não registrada" calado)', async () => {
    const conn = fakeConn()
    const r: any = row(); delete r.authorityRecorded
    planQueries(conn, { fiscal: [r] })
    // D-F130: o mapa recusa e a PORTA tipa (503 FISCAL_VOICE_UNAVAILABLE + ref); a causa fica em causeMessage
    await expect(buildCancelPlan(conn as any, 'setes_setes', 1, 100)).rejects.toEqual(expect.objectContaining({
      statusCode: 503, code: 'FISCAL_VOICE_UNAVAILABLE', causeMessage: expect.stringMatching(/authority_recorded/),
    }))
  })
})

describe('D3/D4 — nota com REGISTRO FISCAL cancelada FICA (Q-CA1…Q-CA4, Valdo 2026-09-29)', () => {
  /** Depois do plano: MAX(event)+1 devolve 2; o resto responde vazio. */
  const execTail = (conn: any) =>
    conn.query.mockImplementation(async (sql: string) => (/MAX\(event\)/.test(String(sql)) ? [[{ nextEvent: 2 }]] : [[]]))

  it('plano: registro fiscal = isFiscalRecord da vigente (fato `authority_recorded` EM PRODUÇÃO — nota (8): nunca a chave); sem registro (R/F) ou sem transmissão = pendente', async () => {
    let conn = fakeConn(); planQueries(conn, { fiscal: [row({ lastKind: 'C', lastCode: '101101' })] })
    expect((await buildCancelPlan(conn as any, 'setes_setes', 1, 100)).fiscalRecord).toBe(true)
    conn = fakeConn(); planQueries(conn, { fiscal: [unrec({ lastKind: 'R', lastSource: 'P' })] })
    expect((await buildCancelPlan(conn as any, 'setes_setes', 1, 100)).fiscalRecord).toBe(false)
    conn = fakeConn(); planQueries(conn)
    expect((await buildCancelPlan(conn as any, 'setes_setes', 1, 100)).fiscalRecord).toBe(false)
  })

  it('Q-CA5: registro em HOMOLOGAÇÃO não é registro fiscal — cancelada segue o caminho da pendente (nota S, pedido A)', async () => {
    const conn = fakeConn()
    planQueries(conn, { fiscal: [row({ lastKind: 'C', lastCode: '101101', environment: 'H' })] })
    expect((await buildCancelPlan(conn as any, 'setes_setes', 1, 100)).fiscalRecord).toBe(false)
  })

  it('venda com registro fiscal: financeiro desfeito e evento C, mas nota/ramos/snapshots FICAM e o pedido vira C (nunca A); nenhum vínculo gravado na voz (D-F28/D-F110)', async () => {
    const conn = fakeConn()
    planQueries(conn, { fiscal: [row({ lastKind: 'C', lastCode: '101101' })] })
    execTail(conn)
    const r = await cancelInvoice(conn as any, ...scope, { orderId: 100, reason: 'Cancelada no fisco' })
    expect(r.event).toBe(2)
    const after = conn.query.mock.calls.slice(PLAN_QUERIES).map((c: any) => String(c[0]))
    expect(after[0]).toMatch(/tb_financial SET deleted = 'S'/)
    expect(after[1]).toMatch(/tb_financial_bills SET deleted = 'S'/)
    expect(after.some(q => /INSERT INTO `setes_setes`.tb_invoice_event/.test(q))).toBe(true)
    expect(after.some(q => /tb_invoice SET deleted = 'S'/.test(q))).toBe(false)
    expect(after.some(q => /tb_invoice_(merchandise|service) SET deleted = 'S'/.test(q))).toBe(false)
    expect(after.some(q => /tb_order_item_(icms|icms_fcp|ipi|ii|pis|cofins|issqn) SET deleted/.test(q))).toBe(false)
    expect(after.some(q => /tb_order SET status = 'A'/.test(q))).toBe(false)
    expect(after.some(q => /transmission/.test(q))).toBe(false)                 // o ERP não escreve a voz (nem lê de novo)
    expect(after[after.length - 1]).toMatch(/UPDATE `setes_setes`.tb_order SET status = 'C'/)
  })

  it('OS com registro fiscal: NÃO reabre (sem open_lock) e LIBERA a competência; trava D5 ocupada não bloqueia', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ status: 'F' }]])
      .mockResolvedValueOnce([[{ id: 8011, number: '6790', serie: '1', model: 'SE', value: '250.00', status: '0' }]])
      .mockResolvedValueOnce([[{ lifeEvent: 1, lastEvent: 1, lastKind: 'E' }]])
      .mockResolvedValueOnce([[]])                          // âncora
      .mockResolvedValueOnce([[{ customerId: 55 }]])        // OS
      .mockResolvedValueOnce([[{ id: 9000 }]])              // cliente JÁ tem outra OS aberta (trava ocupada)
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[rawServiceRow({ invoiceId: 8011, lifeEvent: 1, lastKind: 'C', lastCode: '101101' })]])   // voz: C registrada em P
    execTail(conn)
    const r = await cancelInvoice(conn as any, ...scope, { orderId: 8011, reason: 'Cancelada no fisco' })
    expect(r.event).toBe(2)
    const sqls = conn.query.mock.calls.map((c: any) => String(c[0]))
    expect(sqls.some(q => /tb_service_order SET open_lock/.test(q))).toBe(false)
    const rel = conn.query.mock.calls.find((c: any) => /UPDATE `setes_setes`.tb_contract_item_competence/.test(String(c[0])))!
    expect(String(rel[0])).toMatch(/SET deleted = 'S'[\s\S]*tb_order_id = \?[\s\S]*deleted = 'N'/)
    expect(rel[1]).toEqual([1, 8011])
    expect(sqls.some(q => /tb_order SET status = 'C'/.test(q))).toBe(true)
  })

  it('pendente (sem registro) segue o caminho antigo: nota S, pedido A — e a trava D5 ocupada ainda BLOQUEIA a reabertura', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ status: 'F' }]])
      .mockResolvedValueOnce([[{ id: 100, number: '9', serie: '1', model: 'SE', value: '100.00', status: '0' }]])
      .mockResolvedValueOnce([[{ lifeEvent: 1, lastEvent: 1, lastKind: 'E' }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ customerId: 55 }]])
      .mockResolvedValueOnce([[{ id: 7001 }]])
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[unrec({ lastKind: 'R', lastSource: 'P' })]])   // voz: R sem registro
    const plan = await buildCancelPlan(conn as any, 'setes_setes', 1, 100)
    expect(plan.fiscalRecord).toBe(false)
    expect(plan.blocks).toEqual([expect.objectContaining({ field: 'serviceOrder', ref: '7001' })])
  })
})
