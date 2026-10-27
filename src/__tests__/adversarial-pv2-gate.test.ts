/// <reference types="jest" />
// GATE testar-adversarial da onda da D-PV2 (2026-10-18 — Infra-IA/prompts/prompt_privilegios_interfaces.md §11).
// Objetivo: QUEBRAR a guarda por roteador (`@shared/auth/module-privilege-gate`), a A-PV1 (`require-privilege.ts`),
// as listas de apoio próprias e a D-PV5. Tudo pelo app REAL (JWT RS256 → flags → guarda → rota), banco em dublê.
//
// Convenção: `[RESISTIU]` = a sonda tentou quebrar e o código aguentou (teste normal).
//            `[ACHADO]`   = a sonda quebrou: `it.failing` com a asserção do comportamento SEGURO — o teste fica verde
//                           enquanto o defeito existir e fica VERMELHO quando for corrigido (aí vira `it` normal).
import request from 'supertest'
import { Router } from 'express'
import { bearer } from '../test-setup/test-token'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADV'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../shared/customer-wallet', () => ({ __esModule: true, walletSalesmanId: jest.fn(async () => null) }))
// Serviços-alvo: espiões que provam que a requisição CHEGOU à regra de negócio (passou a autorização).
jest.mock('../modules/interface-configs/interface-configs.service', () => {
  const actual = jest.requireActual('../modules/interface-configs/interface-configs.service')
  return {
    __esModule: true, ...actual,
    saveConfigValue: jest.fn(async () => undefined), saveConfigValueByKey: jest.fn(async () => undefined),
    fetchResolvedConfigs: jest.fn(async () => []),
  }
})
jest.mock('../modules/state-tax-rates/state-tax-rates.service', () => {
  const actual = jest.requireActual('../modules/state-tax-rates/state-tax-rates.service')
  return { __esModule: true, ...actual, createMva: jest.fn(async () => ({ id: 1 })) }
})
jest.mock('../modules/core/core.service', () => {
  const actual = jest.requireActual('../modules/core/core.service')
  return { __esModule: true, ...actual, setInstitutionTheme: jest.fn(async () => undefined) }
})
jest.mock('../modules/billing/billing.service', () => {
  const actual = jest.requireActual('../modules/billing/billing.service')
  return { __esModule: true, ...actual, validateOrder: jest.fn(async () => ({ ok: true, issues: [] })) }
})
jest.mock('../modules/users/users.repository', () => {
  const actual = jest.requireActual('../modules/users/users.repository')
  return {
    __esModule: true, ...actual,
    userExists: jest.fn(async () => true),
    userLinkedToInstitution: jest.fn(async () => true),
    // forma nova (gate socrático da D-PV11): chave + estado — o salvar recusa interface excluída
    findInterfaceKey: jest.fn(async (id: number) => ({ key: id === 3 ? 'users' : id === 4 ? 'establishment' : 'customers', deleted: false })),
    listInterfaceCatalogPrivilegeIds: jest.fn(async () => [1, 2, 3, 6]),
    setUserPrivileges: jest.fn(async () => undefined),
  }
})

// Re-prova (2026-10-18, revista 2026-10-21 — D-PV32): a cadeia da entidade é dublada em entity-fiscal (o barrel re-exporta): o
// salvar devolve o id pedido (ou 2 = a entity da INSTITUTION 2, simulando o reuso pelo documento); a leitura devolve a cadeia GRAVADA
// do emitente para a conferência "mudou?" da D-PV32. O documento do próprio estabelecimento resolve pelo CNPJ (fiscal.repository).
const OWN_CNPJ = '11222333000181', OTHER_CNPJ = '11444777000161'
const OWN_CHAIN = {
  id: 2, entity: { nameCompany: 'Emitente', nickTrade: 'Eu', aniversary: null }, personType: 'J', person: null,
  company: { cnpj: OWN_CNPJ, ie: null, im: null, dtFoundation: null }, noDoc: null, addresses: [], phones: [], socialMedia: [],
}
jest.mock('../shared/entity/entity-fiscal', () => {
  const actual = jest.requireActual('../shared/entity/entity-fiscal')
  return {
    __esModule: true, ...actual,
    saveEntityFiscalChain: jest.fn(async (_c: any, id: number | null) => ({ id: id ?? 2, reused: true })),
    getEntityFiscalFull: jest.fn(async () => OWN_CHAIN),
  }
})
jest.mock('../shared/fiscal/fiscal.repository', () => {
  const actual = jest.requireActual('../shared/fiscal/fiscal.repository')
  return { __esModule: true, ...actual, findEntityIdByCnpj: jest.fn(async (cnpj: string) => (cnpj === OWN_CNPJ ? 2 : cnpj === OTHER_CNPJ ? 3 : null)) }
})

