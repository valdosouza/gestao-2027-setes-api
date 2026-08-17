/// <reference types="jest" />
// Regra de Tributação (fase Faturamento Fiscal e Financeiro, decisões 1/23):
// o foco é a PARIDADE DO MOTOR com o legado (critério de sucesso 1 — as 6
// sutilezas de tributacao.md §2 + desempate com B9 corrigido) e a cascata
// seletor+peças (presença = incidência).
import pool from '../shared/db/connection'
import {
  findTaxRule, resolveMatchStateId, resolveEffectiveSt, pickRule,
  findInvalidCatalogCodes, savePieces,
  TaxRuleMatchCriteria, TaxRuleSelector,
} from '../shared/tax-rule'
import { taxRuleBodyDto } from '../modules/tax-rules/tax-rules.dto'
import * as repo from '../modules/tax-rules/tax-rules.repository'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockQuery = (pool as any).query as jest.Mock

const baseCriteria: TaxRuleMatchCriteria = {
  institutionId: 1, productId: 10, productNcm: '84713012',
  productOrigin: '0', productSt: 'N', purpose: '1', entityId: 55,
  finalConsumer: 'N', simples: 'N',
  destinationStateId: 41, emitterStateId: 41,
}

const sel = (over: Partial<TaxRuleSelector>): TaxRuleSelector => ({
  id: 1, institutionId: 1, productId: null, entityId: null, ncm: null,
  origin: '0', finalConsumer: 'N', simples: 'N', st: 'N', purpose: '1',
  direction: null, cfopId: null, stateId: null, observationId: null,
  taxesId: null, ...over,
})

beforeEach(() => jest.clearAllMocks())

// ---------------------------------------------------------------------
// Motor — as 6 sutilezas
// ---------------------------------------------------------------------

