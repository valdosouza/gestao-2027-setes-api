/// <reference types="jest" />
// Pesquisa avançada — Onda 2 (Infra-IA/prompts/prompt_pesquisa_avancada.md §12, D-BA20…D-BA28):
// as listas brancas das telas da fábrica, numa matriz. O que a matriz garante por módulo:
//  - projeção pública sem expressão (D-BA2), labelKey do módulo, lookup do PRÓPRIO módulo (D-BA14);
//  - o fragmento compilado entra DEPOIS do escopo do repository, nos DOIS SELECTs (página e
//    COUNT), com os params na mesma ordem (D2 da paginação) — critério só ESTREITA;
//  - alias interno de subselect nunca colide com o alias da query base (achado do EXPLAIN:
//    `tb_provider p` × `tb_person p` casava a tabela inteira);
//  - toda tela tem o critério de NOME/descrição (D-BA21).
import { Request } from 'express'
import pool from '../shared/db/connection'
import { parseOptionalQueryId } from '../shared/http/controller-utils'
import { compileCriteria, publicCriteria, SearchCriterion, ListQuery } from '../shared/list'
import { RESERVED_ALIASES } from '../shared/entity'
import { CUSTOMER_SEARCH_CRITERIA, listCustomers } from '../modules/customers/customers.repository'
import { CARRIER_SEARCH_CRITERIA, listCarriers } from '../modules/carriers/carriers.repository'
import { COLLABORATOR_SEARCH_CRITERIA, listCollaborators } from '../modules/collaborators/collaborators.repository'
import { PROVIDER_SEARCH_CRITERIA, listProviders } from '../modules/providers/providers.repository'
import { SALESMAN_SEARCH_CRITERIA, listSalesmen } from '../modules/salesmen/salesmen.repository'
import { INSTITUTION_SEARCH_CRITERIA, listInstitutions } from '../modules/institutions/institutions.repository'
import { BANK_ACCOUNT_SEARCH_CRITERIA, listBankAccounts } from '../modules/bank-accounts/bank-accounts.repository'
import {
  CHARGE_AGREEMENT_SEARCH_CRITERIA, listChargeAgreements,
} from '../modules/bank-charge-agreements/bank-charge-agreements.repository'
import {
  SETTLEMENT_RULE_SEARCH_CRITERIA, listSettlementRules,
} from '../modules/settlement-rules/settlement-rules.repository'
import { PAYMENT_TYPE_SEARCH_CRITERIA, listLinked } from '../modules/payment-types/payment-types.repository'
import { PRICE_LIST_SEARCH_CRITERIA, listPriceLists } from '../modules/price-lists/price-lists.repository'
import { SERVICE_SEARCH_CRITERIA, listServices } from '../modules/services/services.repository'
import { USER_SEARCH_CRITERIA, USER_INSTITUTION_IDS, listUsers, listInstitutionLookup } from '../modules/users/users.repository'
import { CONTRACT_SEARCH_CRITERIA, listContracts, listCustomerLookup } from '../modules/contracts/contracts.repository'
import { fetchUserSearchCriteria, fetchInstitutionLookup, userSearchCriteriaFor } from '../modules/users/users.service'
import { USER_KINDS } from '../modules/users/users.dto'
import { PAYMENT_TYPE_KINDS } from '../shared/payment-types'
import { TAX_RULE_SEARCH_CRITERIA, listTaxRules } from '../modules/tax-rules/tax-rules.repository'
import {
  SERVICE_TAX_RULE_SEARCH_CRITERIA, listServiceTaxRules,
} from '../modules/service-tax-rules/service-tax-rules.repository'
import { CFOP_SEARCH_CRITERIA, listCfop } from '../modules/cfop/cfop.repository'
import { CITY_SEARCH_CRITERIA, listCities } from '../modules/cities/cities.repository'
import { STATE_SEARCH_CRITERIA, listStates } from '../modules/states/states.repository'
import { SERVICE_LIST_SEARCH_CRITERIA, listServiceList } from '../modules/service-list/service-list.repository'
import { INTERFACE_SEARCH_CRITERIA, listInterfaces } from '../modules/interfaces/interfaces.repository'
import { COUNTRY_SEARCH_CRITERIA, listCountries } from '../modules/countries/countries.repository'
import { BANK_SEARCH_CRITERIA, listBanks } from '../modules/banks/banks.repository'
import { PRIVILEGE_SEARCH_CRITERIA, listPrivileges } from '../modules/privileges/privileges.repository'
import { MODULE_SEARCH_CRITERIA, listModules } from '../modules/modules/modules.repository'
import { vitrineSearchCriteria, listVitrine } from '../shared/interface-vitrine'
import { ORDER_SEARCH_CRITERIA, listOrders as listSaleOrders } from '../modules/orders/orders.repository'
import { ORDER_RETURN_SEARCH_CRITERIA, listReturns } from '../modules/order-returns/order-returns.repository'
import { BILL_SEARCH_CRITERIA, SETTLED_SEARCH_CRITERIA, listBills, listSettled } from '../modules/settlements/settlements.repository'
import { BANK_SLIP_SEARCH_CRITERIA, listBankSlips } from '../modules/bank-slips/bank-slips.repository'
import { CHECK_SEARCH_CRITERIA, listChecks } from '../modules/checks/checks.repository'
import { TAX_RULE_ORIGINS, TAX_RULE_PURPOSES } from '../modules/tax-rules/tax-rules.dto'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockQuery = (pool as any).query as jest.Mock
const SCHEMA = 'setes_acme'
const INST = 7

