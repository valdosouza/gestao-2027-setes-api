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
jest.mock('../modules/entities/entities.service', () => {
  const actual = jest.requireActual('../modules/entities/entities.service')
  return { __esModule: true, ...actual, saveEntityTax: jest.fn(async () => undefined) }
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

// Re-prova (2026-10-18): a cadeia da entidade é substituída SÓ no saveEntityFiscalChain — simula o reuso pelo documento
// (o CNPJ do próprio estabelecimento resolve para a entity da institution — analisado em shared/entity/entity-fiscal.ts:233-238)
jest.mock('../shared/entity', () => {
  const actual = jest.requireActual('../shared/entity')
  return { __esModule: true, ...actual, saveEntityFiscalChain: jest.fn(async (_c: any, id: number | null) => ({ id: id ?? 2, reused: true })) }
})

import pool from '../shared/db/connection'
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import { matchModuleRoute, listGatedModules } from '../shared/auth/module-privilege-gate'
import * as configsService from '../modules/interface-configs/interface-configs.service'
import * as entitiesService from '../modules/entities/entities.service'
import * as stateTaxService from '../modules/state-tax-rates/state-tax-rates.service'
import * as coreService from '../modules/core/core.service'
import * as billingService from '../modules/billing/billing.service'
import * as usersRepo from '../modules/users/users.repository'
import app from '../app'

const q = (pool as any).query as jest.Mock
const CATALOG: Record<string, number> = {
  customers: 9, 'interface-configs': 10, 'general-configs': 11, partnerships: 18, settlements: 21,
  'service-orders': 20, 'bank-slips': 38, billing: 40, 'payment-types': 16,
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
describe('escritas fora da guarda por roteador', () => {
  // CORRIGIDO na sessão (interino da Q-PV25: adminGuard nas rotas avulsas de tributação — sem consumidor no app)
  it('[CORRIGIDO] PUT /api/entities/:id/tax NÃO grava a aba Tributação de qualquer entidade sem ALTERAR em Clientes/Fornecedores/Transportadoras', async () => {
    const res = await request(app).put('/api/entities/5/tax').set('Authorization', USER).send({ byPassSt: 'S', consumer: 'N' })
    // UMA asserção só, no EFEITO (o negócio executou?) — o it.failing passa pelo motivo certo, nunca por 400/404 do dublê
    void res
    expect((entitiesService.saveEntityTax as jest.Mock).mock.calls.length).toBe(0)
  })

  it('[CORRIGIDO — era HIGH] regular SEM privilégio NÃO reescreve a TRIBUTAÇÃO DO EMITENTE (tb_entity_tax id = institution) — D-PV5/D41 do Meu Estabelecimento', async () => {
    // (a MESMA pessoa não entra no Meu Estabelecimento — adminGuard, D-PV5: provado no teste [RESISTIU] logo abaixo)
    // pela porta avulsa da entidade grava o enquadramento do EMITENTE (entity = institution 2) com o service REAL:
    ;(entitiesService.saveEntityTax as jest.Mock).mockImplementationOnce(
      jest.requireActual('../modules/entities/entities.service').saveEntityTax)
    business = (sql) => (/FROM setes_central\.tb_entity e/.test(sql) ? [[{ nameCompany: 'Emitente' }]] : [[]])
    const res = await request(app).put('/api/entities/2/tax').set('Authorization', USER)
      .send({ simplesRegime: '2', taxRegime: null })   // MEI no DPS de produção; apuração/pTotTribSN zerados (Q-N36/Q-N37 sem conferência)
    void res
    const upsert = q.mock.calls.filter(c => /ON DUPLICATE KEY UPDATE/.test(String(c[0])) && /tb_entity_tax$/.test(String(c[1]?.[0])))
    // UMA asserção, no efeito: nenhum UPSERT da linha do emitente por quem não é admin
    expect(upsert.map(c => [c[1][0], c[1][1], c[1][2], c[1][5]])).toEqual([])
  })

  it('[RESISTIU] (contraprova do HIGH acima) o mesmo regular NÃO entra no Meu Estabelecimento — a porta "oficial" é só do admin', async () => {
    expect((await request(app).put('/api/establishment').set('Authorization', USER).send({ simplesRegime: '2' })).status).toBe(403)
    expect((await request(app).get('/api/establishment').set('Authorization', USER)).status).toBe(403)
  })

  it.failing('[ACHADO conhecido F7/Q-PV14] POST /api/state-tax-rates/mva grava MVA (dado fiscal) por qualquer autenticado', async () => {
    const res = await request(app).post('/api/state-tax-rates/mva').set('Authorization', USER)
      .send({ stateId: 41, ncm: '22030000', internalAliq: 19, mvaOriginal: 140 })
    // UMA asserção só, no EFEITO (o negócio executou?) — o it.failing passa pelo motivo certo, nunca por 400/404 do dublê
    void res
    expect((stateTaxService.createMva as jest.Mock).mock.calls.length).toBe(0)
  })

  it.failing('[ACHADO LOW] PUT /api/core/theme troca a marca (cores/logo) da institution por qualquer regular', async () => {
    const res = await request(app).put('/api/core/theme').set('Authorization', USER).send({ primaryColor: '#FF0000' })
    // UMA asserção só, no EFEITO (o negócio executou?) — o it.failing passa pelo motivo certo, nunca por 400/404 do dublê
    void res
    expect((coreService.setInstitutionTheme as jest.Mock).mock.calls.length).toBe(0)
  })

  it.failing('[ACHADO LOW] POST /api/billing/validate (grava a regra por item origin A) sem privilégio algum do ramo', async () => {
    const res = await request(app).post('/api/billing/validate').set('Authorization', USER).send({ orderId: 5 })
    // UMA asserção só, no EFEITO (o negócio executou?) — o it.failing passa pelo motivo certo, nunca por 400/404 do dublê
    void res
    expect((billingService.validateOrder as jest.Mock).mock.calls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 4b. RE-PROVA da correção do HIGH (adminGuard em GET/PUT /api/entities/:id/tax — interino da Q-PV25)
// ---------------------------------------------------------------------------------------------------------------------
const taxUpserts = () => q.mock.calls
  .filter(c => /ON DUPLICATE KEY UPDATE/.test(String(c[0])) && /tb_entity_tax$/.test(String(c[1]?.[0])))
  .map(c => [c[1][0], c[1][1], c[1][2], c[1][5]])                // [tabela, entity, institution, simplesRegime]
const realEntityTax = () => {
  ;(entitiesService.saveEntityTax as jest.Mock).mockImplementationOnce(
    jest.requireActual('../modules/entities/entities.service').saveEntityTax)
  business = (sql) => (/FROM setes_central\.tb_entity e/.test(sql) ? [[{ nameCompany: 'Entidade' }]] : [[]])
}
const fakeConn = () => ({ query: q, beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() })

describe('re-prova da correção do HIGH', () => {
  it('[RESISTIU] (1) admin de OUTRA institution: o escopo é o do JWT — grava só a relação (entity 2 × institution 3) no PRÓPRIO schema, nunca a linha do emitente 2', async () => {
    realEntityTax()
    await request(app).put('/api/entities/2/tax?institutionId=2&schemaName=setes_x').set('Authorization', ADMIN)
      .send({ simplesRegime: '2', institutionId: 2, schemaName: 'setes_x' })
    expect(taxUpserts()).toEqual([['setes_y.tb_entity_tax', 2, 3, '2']])
  })

  it('[RESISTIU] (1) GET/PUT /:id/tax recusam regular e super FALSO (403) em toda grafia da rota', async () => {
    for (const [m, url] of [['get', '/api/entities/2/tax'], ['put', '/api/entities/2/tax'], ['put', '/api/Entities/2/TAX'],
      ['put', '/api/entities/2/tax/'], ['put', '/api/entities/%32/tax'], ['patch', '/api/entities/2/tax']] as const) {
      for (const who of [USER, FAKE_SUPER]) {
        const res = await (request(app) as any)[m](url).set('Authorization', who).send({ simplesRegime: '2' })
        expect([m, url, res.status === 403 || res.status === 404]).toEqual([m, url, true])
      }
    }
    expect(entitiesService.saveEntityTax).not.toHaveBeenCalled()
  })

  it.failing('[ACHADO LOW — integridade] o ADMIN grava a tributação do PRÓPRIO emitente por /entities/:id/tax sem as regras do Meu Estabelecimento (Q-N36: ME/EPP sem apuração)', async () => {
    realEntityTax()
    await request(app).put('/api/entities/3/tax').set('Authorization', ADMIN).send({ simplesRegime: '3' })   // sem simplesAssessment/pTotTribSN
    expect(taxUpserts()).toEqual([])
  })

  // CORRIGIDO na sessão (interino da Q-PV28: `assertNotOwnEstablishment` nos 4 papéis com cadeia — 409 ROLE_IS_OWN_ESTABLISHMENT)
  it('[CORRIGIDO — era HIGH] (2) regular com INSERIR em Clientes NÃO cadastra o PRÓPRIO estabelecimento como cliente (a aba Tributação não alcança a linha do EMITENTE)', async () => {
    grant(9, 'customers', 1)                                       // só INSERIR (nada de admin, nada de Meu Estabelecimento)
    ;(pool as any).getConnection.mockResolvedValue(fakeConn())
    await request(app).post('/api/customers').set('Authorization', USER).send({
      entity: { nameCompany: 'Próprio estabelecimento', nickTrade: 'Eu' }, personType: 'N',   // a cadeia é dublê: reuso → id 2
      tax: { simplesRegime: '2', taxRegime: null },
    })
    expect(taxUpserts()).toEqual([])                               // hoje: [['setes_x.tb_entity_tax', 2, 2, '2']]
  })

  it('[CORRIGIDO — era HIGH] (2) idem pelo PUT: regular com ALTERAR em Clientes NÃO edita o "cliente" = estabelecimento nem troca o regime do emitente', async () => {
    grant(9, 'customers', 2)
    ;(pool as any).getConnection.mockResolvedValue(fakeConn())
    business = (sql) => (/SELECT 1 FROM \?\? WHERE id = \? AND tb_institution_id = \? AND deleted = 'N'/.test(sql) ? [[{ 1: 1 }]] : [[]])
    await request(app).put('/api/customers/2').set('Authorization', USER).send({
      entity: { nameCompany: 'Próprio estabelecimento', nickTrade: 'Eu' }, personType: 'N',
      tax: { simplesRegime: '1' },                                   // "não optante" → DPS de produção recusado (422 não suportado)
    })
    expect(taxUpserts()).toEqual([])                               // hoje: [['setes_x.tb_entity_tax', 2, 2, '1']]
  })

  it('[RESISTIU] (3) GET /api/entities/by-document segue ABERTO ao regular sem privilégio (D-PV2: prefill de toda tela)', async () => {
    const res = await request(app).get('/api/entities/by-document?personType=J&doc=11222333000181').set('Authorization', USER)
    expect(denied(res)).toBe(false)
    expect(res.status).not.toBe(403)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 4c. RE-PROVA da barreira interina da Q-PV28 (`assertNotOwnEstablishment` nos 4 papéis com cadeia fiscal)
// ---------------------------------------------------------------------------------------------------------------------
describe('re-prova da barreira do próprio estabelecimento (Q-PV28 interino)', () => {
  const ROLES = ['customers', 'providers', 'carriers', 'collaborators'] as const
  const roleWrites = () => q.mock.calls.filter(c =>
    /^\s*(INSERT|UPDATE)\b/i.test(String(c[0])) && /\.tb_(customer|provider|carrier|collaborator)$/.test(String(c[1]?.[0])))
  const body = { entity: { nameCompany: 'Próprio estabelecimento', nickTrade: 'Eu' }, personType: 'N', tax: { simplesRegime: '2' } }
  let conn: ReturnType<typeof fakeConn>
  beforeEach(() => {
    for (const r of ROLES) grant(9, r, 1, 2)
    conn = fakeConn()
    ;(pool as any).getConnection.mockResolvedValue(conn)
  })
  const nothingWritten = () => {
    expect(taxUpserts()).toEqual([])
    expect(roleWrites()).toEqual([])
    expect(conn.commit).not.toHaveBeenCalled()
  }

  it.each(ROLES)('[RESISTIU] POST /api/%s com o documento do próprio estabelecimento → 409 sem gravar nada (rollback)', async (role) => {
    const res = await request(app).post(`/api/${role}`).set('Authorization', USER).send(body)
    expect([res.status, res.body.code]).toEqual([409, 'ROLE_IS_OWN_ESTABLISHMENT'])
    expect(conn.rollback).toHaveBeenCalled()
    nothingWritten()
  })

  it.each(ROLES)('[RESISTIU] PUT /api/%s/<id do estabelecimento> em toda grafia numérica (2, 02, 2.0, +2, %%202, 0x2) → 409, nada gravado', async (role) => {
    business = (sql) => (/SELECT 1 FROM \?\? WHERE id = \? AND tb_institution_id = \? AND deleted = 'N'/.test(sql) ? [[{ 1: 1 }]] : [[]])
    for (const id of ['2', '02', '2.0', '+2', '%202', '0x2']) {
      const res = await request(app).put(`/api/${role}/${id}`).set('Authorization', USER).send(body)
      expect([role, id, res.status, res.body.code]).toEqual([role, id, 409, 'ROLE_IS_OWN_ESTABLISHMENT'])
    }
    nothingWritten()
  })

  it('[RESISTIU] REVIVE: papel do estabelecimento soft-deletado (deleted=S) não ressuscita — a barreira vem ANTES da linha do papel', async () => {
    business = (sql) => (/SELECT deleted FROM \?\? WHERE id = \? AND tb_institution_id = \? FOR UPDATE/.test(sql) ? [[{ deleted: 'S' }]] : [[]])
    for (const role of ROLES) {
      const res = await request(app).post(`/api/${role}`).set('Authorization', USER).send(body)
      expect([role, res.status]).toEqual([role, 409])
    }
    expect(q.mock.calls.some(c => /SELECT deleted FROM/.test(String(c[0])))).toBe(false)   // nem chegou a olhar o papel
    nothingWritten()
  })

  it('[RESISTIU] o 409 não vaza nada: sem id da entity, sem CNPJ, sem schema; o campo é o cnpj', async () => {
    const res = await request(app).post('/api/customers').set('Authorization', USER).send(body)
    const text = JSON.stringify(res.body)
    expect(text).not.toMatch(/setes_|"id"|\b2\b|tb_/)
    expect(res.body.fields).toEqual([{ field: 'cnpj', message: expect.any(String) }])
  })

  it('[RESISTIU] a barreira não é oráculo de OUTRO tenant: o CNPJ do emitente da institution 3 cadastra cliente normal na 2 e a linha do emitente 3 (setes_y, 3×3) não é tocada', async () => {
    const chain = jest.requireMock('../shared/entity').saveEntityFiscalChain as jest.Mock
    chain.mockImplementationOnce(async () => ({ id: 3, reused: true }))
    const res = await request(app).post('/api/customers').set('Authorization', USER).send(body)
    expect(res.status).toBe(201)
    expect(taxUpserts()).toEqual([['setes_x.tb_entity_tax', 3, 2, '2']])   // a RELAÇÃO 3 × 2 no schema do pedinte, nunca 3 × 3
  })

  it('[RESISTIU] vendedor (promoção sem cadeia) e o restante dos módulos guardados não escrevem tb_entity_tax nem a cadeia (varredura do código)', () => {
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
      'modules/carriers/carriers.repository.ts',             // barreira (Q-PV28)
      'modules/collaborators/collaborators.repository.ts',   // barreira (Q-PV28)
      'modules/customers/customers.repository.ts',           // barreira (Q-PV28)
      'modules/entities/entities.service.ts',                // adminGuard (Q-PV25)
      'modules/establishment/establishment.repository.ts',   // a porta oficial (adminGuard)
      'modules/establishment/establishment.service.ts',      // a porta oficial (adminGuard)
      'modules/institutions/institutions.repository.ts',     // superGuard
      'modules/providers/providers.repository.ts',           // barreira (Q-PV28)
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
