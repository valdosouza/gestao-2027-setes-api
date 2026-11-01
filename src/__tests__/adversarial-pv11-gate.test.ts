/// <reference types="jest" />
// GATE testar-adversarial do delta D-PV10/D-PV11 (2026-10-18 — Infra-IA/prompts/prompt_privilegios_interfaces.md "Rodada 3" e §11.9;
// skill Infra-IA/skills-genericas/testar-adversarial.md), ATUALIZADO em 2026-10-21 para a rodada 2026-10-20 (§11.10): gravação POR MARCA
// (D-PV34), só vendáveis/estruturais travadas (D-PV35), flag morta nos módulos guardados (D-PV36), leitura da Setes = 403 (D-PV38),
// A-PV13 morta e exclusão de usuário fora (D-PV19). Sondas que TENTAM QUEBRAR a delegação da tela "Interfaces dos clientes":
//   [RESISTIU] = `it` que passa (a defesa segurou);
//   [ACHADO]   = `it.failing` com a asserção SEGURA (o código atual a quebra — corrigir e trocar por `it`);
//   [DECIDIDO] = `it` que FIXA uma semântica decidida pelo Valdo (para ninguém "consertar" depois).
// Banco DUBLADO (nenhuma conexão real): o dublê responde pelo texto do SQL, como em super-delegation-d-pv11.test.ts.
import { Router } from 'express'
import request from 'supertest'
import { bearer } from '../test-setup/test-token'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADV'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))

import pool from '../shared/db/connection'
import { isModuleEnabled } from '../feature-flags/flag.service'
import { gatedModule, listGatedRoutes } from '../shared/auth/module-privilege-gate'
import { getMenus } from '../modules/core/core.service'
import { PRIVILEGE_NAME_BY_ID } from '../shared/access'
import { accessAnswer, AccessModel, ModelProfile } from '../test-setup/access-model'
import app from '../app'

const q = (pool as any).query as jest.Mock
const getConn = (pool as any).getConnection as jest.Mock
const flagOn = isModuleEnabled as jest.Mock

const IFACE = 41                    // 'institution-interfaces' (a tela delegável) no dublê
const V = 6, A = 2, I = 1, E = 3    // VISUALIZAR, ALTERAR, INSERIR, EXCLUIR
/** institution → schema (8 = uma FILIAL hipotética da Setes no mesmo schema — frente do grupo; 9 = soft-deletada). */
const SCHEMAS: Record<number, string> = { 1: 'setes_setes', 7: 'setes_cliente', 8: 'setes_setes' }
/** usuário → institutions vinculadas (1 = o Super; 2 = admin da Setes; 9 = usuário da Setes; 30..33 = de outro cliente). */
const LINKS: Record<number, number[]> = { 1: [1], 2: [1], 9: [1], 30: [7], 31: [7], 32: [7], 33: [7] }
/** catálogo do dublê (describeInterface / findInterfaceKey): 43 = linha ANTIGA (soft-deletada) com a chave da tela delegável. */
const INTERFACES: Record<number, { key: string; kind: string; group: string | null; deleted?: boolean }> = {
  41: { key: 'institution-interfaces', kind: 'T', group: 'Super' }, 9: { key: 'customers', kind: 'T', group: 'Registers' },
  10: { key: 'interface-configs', kind: 'T', group: 'Sistema' }, 42: { key: 'users', kind: 'T', group: 'Sistema' },
  43: { key: 'institution-interfaces', kind: 'T', group: 'Super', deleted: true }, 18: { key: 'partnerships', kind: 'R', group: 'Registers' },
}
const CATALOG: Record<number, number[]> = { 41: [V, A], 43: [V, A], 9: [V, I, A, E] }
/** Re-prova da barreira da conta: vínculos que existem mas não estão VIVOS (revogados pelo Super — `setInstitutionLinks` os revive). */
const DORMANT_LINKS: Record<number, Array<{ institutionId: number; kind: string; active: string; deleted: string }>> = {}
/** Corrida (d): o que uma releitura DENTRO da transação de gravação veria (o Super vinculou o usuário à Setes no meio). */
let linksInTx: Record<number, Array<{ institutionId: number; kind: string }>> = {}
const SUPER_EMAIL = 'super@setes.com.br'
const RECOVERY_CODE = '123456'
/** e-mail de login de cada conta (D-PV19: imutável — o PUT tem de repetir o atual). */
const EMAILS: Record<number, string> = { 1: SUPER_EMAIL, 2: 'admin@setes.com.br', 5: 'suporte@setes.com.br', 6: 'u6@setes.com.br', 9: 'u@setes.com.br', 32: 'u32@cliente.com' }

let granted: Set<string>            // `${schema}:${userId}:${privilegeId}` (sempre na interface 41)
let linked: Set<string>             // `${schema}:${institutionId}:${interfaceId}` vivos no contrato
let savedContract: Array<{ schema: string; institutionId: number; ids: number[] }>
let revokedContract: Array<{ schema: string; institutionId: number; ids: number[] }>
let privilegeWrites: string[]
let userWrites: Array<{ sql: string; params: any[] }>
let userPrivilegesListParams: any[] | null

const conn = {
  beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  query: jest.fn(async (sql: string, params: any[] = []) => {
    const schema = /`(setes_\w+)`/.exec(sql)?.[1] ?? ''
    if (/FROM setes_central\.tb_institution_has_user/.test(sql) && /kind/.test(sql)) {
      const uid = Number(params[0])
      return [linksInTx[uid] ?? (LINKS[uid] ?? []).map(inst => ({ institutionId: inst, kind: 'user' }))]
    }
    if (/SELECT active, deleted FROM `setes_\w+`\.tb_institution_has_interface[\s\S]*FOR UPDATE/.test(sql)) {
      return [linked.has(`${schema}:${params[0]}:${params[1]}`) ? [{ active: 'S', deleted: 'N' }] : []]
    }
    if (/INSERT INTO `setes_\w+`\.tb_institution_has_interface/.test(sql)) {
      savedContract.push({ schema, institutionId: params[0], ids: [params[1]] })
    } else if (/UPDATE `setes_\w+`\.tb_institution_has_interface/.test(sql)) {
      if (/SET active = 'S'/.test(sql)) savedContract.push({ schema, institutionId: params[0], ids: [params[1]] })
      else revokedContract.push({ schema, institutionId: params[0], ids: [params[1]] })
    } else if (/tb_user_has_privilege/.test(sql)) {
      privilegeWrites.push(sql)
    } else if (/UPDATE setes_central\.tb_user\b/.test(sql)) {
      userWrites.push({ sql, params })
    } else if (/UPDATE setes_central\.tb_institution_has_user/.test(sql)) {
      userWrites.push({ sql, params })
    } else if (/nextId/.test(sql)) {
      return [[{ nextId: 500 }]]
    }
    return [[]]
  }),
}