import pool from '../shared/db/connection'
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import { matchModuleRoute, listGatedModules } from '../shared/auth/module-privilege-gate'
import * as configsService from '../modules/interface-configs/interface-configs.service'
import * as entityFiscal from '../shared/entity/entity-fiscal'
import * as stateTaxService from '../modules/state-tax-rates/state-tax-rates.service'
import * as coreService from '../modules/core/core.service'
import * as billingService from '../modules/billing/billing.service'
import * as usersRepo from '../modules/users/users.repository'
import app from '../app'

const q = (pool as any).query as jest.Mock
const CATALOG: Record<string, number> = {
  customers: 9, 'interface-configs': 10, 'general-configs': 11, partnerships: 18, settlements: 21,
  'service-orders': 20, orders: 29, 'bank-slips': 38, billing: 40, 'payment-types': 16,
  collaborators: 12, carriers: 23, providers: 24, salesmen: 22,
}
let contracted: Set<number>                                    // interfaces contratadas (qualquer institution do teste)
let granted: Set<string>                                       // `${userId}:${interfaceId}:${privilegeId}`
let businessSql: string[]                                      // SQL que NÃO é da guarda (= a requisição chegou ao negócio)
let dbDown = false
let business: (sql: string, params: any[]) => any = () => [[]]   // resposta do dublê para o SQL de negócio

beforeEach(() => {
  jest.clearAllMocks(); resetPrivilegeCache()
  contracted = new Set(Object.values(CATALOG))
  granted = new Set()
  businessSql = []
  dbDown = false
  business = () => [[]]
  q.mockImplementation(async (sql: string, params: any[] = []) => {
    if (dbDown) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    if (/FROM setes_central\.tb_interface WHERE i18n_key/.test(sql)) {
      const id = CATALOG[String(params[0])]
      return [id ? [{ id }] : []]
    }
    if (/tb_institution_has_interface/.test(sql)) return [contracted.has(Number(params[1])) ? [{ 1: 1 }] : []]
    if (/tb_user_has_privilege/.test(sql)) return [granted.has(`${params[0]}:${params[1]}:${params[2]}`) ? [{ 1: 1 }] : []]
    businessSql.push(String(sql))
    return business(String(sql), params)
  })
})

