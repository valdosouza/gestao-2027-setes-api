/// <reference types="jest" />
// Pesquisa avançada (Infra-IA/prompts/prompt_pesquisa_avancada.md, D-BA1…D-BA15):
// peça @shared/list/search-criteria + pilotos customers e service-orders.
import { Request } from 'express'
import pool from '../shared/db/connection'
import {
  compileCriteria, parseListQuery, publicCriteria, NO_CRITERIA,
  SearchCriterion, MAX_CRITERIA_LENGTH,
} from '../shared/list'
import { CUSTOMER_SEARCH_CRITERIA, listCustomers } from '../modules/customers/customers.repository'
import {
  SERVICE_ORDER_SEARCH_CRITERIA, listOrders,
} from '../modules/service-orders/service-orders.repository'
import * as configRepo from '../shared/interface-config/interface-config.repository'
import * as fieldConfigRepo from '../shared/field-config/field-config.repository'
import * as sessionRepo from '../shared/session-context/session-context.repository'
import { invalidateInterfaceConfig } from '../shared/interface-config/interface-config.service'
import { invalidateSessionContext } from '../shared/session-context/session-context.service'
import { fetchCustomerSearchCriteria } from '../modules/customers/customers.service'
import { fetchCustomerLookup } from '../modules/service-orders/service-orders.service'
import { dayStartUtc, nextDay, todayIn, isValidTimeZone } from '../shared/time-zone'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
jest.mock('../shared/interface-config/interface-config.repository')
jest.mock('../shared/field-config/field-config.repository')
jest.mock('../shared/session-context/session-context.repository')

const mockQuery = (pool as any).query as jest.Mock

const DEFS: SearchCriterion[] = [
  { key: 'name',   kind: 'text',    labelKey: 'x', expr: ['e.a', 'e.b'] },
  { key: 'doc',    kind: 'text',    labelKey: 'x', expr: 'p.cpf', digits: true },
  { key: 'qty',    kind: 'number',  labelKey: 'x', expr: 'i.qty' },
  { key: 'value',  kind: 'money',   labelKey: 'x', expr: 't.v' },
  { key: 'when',   kind: 'date',    labelKey: 'x', expr: 'o.dt' },
  { key: 'seller', kind: 'lookup',  labelKey: 'x', expr: 'c.sid', lookup: '/api/x/seller-lookup' },
  { key: 'kind',   kind: 'options', labelKey: 'x', expr: 'c.k', options: ['F', 'J', 'N'] },
  { key: 'active', kind: 'bool',    labelKey: 'x', expr: 'c.active', boolValues: ['S', 'N'] },
  { key: 'open',   kind: 'bool',    labelKey: 'x', expr: "EXISTS (SELECT 1 FROM t WHERE t.id = c.id)" },
]

const json = (v: unknown) => JSON.stringify(v)

function reqOf(query: Record<string, unknown>): Request {
  return { query } as unknown as Request
}

beforeEach(() => jest.clearAllMocks())