describe('tax-rule match engine (paridade com o legado)', () => {
  it('sutileza 5 (presencial): não contribuinte de outra UF usa a UF do EMITENTE', () => {
    const c = { ...baseCriteria, destinationStateId: 42, emitterStateId: 41,
                presential: true, contributorIndicator: '9' }
    expect(resolveMatchStateId(c)).toBe(41)
    // sem presencial, vale a UF do destinatário
    expect(resolveMatchStateId({ ...c, presential: false })).toBe(42)
    // contribuinte isento (2) NÃO entra na regra presencial
    expect(resolveMatchStateId({ ...c, contributorIndicator: '2' })).toBe(42)
  })

  it('override do cliente (Q18): IgnorarCalculoST vira busca não-ST', () => {
    expect(resolveEffectiveSt({ ...baseCriteria, productSt: 'S',
      customerIgnoreSt: 'S' })).toBe('N')
    expect(resolveEffectiveSt({ ...baseCriteria, productSt: 'S',
      customerIgnoreSt: 'N' })).toBe('S')
    expect(resolveEffectiveSt({ ...baseCriteria, productSt: 'N',
      customerIgnoreSt: 'S' })).toBe('N')
  })

  it('sutileza 3: mesma UF exige estado exato; interestadual aceita coringa', async () => {
    mockQuery.mockResolvedValue([[]])
    await findTaxRule('setes_setes', baseCriteria)          // mesma UF (41=41)
    expect(mockQuery.mock.calls[0][0]).toContain('AND (r.tb_state_id = ?)')
    expect(mockQuery.mock.calls[0][0]).not.toContain('IS NULL)')

    jest.clearAllMocks()
    mockQuery.mockResolvedValue([[]])
    await findTaxRule('setes_setes',
      { ...baseCriteria, destinationStateId: 42 })          // interestadual
    expect(mockQuery.mock.calls[0][0])
      .toContain('AND (r.tb_state_id = ? OR r.tb_state_id IS NULL)')
  })

  it('sutileza 4 (ajuste): CFOP filtra e finalidade é forçada a 0', async () => {
    mockQuery.mockResolvedValue([[]])
    await findTaxRule('setes_setes', { ...baseCriteria, cfopId: '5102' })
    const sql = mockQuery.mock.calls[0][0] as string
    const params = mockQuery.mock.calls[0][1] as any[]
    expect(sql).toContain('AND r.tb_cfop_id = ?')
    expect(params).toContain('0')      // purpose forçada
    expect(params).not.toContain('1')  // a finalidade real do produto não viaja
  })

  it('sutileza 6 (RegraDireta): escolha por item pula a combinação', async () => {
    mockQuery.mockResolvedValue([[{ id: 77, tb_institution_id: 1,
      tb_product_id: null, tb_entity_id: null, ncm: null, origin: '0',
      final_consumer: 'N', simples: 'N', st: 'N', purpose: '1',
      direction: null, tb_cfop_id: null, tb_state_id: null,
      tb_observation_id: null, tb_taxes_id: null }]])
    const rule = await findTaxRule('setes_setes',
      { ...baseCriteria, directRuleId: 77 })
    expect(rule?.id).toBe(77)
    expect(mockQuery.mock.calls[0][0]).toContain('WHERE id = ?')
    expect(mockQuery.mock.calls[0][0]).not.toContain('origin')
  })

  it('RegraDireta é escopada por institution (gate adversarial Onda 1): ' +
     'regra de outro estabelecimento do schema não tributa a nota', async () => {
    mockQuery.mockResolvedValue([[]])
    const rule = await findTaxRule('setes_setes',
      { ...baseCriteria, directRuleId: 77 })
    expect(rule).toBeNull()
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('tb_institution_id = ?')
    expect(mockQuery.mock.calls[0][1]).toEqual([77, baseCriteria.institutionId])
  })

  it('sutilezas 1/2: coringas por NULL e precedência por NCM na ordem', async () => {
    mockQuery.mockResolvedValue([[]])
    await findTaxRule('setes_setes', baseCriteria)
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('(r.tb_product_id IS NULL OR r.tb_product_id = ?)')
    expect(sql).toContain('(r.tb_entity_id IS NULL OR r.tb_entity_id = ?)')
    expect(sql).toContain("(r.ncm IS NULL OR r.ncm = '' OR r.ncm = ?)")
    expect(sql).toContain('ORDER BY r.ncm DESC, r.id')
  })
})

// ---------------------------------------------------------------------
// Desempate (Fc_DefineTributacao com B9 corrigido)
// ---------------------------------------------------------------------

describe('pickRule (desempate)', () => {
  const c = baseCriteria

  it('prioridade: cliente > estado+produto > estado > produto > 1ª da ordem', () => {
    const byEntity = sel({ id: 1, entityId: 55 })
    const byStateProduct = sel({ id: 2, stateId: 41, productId: 10 })
    const byState = sel({ id: 3, stateId: 41 })
    const byProduct = sel({ id: 4, productId: 10 })
    const generic = sel({ id: 5 })

    expect(pickRule([generic, byEntity, byState], c, 41).id).toBe(1)
    expect(pickRule([generic, byState, byStateProduct], c, 41).id).toBe(2)
    expect(pickRule([generic, byState], c, 41).id).toBe(3)
    expect(pickRule([generic, byProduct], c, 41).id).toBe(4)
    expect(pickRule([generic, sel({ id: 6 })], c, 41).id).toBe(5)
  })

  it('B9 corrigido: o fallback por produto usa o PRODUTO, não o código da UF', () => {
    // regra cujo productId coincide com o CÓDIGO DA UF (41=PR) não pode
    // vencer por acidente quando o produto do item é outro
    const trap = sel({ id: 9, productId: 41 })
    const generic = sel({ id: 5 })
    expect(pickRule([generic, trap], { ...c, productId: 10 }, 41).id).toBe(5)
  })
})

// ---------------------------------------------------------------------
// DTO — presença = incidência
// ---------------------------------------------------------------------

