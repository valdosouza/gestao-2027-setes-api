/// <reference types="jest" />
// Faturamento de ordens (W2 Onda 3 — rodada R4): /validate em lote (lista
// COMPLETA + grava regra origin 'A'; 'M' nunca sobrescrita) e /invoice
// consumindo as regras gravadas (422 REQUIRES_VALIDATION sem elas).
import pool from '../shared/db/connection'
import { parseCrt, parseDeadline, addDays, adjustMva, deriveProductSt } from '../modules/billing/billing.context'
import * as repo from '../modules/billing/billing.repository'
import { validateOrder, invoiceOrder } from '../modules/billing/billing.service'
import * as taxRule from '../shared/tax-rule'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

// isola o motor (testado em tax-rules/tax-calc) — o billing orquestra
jest.mock('../shared/tax-rule', () => {
  const actual = jest.requireActual('../shared/tax-rule')
  return { ...actual, findTaxRule: jest.fn(), loadPieces: jest.fn() }
})

// isola os resolvers do catálogo MVA/FCP (testados em state-tax-rates.test)
jest.mock('../modules/state-tax-rates/state-tax-rates.repository', () => ({
  resolveMvaAliq: jest.fn().mockResolvedValue(null),
  resolveFcpAliq: jest.fn().mockResolvedValue(null),
}))

// isola o Framework de Configurações (série default '1')
jest.mock('../shared/interface-config', () => ({
  getConfigContent: jest.fn().mockResolvedValue(null),
}))

// isola a baixa automática à vista (W3.2 — testada isoladamente em
// financial-settlement.test.ts); default = não é espécie/sem baixa.
jest.mock('../shared/financial-settlement', () => ({
  tryAutoSettleCash: jest.fn().mockResolvedValue({ settled: false, reason: 'NOT_CASH' }),
}))

// isola as peças de comissão/devolução (testadas em commission-return.test.ts);
// defaults = venda sem vendedor resolvível/sem devolução — sequências antigas intactas.
jest.mock('../shared/order-return', () => ({
  buildReturnPlan: jest.fn().mockResolvedValue({ issues: [], plan: null }),
  getSaleOrderInfo: jest.fn().mockResolvedValue(null),
  getAnchor: jest.fn().mockResolvedValue(null),
  assertReturnableInTx: jest.fn().mockResolvedValue(undefined),
  persistReturn: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../shared/commission', () => ({
  resolveCommissionAliq: jest.fn().mockResolvedValue(0),
  getPostedItemCommissions: jest.fn().mockResolvedValue([]),
  insertCommissions: jest.fn().mockResolvedValue([]),
}))

const mockQuery = (pool as any).query as jest.Mock
const mockFindTaxRule = (taxRule as any).findTaxRule as jest.Mock
const mockLoadPieces = (taxRule as any).loadPieces as jest.Mock
const mockTryAutoSettleCash = (jest.requireMock('../shared/financial-settlement') as any).tryAutoSettleCash as jest.Mock
const mockOrderReturn = jest.requireMock('../shared/order-return') as any
const mockCommission = jest.requireMock('../shared/commission') as any

const inst = { institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes' }

beforeEach(() => jest.clearAllMocks())

// ---------------------------------------------------------------------
// billing.context — funções puras
// ---------------------------------------------------------------------

describe('billing.context', () => {
  it('parseCrt extrai o 1º caractere válido do rótulo', () => {
    expect(parseCrt('1 - Simples Nacional')).toBe('1')
    expect(parseCrt('3 - Regime Normal - Lucro Presumido')).toBe('3')
    expect(parseCrt('X inválido')).toBeNull()
    expect(parseCrt(null)).toBeNull()
  })

  it('parseDeadline: "028/056/084" → [28, 56, 84]; vazio = à vista', () => {
    expect(parseDeadline('028/056/084')).toEqual([28, 56, 84])
    expect(parseDeadline('30')).toEqual([30])
    expect(parseDeadline('')).toEqual([0])
    expect(parseDeadline(null)).toEqual([0])
  })

  it('addDays soma dias em formato YYYY-MM-DD', () => {
    expect(addDays(new Date('2026-08-20T12:00:00Z'), 28)).toBe('2026-09-17')
  })

  it('adjustMva aplica a fórmula P2.7 quando intra > inter', () => {
    // MVA 40%, inter 12, intra 18: (1.4 × 88/82 − 1) × 100 = 50.2439
    expect(adjustMva(40, 12, 18)).toBeCloseTo(50.2439, 3)
  })

  it('adjustMva mantém a original quando intra ≤ inter', () => {
    expect(adjustMva(40, 18, 12)).toBe(40)
    expect(adjustMva(40, 18, 18)).toBe(40)
  })

  it('deriveProductSt: CEST presente = produto ST', () => {
    expect(deriveProductSt('0100100')).toBe('S')
    expect(deriveProductSt('')).toBe('N')
    expect(deriveProductSt(null)).toBe('N')
  })
})

// ---------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------

describe('billing.repository', () => {
  it('getOrderBranch identifica venda (direction S)', async () => {
    mockQuery.mockResolvedValueOnce([[{ entityId: 55 }]])
    const branch = await repo.getOrderBranch('setes_setes', 1, 10)
    expect(branch).toEqual({ branch: 'sale', recipientEntityId: 55, direction: 'S' })
  })

  it('getOrderBranch identifica compra (direction E) depois de venda vazia', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ entityId: 90 }]])
    const branch = await repo.getOrderBranch('setes_setes', 1, 10)
    expect(branch).toEqual({ branch: 'purchase', recipientEntityId: 90, direction: 'E' })
  })

  it('getOrderBranch devolve null sem nenhum ramo', async () => {
    mockQuery
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
    expect(await repo.getOrderBranch('setes_setes', 1, 10)).toBeNull()
  })

  it('upsertItemRuleAuto preserva origin M no ON DUPLICATE (IF origin=M)', async () => {
    mockQuery.mockResolvedValueOnce([{}])
    await repo.upsertItemRuleAuto('setes_setes', 1, 10, 3, 'Sale', 42, '5102')
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain("IF(origin = 'M', tb_tax_rule_id, VALUES(tb_tax_rule_id))")
    expect(mockQuery.mock.calls[0][1]).toEqual([10, 3, 1, 'Sale', 42, '5102'])
  })
})

