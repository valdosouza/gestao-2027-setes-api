/// <reference types="jest" />
// Pesquisa avançada — Onda 2 (Infra-IA/prompts/prompt_pesquisa_avancada.md §12, D-BA20…D-BA28):
// as listas brancas das telas da fábrica, numa matriz. O que a matriz garante por módulo:
//  - projeção pública sem expressão (D-BA2), labelKey do módulo, lookup do PRÓPRIO módulo (D-BA14);
//  - o fragmento compilado entra DEPOIS do escopo do repository, nos DOIS SELECTs (página e
//    COUNT), com os params na mesma ordem (D2 da paginação) — critério só ESTREITA;
//  - alias interno de subselect nunca colide com o alias da query base (achado do EXPLAIN:
//    `tb_provider p` × `tb_person p` casava a tabela inteira);
//  - toda tela tem o critério de NOME/descrição (D-BA21).
import pool from '../shared/db/connection'
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
import { fetchUserSearchCriteria, fetchInstitutionLookup } from '../modules/users/users.service'
import { USER_KINDS } from '../modules/users/users.dto'
import { PAYMENT_TYPE_KINDS } from '../shared/payment-types'

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
      if (p.kind === 'lookup') expect(p.lookup!.startsWith(`/api/${t.module}/`)).toBe(true)
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
    const [sql] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/LEFT JOIN \(SELECT i\.tb_contract_id, i\.tb_institution_id, SUM\(i\.value\) AS total[\s\S]*WHERE i\.deleted = 'N'/)
    expect(sql).toMatch(/COALESCE\(mv\.total, 0\) AS monthlyValue/)
    expect(sql).toMatch(/AND \(COALESCE\(mv\.total, 0\) >= \?\)/)
    expect(sql).not.toMatch(/SELECT SUM\(i\.value\) FROM/)   // o subselect correlacionado morreu
  })
})