interface Target {
  module: string
  defs:   readonly SearchCriterion[]
  /** alias da tabela que dirige a query base (o que os subselects correlacionam) */
  alias:  string
  /** chave do critério de NOME/descrição (D-BA21) */
  name:   string
  run:    (q: ListQuery) => Promise<unknown>
  /** caminho base dos lookups quando o módulo tem MAIS de uma lista (ex.: /api/settlements/bills/) */
  lookupBase?: string
}

const TARGETS: Target[] = [
  { module: 'customers', defs: CUSTOMER_SEARCH_CRITERIA, alias: 'c', name: 'name',
    run: q => listCustomers(q, SCHEMA, INST, null) },
  { module: 'carriers', defs: CARRIER_SEARCH_CRITERIA, alias: 'c', name: 'name',
    run: q => listCarriers(q, SCHEMA, INST) },
  { module: 'collaborators', defs: COLLABORATOR_SEARCH_CRITERIA, alias: 'c', name: 'name',
    run: q => listCollaborators(q, SCHEMA, INST) },
  { module: 'providers', defs: PROVIDER_SEARCH_CRITERIA, alias: 'p', name: 'name',
    run: q => listProviders(q, SCHEMA, INST) },
  { module: 'salesmen', defs: SALESMAN_SEARCH_CRITERIA, alias: 's', name: 'name',
    run: q => listSalesmen(q, SCHEMA, INST) },
  { module: 'institutions', defs: INSTITUTION_SEARCH_CRITERIA, alias: 'i', name: 'name',
    run: q => listInstitutions(q) },
  { module: 'bank-accounts', defs: BANK_ACCOUNT_SEARCH_CRITERIA, alias: 'a', name: 'bankName',
    run: q => listBankAccounts(q, SCHEMA, INST) },
  { module: 'bank-charge-agreements', defs: CHARGE_AGREEMENT_SEARCH_CRITERIA, alias: 'ag', name: 'agreement',
    run: q => listChargeAgreements(q, SCHEMA, INST) },
  { module: 'settlement-rules', defs: SETTLEMENT_RULE_SEARCH_CRITERIA, alias: 'c', name: 'paymentTypeName',
    run: q => listSettlementRules(q, SCHEMA, INST) },
  { module: 'payment-types', defs: PAYMENT_TYPE_SEARCH_CRITERIA, alias: 'h', name: 'description',
    run: q => listLinked(q, SCHEMA, INST) },
  { module: 'price-lists', defs: PRICE_LIST_SEARCH_CRITERIA, alias: 'l', name: 'description',
    run: q => listPriceLists(q, SCHEMA, INST) },
  { module: 'services', defs: SERVICE_SEARCH_CRITERIA, alias: 'p', name: 'description',
    run: q => listServices(q, SCHEMA, INST) },
  { module: 'users', defs: USER_SEARCH_CRITERIA, alias: 'u', name: 'name',
    run: q => listUsers(q, INST) },
  { module: 'contracts', defs: CONTRACT_SEARCH_CRITERIA, alias: 'c', name: 'customerName',
    run: q => listContracts(q, SCHEMA, INST) },
  // --- Bloco 2 (alias '' = tabela base sem alias nos catálogos pequenos)
  { module: 'tax-rules', defs: TAX_RULE_SEARCH_CRITERIA, alias: 'r', name: 'productName',
    run: q => listTaxRules(SCHEMA, INST, q) },
  { module: 'service-tax-rules', defs: SERVICE_TAX_RULE_SEARCH_CRITERIA, alias: 'r', name: 'serviceListName',
    run: q => listServiceTaxRules(q, SCHEMA, INST) },
  { module: 'cfop', defs: CFOP_SEARCH_CRITERIA, alias: 'c', name: 'description', run: q => listCfop(q) },
  { module: 'cities', defs: CITY_SEARCH_CRITERIA, alias: 'c', name: 'name', run: q => listCities(q) },
  { module: 'states', defs: STATE_SEARCH_CRITERIA, alias: 's', name: 'name', run: q => listStates(q) },
  { module: 'service-list', defs: SERVICE_LIST_SEARCH_CRITERIA, alias: 's', name: 'description', run: q => listServiceList(q) },
  { module: 'interfaces', defs: INTERFACE_SEARCH_CRITERIA, alias: 'i', name: 'description', run: q => listInterfaces(q) },
  { module: 'countries', defs: COUNTRY_SEARCH_CRITERIA, alias: '', name: 'name', run: q => listCountries(q) },
  { module: 'banks', defs: BANK_SEARCH_CRITERIA, alias: '', name: 'description', run: q => listBanks(q) },
  { module: 'privileges', defs: PRIVILEGE_SEARCH_CRITERIA, alias: '', name: 'description', run: q => listPrivileges(q) },
  { module: 'modules', defs: MODULE_SEARCH_CRITERIA, alias: 'm', name: 'description', run: q => listModules(SCHEMA, q) },
  { module: 'interface-configs', defs: vitrineSearchCriteria('interface-configs'), alias: 'i', name: 'name',
    run: q => listVitrine(q, SCHEMA, INST) },
  { module: 'interface-fields', defs: vitrineSearchCriteria('interface-fields'), alias: 'i', name: 'name',
    run: q => listVitrine(q, SCHEMA, INST) },
  // --- Onda 3, Bloco A (telas de processo — a aba `status` segue como parâmetro, aqui '' = todas)
  { module: 'orders', defs: ORDER_SEARCH_CRITERIA, alias: 's', name: 'customerName',
    run: q => listSaleOrders('', q, SCHEMA, INST) },
  { module: 'order-returns', defs: ORDER_RETURN_SEARCH_CRITERIA, alias: 'r', name: 'customerName',
    run: q => listReturns('', q, SCHEMA, INST) },
  // --- Onda 3, Bloco B (financeiro)
  { module: 'settlements-bills', defs: BILL_SEARCH_CRITERIA, alias: 'f', name: 'entityName',
    lookupBase: '/api/settlements/bills/', run: q => listBills('', '', q, SCHEMA, INST) },
  { module: 'settlements-settled', defs: SETTLED_SEARCH_CRITERIA, alias: 'p', name: 'entityName',
    lookupBase: '/api/settlements/settled/', run: q => listSettled(q, SCHEMA, INST) },
  { module: 'bank-slips', defs: BANK_SLIP_SEARCH_CRITERIA, alias: 'bs', name: 'customerName',
    run: q => listBankSlips('', q, SCHEMA, INST) },
  { module: 'checks', defs: CHECK_SEARCH_CRITERIA, alias: 'c', name: 'issuer',
    run: q => listChecks('', q, SCHEMA, INST) },
]