describe('compileCriteria — o tipo decide o operador (D-BA4), tudo em E (D-BA5)', () => {
  it('sem criteria = nenhum fragmento', () => {
    expect(compileCriteria(undefined, DEFS)).toBe(NO_CRITERIA)
    expect(compileCriteria('', DEFS)).toBe(NO_CRITERIA)
  })

  it('texto = contém com escapeLike, várias expressões em OU', () => {
    const c = compileCriteria(json({ name: '50%_x' }), DEFS)
    expect(c.sql).toBe(' AND ((e.a LIKE ? OR e.b LIKE ?))')
    expect(c.params).toEqual(['%50\\%\\_x%', '%50\\%\\_x%'])
  })

  it('texto de documento compara só dígitos', () => {
    const c = compileCriteria(json({ doc: '123.456.789-0' }), DEFS)
    expect(c.params).toEqual(['%1234567890%'])
  })

  it('faixas: número, dinheiro normalizado pela peça money e data com fim inclusivo', () => {
    const c = compileCriteria(json({
      qty: { from: 2 }, value: { from: '9.995', to: 20 }, when: { from: '2026-09-01', to: '2026-09-30' },
    }), DEFS)
    expect(c.sql).toBe(' AND (i.qty >= ? AND t.v >= ? AND t.v <= ? AND o.dt >= ? AND o.dt < DATE_ADD(?, INTERVAL 1 DAY))')
    expect(c.params).toEqual([2, 10, 20, '2026-09-01', '2026-09-30'])
  })

  it('lookup = igualdade; options = IN sem repetição; bool com valores e bool derivado', () => {
    const c = compileCriteria(json({ seller: 5, kind: ['F', 'J', 'F'], active: false, open: true }), DEFS)
    expect(c.sql).toBe(' AND (c.sid = ? AND c.k IN (?, ?) AND c.active = ? AND (EXISTS (SELECT 1 FROM t WHERE t.id = c.id)))')
    expect(c.params).toEqual([5, 'F', 'J', 'N'])
    expect(compileCriteria(json({ open: false }), DEFS).sql).toContain('NOT (EXISTS')
  })

  it('valor vazio = critério não informado', () => {
    expect(compileCriteria(json({ name: '  ', kind: [], qty: { from: null, to: '' }, seller: null }), DEFS))
      .toBe(NO_CRITERIA)
  })

  it('nenhum valor do usuário vira SQL — tudo em placeholder', () => {
    const evil = "x') OR 1=1 --"
    const c = compileCriteria(json({ name: evil }), DEFS)
    expect(c.sql).not.toContain('1=1')
  })

  it.each([
    ['JSON malformado', '{nope'],
    ['não-objeto', json([1, 2])],
    ['chave desconhecida', json({ hack: 1 })],
    ['grande demais', json({ name: 'x'.repeat(MAX_CRITERIA_LENGTH) })],
  ])('400 SEARCH_CRITERIA_INVALID: %s', (_label, raw) => {
    expect(() => compileCriteria(raw, DEFS)).toThrow(expect.objectContaining({
      statusCode: 400, code: 'SEARCH_CRITERIA_INVALID',
    }))
  })

  it('parâmetro repetido (array na query) = 400', () => {
    expect(() => compileCriteria(['{}', '{}'], DEFS)).toThrow(expect.objectContaining({ statusCode: 400 }))
  })

  it.each([
    ['faixa invertida',      { qty: { from: 5, to: 1 } }],
    ['data inválida',        { when: { from: '2026-02-30' } }],
    ['faixa sem objeto',     { value: 10 }],
    ['id inválido',          { seller: -3 }],
    ['id fracionado',        { seller: 1.5 }],
    ['opção fora do domínio', { kind: ['X'] }],
    ['bool não booleano',    { active: 'S' }],
    ['texto não string',     { name: 12 }],
    ['documento sem dígito (L1 do socrático)', { doc: 'abc' }],
    ['número em hexadecimal', { qty: { from: '0x10' } }],
    ['dinheiro que estoura o round2 (H1)', { value: { from: 1e307 } }],
    ['lookup além do inteiro seguro', { seller: 2 ** 60 }],
  ])('422 SEARCH_CRITERION_INVALID com fields[] no critério: %s', (_label, values) => {
    try {
      compileCriteria(json(values), DEFS)
      throw new Error('deveria falhar')
    } catch (err: any) {
      expect(err.statusCode).toBe(422)
      expect(err.code).toBe('SEARCH_CRITERION_INVALID')
      expect(err.fields[0].field).toBe(Object.keys(values)[0])
    }
  })
})

describe('parseListQuery + criteria (D-BA1)', () => {
  it('módulo sem critérios declarados + criteria enviado = 400 (chave desconhecida)', async () => {
    await expect(parseListQuery(reqOf({ criteria: json({ a: 1 }) })))
      .rejects.toMatchObject({ statusCode: 400, code: 'SEARCH_CRITERIA_INVALID' })
  })

  it('sem criteria: ListQuery ganha NO_CRITERIA (34 módulos inalterados)', async () => {
    const q = await parseListQuery(reqOf({ filter: 'a' }))
    expect(q.criteria).toBe(NO_CRITERIA)
  })

  it('com critérios declarados compila junto com filter/page', async () => {
    const q = await parseListQuery(reqOf({ page: '2', criteria: json({ seller: 7 }) }), undefined, DEFS)
    expect(q.page).toBe(2)
    expect(q.criteria.params).toEqual([7])
  })
})