// ---------------------------------------------------------------------
// Service — validateOrder
// ---------------------------------------------------------------------

function mockOrderBase(status = 'A') {
  // getOrderStatus
  mockQuery.mockResolvedValueOnce([[{ status }]])
}

function mockBranchSale(entityId = 55) {
  mockQuery.mockResolvedValueOnce([[{ entityId }]]) // tb_order_sale
}

function mockContext(over: {
  emitterRegime?: string; recipientRegime?: string | null
  emitterState?: number | null; recipientState?: number | null
} = {}) {
  // loadContext: getEntityTax(emitter) → getEntityLocation(emitter)
  //            → getEntityTax(recipient) → getEntityLocation(recipient)
  mockQuery.mockResolvedValueOnce([[{
    consumer: 'N', taxRegime: over.emitterRegime ?? '3 - Regime Normal',
    byPassSt: 'N', indIeDest: '1', issRetido: 'N',
  }]])
  mockQuery.mockResolvedValueOnce([[{
    stateId: over.emitterState === undefined ? 41 : over.emitterState,
    cityId: 1, cityIssAliq: 5,
  }]])
  mockQuery.mockResolvedValueOnce(
    over.recipientRegime === null ? [[]] : [[{
      consumer: 'N', taxRegime: over.recipientRegime ?? '3 - Regime Normal',
      byPassSt: 'N', indIeDest: '1', issRetido: 'N',
    }]])
  mockQuery.mockResolvedValueOnce([[{
    stateId: over.recipientState === undefined ? 41 : over.recipientState,
    cityId: 2, cityIssAliq: 3,
  }]])
}

const itemRow = (over: any = {}) => ({
  id: 1, kind: 'Sale', productId: 100, quantity: 2, unitValue: 50,
  discountValue: 0, productKind: 'P', ncm: '84713012', origin: '0',
  cest: '', kind_tributary: '1', purpose: '1', ...over,
})