// regular (userId 9) na institution 2; admin (7) na 3; super legítimo (1/1); super FALSO (role super fora da Setes)
const USER = bearer({ institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' })
const ADMIN = bearer({ institutionId: 3, userId: 7, role: 'admin', schemaName: 'setes_y' })
const SUPER = bearer({ institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' })
const FAKE_SUPER = bearer({ institutionId: 4, userId: 5, role: 'super', schemaName: 'setes_z' })
const grant = (userId: number, key: string, ...privs: number[]) => privs.forEach(p => granted.add(`${userId}:${CATALOG[key]}:${p}`))
const denied = (r: request.Response) => r.status === 403 && ['PRIVILEGE_REQUIRED', 'INTERFACE_NOT_ALLOWED'].includes(r.body?.code)

// ---------------------------------------------------------------------------------------------------------------------
// 1. Truques de URL e de verbo contra o gateway REAL — regular SEM privilégio algum (tudo contratado)
// ---------------------------------------------------------------------------------------------------------------------
describe('[RESISTIU] truques de URL/verbo não passam da guarda (regular sem privilégio)', () => {
  const cases: Array<[string, string, Record<string, string>]> = [
    ['get', '/api/Customers', {}],                                  // caixa: o mount do Express é case-insensitive
    ['get', '/api/CUSTOMERS/5', {}],
    ['get', '/api/customers/', {}],                                 // barra final (router não-strict)
    ['get', '/api/customers/5/', {}],
    ['get', '/api/customers/%35', {}],                              // segmento codificado ('5')
    ['get', '/api/customers/5%2Fpartnership', {}],                  // %2F não vira separador: cai em /:id (V de customers)
    ['get', '/api/customers/5;jsessionid=1', {}],
    ['get', '/api/customers?x=/key/abc&__proto__=1', {}],          // query não entra no casamento
    ['head', '/api/customers', {}],
    ['patch', '/api/customers/5', {}],                              // verbo sem rota: confere ALTERAR antes do 404
    ['propfind', '/api/customers', {}],                             // verbo desconhecido do mapa: nega
    ['purge', '/api/customers/5', {}],
    ['post', '/api/customers', { 'X-HTTP-Method-Override': 'GET', 'X-HTTP-Method': 'GET' }],
    ['get', '/api/interface-configs/key', {}],                      // sem :moduleKey → cai em /:id ('key') = VISUALIZAR do painel
    ['put', '/api/interface-configs/key/x', {}],                    // 2 segmentos → /:id/:name, não a rota aberta
  ]
  it.each(cases)('%s %s → 403 sem tocar o negócio', async (method, url, headers) => {
    let r = (request(app) as any)[method](url).set('Authorization', USER)
    for (const [k, v] of Object.entries(headers ?? {})) r = r.set(k, v)
    const res: request.Response = await r
    // HEAD não tem corpo: o veredito é o status
    expect(method === 'head' ? res.status === 403 : denied(res)).toBe(true)
    expect(businessSql).toEqual([])
  })

  it('// e /api//customers não chegam a rota nenhuma de dados (404/403, nunca 200)', async () => {
    for (const url of ['/api/customers//5', '/api//customers', '//api/customers']) {
      const res = await request(app).get(url).set('Authorization', USER)
      expect(res.status === 404 || denied(res)).toBe(true)
      expect(businessSql).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 2. Privilégio da interface A não abre B (privilegeAct com outra interface; resolvedor dinâmico)
// ---------------------------------------------------------------------------------------------------------------------
describe('[RESISTIU] privilégio de uma interface não abre outra', () => {
  it('só partnerships (V+A): a aba Parceria passa; o cadastro do cliente e as listas dele não', async () => {
    grant(9, 'partnerships', 6, 2)
    for (const [m, url] of [['get', '/api/customers/5/partnership'], ['put', '/api/customers/5/Partnership'],
      ['get', '/api/customers/collaborator-lookup']] as const) {
      const res = await (request(app) as any)[m](url).set('Authorization', USER).send({ partners: [] })
      expect(denied(res)).toBe(false)
    }
    for (const [m, url] of [['get', '/api/customers/5'], ['put', '/api/customers/5'], ['get', '/api/customers'],
      ['get', '/api/customers/salesman-lookup'], ['delete', '/api/customers/5'], ['post', '/api/customers']] as const) {
      expect(denied(await (request(app) as any)[m](url).set('Authorization', USER).send({}))).toBe(true)
    }
  })

  it('só general-configs (V+A): toda grafia numérica de 11 chega ao service COMO 11 (gate e parseId leem igual)', async () => {
    grant(9, 'general-configs', 6, 2)
    const spy = configsService.saveConfigValue as jest.Mock
    for (const id of ['11', '011', '11.0', '0x0b', '1.1e1', '+11', '%2011', '%31%31', '0b1011', '0o13']) {
      spy.mockClear()
      const res = await request(app).put(`/api/interface-configs/${id}/page_size`).set('Authorization', USER)
        .send({ content: '50', target: 'U' })
      expect([id, res.status]).toEqual([id, 200])
      expect(spy.mock.calls[0][1]).toBe(11)                     // o alvo REAL é a Configurações Gerais — sem desvio
    }
  })

  it('só general-configs: qualquer outro alvo → 403 (12, -11, 11abc, NaN, Infinity, 11/../12)', async () => {
    grant(9, 'general-configs', 6, 2)
    for (const id of ['12', '-11', '11abc', 'NaN', 'Infinity', '1e400', '10']) {
      const res = await request(app).put(`/api/interface-configs/${id}/page_size`).set('Authorization', USER)
        .send({ content: '50', target: 'U' })
      expect([id, denied(res)]).toEqual([id, true])
    }
    expect(configsService.saveConfigValue).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 3. A rota ABERTA PUT /interface-configs/key/:moduleKey/:name (A-PV6) faz o MESMO que a rota guardada /:id/:name
// ---------------------------------------------------------------------------------------------------------------------
describe('rota aberta do override por chave × rota guardada do painel', () => {
  it('[RESISTIU] a guarda do painel barra o ADMIN de institution que NÃO contratou o painel (D-F37 / Q-PV11 (a))', async () => {
    contracted.delete(CATALOG['interface-configs']); contracted.delete(CATALOG['general-configs'])
    const res = await request(app).put('/api/interface-configs/40/max_discount_aliquot').set('Authorization', ADMIN)
      .send({ content: '50', target: 'I' })
    expect([res.status, res.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    expect(configsService.saveConfigValue).not.toHaveBeenCalled()
  })

  // Achado da 1ª passada deste gate (o admin gravava o valor da INSTITUTION pela rota aberta, furando a licença do painel)
  // foi CORRIGIDO em paralelo durante a rodada (controller: CONFIG_INSTITUTION_VIA_PANEL) — a sonda fica como [RESISTIU].
  it('[RESISTIU] o MESMO admin NÃO grava o valor da INSTITUTION pela rota aberta /key (target I / i / ausente / U+I)', async () => {
    contracted.delete(CATALOG['interface-configs']); contracted.delete(CATALOG['general-configs'])
    for (const body of [{ content: '50', target: 'I' }, { content: '50', target: 'i' }, { content: '50' },
      { content: '50', target: ['U', 'I'] }, { content: '50', target: 'U ', }]) {
      const res = await request(app).put('/api/interface-configs/key/billing/max_discount_aliquot').set('Authorization', ADMIN)
        .send(body)
      expect([JSON.stringify(body), res.status === 403 || res.status === 400]).toEqual([JSON.stringify(body), true])
    }
    expect(configsService.saveConfigValueByKey).not.toHaveBeenCalled()
  })

  it('[LIMITE A-PV6] regular SEM privilégio algum grava o override pessoal (scope U) de QUALQUER tela pela rota aberta', async () => {
    const res = await request(app).put('/api/interface-configs/key/customers/default_person_type').set('Authorization', USER)
      .send({ content: 'F', target: 'U' })
    expect(res.status).toBe(200)
    expect((configsService.saveConfigValueByKey as jest.Mock).mock.calls[0].slice(1, 3)).toEqual(['customers', 'default_person_type'])
    // a rota guardada equivalente nega o mesmo usuário — a guarda de /:id/:name não protege nada que /key não alcance
    const guarded = await request(app).put('/api/interface-configs/9/default_person_type').set('Authorization', USER)
      .send({ content: 'F', target: 'U' })
    expect(denied(guarded)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 4. Escritas FORA da guarda (módulos excluídos por nome) — regular SEM privilégio algum
// ---------------------------------------------------------------------------------------------------------------------
describe('escritas fora da guarda por roteador — as sondas do gate (2026-10-18) viraram CERCAS (D-PV23/D-PV30/D-PV31, 2026-10-20)', () => {
  it('[CORRIGIDO → CERCA D-PV23/D-PV30] GET/PUT /api/entities/:id/tax NÃO EXISTEM mais: 404 para regular, admin e super, em toda grafia; nada toca tb_entity_tax', async () => {
    for (const who of [USER, ADMIN, SUPER, FAKE_SUPER]) {
      for (const [m, url] of [['get', '/api/entities/2/tax'], ['put', '/api/entities/2/tax'], ['put', '/api/Entities/2/TAX'], ['put', '/api/entities/2/tax/'],
        ['put', '/api/entities/%32/tax'], ['patch', '/api/entities/2/tax'], ['put', '/api/entities/5/tax']] as const) {
        const res = await (request(app) as any)[m](url).set('Authorization', who).send({ simplesRegime: '2', byPassSt: 'S' })
        expect([m, url, res.status]).toEqual([m, url, 404])
      }
    }
    expect(businessSql.filter(sql => /tb_entity_tax/.test(sql))).toEqual([])
    expect(q.mock.calls.filter(c => /ON DUPLICATE KEY UPDATE/.test(String(c[0])) && /tb_entity_tax/.test(String(c[1]?.[0])))).toEqual([])
  })

  it('[RESISTIU] (contraprova) o regular NÃO entra no Meu Estabelecimento — a porta "oficial" do emitente é só do admin', async () => {
    expect((await request(app).put('/api/establishment').set('Authorization', USER).send({ simplesRegime: '2' })).status).toBe(403)
    expect((await request(app).get('/api/establishment').set('Authorization', USER)).status).toBe(403)
  })

  it('[RESISTIU] GET /api/entities/by-document segue ABERTO ao regular sem privilégio (D-PV2: prefill de toda tela)', async () => {
    const res = await request(app).get('/api/entities/by-document?personType=J&doc=11222333000181').set('Authorization', USER)
    expect(denied(res)).toBe(false)
    expect(res.status).not.toBe(403)
  })

  it('[CORRIGIDO — era MEDIUM F7/Q-PV14 → D-PV23] POST /api/state-tax-rates/mva: regular → 403 e createMva NÃO roda; o admin passa (adminGuard até a tela nascer)', async () => {
    const body = { stateId: 41, ncm: '22030000', internalAliq: 19, mvaOriginal: 140 }
    for (const who of [USER, FAKE_SUPER]) {
      const res = await request(app).post('/api/state-tax-rates/mva').set('Authorization', who).send(body)
      expect(res.status).toBe(403)
    }
    expect((stateTaxService.createMva as jest.Mock).mock.calls.length).toBe(0)
    const ok = await request(app).post('/api/state-tax-rates/mva').set('Authorization', ADMIN).send(body)
    expect(ok.status).toBe(201)
    expect((stateTaxService.createMva as jest.Mock).mock.calls.length).toBe(1)
  })

  it('[CORRIGIDO — era LOW → D-PV31] PUT /api/core/theme: regular → 403 e a marca não muda; o admin grava', async () => {
    const res = await request(app).put('/api/core/theme').set('Authorization', USER).send({ primaryColor: '#FF0000' })
    expect(res.status).toBe(403)
    expect((coreService.setInstitutionTheme as jest.Mock).mock.calls.length).toBe(0)
    expect((await request(app).put('/api/core/theme').set('Authorization', ADMIN).send({ primaryColor: '#FF0000' })).status).toBe(200)
    expect((coreService.setInstitutionTheme as jest.Mock).mock.calls.length).toBe(1)
  })

  it('[CORRIGIDO — era LOW → D-PV23] POST /api/billing/validate exige FATURAR pela interface do RAMO (o mesmo resolvedor do /invoice): sem → 403 e validateOrder NÃO roda; com FATURAR em orders → roda', async () => {
    const res = await request(app).post('/api/billing/validate').set('Authorization', USER).send({ orderId: 5 })
    expect([res.status, res.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
    expect((billingService.validateOrder as jest.Mock).mock.calls.length).toBe(0)
    grant(9, 'orders', 5)
    const ok = await request(app).post('/api/billing/validate').set('Authorization', USER).send({ orderId: 5 })
    expect(ok.status).toBe(200)
    expect((billingService.validateOrder as jest.Mock).mock.calls.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 4c. D-PV32 (2026-10-20, fecha a Q-PV28 = (b)) — o PRÓPRIO estabelecimento como papel: PODE existir; a cadeia e a tributação dele
//     ficam SOMENTE LEITURA pela API (409 OWN_ESTABLISHMENT_READ_ONLY se o corpo tenta mudar). Era a barreira interina (409 na criação).
// ---------------------------------------------------------------------------------------------------------------------
const taxUpserts = () => q.mock.calls
  .filter(c => /ON DUPLICATE KEY UPDATE/.test(String(c[0])) && /tb_entity_tax$/.test(String(c[1]?.[0])))
  .map(c => [c[1][0], c[1][1], c[1][2], c[1][5]])                // [tabela, entity, institution, simplesRegime]
const fakeConn = () => ({ query: q, beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() })

describe('D-PV32 — o próprio estabelecimento como papel (cadeia/tributação somente leitura pela API)', () => {
  const ROLES = ['customers', 'providers', 'carriers', 'collaborators'] as const
  const TABLE: Record<string, string> = { customers: 'tb_customer', providers: 'tb_provider', carriers: 'tb_carrier', collaborators: 'tb_collaborator' }
  const roleWrites = () => q.mock.calls.filter(c =>
    /^\s*(INSERT|UPDATE)\b/i.test(String(c[0])) && /\.tb_(customer|provider|carrier|collaborator)$/.test(String(c[1]?.[0])))
  const chainSaves = () => (entityFiscal.saveEntityFiscalChain as jest.Mock).mock.calls.length
  /** o corpo que o app devolve do GET do emitente — igual ao gravado */
  const sameBody = () => ({ entity: { nameCompany: 'Emitente', nickTrade: 'Eu' }, personType: 'J', company: { cnpj: OWN_CNPJ } })
  const taxBody = () => ({ ...sameBody(), tax: { simplesRegime: '1' } })      // "não optante" → mudaria o DPS de produção
  let conn: ReturnType<typeof fakeConn>
  beforeEach(() => {
    for (const r of ROLES) grant(9, r, 1, 2)
    conn = fakeConn()
    ;(pool as any).getConnection.mockResolvedValue(conn)
    // o papel 2 "existe" para o PUT; a tributação gravada do emitente não existe no dublê (→ toda chave não nula do corpo é mudança)
    business = (sql) => (/SELECT 1 FROM \?\? WHERE id = \? AND tb_institution_id = \? AND deleted = 'N'/.test(sql) ? [[{ 1: 1 }]] : [[]])
  })
  const nothingWritten = () => {
    expect(taxUpserts()).toEqual([])
    expect(roleWrites()).toEqual([])
    expect(chainSaves()).toBe(0)
    expect(conn.beginTransaction).not.toHaveBeenCalled()
  }

  it.each(['customers', 'providers', 'carriers'] as const)('[CORRIGIDO — era HIGH] POST /api/%s com o CNPJ do próprio estabelecimento e TRIBUTAÇÃO diferente → 409 OWN_ESTABLISHMENT_READ_ONLY ANTES da transação, nada gravado', async (role) => {
    const res = await request(app).post(`/api/${role}`).set('Authorization', USER).send(taxBody())
    expect([res.status, res.body.code]).toEqual([409, 'OWN_ESTABLISHMENT_READ_ONLY'])
    expect(res.body.fields).toEqual([{ field: 'tax.simplesRegime', message: expect.any(String) }])
    nothingWritten()
  })

  it.each(ROLES)('[RESISTIU] POST /api/%s igual à cadeia gravada e sem tributação → 201: grava SÓ a linha do PAPEL (id = a institution), nunca a cadeia nem tb_entity_tax', async (role) => {
    const res = await request(app).post(`/api/${role}`).set('Authorization', USER).send(sameBody())
    expect([role, res.status]).toEqual([role, 201])
    expect(chainSaves()).toBe(0)                                       // a cadeia do emitente não se escreve por aqui
    expect(taxUpserts()).toEqual([])
    const writes = roleWrites()
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) {
      expect(String(w[1][0])).toBe(`setes_x.${TABLE[role]}`)
      expect(w[1]).toContain(2)                                        // o id do papel é o da institution
    }
    expect(conn.commit).toHaveBeenCalled()
  })

  it('[CORRIGIDO — era HIGH] PUT /api/customers/2 mudando a RAZÃO SOCIAL do emitente → 409 (campo nomeado), nada gravado; mudando só campos do PAPEL → 200 sem tocar cadeia/tributação', async () => {
    const changed = await request(app).put('/api/customers/2').set('Authorization', USER)
      .send({ ...sameBody(), entity: { nameCompany: 'Outro nome', nickTrade: 'Eu' } })
    expect([changed.status, changed.body.code]).toEqual([409, 'OWN_ESTABLISHMENT_READ_ONLY'])
    expect(changed.body.fields).toEqual([{ field: 'entity.nameCompany', message: expect.any(String) }])
    nothingWritten()
    const ok = await request(app).put('/api/customers/2').set('Authorization', USER).send({ ...sameBody(), creditValue: 1000, active: 'S' })
    expect(ok.status).toBe(200)
    expect(chainSaves()).toBe(0)
    expect(taxUpserts()).toEqual([])
    expect(roleWrites().map(w => String(w[1][0]))).toEqual(['setes_x.tb_customer'])
  })

  it('[RESISTIU] grafias do id (2, 02, 2.0, +2, %202, 0x2) no PUT com tributação diferente → 409 em todas, nada gravado', async () => {
    for (const id of ['2', '02', '2.0', '+2', '%202', '0x2']) {
      const res = await request(app).put(`/api/providers/${id}`).set('Authorization', USER).send(taxBody())
      expect([id, res.status, res.body.code]).toEqual([id, 409, 'OWN_ESTABLISHMENT_READ_ONLY'])
    }
    nothingWritten()
  })

  it('[RESISTIU] o 409 não vaza id/CNPJ/schema; os campos vêm nomeados pelo caminho (tax.*, entity.*, company.*)', async () => {
    const res = await request(app).post('/api/customers').set('Authorization', USER)
      .send({ ...taxBody(), company: { cnpj: OWN_CNPJ, ie: '123' } })
    const text = JSON.stringify(res.body)
    expect(text).not.toMatch(/setes_|"id"|11222333000181|tb_/)
    expect(res.body.fields.map((f: any) => f.field).sort()).toEqual(['company.ie', 'tax.simplesRegime'])
  })

  it('[RESISTIU] a regra não é oráculo de OUTRO tenant: o CNPJ do emitente da institution 3 cadastra cliente normal na 2 — a RELAÇÃO 3 × 2 no schema do pedinte, nunca 3 × 3', async () => {
    ;(entityFiscal.saveEntityFiscalChain as jest.Mock).mockImplementationOnce(async () => ({ id: 3, reused: true }))
    const res = await request(app).post('/api/customers').set('Authorization', USER)
      .send({ entity: { nameCompany: 'Outra empresa', nickTrade: 'X' }, personType: 'J', company: { cnpj: OTHER_CNPJ }, tax: { simplesRegime: '2' } })
    expect(res.status).toBe(201)
    expect(chainSaves()).toBe(1)
    expect(taxUpserts()).toEqual([['setes_x.tb_entity_tax', 3, 2, '2']])
  })

  it('[RESISTIU] o GET do papel devolve ownEstablishment (o app congela os blocos — a regra é da API)', async () => {
    grant(9, 'customers', 6)
    business = (sql) => {
      if (/FROM \?\? c\s+LEFT JOIN setes_central\.tb_entity es/.test(sql)) return [[{ tbSalesmanId: null, tbCarrierId: null, creditStatus: 'L', creditValue: 0, tbPaymentTypesId: 0, multiplier: null, active: 'S' }]]
      return [[]]
    }
    const own = await request(app).get('/api/customers/2').set('Authorization', USER)
    expect([own.status, own.body.data?.ownEstablishment]).toEqual([200, true])
    const other = await request(app).get('/api/customers/5').set('Authorization', USER)
    expect([other.status, other.body.data?.ownEstablishment]).toEqual([200, false])
  })

  it('[RESISTIU] varredura: só os 4 papéis (pela peça), o Meu Estabelecimento e o onboarding escrevem a cadeia/tributação — a porta avulsa saiu', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs'), path = require('path')
    const root = path.join(__dirname, '..')
    const writers: string[] = []
    const walk = (d: string) => { for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f)
      if (fs.statSync(full).isDirectory()) { if (f !== '__tests__' && f !== 'test-setup') walk(full); continue }
      if (!f.endsWith('.ts')) continue
      const src = fs.readFileSync(full, 'utf8')
      if (/\b(upsertEntityTax|saveEntityFiscalChain)\(/.test(src) && !/export async function (upsertEntityTax|saveEntityFiscalChain)\b/.test(src)) {
        writers.push(path.relative(root, full).split(path.sep).join('/'))
      }
    } }
    walk(root)
    expect(writers.sort()).toEqual([
      'modules/carriers/carriers.repository.ts',             // D-PV32 (peça own-establishment)
      'modules/collaborators/collaborators.repository.ts',   // D-PV32
      'modules/customers/customers.repository.ts',           // D-PV32
      'modules/establishment/establishment.repository.ts',   // a porta oficial (adminGuard)
      'modules/establishment/establishment.service.ts',      // a porta oficial (adminGuard)
      'modules/institutions/institutions.repository.ts',     // superGuard
      'modules/providers/providers.repository.ts',           // D-PV32
    ])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 5. Perfis forjados / bordas do papel
// ---------------------------------------------------------------------------------------------------------------------
describe('[RESISTIU] perfis', () => {
  it('role super FORA da institution da Setes = regular (nada contratado → INTERFACE_NOT_ALLOWED; contratado → PRIVILEGE_REQUIRED)', async () => {
    contracted.clear()
    let res = await request(app).get('/api/customers').set('Authorization', FAKE_SUPER)
    expect([res.status, res.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    contracted = new Set(Object.values(CATALOG))
    res = await request(app).get('/api/customers').set('Authorization', FAKE_SUPER)
    expect([res.status, res.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
  })

  it('role "Super"/"SUPER"/" super" na institution 1 e institutionId "1" (string) não viram super', async () => {
    contracted.clear()
    for (const p of [
      { institutionId: 1, userId: 1, role: 'Super', schemaName: 'setes_setes' },
      { institutionId: 1, userId: 1, role: 'SUPER', schemaName: 'setes_setes' },
      { institutionId: 1, userId: 1, role: ' super', schemaName: 'setes_setes' },
      { institutionId: '1', userId: 1, role: 'super', schemaName: 'setes_setes' },
    ]) {
      const res = await request(app).get('/api/customers').set('Authorization', bearer(p as any))
      expect([JSON.stringify(p), res.status === 401 || denied(res)]).toEqual([JSON.stringify(p), true])
    }
  })

  it('admin com a tela NÃO contratada → 403 INTERFACE_NOT_ALLOWED em todo verbo; super legítimo passa (A-PV1)', async () => {
    contracted.delete(CATALOG.customers)
    for (const [m, url] of [['get', '/api/customers'], ['post', '/api/customers'], ['put', '/api/customers/5'], ['delete', '/api/customers/5']] as const) {
      const res = await (request(app) as any)[m](url).set('Authorization', ADMIN).send({})
      expect([m, res.status, res.body.code]).toEqual([m, 403, 'INTERFACE_NOT_ALLOWED'])
    }
    const res = await request(app).get('/api/customers').set('Authorization', SUPER)
    expect(denied(res)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 6. Erro DENTRO da guarda
// ---------------------------------------------------------------------------------------------------------------------
describe('[RESISTIU] erro dentro da guarda', () => {
  it('banco fora do ar durante a conferência → 500 genérico, nenhuma rota de negócio executada, nada vazado', async () => {
    dbDown = true
    const res = await request(app).put('/api/customers/5').set('Authorization', USER).send({})
    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|setes_|SELECT/)
    expect(businessSql).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 7. Atos de processo (D-PV7/D-PV8) — o privilégio do VERBO não abre o ato
// ---------------------------------------------------------------------------------------------------------------------
describe('[RESISTIU] atos de processo', () => {
  it('HEAD /bank-slips/:id/pdf exige IMPRIMIR (V não basta)', async () => {
    grant(9, 'bank-slips', 6)
    expect((await request(app).head('/api/bank-slips/5/pdf').set('Authorization', USER)).status).toBe(403)   // HEAD: sem corpo
    expect(denied(await request(app).get('/api/bank-slips/5/PDF').set('Authorization', USER))).toBe(true)
  })

  it('trocar cobrança (o requirePrivilege da rota SAIU): V → 403; ALTERAR → passa a guarda', async () => {
    grant(9, 'settlements', 6)
    expect(denied(await request(app).put('/api/settlements/bills/1/1/charge').set('Authorization', USER).send({}))).toBe(true)
    grant(9, 'settlements', 2)
    expect(denied(await request(app).put('/api/settlements/bills/1/1/charge').set('Authorization', USER).send({}))).toBe(false)
  })

  it('estorno da baixa com INSERIR → 403 (é EXCLUIR); rotina mensal com INSERIR → 403 (é FATURAR); excluir OS com CANCELAR → 403', async () => {
    grant(9, 'settlements', 1)
    grant(9, 'service-orders', 1, 7)
    expect(denied(await request(app).post('/api/settlements/reversal').set('Authorization', USER).send({}))).toBe(true)
    expect(denied(await request(app).post('/api/service-orders/monthly-run').set('Authorization', USER).send({}))).toBe(true)
    expect(denied(await request(app).post('/api/service-orders/batch-invoice').set('Authorization', USER).send({}))).toBe(true)
    expect(denied(await request(app).delete('/api/service-orders/5').set('Authorization', USER))).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 8. Cerca estrutural: nenhuma rota de módulo guardado é SOMBREADA por outra declarada antes (ex.: lookup depois de /:id)
// ---------------------------------------------------------------------------------------------------------------------
describe('[RESISTIU] nenhuma rota dos 25 módulos guardados é sombreada por outra anterior', () => {
  it('cada rota é a 1ª a casar com o próprio caminho (parâmetros trocados por um valor neutro)', () => {
    const shadowed: string[] = []
    expect(listGatedModules().length).toBeGreaterThanOrEqual(25)              // a cerca não passa no vazio
    for (const key of listGatedModules()) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sub: Router = require(`../modules/${key}/${key}.routes`).default
      const stack = ((sub as any).stack ?? []) as any[]
      for (const layer of stack) {
        if (!layer.route) continue
        const sample = String(layer.route.path).replace(/:[A-Za-z0-9_]+/g, '987654')
        for (const [m, on] of Object.entries(layer.route.methods as Record<string, boolean>)) {
          if (!on || m === '_all') continue
          const hit = matchModuleRoute(sub, m.toUpperCase(), sample)
          if (hit?.layer !== layer) shadowed.push(`${key} ${m.toUpperCase()} ${layer.route.path} ← ${hit?.layer?.route?.path}`)
        }
      }
    }
    expect(shadowed).toEqual([])
  })
})

describe('[RESISTIU] marcador por VERBO em router.route(...) encadeado', () => {
  it('GET aberto não abre o DELETE da MESMA rota; .all(privilegeAct) vale para todo verbo', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const express = require('express')
    const { gatedModule, openRoute, privilegeAct } = jest.requireActual('../shared/auth/module-privilege-gate')
    const sub = express.Router()
    const ok = (_q: any, r: any) => r.json({ ok: true })
    sub.route('/x').get(openRoute('leitura de motor'), ok).delete(ok)
    sub.route('/y').all(privilegeAct(7)).get(ok)
    const mini = express()
    mini.use((req: any, _r: any, n: any) => { req.institution = { institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' }; n() })
    mini.use('/customers', ...gatedModule('customers', sub))
    expect((await request(mini).get('/customers/x')).status).toBe(200)
    expect((await request(mini).delete('/customers/x')).status).toBe(403)        // EXCLUIR de customers (o verbo), não o aberto
    grant(9, 'customers', 6)
    expect((await request(mini).get('/customers/y')).status).toBe(403)           // .all(7) → CANCELAR, VISUALIZAR não basta
    grant(9, 'customers', 7)
    expect((await request(mini).get('/customers/y')).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 9. Listas de apoio novas: injeção no LIKE e IDOR pela query
// ---------------------------------------------------------------------------------------------------------------------
describe('[RESISTIU] listas de apoio próprias', () => {
  it('collaborator-lookup: \\ % _ escapados; institution/schema SÓ do JWT (query forjada ignorada)', async () => {
    grant(9, 'partnerships', 6)
    await request(app).get('/api/customers/collaborator-lookup')
      .query({ filter: 'a\\%_b', institutionId: 1, schemaName: 'setes_setes' }).set('Authorization', USER)
    const [sql, params] = q.mock.calls.find(c => /tb_entity e ON e\.id = c\.id/.test(String(c[0])))!
    expect(String(sql)).toMatch(/LIMIT 50/)
    expect(params).toEqual(['setes_x.tb_collaborator', 2, '%a\\\\\\%\\_b%', '%a\\\\\\%\\_b%', '%a\\\\\\%\\_b%'])
  })

  it('filtro em forma de objeto/array (?filter[x]=1, ?filter=a&filter=b) não quebra a lista (nunca 500)', async () => {
    grant(9, 'settlements', 6)
    for (const url of ['/api/settlements/bank-accounts?filter[x]=1', '/api/settlements/bank-accounts?filter=a&filter=b',
      '/api/settlements/payment-types?filter[__proto__]=1']) {
      const res = await request(app).get(url).set('Authorization', USER)
      expect([url, res.status]).toEqual([url, 200])
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 10. D-PV5 — users/establishment não se concedem (nem com interfaceId de grafia torta)
// ---------------------------------------------------------------------------------------------------------------------
describe('[RESISTIU] D-PV5', () => {
  it('regular não chega ao cadastro de privilégios (adminGuard) — nem para si mesmo', async () => {
    const res = await request(app).put('/api/users/9/privileges/3').set('Authorization', USER).send({ privilegeIds: [1, 2, 3, 6] })
    expect(res.status).toBe(403)
    expect(usersRepo.setUserPrivileges).not.toHaveBeenCalled()
  })

  it('admin: interfaceId de users/establishment em qualquer grafia numérica → 400, nada gravado', async () => {
    for (const iid of ['3', '03', '3.0', '0x3', '+3', '%203', '4', '0b100']) {
      const res = await request(app).put(`/api/users/9/privileges/${iid}`).set('Authorization', ADMIN).send({ privilegeIds: [6] })
      expect([iid, res.status]).toEqual([iid, 400])
    }
    expect(usersRepo.setUserPrivileges).not.toHaveBeenCalled()
  })
})