describe('taxRuleBodyDto', () => {
  const selector = {
    origin: '0', finalConsumer: 'N', simples: 'N', st: 'N', purpose: '1',
  }

  it('regra sem NENHUMA peça é rejeitada', () => {
    const r = taxRuleBodyDto.safeParse({ selector })
    expect(r.success).toBe(false)
  })

  it('peça ICMS exige CST ou CSOSN', () => {
    const r = taxRuleBodyDto.safeParse({ selector, icms: { aliq: 18 } })
    expect(r.success).toBe(false)
  })

  it('pisCofins não aceita kind repetido', () => {
    const r = taxRuleBodyDto.safeParse({ selector, pisCofins: [
      { kind: 'P', cst: '01' }, { kind: 'P', cst: '02' }] })
    expect(r.success).toBe(false)
  })

  it('regra válida: ICMS por CST + PIS/COFINS gêmeos', () => {
    const r = taxRuleBodyDto.safeParse({ selector,
      icms: { cstNr: '00', aliq: 18 },
      pisCofins: [{ kind: 'P', cst: '01', aliq: 1.65 },
                  { kind: 'C', cst: '01', aliq: 7.6 }] })
    expect(r.success).toBe(true)
  })
})

// ---------------------------------------------------------------------
// Peças — validação de catálogo (decisão 33) e invariantes de gravação
// ---------------------------------------------------------------------

describe('findInvalidCatalogCodes (decisão 33 — integridade na peça)', () => {
  it('CFOP inexistente no catálogo central é apontado como selector.cfopId', async () => {
    mockQuery.mockResolvedValue([[]])   // nenhum código encontrado
    const invalid = await findInvalidCatalogCodes(
      { icms: { cstNr: '00' } as any }, { cfopId: '9999' })
    const fields = invalid.map(i => i.field)
    expect(fields).toContain('selector.cfopId')
    expect(fields).toContain('icms.cstNr')
    // consulta do CFOP vai ao catálogo central com deleted='N'
    const cfopCall = mockQuery.mock.calls.find(
      call => (call[0] as string).includes('tb_cfop'))
    expect(cfopCall).toBeDefined()
    expect(cfopCall![0]).toContain("deleted = 'N'")
    expect(cfopCall![1]).toEqual(['9999'])
  })

  it('códigos existentes passam sem achado', async () => {
    mockQuery.mockResolvedValue([[{ id: '5102' }]])
    const invalid = await findInvalidCatalogCodes(
      { ipi: { cst: '50' } as any }, { cfopId: '5102' })
    expect(invalid).toEqual([])
  })
})

describe('savePieces (invariantes do domínio)', () => {
  it('ICMS-ST sem ICMS próprio é 422 dentro da transação (P3.3)', async () => {
    const conn = { query: jest.fn().mockResolvedValue([{}]) }
    await expect(savePieces(conn, 'setes_setes', 1,
      { icmsSt: { modBcSt: '4' } as any }))
      .rejects.toMatchObject({ statusCode: 422 })
  })
})

// ---------------------------------------------------------------------
// Repositório — lista paginada (D2/D8)
// ---------------------------------------------------------------------

describe('tax-rules repository', () => {
  it('listTaxRules: página e COUNT usam a MESMA where; ordem NCM DESC + id', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ total: 3 }]])
    const result = await repo.listTaxRules('setes_setes', 1,
      { filter: '8471', page: 1, pageSize: 25, offset: 0 } as any)
    expect(result.total).toBe(3)
    const pageSql = mockQuery.mock.calls[0][0] as string
    const countSql = mockQuery.mock.calls[1][0] as string
    expect(pageSql).toContain('ORDER BY r.ncm DESC, r.id')
    // colunas reais dos catálogos centrais (500 do smoke 2026-08-16:
    // tb_state não tem description — o JOIN usa st.name)
    expect(pageSql).toContain('st.name AS stateName')
    expect(countSql).toContain("r.deleted = 'N' AND r.tb_institution_id = ?")
    expect(mockQuery.mock.calls[1][1]).toEqual(
      [1, '%8471%', '%8471%', '%8471%'])
  })
})
