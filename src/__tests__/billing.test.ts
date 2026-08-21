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

const mockQuery = (pool as any).query as jest.Mock
const mockFindTaxRule = (taxRule as any).findTaxRule as jest.Mock
const mockLoadPieces = (taxRule as any).loadPieces as jest.Mock

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

  it('emitente Simples (CRT 1) gera issue de CSOSN pendente', async () => {
    mockOrderBase()
    mockBranchSale()
    mockContext({ emitterRegime: '1 - Simples Nacional' })
    mockQuery.mockResolvedValueOnce([[]]) // sem itens
    mockQuery.mockResolvedValueOnce([[]]) // sem links

    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues.some(i =>
      i.scope === 'emitter' && i.message.includes('CSOSN'))).toBe(true)
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

    // persistInvoice via conn
    const conn = {
      beginTransaction: jest.fn(), query: jest.fn(),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]])   // FOR UPDATE
      .mockResolvedValueOnce([{}])                  // icms item
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
    mockQuery.mockResolvedValueOnce([[]])                 // links (serviço não exige)
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ paymentTypeId: 5, deadline: null }]])
    mockQuery.mockResolvedValueOnce([[]])                 // installments

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
    mockQuery.mockResolvedValueOnce([[]])                 // links (serviço não exige)
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ paymentTypeId: 5, deadline: null }]])
    mockQuery.mockResolvedValueOnce([[]])                 // installments

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
})