/**
 * O veredito (costura A1 — D-AU3/D-AU6): as views respondidas pelo dublê. Perfil do VÍNCULO (`vw_user_link`), nunca o `role` do token:
 * o 1 é o super da Setes; o 2 admin da Setes; o 30 admin do cliente 7; 31 e 33 têm kind 'super' FORA da Setes (a view dá 'user'); o 32
 * usuário comum. Contrato = as marcas vivas (`linked`); concessão na delegável = `granted`.
 */
const PROFILE: Record<number, ModelProfile> = { 1: 'super', 2: 'admin', 30: 'admin' }
function modelFor(userId: number, institutionId: number): AccessModel | null {
  if (!(LINKS[userId] ?? []).includes(institutionId)) return null
  const schema = SCHEMAS[institutionId]
  const profile: ModelProfile = userId === 1 && institutionId !== 1 ? 'user' : (PROFILE[userId] ?? 'user')
  const contracted = [...linked].filter(l => l.startsWith(`${schema}:${institutionId}:`))
    .map(l => INTERFACES[Number(l.split(':')[2])]).filter(i => i && !i.deleted).map(i => i.key)
  const verbs = [...granted].filter(g => g.startsWith(`${schema}:${userId}:`)).map(g => PRIVILEGE_NAME_BY_ID[Number(g.split(':')[2])])
  return { profile, vendor: institutionId === 1, contracted, granted: { 'institution-interfaces': verbs } }
}

function defaultDb(sql: string, params: any[] = []): any {
  const a = accessAnswer(sql, params, modelFor)
  if (a) return [a, []]
  if (/SELECT i18n_key AS k FROM setes_central\.tb_interface WHERE id/.test(sql)) {
    const i = INTERFACES[Number(params[0])]
    return [i && !i.deleted ? [{ k: i.key }] : []]
  }
  if (/SELECT id, i18n_key AS k, kind, group_default AS groupDefault\s+FROM setes_central\.tb_interface WHERE id = \?/.test(sql)) {
    const i = INTERFACES[Number(params[0])]
    return [i && !i.deleted ? [{ id: Number(params[0]), k: i.key, kind: i.kind, groupDefault: i.group }] : []]
  }
  if (/SELECT i18n_key AS i18nKey(, deleted)? FROM setes_central\.tb_interface WHERE id = \?/.test(sql)) {
    const i = INTERFACES[Number(params[0])]
    if (!i) return [[]]
    const deleted = i.deleted ? 'S' : 'N'
    if (/deleted = 'N'/.test(sql) && deleted === 'S') return [[]]
    return [[{ i18nKey: i.key, deleted }]]
  }
  if (/SELECT 1 FROM setes_central\.tb_user WHERE id = \?/.test(sql)) return [[{ 1: 1 }]]
  // D-PV19: editUser lê a conta (getUser) — e-mail atual + ativo do vínculo em foco
  if (/e\.name_company AS nameCompany/.test(sql) && /FROM setes_central\.tb_user u/.test(sql)) {
    const uid = Number(params[2] ?? params[0])
    return [[{ id: uid, nameCompany: 'U', nickTrade: 'U', email: EMAILS[uid] ?? `u${uid}@x.com`, active: 'S', hasCredential: 1 }]]
  }
  // vínculos com o perfil (assertAccountManageable): o usuário 1 é o SUPER da Setes
  if (/SELECT tb_institution_id AS institutionId, kind[\s\S]*?FROM setes_central\.tb_institution_has_user/.test(sql)) {
    const uid = Number(params[0])
    const live = (LINKS[uid] ?? []).map(inst => ({ institutionId: inst, kind: uid === 1 ? 'super' : (uid === 2 ? 'admin' : 'user'), alive: 1 }))
    const where = sql.slice(sql.indexOf('WHERE'))
    const dormant = (DORMANT_LINKS[uid] ?? []).filter(l =>
      !(/active = 'S'/.test(where) && l.active !== 'S') && !(/deleted = 'N'/.test(where) && l.deleted !== 'N'))
    return [[...live, ...dormant.map(l => ({ institutionId: l.institutionId, kind: l.kind,
      alive: l.active === 'S' && l.deleted === 'N' ? 1 : 0 }))]]
  }
  if (/SELECT ehm\.tb_entity_id AS id/.test(sql)) return [params[0] === SUPER_EMAIL ? [{ id: 1 }] : []]
  if (/SELECT u\.id, u\.password, u\.active/.test(sql)) return [params[0] === SUPER_EMAIL ? [{ id: 1, password: 'X', active: 'S' }] : []]
  if (/activation_key AS activationKey/.test(sql)) return [[{ activationKey: RECOVERY_CODE, ageMinutes: 1 }]]
  if (/UPDATE setes_central\.tb_user\s+SET password = \?, activation_key = NULL/.test(sql)) { userWrites.push({ sql, params }); return [[]] }
  if (/FROM setes_central\.tb_institution_has_user/.test(sql) && /tb_user_id = \? AND tb_institution_id = \?/.test(sql)) {
    return [(LINKS[Number(params[0])] ?? []).includes(Number(params[1])) ? [{ 1: 1 }] : []]
  }
  if (/schema_name AS schemaName/.test(sql) && /deleted = 'N'/.test(sql)) {
    const s = SCHEMAS[Number(params[0])]
    return [s ? [{ schemaName: s }] : []]
  }
  if (/FROM setes_central\.tb_interface_has_privilege\s+WHERE tb_interface_id = \?/.test(sql)) {
    return [(CATALOG[Number(params[0])] ?? []).map(id => ({ id }))]
  }
  if (/FROM setes_central\.tb_institution i\s+INNER JOIN setes_central\.tb_entity/.test(sql) && /LIMIT/.test(sql)) {
    return [[{ id: 7, name: 'Cliente X', active: 'S' }]]
  }
  if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: 1 }]]
  if (/LEFT JOIN `setes_\w+`\.tb_institution_has_interface/.test(sql)) {
    return [[{ id: 9, description: 'Clientes', groupDefault: 'Cadastros', kind: 'T', granted: 1, _inst: params[0] }]]
  }
  if (/i\.i18n_key NOT IN \(\?\)/.test(sql)) { userPrivilegesListParams = params; return [[]] }
  return [[]]
}

beforeEach(() => {
  jest.clearAllMocks();  granted = new Set(); linked = new Set(['setes_cliente:7:9']); savedContract = []; revokedContract = []; privilegeWrites = []; userWrites = []; userPrivilegesListParams = null
  linksInTx = {}
  for (const k of Object.keys(DORMANT_LINKS)) delete DORMANT_LINKS[Number(k)]
  getConn.mockResolvedValue(conn)
  flagOn.mockResolvedValue(true)
  q.mockImplementation(async (sql: string, params: any[] = []) => defaultDb(sql, params))
})

