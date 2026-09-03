/// <reference types="jest" />
// Onda 3 da Regra de Tributação de Serviço (prompt_regra_tributacao_servico.md
// D6/D12/D13/D14): peça @shared/service-tax-rule (resolução + checagem) e o
// caminho kind='S' do billing — validate grava vínculo irmão 'A' só com regra
// coerente; invoice exige vínculo, revalida e calcula com a ALÍQUOTA DA REGRA.
import pool from '../shared/db/connection'
import {
  checkServiceRule, serviceRuleProblemMessage, resolveServiceTaxRule,
  getServiceTaxRuleById, ServiceTaxRuleResolved,
} from '../shared/service-tax-rule'
import * as taxRule from '../shared/tax-rule'
import { validateOrder, invoiceOrder } from '../modules/billing/billing.service'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
jest.mock('../shared/tax-rule', () => {
  const actual = jest.requireActual('../shared/tax-rule')
  return { ...actual, findTaxRule: jest.fn(), loadPieces: jest.fn() }
})
jest.mock('../modules/state-tax-rates/state-tax-rates.repository', () => ({
  resolveMvaAliq: jest.fn().mockResolvedValue(null),
  resolveFcpAliq: jest.fn().mockResolvedValue(null),
}))
jest.mock('../shared/interface-config', () => ({
  getConfigContent: jest.fn().mockResolvedValue(null),
}))
jest.mock('../shared/financial-settlement', () => ({
  tryAutoSettleCash: jest.fn().mockResolvedValue({ settled: false, reason: 'NOT_CASH' }),
}))
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
const inst = { institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes' }
const RULE: ServiceTaxRuleResolved = {
  id: 2, cityId: 4004, cityName: 'CURITIBA', serviceListId: '1.02',
  aliq: 5, municipalCode: '0102', active: 'S',
}
beforeEach(() => jest.clearAllMocks())

// --------------------------------------------------------------------
describe('@shared/service-tax-rule — checkServiceRule (D6/D12)', () => {
  it('null = NO_RULE; inativa = INACTIVE; cidade ≠ tomador = CITY_MISMATCH; ok = null', () => {
    expect(checkServiceRule(null, 4004)).toBe('NO_RULE')
    expect(checkServiceRule({ ...RULE, active: 'N' }, 4004)).toBe('INACTIVE')
    expect(checkServiceRule(RULE, 3550)).toBe('CITY_MISMATCH')
    expect(checkServiceRule(RULE, 4004)).toBeNull()
  })

  it('tomador sem cidade NÃO dispara mismatch (o contexto já acusa endereço)', () => {
    expect(checkServiceRule(RULE, null)).toBeNull()
  })

  it('mensagens carregam item, regra e cidade', () => {
    expect(serviceRuleProblemMessage(9, 'NO_RULE', null)).toContain('sem regra de tributação de serviço')
    expect(serviceRuleProblemMessage(9, 'CITY_MISMATCH', RULE)).toContain('CURITIBA')
    expect(serviceRuleProblemMessage(9, 'INACTIVE', RULE)).toContain('2')
  })

  it('resolveServiceTaxRule vai por tb_service → regra viva; getById filtra institution', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 2, cityId: 4004, cityName: 'CURITIBA',
      serviceListId: '1.02', aliq: '5.00', municipalCode: '0102', active: 'S' }]])
    const r = await resolveServiceTaxRule('setes_setes', 1, 18)
    expect(r?.aliq).toBe(5)
    expect(mockQuery.mock.calls[0][0] as string).toContain('tb_service sv')
    expect(mockQuery.mock.calls[0][1]).toEqual([18, 1])

    mockQuery.mockResolvedValueOnce([[]])
    expect(await getServiceTaxRuleById('setes_setes', 1, 99)).toBeNull()
    expect(mockQuery.mock.calls[1][1]).toEqual([99, 1])
  })
})

// --------------------------------------------------------------------
// billing — helpers de mock (mesma sequência do billing.test)
function mockOrderBase(status = 'A') { mockQuery.mockResolvedValueOnce([[{ status }]]) }
function mockBranchSale(entityId = 55) { mockQuery.mockResolvedValueOnce([[{ entityId }]]) }
function mockContext(recipientCity = 4004) {
  mockQuery.mockResolvedValueOnce([[{ consumer: 'N', taxRegime: '3 - Regime Normal', byPassSt: 'N', indIeDest: '1', issRetido: 'N' }]])
  mockQuery.mockResolvedValueOnce([[{ stateId: 41, cityId: 4004 }]])            // emitente
  mockQuery.mockResolvedValueOnce([[{ consumer: 'N', taxRegime: '3 - Regime Normal', byPassSt: 'N', indIeDest: '1', issRetido: 'N' }]])
  mockQuery.mockResolvedValueOnce([[{ stateId: 41, cityId: recipientCity }]])   // tomador
}
const serviceItem = (over: any = {}) => ({
  id: 1, kind: 'Service', productId: 18, quantity: 1, unitValue: 1000,
  discountValue: 0, productKind: 'S', ncm: null, origin: null, cest: '',
  kind_tributary: null, purpose: null, ...over,
})
const ruleRow = (over: any = {}) => ({ id: 2, cityId: 4004, cityName: 'CURITIBA',
  serviceListId: '1.02', aliq: 5, municipalCode: '0102', active: 'S', ...over })