describe('projeção pública — expressão SQL NUNCA sai da API (parecer do guardião)', () => {
  it.each([
    ['customers', CUSTOMER_SEARCH_CRITERIA],
    ['service-orders', SERVICE_ORDER_SEARCH_CRITERIA],
  ])('%s', (_m, defs) => {
    const pub = publicCriteria(defs)
    expect(pub).toHaveLength(defs.length)
    for (const p of pub) {
      expect(Object.keys(p).sort()).toEqual(
        expect.arrayContaining(['key', 'kind', 'labelKey']))
      expect(p).not.toHaveProperty('expr')
      expect(p).not.toHaveProperty('boolValues')
      expect(p.labelKey.startsWith('search.')).toBe(true)
      if (p.kind === 'lookup') expect(p.lookup).toMatch(/^\/api\/(customers|service-orders)\//)
    }
  })
})

describe('piloto customers — critério só ESTREITA o escopo', () => {
  it('carteira e critérios na MESMA where da página e do COUNT; carteira antes dos critérios', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    const criteria = compileCriteria(json({ salesman: 99, personType: ['J'], createdAt: { from: '2026-01-01' } }),
      CUSTOMER_SEARCH_CRITERIA)
    await listCustomers({ filter: '', page: 1, pageSize: 25, offset: 0, criteria }, 'setes_acme', 7, 42)

    const [pageSql, pageParams] = mockQuery.mock.calls[0]
    const [countSql, countParams] = mockQuery.mock.calls[1]
    // escopo do repository continua lá e o critério vem DEPOIS, com AND
    expect(pageSql).toMatch(/c\.tb_institution_id = \? AND c\.deleted = 'N'[\s\S]*c\.tb_salesman_id = \?\) AND \(c\.tb_salesman_id = \?/)
    expect(countSql).toContain(criteria.sql)
    // vendedor 42 preso à carteira + critério pedindo o 99 = lista vazia, nunca a do 99
    expect(pageParams.slice(0, 7)).toEqual(['setes_acme.tb_customer', 7, null, null, null, 42, 42])
    expect(pageParams.slice(7, 7 + criteria.params.length)).toEqual([99, 'J', '2026-01-01 03:00:00'])
    expect(countParams).toEqual(pageParams.slice(0, countParams.length))
  })

  it('D-BA15: com carteira TRAVADA o critério "salesman" não é servido', async () => {
    invalidateInterfaceConfig(7, 9)
    invalidateSessionContext(7, 42)
    ;(fieldConfigRepo.findInterfaceIdByKey as jest.Mock).mockResolvedValue(9)
    ;(configRepo.listCatalogConfigs as jest.Mock).mockResolvedValue([{
      name: 'restrict_customer_to_salesman', description: 'Carteira',
      kind: 'Boolean', options: null, defaultContent: 'N', scope: 'I',
    }])
    ;(configRepo.listConfigValues as jest.Mock).mockResolvedValue(
      [{ name: 'restrict_customer_to_salesman', tbUserId: 0, content: 'S' }])
    ;(sessionRepo.existsSalesman as jest.Mock).mockResolvedValue(true)

    const scope = { schemaName: 'setes_acme', institutionId: 7, userId: 42, role: 'user' }
    const locked = await fetchCustomerSearchCriteria(scope)
    expect(locked.map(c => c.key)).not.toContain('salesman')

    invalidateSessionContext(7, 42)
    ;(sessionRepo.existsSalesman as jest.Mock).mockResolvedValue(false)
    const free = await fetchCustomerSearchCriteria(scope)
    expect(free.map(c => c.key)).toContain('salesman')
  })
})

describe('piloto service-orders', () => {
  it('critérios depois do escopo, mesma where no COUNT, aba status preservada', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    const criteria = compileCriteria(json({
      customer: 12, dtRecord: { from: '2026-09-01', to: '2026-09-30' }, totalValue: { to: 250 },
    }), SERVICE_ORDER_SEARCH_CRITERIA)
    await listOrders('F', { filter: '', page: 1, pageSize: 25, offset: 0, criteria }, 'setes_acme', 7)

    const [pageSql, pageParams] = mockQuery.mock.calls[0]
    const [countSql, countParams] = mockQuery.mock.calls[1]
    expect(pageSql).toContain(`WHERE c.tb_institution_id = ? AND c.deleted = 'N'`)
    expect(pageSql).toContain(' AND (s.tb_customer_id = ? AND o.dt_record >= ?')
    expect(countSql).toContain(criteria.sql)
    expect(pageParams.slice(0, 4)).toEqual([7, 'F', 'F', 'F'])
    expect(pageParams.slice(9, 9 + criteria.params.length)).toEqual([12, '2026-09-01', '2026-09-30', 250])
    expect(countParams).toEqual(pageParams.slice(0, countParams.length))
  })
})