function sampleFor(def: SearchCriterion): unknown {
  switch (def.kind) {
    case 'text':    return def.digits ? '12345678901' : 'abc'
    case 'number':  return { from: 1, to: 10 }
    case 'money':   return { from: 1, to: 1000 }
    case 'date':    return { from: '2026-01-01', to: '2026-12-31' }
    case 'lookup':  return 5
    case 'options': return [def.options![0]]
    case 'bool':    return true
  }
}

/** aliases declarados DENTRO das expressões (FROM/JOIN tabela alias) */
function innerAliases(expr: string | readonly string[]): string[] {
  const text = Array.isArray(expr) ? expr.join(' ') : String(expr)
  return [...text.matchAll(/(?:FROM|JOIN)\s+[`\w.$]+\s+(\w+)/g)].map(m => m[1])
}

beforeEach(() => jest.clearAllMocks())

describe.each(TARGETS.map(t => [t.module, t] as const))('Onda 2 — %s', (_name, t) => {
  it('projeção pública sem expressão; labelKey e lookup do PRÓPRIO módulo (D-BA2/D-BA14)', () => {
    const keys = t.defs.map(d => d.key)
    expect(new Set(keys).size).toBe(keys.length)
    const pub = publicCriteria(t.defs)
    expect(pub).toHaveLength(t.defs.length)
    for (const p of pub) {
      expect(p).not.toHaveProperty('expr')
      expect(p).not.toHaveProperty('boolValues')
      expect(p.labelKey).toBe(`search.${t.module}.${p.key}`)
      if (p.kind === 'lookup') expect(p.lookup!.startsWith(t.lookupBase ?? `/api/${t.module}/`)).toBe(true)
      if (p.kind === 'options') expect(p.options!.length).toBeGreaterThan(0)
    }
  })

  it('D-BA21: o critério de NOME/descrição existe e é texto', () => {
    const name = t.defs.find(d => d.key === t.name)
    expect(name?.kind).toBe('text')
  })

  it('alias interno dos subselects não colide com o alias da query base', () => {
    for (const d of t.defs) {
      for (const inner of innerAliases(d.expr)) {
        expect(inner).not.toBe(t.alias)
        expect(inner).not.toBe('e')   // tb_entity juntada na query base dos papéis
      }
    }
    expect(RESERVED_ALIASES.has(t.alias)).toBe(false)
  })

  it('fragmento compilado DEPOIS do escopo, nos dois SELECTs, params na mesma ordem (D2)', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    const values = Object.fromEntries(t.defs.map(d => [d.key, sampleFor(d)]))
    const criteria = compileCriteria(JSON.stringify(values), t.defs)
    expect(criteria.applied.sort()).toEqual(t.defs.map(d => d.key).sort())
    await t.run({ filter: '', page: 1, pageSize: 25, offset: 0, criteria })

    expect(mockQuery).toHaveBeenCalledTimes(2)
    const [pageSql, pageParams] = mockQuery.mock.calls[0]
    const [countSql, countParams] = mockQuery.mock.calls[1]
    // o AND dos critérios vem depois do WHERE do repository
    expect(pageSql.indexOf(criteria.sql)).toBeGreaterThan(pageSql.indexOf('WHERE'))
    expect(countSql).toContain(criteria.sql)
    expect(countSql.startsWith('SELECT COUNT(*)')).toBe(true)
    // params do COUNT = prefixo dos da página (que só acrescenta LIMIT/OFFSET)
    expect(countParams).toEqual(pageParams.slice(0, countParams.length))
    expect(pageParams.slice(-2)).toEqual([25, 0])
    // os params dos critérios são os últimos antes do LIMIT/OFFSET
    const n = criteria.params.length
    expect(pageParams.slice(-2 - n, -2)).toEqual(criteria.params)
  })

  it('sem critério = o MESMO SQL de antes, só sem o fragmento (tela sem pesquisa avançada não muda)', async () => {
    mockQuery.mockResolvedValue([[{ total: 0 }]])
    const values = Object.fromEntries(t.defs.map(d => [d.key, sampleFor(d)]))
    const withCriteria = compileCriteria(JSON.stringify(values), t.defs)
    await t.run({ filter: '', page: 1, pageSize: 25, offset: 0, criteria: withCriteria })
    const [withSql, withParams] = mockQuery.mock.calls[0]
    mockQuery.mockClear()
    await t.run({ filter: '', page: 1, pageSize: 25, offset: 0, criteria: compileCriteria(undefined, t.defs) })
    const [plainSql, plainParams] = mockQuery.mock.calls[0]
    expect(withSql.replace(withCriteria.sql, '')).toBe(plainSql)
    const n = withCriteria.params.length
    expect([...withParams.slice(0, -2 - n), ...withParams.slice(-2)]).toEqual(plainParams)
  })
})

describe('domínios reutilizados (skill novo-modulo: options = constante do domínio)', () => {
  it('payment-types.kind usa o domínio da migration 027', () => {
    const kind = PAYMENT_TYPE_SEARCH_CRITERIA.find(d => d.key === 'kind')!
    expect(kind.options).toEqual(PAYMENT_TYPE_KINDS)
    expect(PAYMENT_TYPE_KINDS).toEqual(['E', 'X', 'Q', 'B', 'W', 'C', 'O'])
  })

  it('payment-types.enable protege a palavra reservada com crase', () => {
    const enable = PAYMENT_TYPE_SEARCH_CRITERIA.find(d => d.key === 'enable')!
    expect(enable.expr).toBe('h.`enable`')
  })

  it('users.kind usa o domínio tipado do DTO (D-BA23)', () => {
    const kind = USER_SEARCH_CRITERIA.find(d => d.key === 'kind')!
    expect(kind.options).toEqual(USER_KINDS)
    expect(USER_KINDS).toEqual(['user', 'admin', 'super'])
  })
})

describe("peça — shape 'set' (parecer do guardião, Onda 2): pertinência a um CONJUNTO", () => {
  const DEFS: SearchCriterion[] = [
    { key: 'inst', kind: 'lookup', labelKey: 'x', shape: 'set', expr: '(SELECT z.i FROM z WHERE z.u = u.id)', lookup: '/api/users/institution-lookup' },
    { key: 'plain', kind: 'lookup', labelKey: 'x', expr: 'c.sid', lookup: '/api/x/y' },
  ]

  it("lookup escalar = igualdade; shape 'set' = `? IN (expr)`", () => {
    const c = compileCriteria(JSON.stringify({ inst: 3, plain: 4 }), DEFS)
    expect(c.sql).toBe(' AND (? IN (SELECT z.i FROM z WHERE z.u = u.id) AND c.sid = ?)')
    expect(c.params).toEqual([3, 4])
  })

  it("shape 'set' fora de lookup é erro de DECLARAÇÃO (não 400/422 do usuário)", () => {
    const bad: SearchCriterion[] = [{ key: 'k', kind: 'options', labelKey: 'x', shape: 'set', expr: 'c.k', options: ['A'] }]
    expect(() => compileCriteria(JSON.stringify({ k: ['A'] }), bad)).toThrow(/shape 'set'/)
  })

  it('shape não vaza na projeção pública (o app não precisa saber a forma)', () => {
    expect(publicCriteria(DEFS)[0]).not.toHaveProperty('shape')
  })

  it('users.institution: conjunto ESCOPADO do vínculo (active + deleted) — teste de escopo da D-BA13', () => {
    expect(USER_INSTITUTION_IDS).toMatch(/uih\.active = 'S'/)
    expect(USER_INSTITUTION_IDS).toMatch(/uih\.deleted = 'N'/)
    expect(USER_INSTITUTION_IDS).toMatch(/uih\.tb_user_id = u\.id/)
    const inst = USER_SEARCH_CRITERIA.find(d => d.key === 'institution')!
    expect(inst.shape).toBe('set')
    const c = compileCriteria(JSON.stringify({ institution: 9 }), USER_SEARCH_CRITERIA)
    expect(c.sql).toBe(` AND (? IN ${USER_INSTITUTION_IDS})`)
  })
})

describe('users — critérios de VÍNCULO só com vínculo (parecer do guardião) e "instituição" só Super (D-BA24)', () => {
  const admin = { isSuper: false, institutionId: 7, schemaName: SCHEMA }
  const sup   = { isSuper: true,  institutionId: 1, schemaName: 'setes_setes' }

  it('admin: kind servido (foco = a própria institution), institution NÃO', async () => {
    const keys = (await fetchUserSearchCriteria(admin, null)).map(c => c.key)
    expect(keys).toContain('kind')
    expect(keys).not.toContain('institution')
    // o institutionId pedido pelo admin é ignorado — vale o JWT
    expect((await fetchUserSearchCriteria(admin, 99)).map(c => c.key)).toEqual(keys)
  })

  it('super SEM foco: institution servido, kind NÃO (atributo de vínculo exige vínculo)', async () => {
    const keys = (await fetchUserSearchCriteria(sup, null)).map(c => c.key)
    expect(keys).toContain('institution')
    expect(keys).not.toContain('kind')
  })

  it('super COM foco: os dois', async () => {
    const keys = (await fetchUserSearchCriteria(sup, 7)).map(c => c.key)
    expect(keys).toEqual(expect.arrayContaining(['institution', 'kind']))
  })

  it('lookup de instituições: 403 para quem não é Super; Super lista por nome', async () => {
    await expect(fetchInstitutionLookup(admin, 'x')).rejects.toMatchObject({ statusCode: 403 })
    mockQuery.mockResolvedValueOnce([[{ id: 1, name: 'Setes' }]])
    expect(await fetchInstitutionLookup(sup, 'se')).toEqual([{ id: 1, name: 'Setes' }])
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/i\.deleted = 'N'/)
    expect(params).toEqual(['%se%', '%se%', '%se%'])
  })

  it('lista: o vínculo em foco é LEFT JOIN 1:1 — coluna kind e critério kind são a mesma expressão', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    const criteria = compileCriteria(JSON.stringify({ kind: ['admin'] }), USER_SEARCH_CRITERIA)
    await listUsers({ filter: '', page: 1, pageSize: 25, offset: 0, criteria }, 7)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/LEFT JOIN setes_central\.tb_institution_has_user ihu[\s\S]*ihu\.tb_institution_id = \?/)
    expect(sql).toMatch(/ihu\.kind\s/)
    expect(sql).not.toMatch(/SELECT ihu\.kind FROM/)   // o subselect correlacionado morreu
    expect(params).toEqual([7, '', '%%', '%%', '%%', 7, 'admin', 25, 0])
  })

  it('catálogo servido = catálogo aceito: admin mandando "institution" (não servido) = 400, não lista', () => {
    const defs = userSearchCriteriaFor(admin, null)
    expect(defs.map(d => d.key)).not.toContain('institution')
    expect(() => compileCriteria(JSON.stringify({ institution: 7 }), defs)).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'SEARCH_CRITERIA_INVALID' }))
    // super sem foco mandando kind = idem (atributo de vínculo sem vínculo não é "lista vazia")
    expect(() => compileCriteria(JSON.stringify({ kind: ['admin'] }), userSearchCriteriaFor(sup, null)))
      .toThrow(expect.objectContaining({ statusCode: 400 }))
    // com foco, aceito
    expect(compileCriteria(JSON.stringify({ kind: ['admin'] }), userSearchCriteriaFor(sup, 7)).applied).toEqual(['kind'])
  })

  it('listInstitutionLookup escapa o LIKE', async () => {
    mockQuery.mockResolvedValueOnce([[]])
    await listInstitutionLookup('50%_a')
    expect(mockQuery.mock.calls[0][1][0]).toBe('%50\\%\\_a%')
  })
})

describe('contracts — cliente pela carteira (D-BA27) e valor mensal pelo alias mv', () => {
  it('lookup de cliente carrega a carteira do vendedor nos params (NULL = sem trava)', async () => {
    mockQuery.mockResolvedValueOnce([[]])
    await listCustomerLookup('k2', SCHEMA, INST, 42)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/cu\.tb_institution_id = \? AND cu\.deleted = 'N'/)
    expect(sql).toMatch(/\(\? IS NULL OR cu\.tb_salesman_id = \?\)/)
    expect(params).toEqual([INST, '%k2%', '%k2%', '%k2%', 42, 42])
  })

  it('valor mensal: derived table 1:1 na query base — coluna e critério usam mv.total', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    const criteria = compileCriteria(JSON.stringify({ monthlyValue: { from: 100 } }), CONTRACT_SEARCH_CRITERIA)
    await listContracts({ filter: '', page: 1, pageSize: 25, offset: 0, criteria }, SCHEMA, INST)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/LEFT JOIN \(SELECT i\.tb_contract_id, i\.tb_institution_id, SUM\(i\.value\) AS total[\s\S]*WHERE i\.tb_institution_id = \? AND i\.deleted = 'N'/)
    expect(params.slice(0, 2)).toEqual([INST, INST])   // derived table escopada + where da lista
    expect(sql).toMatch(/COALESCE\(mv\.total, 0\) AS monthlyValue/)
    expect(sql).toMatch(/AND \(COALESCE\(mv\.total, 0\) >= \?\)/)
    expect(sql).not.toMatch(/SELECT SUM\(i\.value\) FROM/)   // o subselect correlacionado morreu
  })
})

describe('Bloco 2 — tax-rules: derivados por LEFT JOIN (D-BA22) e domínios do DTO', () => {
  it('origem e finalidade reusam as constantes do DTO', () => {
    expect(TAX_RULE_SEARCH_CRITERIA.find(d => d.key === 'origin')!.options).toEqual(TAX_RULE_ORIGINS)
    expect(TAX_RULE_SEARCH_CRITERIA.find(d => d.key === 'purpose')!.options).toEqual(TAX_RULE_PURPOSES)
  })

  it('hasIcms = presença do filho: coluna da linha e critério são a MESMA expressão; HAS() correlacionado morreu', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    const criteria = compileCriteria(JSON.stringify({ hasIcms: true, hasIi: false }), TAX_RULE_SEARCH_CRITERIA)
    await listTaxRules(SCHEMA, INST, { filter: '', page: 1, pageSize: 25, offset: 0, criteria })
    const [sql] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/LEFT JOIN `setes_acme`\.tb_tax_rule_icms icms ON icms\.id = r\.id AND icms\.deleted = 'N'/)
    expect(sql).toMatch(/\(icms\.id IS NOT NULL\)\s+AS hasIcms/)
    expect(sql).not.toMatch(/EXISTS \(SELECT 1 FROM `setes_acme`\.tb_tax_rule_icms/)
    expect(criteria.sql).toContain('icms.id IS NOT NULL')
    expect(criteria.sql).toContain('ii.id IS NOT NULL')
  })

  it('PIS/COFINS (PK id+kind, 1:N) entra AGRUPADO — o COUNT não duplica a regra', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    await listTaxRules(SCHEMA, INST, {
      filter: '', page: 1, pageSize: 25, offset: 0, criteria: compileCriteria(undefined, TAX_RULE_SEARCH_CRITERIA),
    })
    const [countSql] = mockQuery.mock.calls[1]
    expect(countSql).toMatch(/LEFT JOIN \(SELECT pc0\.id FROM `setes_acme`\.tb_tax_rule_pis_cofins pc0 WHERE pc0\.deleted = 'N' GROUP BY pc0\.id\) pc/)
  })
})

describe('gate adversarial do Bloco 2 (2026-10-03)', () => {
  it('parseOptionalQueryId: ausente = null; id válido passa; lixo = 400 com fields[] (era NaN no SQL → 500)', () => {
    const req = (q: Record<string, unknown>) => ({ query: q }) as unknown as Request
    expect(parseOptionalQueryId(req({}), 'stateId')).toBeNull()
    expect(parseOptionalQueryId(req({ stateId: '' }), 'stateId')).toBeNull()
    expect(parseOptionalQueryId(req({ stateId: '41' }), 'stateId')).toBe(41)
    for (const bad of ['abc', '-1', '0', '1.5', '1e3', ' 7', '99999999999999999999']) {
      expect(() => parseOptionalQueryId(req({ stateId: bad }), 'stateId')).toThrow(
        expect.objectContaining({ statusCode: 400, fields: [expect.objectContaining({ field: 'stateId' })] }))
    }
    expect(() => parseOptionalQueryId(req({ stateId: ['1', '2'] }), 'stateId')).toThrow(expect.objectContaining({ statusCode: 400 }))
  })

  it("cfop.active: ativo = 'S' (coluna nullable com '' residual) — sim + não cobre TODAS as linhas", () => {
    const yes = compileCriteria(JSON.stringify({ active: true }), CFOP_SEARCH_CRITERIA)
    const no  = compileCriteria(JSON.stringify({ active: false }), CFOP_SEARCH_CRITERIA)
    expect(yes.sql).toBe(" AND ((COALESCE(c.active, 'N') = 'S'))")
    expect(no.sql).toBe(" AND (NOT (COALESCE(c.active, 'N') = 'S'))")
  })
})

describe('Onda 3 / Bloco A — pedidos e devoluções', () => {
  it('D-BA41: "tem serviço" = LEFT JOIN 1:1 do ramo; coluna e critério são a MESMA expressão; o EXISTS do SELECT morreu', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    const criteria = compileCriteria(JSON.stringify({ hasService: true }), ORDER_SEARCH_CRITERIA)
    await listSaleOrders('A', { filter: '', page: 1, pageSize: 25, offset: 0, criteria }, SCHEMA, INST)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/LEFT JOIN `setes_acme`\.tb_order_service os\s+ON os\.id = s\.id AND os\.tb_institution_id = s\.tb_institution_id\s+AND os\.terminal = s\.terminal AND os\.deleted = 'N'/)
    expect(sql).toMatch(/\(os\.id IS NOT NULL\) AS hasService/)
    expect(sql).not.toMatch(/EXISTS\(SELECT 1 FROM `setes_acme`\.tb_order_service/)
    expect(criteria.sql).toBe(' AND ((os.id IS NOT NULL))')
    // a aba (status) continua na where ANTES do critério — D-BA33
    expect(params.slice(0, 4)).toEqual([INST, 'A', 'A', 'A'])
  })

  it('nota e negociação também 1:1 pela PK (nunca duplicam o COUNT)', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    await listSaleOrders('', { filter: '', page: 1, pageSize: 25, offset: 0, criteria: compileCriteria(undefined, ORDER_SEARCH_CRITERIA) }, SCHEMA, INST)
    const [countSql] = mockQuery.mock.calls[1]
    expect(countSql).toMatch(/tb_invoice inv\s+ON inv\.id = s\.id AND inv\.tb_institution_id = s\.tb_institution_id\s+AND inv\.terminal = s\.terminal/)
    expect(countSql).toMatch(/tb_order_billing ob\s+ON ob\.id = s\.id AND ob\.tb_institution_id = s\.tb_institution_id\s+AND ob\.terminal = s\.terminal/)
  })
})

describe('Onda 3 / Bloco B — títulos pela forma de LISTA da peça do saldo (D-BA37, parecer do guardião)', () => {
  it('a aba virou predicado do WHERE sobre o alias `pp`; sem HAVING; COUNT simples; ordem dos `?` fixada', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    const criteria = compileCriteria(JSON.stringify({ balance: { from: 10 } }), BILL_SEARCH_CRITERIA)
    await listBills('open', 'RA', { filter: 'x', page: 1, pageSize: 25, offset: 0, criteria }, SCHEMA, INST)
    const [sql, params] = mockQuery.mock.calls[0]
    const [countSql, countParams] = mockQuery.mock.calls[1]
    expect(sql).not.toMatch(/HAVING/)
    expect(sql).toMatch(/AND GREATEST\(ROUND\(f\.tag_value - COALESCE\(pp\.principal_paid, 0\), 2\), 0\) > 0/)
    expect(countSql.startsWith('SELECT COUNT(*) AS total FROM `setes_acme`.tb_financial f')).toBe(true)
    // derived table (institution) ANTES do WHERE: [inst(pp), inst(f), kind, kind, like×4, ...critério]
    expect(params.slice(0, 8)).toEqual([INST, INST, 'RA', 'RA', '%x%', '%x%', '%x%', '%x%'])
    expect(countParams).toEqual(params.slice(0, countParams.length))
    expect(criteria.sql).toBe(' AND (GREATEST(ROUND(f.tag_value - COALESCE(pp.principal_paid, 0), 2), 0) >= ?)')
  })

  it('a aba "Baixados" filtra principal coberto > 0 (estornada sai, como antes)', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    await listBills('settled', '', { filter: '', page: 1, pageSize: 25, offset: 0, criteria: compileCriteria(undefined, BILL_SEARCH_CRITERIA) }, SCHEMA, INST)
    expect(mockQuery.mock.calls[0][0]).toMatch(/AND COALESCE\(pp\.principal_paid, 0\) > 0/)
  })

  it('boletos: clientes de TODOS os títulos por derived table `sc` escopada (`?` antes do WHERE)', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    const criteria = compileCriteria(JSON.stringify({ customerName: 'k2' }), BANK_SLIP_SEARCH_CRITERIA)
    await listBankSlips('', { filter: '', page: 1, pageSize: 25, offset: 0, criteria }, SCHEMA, INST)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/GROUP BY t\.tb_institution_id, t\.tb_bank_slip_id\) sc\s+ON sc\.tb_institution_id = bs\.tb_institution_id AND sc\.tb_bank_slip_id = bs\.id/)
    expect(params.slice(0, 2)).toEqual([INST, INST])
    expect(criteria.sql).toBe(' AND ((sc.customer_names LIKE ?))')   // texto = grupo OU (aqui 1 expressão)
  })
})