describe('validateOrder — caminho kind=S (D6/D12/D14)', () => {
  it('serviço com regra coerente: grava vínculo irmão (origin A) e conta rulesResolved', async () => {
    mockOrderBase(); mockBranchSale(); mockContext()
    mockQuery.mockResolvedValueOnce([[serviceItem()]])   // itens
    mockQuery.mockResolvedValueOnce([[]])                // links mercadoria
    mockQuery.mockResolvedValueOnce([[]])                // links serviço
    mockQuery.mockResolvedValueOnce([[ruleRow()]])       // resolveServiceTaxRule
    mockQuery.mockResolvedValueOnce([{}])                // upsert vínculo A

    const report = await validateOrder(inst as any, { orderId: 10 })

    expect(report.issues).toEqual([])
    expect(report.rulesResolved).toBe(1)
    const upsert = mockQuery.mock.calls.find(c =>
      (c[0] as string).includes('tb_order_item_service_tax_rule') && (c[0] as string).includes('INSERT'))
    expect(upsert).toBeDefined()
    expect(upsert![1]).toEqual([10, 1, 1, 'Service', 2])
  })

  it('serviço SEM regra: issue serviceTaxRule + limpa vínculo A, nada gravado (D6)', async () => {
    mockOrderBase(); mockBranchSale(); mockContext()
    mockQuery.mockResolvedValueOnce([[serviceItem()]])
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[]])                // sem regra
    mockQuery.mockResolvedValueOnce([{}])                // clear vínculo A

    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.rulesResolved).toBe(0)
    expect(report.issues).toEqual([expect.objectContaining({ scope: 'item', itemId: 1, field: 'serviceTaxRule' })])
    const clear = mockQuery.mock.calls.find(c =>
      (c[0] as string).includes('tb_order_item_service_tax_rule') && (c[0] as string).includes("SET deleted = 'S'"))
    expect(clear).toBeDefined()
  })

  it('cidade da regra ≠ cidade do tomador: issue bloqueante (D12)', async () => {
    mockOrderBase(); mockBranchSale(); mockContext(3550)  // tomador em São Paulo
    mockQuery.mockResolvedValueOnce([[serviceItem()]])
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[ruleRow()]])       // regra de Curitiba
    mockQuery.mockResolvedValueOnce([{}])                // clear

    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.issues[0].message).toContain('CURITIBA')
    expect(report.issues[0].message).toContain('outra cidade')
  })

  it('RegraDireta (origin M): usa a regra escolhida, não re-resolve pelo cadastro (D14)', async () => {
    mockOrderBase(); mockBranchSale(); mockContext()
    mockQuery.mockResolvedValueOnce([[serviceItem()]])
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Service', serviceTaxRuleId: 7, origin: 'M' }]])
    mockQuery.mockResolvedValueOnce([[ruleRow({ id: 7 })]])   // getById(7)

    const report = await validateOrder(inst as any, { orderId: 10 })
    expect(report.rulesManual).toBe(1)
    expect(report.issues).toEqual([])
    expect(mockQuery.mock.calls[9][1]).toEqual([7, 1])   // buscou a regra 7 por id (status, ramo, 4 ctx, itens, links, links serviço, getById)
    const upsert = mockQuery.mock.calls.find(c => (c[0] as string).includes('INSERT INTO') && (c[0] as string).includes('service_tax_rule'))
    expect(upsert).toBeUndefined()
  })
})

describe('invoiceOrder — caminho kind=S', () => {
  it('serviço sem vínculo -> 422 REQUIRES_VALIDATION (a interrupção prometida — D6)', async () => {
    mockOrderBase(); mockBranchSale(); mockContext()
    mockQuery.mockResolvedValueOnce([[serviceItem()]])
    mockQuery.mockResolvedValueOnce([[]])   // links mercadoria
    mockQuery.mockResolvedValueOnce([[]])   // links serviço — vazio
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'REQUIRES_VALIDATION' })
  })

  it('vínculo com regra que ficou incoerente (tomador mudou de cidade) -> 422 REQUIRES_VALIDATION', async () => {
    mockOrderBase(); mockBranchSale(); mockContext(3550)
    mockQuery.mockResolvedValueOnce([[serviceItem()]])
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Service', serviceTaxRuleId: 2, origin: 'A' }]])
    mockQuery.mockResolvedValueOnce([[ruleRow()]])
    await expect(invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'REQUIRES_VALIDATION' })
  })

  it('fatura serviço com a ALÍQUOTA DA REGRA (D13) e grava item LC 116 + código municipal no ISSQN', async () => {
    mockOrderBase(); mockBranchSale(); mockContext()
    mockQuery.mockResolvedValueOnce([[serviceItem()]])
    mockQuery.mockResolvedValueOnce([[]])
    mockQuery.mockResolvedValueOnce([[{ orderItemId: 1, kind: 'Service', serviceTaxRuleId: 2, origin: 'A' }]])
    mockQuery.mockResolvedValueOnce([[ruleRow()]])
    mockQuery.mockResolvedValueOnce([[{ freight: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ expenses: 0 }]])
    mockQuery.mockResolvedValueOnce([[{ paymentTypeId: 5, deadline: null }]])
    mockQuery.mockResolvedValueOnce([[]])   // installments
    mockQuery.mockResolvedValueOnce([[]])   // observações gerais

    const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]])
      .mockResolvedValueOnce([{}])                  // issqn item
      .mockResolvedValueOnce([[{ nextNumber: 1 }]])
      .mockResolvedValueOnce([{}])                  // tb_invoice
      .mockResolvedValueOnce([{}])                  // tb_invoice_service
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])

    const result = await invoiceOrder(inst as any, { orderId: 10, useMvaOriginal: false })
    expect(result.model).toBe('SE')
    const issqn = conn.query.mock.calls.find(c => (c[0] as string).includes('tb_order_item_issqn'))
    expect(issqn).toBeDefined()
    // params: ...key(3), base, aliq, valor, listservice, tax_code
    const p = issqn![1] as any[]
    expect(p.slice(-5)).toEqual([1000, 5, 50, '1.02', '0102'])
  })
})