const SUPER       = bearer({ institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' })
const SETES_ADMIN = bearer({ institutionId: 1, userId: 2, role: 'admin', schemaName: 'setes_setes' })
const SETES_USER  = bearer({ institutionId: 1, userId: 9, role: 'user', schemaName: 'setes_setes' })
const OTHER_ADMIN = bearer({ institutionId: 7, userId: 30, role: 'admin', schemaName: 'setes_cliente' })
const OTHER_SUPER = bearer({ institutionId: 7, userId: 31, role: 'super', schemaName: 'setes_cliente' })
const OTHER_USER  = bearer({ institutionId: 7, userId: 32, role: 'user', schemaName: 'setes_cliente' })
/** "super" de outro cliente com o schema da Setes no token (forma que o login nunca produz) — com vínculo no setes_setes. */
const OTHER_FORGED_SCHEMA = bearer({ institutionId: 7, userId: 33, role: 'super', schemaName: 'setes_setes' })

const nothingWritten = () => { expect(savedContract).toEqual([]); expect(revokedContract).toEqual([]) }
const mark = (token: string, inst: string | number, iface: string | number, linkedTo = true) =>
  request(app).put(`/api/institution-interfaces/${inst}/interfaces/${iface}`).set('Authorization', token).send({ linked: linkedTo })

// =====================================================================================================================
// (1) usuário da Setes SEM a liberação chegando na tela por truque de URL
// =====================================================================================================================
describe('(1) truques de URL sem a liberação do Super', () => {
  const tricks: Array<[string, string]> = [
    ['get', '/api/institution-interfaces'],
    ['get', '/api/Institution-Interfaces'],
    ['get', '/api/INSTITUTION-INTERFACES/7'],
    ['get', '/api/institution-interfaces/'],
    ['get', '/api/institution-interfaces/7/'],
    ['get', '/api/institution-interfaces/%37'],
    ['get', '/api/institution-interfaces//7'],
    ['get', '/api/institution-interfaces/7?page=0&pageSize=-1'],
    ['head', '/api/institution-interfaces'],
    ['put', '/api/institution-interfaces/7/interfaces/9'],
    ['put', '/api/Institution-Interfaces/7/interfaces/9/'],
    ['put', '/api/institution-interfaces/7'],
    ['post', '/api/institution-interfaces/7/interfaces/9'],
    ['patch', '/api/institution-interfaces/7/interfaces/9'],
    ['delete', '/api/institution-interfaces/7/interfaces/9'],
  ]

  it('[RESISTIU] admin e usuário da Setes sem nenhum vínculo: toda variação de caminho/verbo → 403, nada gravado', async () => {
    for (const token of [SETES_ADMIN, SETES_USER]) {
      for (const [verb, url] of tricks) {
        const req = (request(app) as any)[verb](url).set('Authorization', token)
        const r = ['get', 'head'].includes(verb) ? await req : await req.send({ linked: true })
        expect([url, verb, r.status]).toEqual([url, verb, 403])
      }
    }
    nothingWritten()
  })

  it('[RESISTIU] só VISUALIZAR: "method override" (cabeçalho e query) não transforma o PUT em GET', async () => {
    granted = new Set(['setes_setes:9:6'])
    const r = await request(app).put('/api/institution-interfaces/7/interfaces/9?_method=GET')
      .set('Authorization', SETES_USER).set('X-HTTP-Method-Override', 'GET').send({ linked: true })
    expect([r.status, r.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
    nothingWritten()
  })

  it('[RESISTIU] com V+A: verbos sem rota (POST/DELETE) pedem o privilégio do verbo (INSERIR/EXCLUIR não existem no catálogo) → 403; a antiga lista inteira não existe mais (404)', async () => {
    granted = new Set(['setes_setes:9:6', 'setes_setes:9:2'])
    for (const verb of ['post', 'delete']) {
      const r = await (request(app) as any)[verb]('/api/institution-interfaces/7/interfaces/9').set('Authorization', SETES_USER).send({ linked: true })
      expect([verb, r.status, r.body.code]).toEqual([verb, 403, 'PRIVILEGE_REQUIRED'])
    }
    // PATCH = ALTERAR no mapa da guarda → passa a guarda e cai no 404 do roteador (nenhum handler grava)
    const p = await request(app).patch('/api/institution-interfaces/7/interfaces/9').set('Authorization', SETES_USER).send({ linked: true })
    expect(p.status).toBe(404)
    // D-PV34: o PUT da LISTA inteira saiu — passa a guarda (ALTERAR) e cai no 404
    const old = await request(app).put('/api/institution-interfaces/7').set('Authorization', SETES_USER).send({ interfaceIds: [9] })
    expect(old.status).toBe(404)
    nothingWritten()
  })

  it('[RESISTIU] HEAD com VISUALIZAR passa (mesma regra do GET) e não grava', async () => {
    granted = new Set(['setes_setes:9:6'])
    expect((await request(app).head('/api/institution-interfaces').set('Authorization', SETES_USER)).status).toBe(200)
    nothingWritten()
  })
})

// =====================================================================================================================
// (2) admin da Setes concedendo a SI MESMO (ou a outro) o privilégio da tela delegada
// =====================================================================================================================
describe('(2) auto-concessão pelo cadastro de privilégios', () => {
  const variants = ['41', '41.0', '0x29', '+41', '%2041', '041', '4.1e1', '41%20']

  it('[RESISTIU] admin da Setes: toda grafia do id da interface delegável → 403 SUPER_DELEGATION_SUPER_ONLY (ou 400), nada escrito', async () => {
    for (const v of variants) {
      for (const body of [{ privilegeIds: [V, A] }, { privilegeIds: [V, A], institutionId: 1 }, { privilegeIds: [V, A], institutionId: 7 }]) {
        const r = await request(app).put(`/api/users/2/privileges/${v}`).set('Authorization', SETES_ADMIN).send(body)
        expect([v, [400, 403].includes(r.status)]).toEqual([v, true])
        if (r.status === 403) expect(r.body.code).toBe('SUPER_DELEGATION_SUPER_ONLY')
      }
    }
    expect(privilegeWrites).toEqual([])
  })

  it('[RESISTIU] id de uma linha SOFT-DELETADA do catálogo com a chave delegável (pré-concessão que reviveria) → recusado, nada escrito', async () => {
    for (const token of [SETES_ADMIN, SUPER]) {
      const r = await request(app).put('/api/users/2/privileges/43').set('Authorization', token).send({ privilegeIds: [V, A], institutionId: 1 })
      expect([400, 403]).toContain(r.status)
    }
    expect(privilegeWrites).toEqual([])
  })

  it('[RESISTIU] admin da Setes não concede a OUTRO usuário da Setes, nem REVOGA a liberação que o Super deu', async () => {
    for (const privilegeIds of [[V, A], []]) {
      const r = await request(app).put('/api/users/9/privileges/41').set('Authorization', SETES_ADMIN).send({ privilegeIds })
      expect([r.status, r.body.code]).toEqual([403, 'SUPER_DELEGATION_SUPER_ONLY'])
    }
    expect(privilegeWrites).toEqual([])
  })

  it('[RESISTIU] admin de OUTRO cliente: o institutionId do corpo é ignorado (alvo forçado ao JWT) → 403', async () => {
    const r = await request(app).put('/api/users/30/privileges/41').set('Authorization', OTHER_ADMIN)
      .send({ privilegeIds: [V], institutionId: 1 })
    expect([r.status, r.body.code]).toEqual([403, 'SUPER_DELEGATION_SUPER_ONLY'])
    expect(privilegeWrites).toEqual([])
  })

  it('[RESISTIU] o próprio Super só libera para usuário da Setes (alvo 7 → 403); para a Setes grava', async () => {
    const r7 = await request(app).put('/api/users/30/privileges/41').set('Authorization', SUPER).send({ privilegeIds: [V], institutionId: 7 })
    expect([r7.status, r7.body.code]).toEqual([403, 'SUPER_DELEGATION_SUPER_ONLY'])
    expect(privilegeWrites).toEqual([])
    const r1 = await request(app).put('/api/users/9/privileges/41').set('Authorization', SUPER).send({ privilegeIds: [V, A], institutionId: 1 })
    expect(r1.status).toBe(200)
    expect(privilegeWrites.length).toBeGreaterThan(0)
  })

  it('[RESISTIU] admin da Setes não se promove a super pelos vínculos (PUT /users/:id/institutions é só do Super)', async () => {
    const r = await request(app).put('/api/users/2/institutions').set('Authorization', SETES_ADMIN)
      .send({ links: [{ institutionId: 1, kind: 'super' }] })
    expect(r.status).toBe(403)
    const c = await request(app).post('/api/users').set('Authorization', SETES_ADMIN)
      .send({ nameCompany: 'X', nickTrade: 'X', email: 'x@x.com', password: '12345', kind: 'super' })
    expect(c.status).toBe(400)
  })

  // ---- ACHADO HIGH (2026-10-18): o admin da Setes não concede, mas ASSUME a conta do Super (mesma institution 1) --------------
  it('[CORRIGIDO — era HIGH] admin da Setes NÃO troca a senha do usuário SUPER (tomada da conta = tudo, inclusive conceder a delegação a si)', async () => {
    const r = await request(app).put('/api/users/1').set('Authorization', SETES_ADMIN)
      .send({ nameCompany: 'Super', nickTrade: 'Super', email: SUPER_EMAIL, password: 'nova-senha', active: 'S' })
    expect([403, 404]).toContain(r.status)
    expect(userWrites.filter(w => /SET password/.test(w.sql))).toEqual([])
  })

  it('[CORRIGIDO — era HIGH] admin da Setes NÃO desativa o usuário SUPER; e a exclusão de usuário NÃO EXISTE mais (D-PV19/D-UC1 — 404 para todos)', async () => {
    for (const token of [SETES_ADMIN, SUPER]) {
      const d = await request(app).delete('/api/users/1').set('Authorization', token)
      expect(d.status).toBe(404)
    }
    const u = await request(app).put('/api/users/1').set('Authorization', SETES_ADMIN)
      .send({ nameCompany: 'Super', nickTrade: 'Super', email: SUPER_EMAIL, active: 'N' })
    expect([403, 404]).toContain(u.status)
    expect(userWrites).toEqual([])
  })

  // ---- DECIDIDO (D-PV19, Valdo 2026-10-20 — a A-PV13 MORREU: o dono da credencial é o titular do e-mail, D-UC3) ------------------
  // Antes (interino, 2026-10-18) a conta com vínculo com OUTRO estabelecimento era só do Super; agora cada estabelecimento gere o seu
  // vínculo e, pela D-PV12, o admin mexe na senha de todos do próprio estabelecimento menos a do super. Limite registrado (Q-PV55):
  // até a onda 0 do convidado (D-UC6 — o admin define só a senha INICIAL), o admin de X troca a senha de um login que o Super também
  // vinculou a Y. Conhecimento negativo: NÃO "consertar" — o vínculo cruzado só o Super cria.
  it('[DECIDIDO D-PV19 + D-PV48] admin de OUTRO cliente edita usuário vinculado TAMBÉM à Setes (a A-PV13 morreu) — mas a SENHA ninguém troca: 409', async () => {
    LINKS[5] = [1, 7]
    try {
      const body = { nameCompany: 'Suporte', nickTrade: 'Suporte', email: 'suporte@setes.com.br', active: 'S' }
      const pw = await request(app).put('/api/users/5').set('Authorization', OTHER_ADMIN).send({ ...body, password: 'nova-senha' })
      expect([pw.status, pw.body.code]).toEqual([409, 'PASSWORD_OWNER_ONLY'])
      const r = await request(app).put('/api/users/5').set('Authorization', OTHER_ADMIN).send(body)
      expect(r.status).toBe(200)
      expect(userWrites.filter(w => /SET password/.test(w.sql))).toEqual([])
    } finally {
      delete LINKS[5]
    }
  })

  // ---- DECIDIDO (D-PV12, Valdo — fecha a Q-PV37): o admin da Setes TROCA a senha do usuário que o Super liberou ---------
  it('[SUPERADO pela D-PV48 — a D-PV12 caiu] admin da Setes NÃO troca a senha do usuário que o Super liberou (só o titular, pela recuperação); o resto da conta segue editável', async () => {
    granted = new Set(['setes_setes:9:6', 'setes_setes:9:2'])
    const body = { nameCompany: 'U', nickTrade: 'U', email: 'u@setes.com.br', active: 'S' }
    const pw = await request(app).put('/api/users/9').set('Authorization', SETES_ADMIN).send({ ...body, password: 'nova-senha' })
    expect([pw.status, pw.body.code]).toEqual([409, 'PASSWORD_OWNER_ONLY'])
    const r = await request(app).put('/api/users/9').set('Authorization', SETES_ADMIN).send(body)
    expect(r.status).toBe(200)
    expect(userWrites.filter(w => /SET password/.test(w.sql))).toEqual([])
  })
})

// =====================================================================================================================
// (3) usuário liberado tocando o vínculo da PRÓPRIA Setes (id 1 em outras grafias) — D-PV38: nem LER
// =====================================================================================================================
describe('(3) o vínculo da própria Setes', () => {
  const ones = ['1', '01', '001', '1.0', '0x1', '%31', '+1', '%2B1', '%201', '1%20', '1e0', '0.1e1', '1.0000000000000001', '1/']

  it('[RESISTIU] marca com toda grafia de "1" → 403 SETES_INTERFACES_SUPER_ONLY ou 400 — nunca grava a linha da 1', async () => {
    granted = new Set(['setes_setes:9:6', 'setes_setes:9:2'])
    for (const id of ones) {
      for (const to of [true, false]) {
        const r = await mark(SETES_USER, id, 9, to)
        // '1/' vira `//interfaces` — nenhuma rota casa (404 do Express): também não grava
        expect([id, to, [400, 403, 404].includes(r.status)]).toEqual([id, to, true])
        if (r.status === 403) expect(r.body.code).toBe('SETES_INTERFACES_SUPER_ONLY')
      }
    }
    expect(savedContract.filter(s => s.institutionId === 1)).toEqual([])
    expect(revokedContract.filter(s => s.institutionId === 1)).toEqual([])
  })

  it('[CORRIGIDO — era LOW/questão → D-PV38] LER o vínculo da Setes pelo GET /1 → 403 para o liberado (o mesmo veredito do salvar); a lista o esconde; o Super lê', async () => {
    granted = new Set(['setes_setes:9:6'])
    const r = await request(app).get('/api/institution-interfaces/1').set('Authorization', SETES_USER)
    expect([r.status, r.body.code]).toEqual([403, 'SETES_INTERFACES_SUPER_ONLY'])
    for (const id of ['01', '1.0', '0x1']) expect((await request(app).get(`/api/institution-interfaces/${id}`).set('Authorization', SETES_USER)).status).toBe(403)
    expect((await request(app).get('/api/institution-interfaces/1').set('Authorization', SUPER)).status).toBe(200)
  })

  it('[ANALISADO LOW — latente] FILIAL da Setes no mesmo schema (frente do grupo): hoje grava com a chave DELA, não toca a da 1', async () => {
    granted = new Set(['setes_setes:9:6', 'setes_setes:9:2'])
    const r = await mark(SETES_USER, 8, 9)
    expect(r.status).toBe(200)
    expect(savedContract).toEqual([{ schema: 'setes_setes', institutionId: 8, ids: [9] }])
    // quando a chave do contrato virar a do GRUPO (D-GE22), este PUT passaria a escrever o contrato da Setes:
    // o predicado `isOwnVendorInstitution` (D-PV37) precisa virar "o GRUPO do alvo é o da Setes" — um lugar só.
  })
})

// =====================================================================================================================
// (4) liberação vinda de OUTRA institution
// =====================================================================================================================
describe('(4) usuário de outra institution', () => {
  it('[RESISTIU] admin/super/user de outro cliente — mesmo com vínculo marcado no schema dele ou com o schema da Setes no token → 403', async () => {
    granted = new Set(['setes_cliente:30:6', 'setes_cliente:31:6', 'setes_cliente:32:6', 'setes_setes:33:6', 'setes_setes:33:2'])
    for (const token of [OTHER_ADMIN, OTHER_SUPER, OTHER_USER, OTHER_FORGED_SCHEMA]) {
      for (const [verb, url] of [['get', '/api/institution-interfaces'], ['get', '/api/institution-interfaces/7'], ['put', '/api/institution-interfaces/7/interfaces/9']]) {
        const r = await (request(app) as any)[verb](url).set('Authorization', token).send({ linked: true })
        expect([url, r.status, r.body.code]).toEqual([url, 403, 'INTERFACE_NOT_ALLOWED'])
      }
    }
    nothingWritten()
  })

  it('[RESISTIU] institutionId como TEXTO "1" no token (tipo trocado) não vira Setes nem super', async () => {
    const token = bearer({ institutionId: '1' as any, userId: 1, role: 'super', schemaName: 'setes_setes' })
    granted = new Set(['setes_setes:1:6', 'setes_setes:1:2'])
    const r = await mark(token, 7, 9)
    expect([401, 403]).toContain(r.status)
    nothingWritten()
  })
})

// =====================================================================================================================
// (5) o que o liberado escreve no vínculo — D-PV34 (uma marca) e D-PV35 (só vendáveis, estruturais travadas)
// =====================================================================================================================
describe('(5) corpo da marca', () => {
  beforeEach(() => { granted = new Set(['setes_setes:9:6', 'setes_setes:9:2']) })

  it('[RESISTIU] corpo inválido (linked ausente, texto, número, null, objeto) → 400, nada gravado', async () => {
    const bodies: any[] = [{}, { linked: 'S' }, { linked: 1 }, { linked: null }, { linked: { x: 1 } }, { interfaceIds: [9] }]
    for (const body of bodies) {
      const r = await request(app).put('/api/institution-interfaces/7/interfaces/9').set('Authorization', SETES_USER).send(body)
      expect([JSON.stringify(body).slice(0, 40), r.status]).toEqual([JSON.stringify(body).slice(0, 40), 400])
    }
    nothingWritten()
  })

  it('[RESISTIU] interfaceId inválido (negativo, zero, fração, texto, gigante) e fora do catálogo → 400 (nunca 500), nada gravado', async () => {
    for (const id of ['-1', '0', '1.5', 'abc', '1e20', String(Number.MAX_SAFE_INTEGER + 2), '500']) {
      const r = await mark(SETES_USER, 7, id)
      expect([id, r.status]).toEqual([id, 400])
    }
    nothingWritten()
  })

  it('[RESISTIU] idempotência: conceder o já concedido não escreve nem gera evento; a repetição da marca não duplica', async () => {
    const r1 = await mark(SETES_USER, 7, 9, true)
    expect([r1.status, r1.body.data]).toEqual([200, { interfaceId: 9, linked: true, changed: false }])
    nothingWritten()
    const r2 = await mark(SETES_USER, 7, 18, true)
    const r3 = await mark(SETES_USER, 7, 18, true)
    expect([r2.body.data.changed, r3.body.data.changed]).toEqual([true, true])    // o dublê não "aprende" — cada marca é uma transação travante
    expect(savedContract).toEqual([{ schema: 'setes_cliente', institutionId: 7, ids: [18] }, { schema: 'setes_cliente', institutionId: 7, ids: [18] }])
  })

  it('[CORRIGIDO — era LOW analisado → D-PV35] o liberado NÃO põe no contrato de um cliente telas do grupo Super (inclusive a própria delegável) → 400 INTERFACE_NOT_SELLABLE', async () => {
    const r = await mark(SETES_USER, 7, IFACE)
    expect([r.status, r.body.code]).toEqual([400, 'INTERFACE_NOT_SELLABLE'])
    nothingWritten()
    // [RESISTIU] o cadastro de privilégios do admin do cliente NÃO lista a tela delegável mesmo que ela estivesse no contrato dele
    await request(app).get('/api/users/30/privileges').set('Authorization', OTHER_ADMIN)
    expect(userPrivilegesListParams?.[2]).toEqual(expect.arrayContaining(['users', 'establishment', 'institution-interfaces']))
  })

  it('[RESISTIU] D-PV35: revogar ESTRUTURAL pela porta delegada → 409 INTERFACE_STRUCTURAL_LOCKED; conceder pode', async () => {
    linked.add('setes_cliente:7:42')
    const r = await mark(SETES_USER, 7, 42, false)
    expect([r.status, r.body.code]).toEqual([409, 'INTERFACE_STRUCTURAL_LOCKED'])
    nothingWritten()
    expect((await mark(SETES_USER, 7, 42, true)).body.data.changed).toBe(false)
  })
})

// =====================================================================================================================
// (6) IDOR — resolução da institution alvo
// =====================================================================================================================
describe('(6) institution alvo', () => {
  beforeEach(() => { granted = new Set(['setes_setes:9:6', 'setes_setes:9:2']) })

  it('[RESISTIU] alvo inexistente/soft-deletado (9, 0, -0, 99999) → 404 no GET e na marca, nada gravado; a busca filtra deleted', async () => {
    for (const id of ['9', '0', '-0', '99999']) {
      expect([id, (await request(app).get(`/api/institution-interfaces/${id}`).set('Authorization', SETES_USER)).status]).toEqual([id, 404])
      expect([id, (await mark(SETES_USER, id, 9)).status]).toEqual([id, 404])
    }
    nothingWritten()
    const schemaSql = q.mock.calls.map(c => String(c[0])).filter(s => /schema_name AS schemaName/.test(s))
    expect(schemaSql.length).toBeGreaterThan(0)
    for (const s of schemaSql) expect(s).toMatch(/deleted = 'N'/)
  })

  it('[RESISTIU] id negativo / não numérico → 400 INVALID_ID', async () => {
    for (const id of ['-1', 'abc', '1;DROP', '1%27']) {
      const r = await mark(SETES_USER, id, 9)
      expect([id, r.status]).toEqual([id, 400])
    }
    nothingWritten()
  })

  it('[RESISTIU] filtro da lista com curingas LIKE vai escapado e por placeholder', async () => {
    granted = new Set(['setes_setes:9:6'])
    await request(app).get(`/api/institution-interfaces?filter=${encodeURIComponent("%_'; DROP TABLE x --")}`).set('Authorization', SETES_USER)
    const call = q.mock.calls.find(c => /INNER JOIN setes_central\.tb_entity/.test(String(c[0])) && /LIMIT/.test(String(c[0])))!
    expect(String(call[0])).not.toMatch(/DROP/)
    expect(call[1][2]).toBe("%\\%\\_'; DROP TABLE x --%")
  })
})

// =====================================================================================================================
// (7) as rotas do Super em /api/admin seguem só do Super
// =====================================================================================================================
describe('(7) /api/admin', () => {
  it('[RESISTIU] liberado (V+A, admin ou usuário) → 403 em toda rota de /api/admin; o Super passa', async () => {
    granted = new Set(['setes_setes:2:6', 'setes_setes:2:2', 'setes_setes:9:6', 'setes_setes:9:2'])
    for (const token of [SETES_ADMIN, SETES_USER]) {
      for (const [verb, url, body] of [
        ['get', '/api/admin/institutions', undefined], ['get', '/api/admin/institutions/7/interfaces', undefined],
        ['put', '/api/admin/institutions/7/interfaces/9', { linked: true }], ['put', '/api/admin/institutions/1/interfaces/9', { linked: true }],
        ['put', '/api/admin/institutions/7/feature-flags', { moduleKey: 'orders', enabled: true }],
      ] as const) {
        const r = await (request(app) as any)[verb](url).set('Authorization', token).send(body ?? {})
        expect([url, verb, r.status]).toEqual([url, verb, 403])
      }
    }
    nothingWritten()
    expect((await request(app).get('/api/admin/institutions/7/interfaces').set('Authorization', SUPER)).status).toBe(200)
  })
})

// =====================================================================================================================
// (8) menu: botões da tela delegada = só o que o Super marcou
// =====================================================================================================================
describe('(8) menu', () => {
  const row = (id: number, key: string, group: string) => ({
    moduleId: null, moduleDescription: group, moduleIcon: null, interfaceId: id, interfaceDescription: key, i18nKey: key,
  })
  /**
   * Costura A1 (D-AU3/D-AU6): o repositório dá só o ARRANJO (módulos, telas sem módulo, a delegável); QUAIS telas e QUAIS botões vêm
   * de UMA leitura da `vw_user_access` — respondida pelo dublê. Catálogo: orders com VISUALIZAR; a delegável com VISUALIZAR e ALTERAR;
   * o Super marcou ao admin da Setes SÓ o VISUALIZAR da delegável.
   */
  const menuModel = (contracted: string[]): AccessModel => ({
    profile: 'admin', vendor: true, contracted,
    registered: { orders: ['VISUALIZAR'], 'institution-interfaces': ['VISUALIZAR', 'ALTERAR'] },
    granted: { 'institution-interfaces': ['VISUALIZAR'] },
    interfaceIds: { orders: 29, 'institution-interfaces': IFACE },
  })
  const menuDb = (opts: { ungrouped: any[]; delegable: any[]; model: AccessModel }) => async (sql: string, params: any[] = []) => {
    const a = accessAnswer(sql, params, opts.model)
    if (a) return [a, []]
    if (/NOT EXISTS \(SELECT 1 FROM `setes_\w+`\.tb_module_has_interface/.test(sql)) return [opts.ungrouped]
    if (/FROM `setes_\w+`\.tb_module m\b/.test(sql)) return [[]]
    if (/i\.i18n_key IN \(\?\)/.test(sql)) return [opts.delegable]
    return [[]]
  }
  const flat = (menus: any[]) => menus.flatMap(m => m.interfaces.map((i: any) => [i.i18nKey, i.privileges]))
  const ADMIN_SETES = { institutionId: 1, userId: 2, role: 'admin', schemaName: 'setes_setes' } as any

  it('[RESISTIU] admin com SÓ VISUALIZAR marcado pelo Super: a tela aparece com [VISUALIZAR], nunca o catálogo [VISUALIZAR, ALTERAR]', async () => {
    q.mockImplementation(menuDb({
      ungrouped: [row(29, 'orders', 'Vendas')], delegable: [row(IFACE, 'institution-interfaces', 'Super')], model: menuModel(['orders']),
    }))
    expect(flat(await getMenus(ADMIN_SETES))).toEqual([['orders', ['VISUALIZAR']], ['institution-interfaces', ['VISUALIZAR']]])
  })

  // Era `it.failing` [ACHADO LOW] (2026-10-18): a tela aparecia DUAS vezes, uma com os botões do catálogo. A costura A1 fechou por
  // construção — os botões de QUALQUER entrada vêm da view (a delegável só pela concessão, nunca pelo contrato) e o menu não repete a tela.
  it('[CORRIGIDO pela costura A1 — era ACHADO LOW] a tela delegável também no CONTRATO da Setes fora do grupo Super: aparece UMA vez, só com o que o Super marcou', async () => {
    q.mockImplementation(menuDb({
      ungrouped: [row(29, 'orders', 'Vendas'), row(IFACE, 'institution-interfaces', 'Sistema')],
      delegable: [row(IFACE, 'institution-interfaces', 'Sistema')],
      model: menuModel(['orders', 'institution-interfaces']),
    }))
    const entries = flat(await getMenus(ADMIN_SETES)).filter(([k]: any) => k === 'institution-interfaces')
    expect(entries).toEqual([['institution-interfaces', ['VISUALIZAR']]])
  })
})

// =====================================================================================================================
// (9) flags — D-PV10 (sem o atalho da institution 1) × D-PV36 (a flag morreu nos módulos guardados)
// =====================================================================================================================
describe('(9) flags (D-PV10 + D-PV36)', () => {
  it('[DECIDIDO D-PV36] módulo GUARDADO (a tela delegável inclusive): a flag desligada NÃO barra e nem é consultada — a licença é a delegação/o contrato', async () => {
    flagOn.mockResolvedValue(false)
    granted = new Set(['setes_setes:9:6', 'setes_setes:9:2'])
    expect((await request(app).get('/api/institution-interfaces').set('Authorization', SUPER)).status).toBe(200)
    expect((await request(app).get('/api/institution-interfaces').set('Authorization', SETES_USER)).status).toBe(200)
    expect(flagOn).not.toHaveBeenCalledWith(1, 'institution-interfaces')
    // sem a liberação a tela segue fechada — pela DELEGAÇÃO, não pela flag
    granted = new Set()
    expect((await request(app).get('/api/institution-interfaces').set('Authorization', SETES_USER)).status).toBe(403)
  })

  it('[RESISTIU] admin da Setes sem a flag do módulo NÃO guardado → 403 MODULE_NOT_ENABLED (users, modules, establishment, billing); o guardado (orders) cai na LICENÇA', async () => {
    flagOn.mockResolvedValue(false)
    for (const url of ['/api/users', '/api/modules', '/api/establishment']) {
      const r = await request(app).get(url).set('Authorization', SETES_ADMIN)
      expect([url, r.status, r.body.code]).toEqual([url, 403, 'MODULE_NOT_ENABLED'])
    }
    const b = await request(app).post('/api/billing/validate').set('Authorization', SETES_ADMIN).send({ orderId: 1 })
    expect([b.status, b.body.code]).toEqual([403, 'MODULE_NOT_ENABLED'])
    const o = await request(app).get('/api/orders').set('Authorization', SETES_ADMIN)
    expect([o.status, o.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])        // nada contratado no dublê — a licença decide
    expect(flagOn).not.toHaveBeenCalledWith(1, 'orders')
  })

  it('[RESISTIU] variação de caixa no segmento do módulo não fura a flag (segmento desconhecido = não guardado → flag exata → nega)', async () => {
    flagOn.mockImplementation(async (_i: number, key: string) => key === 'institution-interfaces')
    granted = new Set(['setes_setes:9:6'])
    expect((await request(app).get('/api/institution-interfaces').set('Authorization', SETES_USER)).status).toBe(200)
    expect((await request(app).get('/api/Institution-Interfaces').set('Authorization', SETES_USER)).status).toBe(403)
  })
})

// =====================================================================================================================
// (10) a montagem recusa chave não delegável
// =====================================================================================================================
describe('(10) montagem', () => {
  it('[RESISTIU] delegatedSuper com chave fora da lista (inclusive caixa/espaço trocados) lança na montagem', () => {
    for (const key of ['institutions', 'interfaces', 'privileges', 'banks', 'admin', 'Institution-Interfaces', 'institution-interfaces ', '']) {
      expect(() => gatedModule(key, Router(), { delegatedSuper: true })).toThrow(/DELEGABLE_SUPER_INTERFACES/)
    }
  })

  it('[RESISTIU] a tabela das rotas guardadas: só institution-interfaces é delegada, GET → 6 e a marca (PUT) → 2', () => {
    const delegated = listGatedRoutes().filter(r => r.delegatedSuper)
    expect([...new Set(delegated.map(r => r.moduleKey))]).toEqual(['institution-interfaces'])
    expect(delegated.map(r => [r.method, r.path, r.privilegeId]).sort()).toEqual([['GET', '/', 6], ['GET', '/:id', 6], ['PUT', '/:id/interfaces/:interfaceId', 2]].sort())
  })
})

// =====================================================================================================================
// RE-PROVA (2026-10-18, revista em 2026-10-21) — a barreira da conta (`assertAccountManageable` — D-PV12; a A-PV13 morreu, D-PV19)
// =====================================================================================================================
describe('(R2) barreira da conta — outras portas, vínculo adormecido, corrida', () => {
  // D-PV48: a edição da conta NÃO leva senha (credencial existente — só o titular troca, pela recuperação)
  const editBody = (email: string) => ({ nameCompany: 'U', nickTrade: 'U', email, active: 'S' })
  const passwordWrites = () => userWrites.filter(w => /SET password/.test(w.sql))

  // ---- (a) outras rotas que escrevem a CONTA ----------------------------------------------------------------------------
  it('[RESISTIU] (a) criar usuário com o e-mail de login do Super → 409, nada gravado', async () => {
    for (const token of [SETES_ADMIN, OTHER_ADMIN]) {
      const r = await request(app).post('/api/users').set('Authorization', token)
        .send({ nameCompany: 'X', nickTrade: 'X', email: SUPER_EMAIL, password: '12345', kind: 'admin' })
      expect(r.status).toBe(409)
    }
    expect(userWrites).toEqual([])
  })

  it('[RESISTIU] (a) admin trocando o e-mail da PRÓPRIA conta (para o do Super ou qualquer outro) → 409 LOGIN_EMAIL_IMMUTABLE (D-PV19), nada gravado', async () => {
    for (const email of [SUPER_EMAIL, 'outro@setes.com.br']) {
      const r = await request(app).put('/api/users/2').set('Authorization', SETES_ADMIN).send(editBody(email))
      expect([r.status, r.body.code]).toEqual([409, 'LOGIN_EMAIL_IMMUTABLE'])
    }
    expect(userWrites).toEqual([])
  })

  it('[RESISTIU] (a) a conta própria (vínculo com o próprio estabelecimento, sem super) segue editável — controle; o ativo vai ao VÍNCULO, não à credencial', async () => {
    const r = await request(app).put('/api/users/32').set('Authorization', OTHER_ADMIN).send(editBody('u32@cliente.com'))
    expect(r.status).toBe(200)
    expect(passwordWrites()).toEqual([])                       // D-PV48: nenhuma porta do cadastro grava senha de credencial existente
    expect(userWrites.filter(w => /tb_institution_has_user/.test(w.sql) && /SET active/.test(w.sql)).map(w => w.params)).toEqual([['S', 32, 7]])
    expect(userWrites.filter(w => /UPDATE setes_central\.tb_user\b/.test(w.sql) && /active/.test(w.sql))).toEqual([])
  })

  it('[RESISTIU] (a) super × admin: o 403 da barreira vem com code USER_MANAGED_BY_SUPER; sem vínculo com o próprio = 404', async () => {
    const r = await request(app).put('/api/users/1').set('Authorization', SETES_ADMIN).send(editBody(SUPER_EMAIL))
    expect([r.status, r.body.code]).toEqual([403, 'USER_MANAGED_BY_SUPER'])
    const o = await request(app).put('/api/users/1').set('Authorization', OTHER_ADMIN).send(editBody(SUPER_EMAIL))
    expect(o.status).toBe(404)
    expect(userWrites).toEqual([])
  })

  it.failing('[ACHADO MEDIUM — pré-existente, fora do delta] (a) /auth/change-password: o código de 6 dígitos não morre depois de N tentativas erradas (força bruta só freada pelo limite por IP)', async () => {
    for (let i = 0; i < 25; i++) {
      const w = await request(app).post('/auth/change-password').send({ email: SUPER_EMAIL, code: String(100000 + i), newPassword: 'tomada' })
      expect(w.status).toBe(401)
    }
    const ok = await request(app).post('/auth/change-password').send({ email: SUPER_EMAIL, code: RECOVERY_CODE, newPassword: 'tomada' })
    expect(ok.status).toBe(401)
    expect(passwordWrites()).toEqual([])
  })

  // ---- (b) desvincular o super / usuário multi-institution ------------------------------------------------------------
  it('[RESISTIU] (b) admin não mexe nos VÍNCULOS de ninguém (nem do Super, nem de multi-institution, nem os próprios)', async () => {
    LINKS[5] = [1, 7]
    try {
      for (const [token, uid] of [[SETES_ADMIN, 1], [SETES_ADMIN, 2], [OTHER_ADMIN, 5], [SETES_ADMIN, 5]] as const) {
        const r = await request(app).put(`/api/users/${uid}/institutions`).set('Authorization', token).send({ links: [] })
        expect([uid, r.status]).toEqual([uid, 403])
      }
    } finally { delete LINKS[5] }
  })

  it('[DECIDIDO D-PV19/D-UC1] (b) a exclusão de usuário não existe — DELETE /api/users/:id é 404 para admin e Super, nada gravado', async () => {
    LINKS[5] = [1, 7]
    try {
      for (const [token, uid] of [[SETES_ADMIN, 1], [OTHER_ADMIN, 5], [SETES_ADMIN, 5], [SUPER, 5]] as const) {
        const r = await request(app).delete(`/api/users/${uid}`).set('Authorization', token)
        expect([uid, r.status]).toEqual([uid, 404])
      }
      expect(userWrites).toEqual([])
    } finally { delete LINKS[5] }
  })

  it('[RESISTIU] (b) cadastro de privilégios: o admin não revoga a liberação do usuário multi-institution pela outra porta', async () => {
    LINKS[5] = [1, 7]
    try {
      const r = await request(app).put('/api/users/5/privileges/41').set('Authorization', SETES_ADMIN).send({ privilegeIds: [] })
      expect([r.status, r.body.code]).toEqual([403, 'SUPER_DELEGATION_SUPER_ONLY'])
      expect(privilegeWrites).toEqual([])
    } finally { delete LINKS[5] }
  })

  // ---- (c) vínculo ADORMECIDO ---------------------------------------------------------------------------------------------
  it('[RESISTIU — corrigido na re-prova] (c) vínculo REVOGADO de super com a Setes (active N) conta: o admin do cliente não troca a senha (o Super, ao reviver o vínculo, entregaria a conta)', async () => {
    LINKS[6] = [7]
    DORMANT_LINKS[6] = [{ institutionId: 1, kind: 'super', active: 'N', deleted: 'N' }]
    try {
      const r = await request(app).put('/api/users/6').set('Authorization', OTHER_ADMIN).send(editBody('u6@setes.com.br'))
      expect([r.status, r.body.code]).toEqual([403, 'USER_MANAGED_BY_SUPER'])
      expect(passwordWrites()).toEqual([])
    } finally { delete LINKS[6] }
  })

  it('[DECIDIDO D-PV19] (c) vínculo com OUTRO estabelecimento (vivo ou adormecido, kind user) NÃO barra mais — a A-PV13 morreu; a conta é do titular', async () => {
    LINKS[6] = [7]
    DORMANT_LINKS[6] = [{ institutionId: 1, kind: 'user', active: 'N', deleted: 'S' }]
    try {
      const r = await request(app).put('/api/users/6').set('Authorization', OTHER_ADMIN).send(editBody('u6@setes.com.br'))
      expect(r.status).toBe(200)
      expect(passwordWrites()).toEqual([])                       // D-PV48: nenhuma porta do cadastro grava senha de credencial existente
    } finally { delete LINKS[6] }
  })

  // ---- (d) corrida entre ler os vínculos e gravar ----------------------------------------------------------------------
  it.failing('[ACHADO LOW] (d) a barreira lê os vínculos FORA da transação da gravação (sem FOR UPDATE nem releitura): o Super vinculando a conta como SUPER no meio não barra a escrita', async () => {
    linksInTx = { 32: [{ institutionId: 7, kind: 'user' }, { institutionId: 1, kind: 'super' }] }
    const r = await request(app).put('/api/users/32').set('Authorization', OTHER_ADMIN).send(editBody('u32@cliente.com'))
    expect(r.status).toBe(403)
    expect(passwordWrites()).toEqual([])
  })
})