describe('validateOrder', () => {
  it('ordem já faturada -> 409', async () => {
    mockOrderBase('F')
    await expect(validateOrder(inst as any, { orderId: 10 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ORDER_INVOICED' })
  })

  it('empilha TODAS as issues (não para na primeira) e grava regra achada', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    // listBillingItems: 2 itens — um sem NCM, outro ok
    mockQuery.mockResolvedValueOnce([[
      itemRow({ id: 1, ncm: null }),
      itemRow({ id: 2 }),
    ]])
    // getItemRuleLinks: nenhum
    mockQuery.mockResolvedValueOnce([[]])
    // findTaxRule: item 1 sem regra, item 2 acha
    mockFindTaxRule
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 42, cfopId: '5102' })
    // clearAutoRuleLink do item 1 + upsert do item 2
    mockQuery.mockResolvedValueOnce([{}])
    mockQuery.mockResolvedValueOnce([{}])

    const report = await validateOrder(inst as any, { orderId: 10 })

    expect(report.issues.length).toBe(2) // ncm ausente + regra ausente do item 1
    expect(report.issues.some(i => i.field === 'ncm' && i.itemId === 1)).toBe(true)
    expect(report.issues.some(i => i.field === 'taxRule' && i.itemId === 1)).toBe(true)
    expect(report.rulesResolved).toBe(1)

    // gate A5: match que falhou LIMPA o link automático antigo do item
    const clearCall = mockQuery.mock.calls.find(c =>
      (c[0] as string).includes("origin = 'A'") && (c[0] as string).includes("SET deleted = 'S'"))
    expect(clearCall).toBeDefined()
  })

  it('linha manual (M) é respeitada — motor não roda para o item', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 99, cfopId: '5405',
      setFinancial: 'S', origin: 'M',
    }]])

    const report = await validateOrder(inst as any, { orderId: 10 })

    expect(mockFindTaxRule).not.toHaveBeenCalled()
    expect(report.rulesManual).toBe(1)
    expect(report.issues).toEqual([])
  })

  // D42 — regra casada precisa do código do regime VIGENTE do emitente
  it('D42: emitente Simples + regra só-CST -> issue e link NÃO gravado', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ emitterRegime: '1 - Simples Nacional' })
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]]) // itens
    mockQuery.mockResolvedValueOnce([[]])                   // links
    mockFindTaxRule.mockResolvedValueOnce({ id: 42, cfopId: '5102' })
    mockLoadPieces.mockResolvedValueOnce({ icms: { cstNr: '00', csosn: null } })
    mockQuery.mockResolvedValueOnce([{}]) // clearAutoRuleLink

    const report = await validateOrder(inst as any, { orderId: 10 })

    expect(report.rulesResolved).toBe(0)
    expect(report.issues.some(i => i.field === 'taxRule' && i.itemId === 1
      && i.message.includes('sem CSOSN'))).toBe(true)
    // link automático limpo (sem link o /invoice devolve REQUIRES_VALIDATION)
    const clearCall = mockQuery.mock.calls.find(c =>
      (c[0] as string).includes("origin = 'A'") && (c[0] as string).includes("SET deleted = 'S'"))
    expect(clearCall).toBeDefined()
    // e NENHUM upsert de link aconteceu
    const upsertCall = mockQuery.mock.calls.find(c =>
      (c[0] as string).includes('tb_order_item_has_tax_rule') && (c[0] as string).includes('INSERT'))
    expect(upsertCall).toBeUndefined()
  })

  it('D42: emitente Normal + regra só-CSOSN -> issue pedindo CST', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ emitterRegime: '3 - Regime Normal - Lucro Real' })
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[]])
    mockFindTaxRule.mockResolvedValueOnce({ id: 42, cfopId: '5102' })
    mockLoadPieces.mockResolvedValueOnce({ icms: { cstNr: null, csosn: '102' } })
    mockQuery.mockResolvedValueOnce([{}]) // clearAutoRuleLink

    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues.some(i => i.field === 'taxRule'
      && i.message.includes('sem CST'))).toBe(true)
  })

  it('D42: RegraDireta (M) incompleta p/ o regime gera issue mas o vínculo permanece', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ emitterRegime: '1 - Simples Nacional' })
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 99, cfopId: '5405',
      setFinancial: 'S', origin: 'M',
    }]])
    mockLoadPieces.mockResolvedValueOnce({ icms: { cstNr: '60', csosn: null } })

    const report = await validateOrder(inst as any, { orderId: 10 })

    expect(report.rulesManual).toBe(1)
    expect(mockFindTaxRule).not.toHaveBeenCalled()
    expect(report.issues.some(i => i.field === 'taxRule' && i.itemId === 1
      && i.message.includes('99'))).toBe(true)
  })

  it('D42: regra completa p/ o regime segue normal (Simples + CSOSN presente)', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ emitterRegime: '1 - Simples Nacional' })
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[]])
    mockFindTaxRule.mockResolvedValueOnce({ id: 42, cfopId: '5102' })
    mockLoadPieces.mockResolvedValueOnce({ icms: { cstNr: null, csosn: '102' } })
    mockQuery.mockResolvedValueOnce([{}]) // upsert

    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.rulesResolved).toBe(1)
    expect(report.issues).toEqual([])
  })

  it('emitente Simples (CRT 1) NÃO gera issue — CSOSN implementado (P2.9)', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ emitterRegime: '1 - Simples Nacional' })
    mockQuery.mockResolvedValueOnce([[]]) // sem itens
    mockQuery.mockResolvedValueOnce([[]]) // sem links

    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues.some(i => i.scope === 'emitter')).toBe(false)
  })

  it('ordem de ajuste sem adjustment -> issue de order', async () => {
    mockOrderBase()
    // branch: sale vazio, purchase vazio, adjust presente
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[{ entityId: 55, direction: 'S' }]])
    mockContext()
    mockQuery.mockResolvedValueOnce([[]]) // itens
    mockQuery.mockResolvedValueOnce([[]]) // links

    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.branch).toBe('adjust')
    expect(report.issues.some(i => i.field === 'adjustment')).toBe(true)
  })
})

// ---------------------------------------------------------------------
// Service — invoiceOrder
// ---------------------------------------------------------------------