describe('Q-BA13 — lookup de cliente da OS respeita a carteira travada', () => {
  function lockWallet(isSalesman: boolean) {
    invalidateInterfaceConfig(7, 9)
    invalidateSessionContext(7, 42)
    ;(fieldConfigRepo.findInterfaceIdByKey as jest.Mock).mockResolvedValue(9)
    ;(configRepo.listCatalogConfigs as jest.Mock).mockResolvedValue([{
      name: 'restrict_customer_to_salesman', description: 'Carteira',
      kind: 'Boolean', options: null, defaultContent: 'N', scope: 'I',
    }])
    ;(configRepo.listConfigValues as jest.Mock).mockResolvedValue(
      [{ name: 'restrict_customer_to_salesman', tbUserId: 0, content: 'S' }])
    ;(sessionRepo.existsSalesman as jest.Mock).mockResolvedValue(isSalesman)
  }
  const scope = { schemaName: 'setes_acme', institutionId: 7, userId: 42, role: 'user' }

  it('vendedor com carteira travada: só a carteira dele', async () => {
    lockWallet(true)
    mockQuery.mockResolvedValueOnce([[]])
    await fetchCustomerLookup('jo', scope)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('cu.tb_salesman_id = ?')
    expect(params.slice(-2)).toEqual([42, 42])
  })

  it('quem não é vendedor: sem restrição', async () => {
    lockWallet(false)
    mockQuery.mockResolvedValueOnce([[]])
    await fetchCustomerLookup('', scope)
    expect(mockQuery.mock.calls[0][1].slice(-2)).toEqual([null, null])
  })
})

describe('Q-BA14 — fuso do estabelecimento (@shared/time-zone)', () => {
  it('início do dia na zona como instante UTC', () => {
    expect(dayStartUtc('2026-09-30', 'America/Sao_Paulo')).toBe('2026-09-30 03:00:00')
    expect(dayStartUtc('2026-09-30', 'America/Manaus')).toBe('2026-09-30 04:00:00')
    expect(dayStartUtc('2026-09-30', 'America/Noronha')).toBe('2026-09-30 02:00:00')
    expect(dayStartUtc('2026-09-30', 'America/Rio_Branco')).toBe('2026-09-30 05:00:00')
    // horário de verão histórico de SP (2018-11-04 começou à 0h → dia começa 01:00 local = 03:00Z)
    expect(dayStartUtc('2018-11-04', 'America/Sao_Paulo')).toBe('2018-11-04 03:00:00')
  })

  it('"hoje" depende da zona: 30/09 22h em Brasília já é 01/10 em UTC', () => {
    const instant = new Date('2026-10-01T01:00:00Z')
    expect(todayIn('America/Sao_Paulo', instant)).toBe('2026-09-30')
    expect(todayIn('UTC', instant)).toBe('2026-10-01')
  })

  it('nextDay atravessa mês e ano; zona inválida é detectada', () => {
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
    expect(isValidTimeZone('America/Sao_Paulo')).toBe(true)
    expect(isValidTimeZone('Marte/Olympus')).toBe(false)
  })

  it('critério DATETIME converte só as PONTAS (coluna intacta, fim = início do dia seguinte)', () => {
    const c = compileCriteria(json({ createdAt: { from: '2026-09-01', to: '2026-09-30' } }),
      CUSTOMER_SEARCH_CRITERIA, 'America/Manaus')
    expect(c.sql).toBe(" AND (c.created_at >= CONVERT_TZ(?, '+00:00', @@session.time_zone)"
      + " AND c.created_at < CONVERT_TZ(?, '+00:00', @@session.time_zone))")
    expect(c.params).toEqual(['2026-09-01 04:00:00', '2026-10-01 04:00:00'])
  })

  it('critério DATE (dt_record da OS) segue comparação direta, sem fuso', () => {
    const c = compileCriteria(json({ dtRecord: { from: '2026-09-01' } }), SERVICE_ORDER_SEARCH_CRITERIA, 'America/Manaus')
    expect(c.sql).toBe(' AND (o.dt_record >= ?)')
    expect(c.params).toEqual(['2026-09-01'])
  })
})