describe('invoiceOrder', () => {
  it('item de mercadoria sem regra gravada -> 422 REQUIRES_VALIDATION', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]]) // itens
    mockQuery.mockResolvedValueOnce([[]])                   // links vazios

    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'REQUIRES_VALIDATION' })
  })

  it('pendência de cadastro (destinatário sem UF) -> 422 antes de tudo', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ recipientState: null })
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'REQUIRES_VALIDATION' })
  })

  it('fatura feliz: calcula, monta parcelas do prazo e persiste', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])   // itens (100.00)
    mockQuery.mockResolvedValueOnce([[{                       // link A
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])           // findDeadRuleIds: 42 vivo
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])       // shipping
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])      // totalizer
    mockLoadPieces.mockResolvedValueOnce({
      icms: { cstNr: '00', csosn: null, modBc: '3', dischargeId: null,
        aliq: 18, aliqReduction: 0, baseReduction: 0, deferred: 'N',
        deferredAliq: null, highlight: 'N' },
    })
    mockQuery.mockResolvedValueOnce([[{                       // order_billing
      paymentTypeId: 5, deadline: '028/056',
    }]])
    mockQuery.mockResolvedValueOnce([[]])                     // installments vazios
    mockQuery.mockResolvedValueOnce([[]])                     // getRuleObservationNotes
    mockQuery.mockResolvedValueOnce([[]])                     // getGeneralObservations
    mockQuery.mockResolvedValueOnce([[]])                     // getNcmApproxRates

    // persistInvoice via conn
    const conn = {
      beginTransaction: jest.fn(), query: jest.fn(),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]])   // FOR UPDATE
      .mockResolvedValueOnce([{}])                  // icms item
      .mockResolvedValueOnce([{}])                  // approx_tax_aliq update
      .mockResolvedValueOnce([[{ nextNumber: 1 }]]) // MAX+1 nota
      .mockResolvedValueOnce([{}])                  // tb_invoice
      .mockResolvedValueOnce([{}])                  // tb_invoice_merchandise
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]) // financial p1 + bill p1
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]) // financial p2 + bill p2
      .mockResolvedValueOnce([{}])                  // status F

    const result = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })

    expect(result.invoiceNumber).toBe('1')
    expect(result.model).toBe('55')
    expect(result.parcels).toBe(2)                  // prazo 028/056
    expect(result.totalValue).toBe(100)
    expect(conn.commit).toHaveBeenCalled()

    // financeiro: 2 parcelas de 50 kind RA (venda)
    const finCalls = conn.query.mock.calls.filter(c =>
      (c[0] as string).includes('INSERT INTO') && (c[0] as string).includes('tb_financial\n'))
    const billCalls = conn.query.mock.calls.filter(c =>
      (c[0] as string).includes('tb_financial_bills'))
    expect(billCalls.length).toBe(2)
    expect(billCalls[0][1]).toContain('RA')
    void finCalls
  })

  it('gate A4: regra do link soft-deletada -> 422 REQUIRES_VALIDATION (nunca nota sem imposto)', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockQuery.mockResolvedValueOnce([[]]) // findDeadRuleIds: 42 NÃO está vivo

    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'REQUIRES_VALIDATION' })
  })

  it('gate A6: item com desconto maior que o valor -> 422 NEGATIVE_ITEM_VALUE', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, discountValue: 140 })]]) // 100 - 140 = -40
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]]) // regra viva

    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'NEGATIVE_ITEM_VALUE' })
  })

  it('gate A2: deadline absurdo ("999999999") -> 422 INVALID_DEADLINE, nunca 500', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockLoadPieces.mockResolvedValueOnce({
      icms: { cstNr: '00', csosn: null, modBc: '3', dischargeId: null,
        aliq: 18, aliqReduction: 0, baseReduction: 0, deferred: 'N',
        deferredAliq: null, highlight: 'N' },
    })
    mockQuery.mockResolvedValueOnce([[{ paymentTypeId: 5, deadline: '999999999' }]])
    mockQuery.mockResolvedValueOnce([[]]) // installments

    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'INVALID_DEADLINE' })
  })

  it('gate A8: destinatário sem tributação configurada gera issue na validação', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ recipientRegime: null })
    mockQuery.mockResolvedValueOnce([[]]) // itens
    mockQuery.mockResolvedValueOnce([[]]) // links

    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues.some(i =>
      i.scope === 'recipient' && i.field === 'taxRegime')).toBe(true)
  })

  it('gate P1: nota SÓ de serviço grava tb_invoice_service, nunca merchandise', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, productKind: 'S' })]])
    mockQuery.mockResolvedValueOnce([[]])                 // links (mercadoria)
    // Onda 3: serviço exige vínculo irmão + regra viva/coerente (cidade 2 = tomador)
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Sale', serviceTaxRuleId: 2, origin: 'A' }]])
    mockQuery.mockResolvedValueOnce([[{ id: 2, cityId: 2, cityName: 'X', serviceListId: '1.02', aliq: 5, municipalCode: null, active: 'S' }]])
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ paymentTypeId: 5, deadline: null }]])
    mockQuery.mockResolvedValueOnce([[]])                 // installments
    mockQuery.mockResolvedValueOnce([[]])                 // getGeneralObservations

    const conn = {
      beginTransaction: jest.fn(), query: jest.fn(),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]])   // FOR UPDATE
      .mockResolvedValueOnce([{}])                  // issqn item
      .mockResolvedValueOnce([[{ nextNumber: 1 }]]) // MAX+1
      .mockResolvedValueOnce([{}])                  // tb_invoice
      .mockResolvedValueOnce([{}])                  // tb_invoice_service
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]) // financeiro p1
      .mockResolvedValueOnce([{}])                  // status F

    const result = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })

    expect(result.model).toBe('SE')                 // só serviço → SE
    const sqls = conn.query.mock.calls.map(c => c[0] as string)
    expect(sqls.some(s => s.includes('tb_invoice_service'))).toBe(true)
    expect(sqls.some(s => s.includes('tb_invoice_merchandise'))).toBe(false)
  })

  it('ordem já faturada detectada DENTRO da transação -> 409 e rollback', async () => {
    mockOrderBase()  // status A na leitura otimista
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, productKind: 'S', kind: 'Sale' })]])
    mockQuery.mockResolvedValueOnce([[]])                 // links (mercadoria)
    // Onda 3: serviço exige vínculo irmão + regra viva/coerente (cidade 2 = tomador)
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Sale', serviceTaxRuleId: 2, origin: 'A' }]])
    mockQuery.mockResolvedValueOnce([[{ id: 2, cityId: 2, cityName: 'X', serviceListId: '1.02', aliq: 5, municipalCode: null, active: 'S' }]])
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ paymentTypeId: 5, deadline: null }]])
    mockQuery.mockResolvedValueOnce([[]])                 // installments
    mockQuery.mockResolvedValueOnce([[]])                 // getGeneralObservations

    const conn = {
      beginTransaction: jest.fn(), query: jest.fn(),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ status: 'F' }]]) // mudou no meio

    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ORDER_INVOICED' })
    expect(conn.rollback).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------
  // Rodada 5 (evidência do legado, 2026-08-21)
  // -------------------------------------------------------------------

  it('R5-Q3: item de mercadoria sem NCM -> 422 MISSING_NCM (gate revalidado no /invoice)', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, ncm: null })]])
    mockQuery.mockResolvedValueOnce([[]]) // getItemRuleLinks

    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'MISSING_NCM' })
  })

  it('R5-Q2: parcelamento elaborado diverge do valor atual -> 422 INSTALLMENT_MISMATCH', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])   // itens (100.00)
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])           // findDeadRuleIds
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockLoadPieces.mockResolvedValueOnce({
      icms: { cstNr: '00', csosn: null, modBc: '3', dischargeId: null,
        aliq: 18, aliqReduction: 0, baseReduction: 0, deferred: 'N',
        deferredAliq: null, highlight: 'N' },
    })
    mockQuery.mockResolvedValueOnce([[{ paymentTypeId: 5, deadline: '028/056' }]])
    // elaborado com soma 80 ≠ financialBase 100 (itens editados depois da negociação)
    mockQuery.mockResolvedValueOnce([[
      { parcel: 1, dueDate: '2026-09-01', amount: 40, paymentTypeId: 5 },
      { parcel: 2, dueDate: '2026-10-01', amount: 40, paymentTypeId: 5 },
    ]])

    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'INSTALLMENT_MISMATCH' })
  })

  function mockPersistTxn(extraInserts: number) {
    const conn = {
      beginTransaction: jest.fn(), query: jest.fn(),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])   // FOR UPDATE
    conn.query.mockResolvedValueOnce([{}])                  // icms item
    conn.query.mockResolvedValueOnce([{}])                  // approx_tax_aliq update
    conn.query.mockResolvedValueOnce([[{ nextNumber: 1 }]]) // MAX+1 nota
    conn.query.mockResolvedValueOnce([{}])                  // tb_invoice
    conn.query.mockResolvedValueOnce([{}])                  // tb_invoice_merchandise
    for (let i = 0; i < extraInserts; i++) {
      conn.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]) // financial + bill
    }
    conn.query.mockResolvedValueOnce([{}])                  // status F
    return conn
  }

  function mockHappyItemChain(deadline: string | null) {
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])           // findDeadRuleIds
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockLoadPieces.mockResolvedValueOnce({
      icms: { cstNr: '00', csosn: null, modBc: '3', dischargeId: null,
        aliq: 18, aliqReduction: 0, baseReduction: 0, deferred: 'N',
        deferredAliq: null, highlight: 'N' },
    })
    mockQuery.mockResolvedValueOnce([[{ paymentTypeId: 5, deadline }]])
    mockQuery.mockResolvedValueOnce([[]])                     // installments vazios
    mockQuery.mockResolvedValueOnce([[]])                     // getRuleObservationNotes
    mockQuery.mockResolvedValueOnce([[]])                     // getGeneralObservations
    mockQuery.mockResolvedValueOnce([[]])                     // getNcmApproxRates
  }

  it('R5-Q1: compra (branch purchase) gera financeiro PA + D', async () => {
    mockOrderBase()
    mockQuery.mockResolvedValueOnce([[]])                    // tb_order_sale vazio
    mockQuery.mockResolvedValueOnce([[{ entityId: 90 }]])    // tb_order_purchase
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, kind: 'Purchase' })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Purchase', taxRuleId: 42, cfopId: '1102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockHappyItemChain(null)

    const conn = mockPersistTxn(1)
    const result = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(result.parcels).toBe(1)

    const billCalls = conn.query.mock.calls.filter(c => (c[0] as string).includes('tb_financial_bills'))
    expect(billCalls[0][1]).toContain('PA')
    expect(billCalls[0][1]).toContain('D')
  })

  it('R5-Q1: ajuste com direção Entrada (E) gera RA + D — inverso do padrão de venda', async () => {
    mockOrderBase()
    mockQuery.mockResolvedValueOnce([[]])                    // sale vazio
    mockQuery.mockResolvedValueOnce([[]])                    // purchase vazio
    // direção vem do RAMO (fonte única — parecer 2026-08-24)
    mockQuery.mockResolvedValueOnce([[{ entityId: 55, direction: 'E' }]])
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, kind: 'Adjust' })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Adjust', taxRuleId: 42, cfopId: '1949',
      setFinancial: 'S', origin: 'A',
    }]])
    mockHappyItemChain(null)

    const conn = mockPersistTxn(1)
    await invoiceOrder(inst as any, {
      orderId: 10, useMvaOriginal: false, adjustment: { cfopId: '1949' },
    })

    const billCalls = conn.query.mock.calls.filter(c => (c[0] as string).includes('tb_financial_bills'))
    expect(billCalls[0][1]).toContain('RA')
    expect(billCalls[0][1]).toContain('D')
  })

  it('R5-Q1: ajuste com direção Saída (S) gera PA + C', async () => {
    mockOrderBase()
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[{ entityId: 55, direction: 'S' }]])
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, kind: 'Adjust' })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Adjust', taxRuleId: 42, cfopId: '5949',
      setFinancial: 'S', origin: 'A',
    }]])
    mockHappyItemChain(null)

    const conn = mockPersistTxn(1)
    await invoiceOrder(inst as any, {
      orderId: 10, useMvaOriginal: false, adjustment: { cfopId: '5949' },
    })

    const billCalls = conn.query.mock.calls.filter(c => (c[0] as string).includes('tb_financial_bills'))
    expect(billCalls[0][1]).toContain('PA')
    expect(billCalls[0][1]).toContain('C')
  })

  it('P2.9: emitente Simples fatura por CSOSN (regra com csosn, sem cstNr)', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ emitterRegime: '1 - Simples Nacional' })
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])           // findDeadRuleIds
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockLoadPieces.mockResolvedValueOnce({
      icms: { cstNr: null, csosn: '900', modBc: '3', dischargeId: null,
        aliq: 18, aliqReduction: 0, baseReduction: 0, deferred: 'N',
        deferredAliq: null, highlight: 'N' },
    })
    mockQuery.mockResolvedValueOnce([[{ paymentTypeId: 5, deadline: null }]])
    mockQuery.mockResolvedValueOnce([[]])                     // installments
    mockQuery.mockResolvedValueOnce([[]])                     // getRuleObservationNotes
    mockQuery.mockResolvedValueOnce([[]])                     // getGeneralObservations
    mockQuery.mockResolvedValueOnce([[]])                     // getNcmApproxRates

    const conn = mockPersistTxn(1)
    const result = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(result.totalValue).toBe(100)

    const icmsCall = conn.query.mock.calls.find(c => (c[0] as string).includes('tb_order_item_icms'))
    expect(icmsCall![1]).toContain('900')      // cst gravado com o código CSOSN (fallback)
  })

  it('W3.2: parcelas em espécie -> tryAutoSettleCash chamado por parcela, autoSettled reflete o resultado', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])   // itens (100.00)
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockHappyItemChain('028/056')                              // 2 parcelas de 50

    mockTryAutoSettleCash
      .mockResolvedValueOnce({ settled: true, settledCode: 1, statementId: 1, cashierId: 5 })
      .mockResolvedValueOnce({ settled: false, reason: 'NO_OPEN_CASHIER' })

    const conn = mockPersistTxn(2)
    const result = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })

    expect(result.autoSettled).toBe(1)
    expect(mockTryAutoSettleCash).toHaveBeenCalledTimes(2)
    expect(mockTryAutoSettleCash).toHaveBeenNthCalledWith(1, conn,
      'setes_setes', 1, 7,
      expect.objectContaining({ orderId: 10, parcel: 1, paymentTypeId: 5 }))
  })

  it('gate socrático 2026-08-22: falha TÉCNICA na baixa automática NÃO derruba a nota (SAVEPOINT isola)', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockHappyItemChain(null) // 1 parcela

    mockTryAutoSettleCash.mockRejectedValueOnce(new Error('falha técnica inesperada'))

    const conn = mockPersistTxn(1)
    const result = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })

    // a nota persiste normalmente (commit chamado, nunca rollback)
    expect(conn.commit).toHaveBeenCalled()
    expect(conn.rollback).not.toHaveBeenCalled()
    expect(result.autoSettled).toBe(0)

    // a falha foi isolada por SAVEPOINT, não pelo catch da transação inteira
    const sqls = conn.query.mock.calls.map(c => c[0] as string)
    expect(sqls.some(s => s.includes('SAVEPOINT auto_settle'))).toBe(true)
    expect(sqls.some(s => s.includes('ROLLBACK TO SAVEPOINT auto_settle'))).toBe(true)
  })
})

// ---------------------------------------------------------------------
// Comissão por item + Devolução de mercadoria (rodada Q1–Q5, 2026-08-24)
// ---------------------------------------------------------------------

describe('comissão e devolução', () => {
  function mockBranchAdjust(entityId = 55, direction: 'E' | 'S' = 'E') {
    mockQuery.mockResolvedValueOnce([[]])   // sale vazio
    mockQuery.mockResolvedValueOnce([[]])   // purchase vazio
    mockQuery.mockResolvedValueOnce([[{ entityId, direction }]])
  }

  function mockInvoiceChain() {
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])           // findDeadRuleIds
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockLoadPieces.mockResolvedValueOnce({
      icms: { cstNr: '00', csosn: null, modBc: '3', dischargeId: null,
        aliq: 18, aliqReduction: 0, baseReduction: 0, deferred: 'N',
        deferredAliq: null, highlight: 'N' },
    })
    mockQuery.mockResolvedValueOnce([[{ paymentTypeId: 5, deadline: null }]])
    mockQuery.mockResolvedValueOnce([[]])                     // installments vazios
    mockQuery.mockResolvedValueOnce([[]])                     // getRuleObservationNotes
    mockQuery.mockResolvedValueOnce([[]])                     // getGeneralObservations
    mockQuery.mockResolvedValueOnce([[]])                     // getNcmApproxRates
  }

  function mockTxn() {
    const conn = {
      beginTransaction: jest.fn(), query: jest.fn(),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValue([{}])
    conn.query.mockResolvedValueOnce([[{ status: 'A' }]])   // FOR UPDATE
    conn.query.mockResolvedValueOnce([{}])                  // icms item
    conn.query.mockResolvedValueOnce([{}])                  // approx_tax_aliq
    conn.query.mockResolvedValueOnce([[{ nextNumber: 1 }]]) // MAX+1 nota
    return conn
  }

  it('validate: âncora presente com ajuste de SAÍDA vira issue (sem consultar o pedido)', async () => {
    mockOrderBase()
    mockBranchAdjust(55, 'S')
    mockContext()
    mockQuery.mockResolvedValueOnce([[]]) // itens
    mockOrderReturn.getAnchor.mockResolvedValueOnce({ orderIdOri: 77 })
    mockQuery.mockResolvedValueOnce([[]]) // links

    const report = await validateOrder(inst as any, {
      orderId: 10, adjustment: { cfopId: '5202' },
    })
    expect(report.issues.some(i =>
      i.field === 'adjustment' && i.message.includes('ENTRADA'))).toBe(true)
    expect(mockOrderReturn.buildReturnPlan).not.toHaveBeenCalled()
  })

  it('validate: devolução (âncora) propaga as issues do plano (qtde > saldo etc.)', async () => {
    mockOrderBase()
    mockBranchAdjust(55, 'E')
    mockContext()
    mockQuery.mockResolvedValueOnce([[]]) // itens
    mockOrderReturn.getAnchor.mockResolvedValueOnce({ orderIdOri: 77 })
    mockOrderReturn.buildReturnPlan.mockResolvedValueOnce({
      issues: [{ itemId: 1, field: 'quantity', message: 'saldo insuficiente' }],
      plan: null,
    })
    mockQuery.mockResolvedValueOnce([[]]) // links

    const report = await validateOrder(inst as any, {
      orderId: 10, adjustment: { cfopId: '1202' },
    })
    expect(mockOrderReturn.getAnchor).toHaveBeenCalledWith('setes_setes', 1, 10)
    expect(mockOrderReturn.buildReturnPlan).toHaveBeenCalledWith(
      'setes_setes', 1, 77, 55, expect.any(Array))
    expect(report.issues.some(i =>
      i.itemId === 1 && i.field === 'quantity' && i.scope === 'item')).toBe(true)
  })

  it('invoice: devolução inválida -> 422 RETURN_INVALID (gate DURO revalidado)', async () => {
    mockOrderBase()
    mockBranchAdjust(55, 'E')
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, kind: 'Adjust' })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Adjust', taxRuleId: 42, cfopId: '1202',
      setFinancial: 'S', origin: 'A',
    }]])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]]) // regra viva
    mockOrderReturn.getAnchor.mockResolvedValueOnce({ orderIdOri: 77 })
    mockOrderReturn.buildReturnPlan.mockResolvedValueOnce({
      issues: [{ itemId: 1, field: 'quantity', message: 'saldo insuficiente' }],
      plan: null,
    })

    await expect(invoiceOrder(inst as any, {
      orderId: 10, useMvaOriginal: false, adjustment: { cfopId: '1202' },
    })).rejects.toMatchObject({ statusCode: 422, code: 'RETURN_INVALID' })
  })

  it('invoice: âncora presente com ajuste de Saída -> 422 RETURN_REQUIRES_ENTRY', async () => {
    mockOrderBase()
    mockBranchAdjust(55, 'S')
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, kind: 'Adjust' })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Adjust', taxRuleId: 42, cfopId: '5202',
      setFinancial: 'S', origin: 'A',
    }]])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]])
    mockOrderReturn.getAnchor.mockResolvedValueOnce({ orderIdOri: 77 })

    await expect(invoiceOrder(inst as any, {
      orderId: 10, useMvaOriginal: false, adjustment: { cfopId: '5202' },
    })).rejects.toMatchObject({ statusCode: 422, code: 'RETURN_REQUIRES_ENTRY' })
  })

  it('venda gera comissão POSITIVA por item (kind F, base = valor líquido)', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])   // 2 × 50 = 100
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockInvoiceChain()
    mockOrderReturn.getSaleOrderInfo.mockResolvedValueOnce(
      { salesmanId: 9, customerId: 55 })
    mockCommission.resolveCommissionAliq.mockResolvedValueOnce(5)

    const conn = mockTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })

    expect(mockCommission.insertCommissions).toHaveBeenCalledWith(
      conn, 'setes_setes', 1, [expect.objectContaining({
        kind: 'F', orderId: 10, orderItemId: 1, orderItemKind: 'Sale',
        salesmanId: 9, customerId: 55, baseValue: 100, aliq: 5, value: 5,
      })])
  })

  it('venda com alíquota 0 NÃO gera lançamento', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1 })]])
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102',
      setFinancial: 'S', origin: 'A',
    }]])
    mockInvoiceChain()
    mockOrderReturn.getSaleOrderInfo.mockResolvedValueOnce(
      { salesmanId: 9, customerId: 55 })
    mockCommission.resolveCommissionAliq.mockResolvedValueOnce(0)

    const conn0 = mockTxn()
    await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(mockCommission.insertCommissions).toHaveBeenCalledWith(conn0, 'setes_setes', 1, [])
  })

  it('devolução: comissão NEGATIVA espelha a alíquota POSTADA da venda + persiste os elos', async () => {
    mockOrderBase()
    mockBranchAdjust(55, 'E')
    mockContext()
    mockQuery.mockResolvedValueOnce([[itemRow({ id: 1, kind: 'Adjust' })]]) // base 100
    mockQuery.mockResolvedValueOnce([[{
      orderItemId: 1, kind: 'Adjust', taxRuleId: 42, cfopId: '1202',
      setFinancial: 'S', origin: 'A',
    }]])
    const plan = {
      orderIdOri: 77, salesmanId: 9, customerId: 55,
      links: [{ itemId: 1, itemKind: 'Adjust', quantity: 2, itemIdOri: 33,
        kindOri: 'Sale', productId: 100, priceListIdOri: 2 }],
    }
    mockOrderReturn.getAnchor.mockResolvedValueOnce({ orderIdOri: 77 })
    mockOrderReturn.buildReturnPlan.mockResolvedValueOnce({ issues: [], plan })
    mockInvoiceChain()
    mockCommission.getPostedItemCommissions.mockResolvedValueOnce([
      { orderItemId: 33, orderItemKind: 'Sale', salesmanId: 9, customerId: 55, aliq: 10 },
    ])

    const conn = mockTxn()
    await invoiceOrder(inst as any, {
      orderId: 10, useMvaOriginal: false, adjustment: { cfopId: '1202' },
    })

    // estorno POR ITEM (corrige o achado literal do legado — Q2): -10 sobre 100 a 10%
    expect(mockCommission.insertCommissions).toHaveBeenCalledWith(
      conn, 'setes_setes', 1, [expect.objectContaining({
        kind: 'F', orderItemId: 1, orderItemKind: 'Adjust',
        salesmanId: 9, baseValue: 100, aliq: 10, value: -10,
      })])
    // alíquota veio do lançamento postado — não re-resolve pela fonte atual
    expect(mockCommission.resolveCommissionAliq).not.toHaveBeenCalled()
    // saldo REVALIDADO sob lock da origem ANTES de gravar (R2/HIGH dos gates)
    expect(mockOrderReturn.assertReturnableInTx).toHaveBeenCalledWith(
      conn, 'setes_setes', 1, 10, plan)
    expect(mockOrderReturn.persistReturn).toHaveBeenCalledWith(
      conn, 'setes_setes', 1, 10, plan)
  })

  it('devolução: item de SERVIÇO fica fora do plano (mercadoria apenas)', async () => {
    mockOrderBase()
    mockBranchAdjust(55, 'E')
    mockContext()
    mockQuery.mockResolvedValueOnce([[
      itemRow({ id: 1, kind: 'Adjust' }),
      itemRow({ id: 2, kind: 'Adjust', productKind: 'S', ncm: null }),
    ]])
    mockOrderReturn.getAnchor.mockResolvedValueOnce({ orderIdOri: 77 })
    mockOrderReturn.buildReturnPlan.mockResolvedValueOnce({ issues: [], plan: null })
    mockQuery.mockResolvedValueOnce([[]]) // links
    mockQuery.mockResolvedValueOnce([[]]) // links de serviço (Onda 3)
    mockQuery.mockResolvedValueOnce([[]]) // item 2 (serviço) sem regra -> issue
    mockQuery.mockResolvedValueOnce([{}]) // clear vínculo A do serviço

    await validateOrder(inst as any, {
      orderId: 10, adjustment: { cfopId: '1202' },
    })
    const passedItems = mockOrderReturn.buildReturnPlan.mock.calls[0][4]
    expect(passedItems).toHaveLength(1)
    expect(passedItems[0].id).toBe(1)
  })
})
