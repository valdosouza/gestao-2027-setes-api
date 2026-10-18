/// <reference types="jest" />
// GATE testar-adversarial do delta D-PV10/D-PV11 (2026-10-18 — Infra-IA/prompts/prompt_privilegios_interfaces.md "Rodada 3" e §11.9;
// skill Infra-IA/skills-genericas/testar-adversarial.md). Sondas que TENTAM QUEBRAR a delegação da tela "Interfaces dos clientes":
//   [RESISTIU] = `it` que passa (a defesa segurou);
//   [ACHADO]   = `it.failing` com a asserção SEGURA (o código atual a quebra — corrigir e trocar por `it`).
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
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import { gatedModule, listGatedRoutes } from '../shared/auth/module-privilege-gate'
import { getMenus } from '../modules/core/core.service'
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
const INTERFACE_KEY: Record<number, string> = { 41: 'institution-interfaces', 9: 'customers', 42: 'users', 43: 'institution-interfaces' }
/** 43 = uma linha ANTIGA (soft-deletada) do catálogo com a MESMA chave da tela delegável — o catálogo de privilégios dela segue ativo. */
const SOFT_DELETED_INTERFACES = new Set([43])
const CATALOG: Record<number, number[]> = { 41: [V, A], 43: [V, A], 9: [V, I, A, E] }
/** Re-prova da barreira da conta: vínculos que existem mas não estão VIVOS (revogados pelo Super — `setInstitutionLinks` os revive). */
const DORMANT_LINKS: Record<number, Array<{ institutionId: number; kind: string; active: string; deleted: string }>> = {}
/** Corrida (d): o que uma releitura DENTRO da transação de gravação veria (o Super vinculou o usuário à Setes no meio). */
let linksInTx: Record<number, Array<{ institutionId: number; kind: string }>> = {}
const SUPER_EMAIL = 'super@setes.com.br'
const RECOVERY_CODE = '123456'

let granted: Set<string>            // `${schema}:${userId}:${privilegeId}` (sempre na interface 41)
let savedContract: Array<{ schema: string; institutionId: number; ids: number[] }>
let revokedContract: Array<{ schema: string; institutionId: number }>
let privilegeWrites: string[]
let userWrites: Array<{ sql: string; params: any[] }>
let userPrivilegesListParams: any[] | null

const conn = {
  beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  query: jest.fn(async (sql: string, params: any[] = []) => {
    const schema = /`(setes_\w+)`/.exec(sql)?.[1] ?? ''
    if (/FROM setes_central\.tb_institution_has_user/.test(sql) && /kind/.test(sql)) {
      // releitura dos vínculos dentro da transação (se um dia existir): devolve o estado "depois do Super"
      const uid = Number(params[0])
      return [linksInTx[uid] ?? (LINKS[uid] ?? []).map(inst => ({ institutionId: inst, kind: 'user' }))]
    }
    if (/INSERT INTO `setes_\w+`\.tb_institution_has_interface/.test(sql)) {
      savedContract.push({ schema, institutionId: params[0][0][0], ids: params[0].map((v: any[]) => v[1]) })
    } else if (/UPDATE `setes_\w+`\.tb_institution_has_interface/.test(sql)) {
      revokedContract.push({ schema, institutionId: params[0] })
    } else if (/tb_user_has_privilege/.test(sql)) {
      privilegeWrites.push(sql)
    } else if (/UPDATE setes_central\.tb_user\b/.test(sql)) {
      userWrites.push({ sql, params })
    } else if (/nextId/.test(sql)) {
      return [[{ nextId: 500 }]]
    }
    return [[]]
  }),
}

function defaultDb(sql: string, params: any[] = []): any {
  if (/FROM setes_central\.tb_interface WHERE i18n_key/.test(sql)) return [params[0] === 'institution-interfaces' ? [{ id: IFACE }] : []]
  if (/SELECT i18n_key AS i18nKey(, deleted)? FROM setes_central\.tb_interface WHERE id = \?/.test(sql)) {
    const id = Number(params[0])
    const key = INTERFACE_KEY[id]
    const deleted = SOFT_DELETED_INTERFACES.has(id) ? 'S' : 'N'
    if (!key) return [[]]
    // a forma antiga da consulta filtrava `deleted = 'N'` no SQL; a nova devolve a coluna
    if (/deleted = 'N'/.test(sql) && deleted === 'S') return [[]]
    return [[{ i18nKey: key, deleted }]]
  }
  if (/tb_user_has_privilege/.test(sql) && /tb_privilege_id = \?/.test(sql)) {
    const schema = /`(setes_\w+)`/.exec(sql)?.[1]
    return [granted.has(`${schema}:${params[0]}:${params[2]}`) && params[1] === IFACE ? [{ 1: 1 }] : []]
  }
  if (/SELECT 1 FROM setes_central\.tb_user WHERE id = \?/.test(sql)) return [[{ 1: 1 }]]
  // vínculos com o perfil (assertAccountManageable — correção interina dos HIGH): o usuário 1 é o SUPER da Setes
  if (/SELECT tb_institution_id AS institutionId, kind[\s\S]*?FROM setes_central\.tb_institution_has_user/.test(sql)) {
    const uid = Number(params[0])
    const live = (LINKS[uid] ?? []).map(inst => ({ institutionId: inst, kind: uid === 1 ? 'super' : (uid === 2 ? 'admin' : 'user'), alive: 1 }))
    // re-prova (c): vínculos ADORMECIDOS (active 'N' / deleted 'S') entram só se a consulta não os filtrar no WHERE
    const where = sql.slice(sql.indexOf('WHERE'))
    const dormant = (DORMANT_LINKS[uid] ?? []).filter(l =>
      !(/active = 'S'/.test(where) && l.active !== 'S') && !(/deleted = 'N'/.test(where) && l.deleted !== 'N'))
    return [[...live, ...dormant.map(l => ({ institutionId: l.institutionId, kind: l.kind,
      alive: l.active === 'S' && l.deleted === 'N' ? 1 : 0 }))]]
  }
  // re-prova (a): dono do e-mail de login (assertLoginEmailFree) e o fluxo de recuperação de senha do /auth
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
  if (/SELECT id FROM setes_central\.tb_interface WHERE deleted = 'N' AND id IN/.test(sql)) {
    return [params[0].filter((id: number) => id < 100).map((id: number) => ({ id }))]
  }
  if (/FROM setes_central\.tb_institution i\s+INNER JOIN setes_central\.tb_entity/.test(sql) && /LIMIT/.test(sql)) {
    return [[{ id: 7, name: 'Cliente X', active: 'S' }]]
  }
  if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: 1 }]]
  if (/LEFT JOIN `setes_\w+`\.tb_institution_has_interface/.test(sql)) {
    return [[{ id: 9, description: 'Clientes', groupDefault: 'Cadastros', kind: 'T', granted: 1, _inst: params[0] }]]
  }
  if (/i\.i18n_key NOT IN \(\?\)/.test(sql)) { userPrivilegesListParams = params; return [[]] }
  if (/UPDATE setes_central\.tb_user SET deleted = 'S'/.test(sql)) { userWrites.push({ sql, params }); return [[]] }
  return [[]]
}

beforeEach(() => {
  jest.clearAllMocks(); resetPrivilegeCache()
  granted = new Set(); savedContract = []; revokedContract = []; privilegeWrites = []; userWrites = []; userPrivilegesListParams = null
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
    ['put', '/api/institution-interfaces/7'],
    ['put', '/api/Institution-Interfaces/7/'],
    ['post', '/api/institution-interfaces/7'],
    ['patch', '/api/institution-interfaces/7'],
    ['delete', '/api/institution-interfaces/7'],
  ]

  it('[RESISTIU] admin e usuário da Setes sem nenhum vínculo: toda variação de caminho/verbo → 403, nada gravado', async () => {
    for (const token of [SETES_ADMIN, SETES_USER]) {
      for (const [verb, url] of tricks) {
        const req = (request(app) as any)[verb](url).set('Authorization', token)
        const r = ['get', 'head'].includes(verb) ? await req : await req.send({ interfaceIds: [9] })
        expect([url, verb, r.status]).toEqual([url, verb, 403])
      }
    }
    nothingWritten()
  })

  it('[RESISTIU] só VISUALIZAR: "method override" (cabeçalho e query) não transforma o PUT em GET', async () => {
    granted = new Set(['setes_setes:9:6'])
    const r = await request(app).put('/api/institution-interfaces/7?_method=GET')
      .set('Authorization', SETES_USER).set('X-HTTP-Method-Override', 'GET').send({ interfaceIds: [9] })
    expect([r.status, r.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
    nothingWritten()
  })

  it('[RESISTIU] com V+A: verbos sem rota (POST/PATCH/DELETE) pedem o privilégio do verbo (INSERIR/EXCLUIR não existem no catálogo) → 403', async () => {
    granted = new Set(['setes_setes:9:6', 'setes_setes:9:2'])
    for (const verb of ['post', 'delete']) {
      const r = await (request(app) as any)[verb]('/api/institution-interfaces/7').set('Authorization', SETES_USER).send({ interfaceIds: [] })
      expect([verb, r.status, r.body.code]).toEqual([verb, 403, 'PRIVILEGE_REQUIRED'])
    }
    // PATCH = ALTERAR no mapa da guarda → passa a guarda e cai no 404 do roteador (nenhum handler grava)
    const p = await request(app).patch('/api/institution-interfaces/7').set('Authorization', SETES_USER).send({ interfaceIds: [] })
    expect(p.status).toBe(404)
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

  // ---- ACHADO HIGH: o admin da Setes não concede, mas ASSUME a conta do Super (mesma institution 1) ----------------------
  // CORRIGIDO na sessão (interino da Q-PV37: `assertAccountManageable` no editUser/removeUser)
  it('[CORRIGIDO — era HIGH] admin da Setes NÃO troca a senha/e-mail do usuário SUPER (tomada da conta = tudo, inclusive conceder a delegação a si)', async () => {
    const r = await request(app).put('/api/users/1').set('Authorization', SETES_ADMIN)
      .send({ nameCompany: 'Super', nickTrade: 'Super', email: 'admin.da.setes@x.com', password: 'nova-senha', active: 'S' })
    expect([403, 404]).toContain(r.status)
    expect(userWrites.filter(w => /SET password/.test(w.sql))).toEqual([])
  })

  // CORRIGIDO na sessão (interino da Q-PV37: `assertAccountManageable` no editUser/removeUser)
  it('[CORRIGIDO — era HIGH] admin da Setes NÃO exclui nem desativa o usuário SUPER', async () => {
    const d = await request(app).delete('/api/users/1').set('Authorization', SETES_ADMIN)
    expect([403, 404]).toContain(d.status)
    const u = await request(app).put('/api/users/1').set('Authorization', SETES_ADMIN)
      .send({ nameCompany: 'Super', nickTrade: 'Super', email: 'super@setes.com.br', active: 'N' })
    expect([403, 404]).toContain(u.status)
    expect(userWrites).toEqual([])
  })

  // CORRIGIDO na sessão (interino da Q-PV37: `assertAccountManageable` no editUser/removeUser)
  it('[CORRIGIDO — era HIGH] admin de OUTRO cliente NÃO troca a senha de usuário vinculado TAMBÉM à Setes (a senha/e-mail é global — escrita cross-tenant)', async () => {
    // usuário 5: equipe da Setes vinculada à Setes (1) e ao cliente 7 (suporte) — o login é UM só (setes_central.tb_user)
    LINKS[5] = [1, 7]
    try {
      const r = await request(app).put('/api/users/5').set('Authorization', OTHER_ADMIN)
        .send({ nameCompany: 'Suporte', nickTrade: 'Suporte', email: 'suporte@setes.com.br', password: 'nova-senha', active: 'S' })
      expect([403, 404]).toContain(r.status)
      expect(userWrites.filter(w => /SET password/.test(w.sql))).toEqual([])
    } finally {
      delete LINKS[5]
    }
  })

  // ---- DECIDIDO (D-PV12, Valdo — fecha a Q-PV37): o admin da Setes TROCA a senha do usuário que o Super liberou ---------
  // Conhecimento negativo: NÃO "consertar" para barrar. Trocar senha é rotina do admin; só a conta do SUPER fica fora do alcance dele
  // (o super é um só). A liberação da tela delegada não muda quem gere a conta.
  it('[DECIDIDO D-PV12] admin da Setes troca a senha do usuário que o Super liberou — rotina do admin; só a conta do super fica fora', async () => {
    granted = new Set(['setes_setes:9:6', 'setes_setes:9:2'])
    const r = await request(app).put('/api/users/9').set('Authorization', SETES_ADMIN)
      .send({ nameCompany: 'U', nickTrade: 'U', email: 'u@setes.com.br', password: 'nova-senha', active: 'S' })
    expect(r.status).toBe(200)
    expect(userWrites.filter(w => /SET password/.test(w.sql)).length).toBe(1)
  })
})

// =====================================================================================================================
// (3) usuário liberado tocando o vínculo da PRÓPRIA Setes (id 1 em outras grafias)
// =====================================================================================================================
describe('(3) o vínculo da própria Setes', () => {
  const ones = ['1', '01', '001', '1.0', '0x1', '%31', '+1', '%2B1', '%201', '1%20', '1e0', '0.1e1', '1.0000000000000001', '1/']

  it('[RESISTIU] PUT com toda grafia de "1" → 403 SETES_INTERFACES_SUPER_ONLY ou 400 — nunca grava a linha da 1', async () => {
    granted = new Set(['setes_setes:9:6', 'setes_setes:9:2'])
    for (const id of ones) {
      const r = await request(app).put(`/api/institution-interfaces/${id}`).set('Authorization', SETES_USER).send({ interfaceIds: [9] })
      expect([id, [400, 403].includes(r.status)]).toEqual([id, true])
      if (r.status === 403) expect(r.body.code).toBe('SETES_INTERFACES_SUPER_ONLY')
    }
    expect(savedContract.filter(s => s.institutionId === 1)).toEqual([])
    expect(revokedContract.filter(s => s.institutionId === 1)).toEqual([])
  })

  it('[RESISTIU] lista vazia (revogar tudo) da Setes também é recusada', async () => {
    granted = new Set(['setes_setes:9:6', 'setes_setes:9:2'])
    const r = await request(app).put('/api/institution-interfaces/1').set('Authorization', SETES_USER).send({ interfaceIds: [] })
    expect([r.status, r.body.code]).toEqual([403, 'SETES_INTERFACES_SUPER_ONLY'])
    nothingWritten()
  })

  it('[ANALISADO LOW — questão] LER o vínculo da Setes pelo GET /1 é permitido ao liberado, embora a LISTA o esconda', async () => {
    granted = new Set(['setes_setes:9:6'])
    const r = await request(app).get('/api/institution-interfaces/1').set('Authorization', SETES_USER)
    expect(r.status).toBe(200)                                     // comportamento ATUAL (documentado — a decisão diz só "não altera")
    expect(r.body.data[0]._inst).toBe(1)
  })

  it('[ANALISADO LOW — latente] FILIAL da Setes no mesmo schema (frente do grupo): hoje grava com a chave DELA, não toca a da 1', async () => {
    granted = new Set(['setes_setes:9:6', 'setes_setes:9:2'])
    const r = await request(app).put('/api/institution-interfaces/8').set('Authorization', SETES_USER).send({ interfaceIds: [9] })
    expect(r.status).toBe(200)
    expect(savedContract).toEqual([{ schema: 'setes_setes', institutionId: 8, ids: [9] }])
    // quando a chave do contrato virar a do GRUPO (D-GE22), este PUT passaria a escrever o contrato da Setes:
    // a guarda `institutionId === SETES_INSTITUTION_ID` do service precisa virar "o GRUPO do alvo é o da Setes".
  })
})

// =====================================================================================================================
// (4) liberação vinda de OUTRA institution
// =====================================================================================================================
describe('(4) usuário de outra institution', () => {
  it('[RESISTIU] admin/super/user de outro cliente — mesmo com vínculo marcado no schema dele ou com o schema da Setes no token → 403', async () => {
    granted = new Set(['setes_cliente:30:6', 'setes_cliente:31:6', 'setes_cliente:32:6', 'setes_setes:33:6', 'setes_setes:33:2'])
    for (const token of [OTHER_ADMIN, OTHER_SUPER, OTHER_USER, OTHER_FORGED_SCHEMA]) {
      for (const [verb, url] of [['get', '/api/institution-interfaces'], ['get', '/api/institution-interfaces/7'], ['put', '/api/institution-interfaces/7']]) {
        const r = await (request(app) as any)[verb](url).set('Authorization', token).send({ interfaceIds: [9] })
        expect([url, r.status, r.body.code]).toEqual([url, 403, 'INTERFACE_NOT_ALLOWED'])
      }
    }
    nothingWritten()
  })

  it('[RESISTIU] institutionId como TEXTO "1" no token (tipo trocado) não vira Setes nem super', async () => {
    const token = bearer({ institutionId: '1' as any, userId: 1, role: 'super', schemaName: 'setes_setes' })
    granted = new Set(['setes_setes:1:6', 'setes_setes:1:2'])
    const r = await request(app).put('/api/institution-interfaces/7').set('Authorization', token).send({ interfaceIds: [9] })
    expect([401, 403]).toContain(r.status)
    nothingWritten()
  })
})

// =====================================================================================================================
// (5) o que o liberado escreve no vínculo
// =====================================================================================================================
describe('(5) corpo do PUT', () => {
  beforeEach(() => { granted = new Set(['setes_setes:9:6', 'setes_setes:9:2']) })

  it('[RESISTIU] ids inválidos (negativo, zero, fração, texto, null, ausente, objeto, >1000) → 400, nada gravado', async () => {
    const bodies: any[] = [
      { interfaceIds: [-1] }, { interfaceIds: [0] }, { interfaceIds: [1.5] }, { interfaceIds: ['9'] }, { interfaceIds: null },
      {}, { interfaceIds: { 0: 9 } }, { interfaceIds: Array.from({ length: 1001 }, (_, i) => i + 1) }, { interfaceIds: [9, true] },
    ]
    for (const body of bodies) {
      const r = await request(app).put('/api/institution-interfaces/7').set('Authorization', SETES_USER).send(body)
      expect([JSON.stringify(body).slice(0, 40), r.status]).toEqual([JSON.stringify(body).slice(0, 40), 400])
    }
    nothingWritten()
  })

  it('[RESISTIU] id gigante (1e20, MAX_SAFE+2) e id fora do catálogo → 400 VALIDATION_FAILED no campo (nunca 500)', async () => {
    for (const ids of [[1e20], [Number.MAX_SAFE_INTEGER + 2], [9, 500]]) {
      const r = await request(app).put('/api/institution-interfaces/7').set('Authorization', SETES_USER).send({ interfaceIds: ids })
      expect([r.status, r.body.code, r.body.fields?.[0]?.field]).toEqual([400, 'VALIDATION_FAILED', 'interfaceIds'])
    }
    nothingWritten()
  })

  it('[RESISTIU] repetidos são tirados; 1000 ids distintos do catálogo cabem', async () => {
    const r = await request(app).put('/api/institution-interfaces/7').set('Authorization', SETES_USER).send({ interfaceIds: [9, 9, 9, 10] })
    expect(r.status).toBe(200)
    expect(savedContract).toEqual([{ schema: 'setes_cliente', institutionId: 7, ids: [9, 10] }])
  })

  it('[ANALISADO LOW] o liberado põe no contrato de um cliente telas do grupo Super (inclusive a própria delegável) — hoje inócuo', async () => {
    const r = await request(app).put('/api/institution-interfaces/7').set('Authorization', SETES_USER).send({ interfaceIds: [IFACE] })
    expect(r.status).toBe(200)                                     // comportamento ATUAL: o catálogo inteiro é aceito
    expect(savedContract).toEqual([{ schema: 'setes_cliente', institutionId: 7, ids: [IFACE] }])
    // [RESISTIU] o cadastro de privilégios do admin do cliente NÃO lista a tela delegável mesmo que ela entre no contrato dele
    await request(app).get('/api/users/30/privileges').set('Authorization', OTHER_ADMIN)
    expect(userPrivilegesListParams?.[2]).toEqual(expect.arrayContaining(['users', 'establishment', 'institution-interfaces']))
  })
})

// =====================================================================================================================
// (6) IDOR — resolução da institution alvo
// =====================================================================================================================
describe('(6) institution alvo', () => {
  beforeEach(() => { granted = new Set(['setes_setes:9:6', 'setes_setes:9:2']) })

  it('[RESISTIU] alvo inexistente/soft-deletado (9, 0, -0, 99999) → 404 no GET e no PUT, nada gravado; a busca filtra deleted', async () => {
    for (const id of ['9', '0', '-0', '99999']) {
      expect([id, (await request(app).get(`/api/institution-interfaces/${id}`).set('Authorization', SETES_USER)).status]).toEqual([id, 404])
      expect([id, (await request(app).put(`/api/institution-interfaces/${id}`).set('Authorization', SETES_USER).send({ interfaceIds: [9] })).status])
        .toEqual([id, 404])
    }
    nothingWritten()
    const schemaSql = q.mock.calls.map(c => String(c[0])).filter(s => /schema_name AS schemaName/.test(s))
    expect(schemaSql.length).toBeGreaterThan(0)
    for (const s of schemaSql) expect(s).toMatch(/deleted = 'N'/)
  })

  it('[RESISTIU] id negativo / não numérico → 400 INVALID_ID', async () => {
    for (const id of ['-1', 'abc', '1;DROP', '1%27']) {
      const r = await request(app).put(`/api/institution-interfaces/${id}`).set('Authorization', SETES_USER).send({ interfaceIds: [9] })
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
        ['put', '/api/admin/institutions/7/interfaces', { interfaceIds: [9] }], ['put', '/api/admin/institutions/1/interfaces', { interfaceIds: [9] }],
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
  const menuDb = (opts: { ungrouped: any[]; delegated: any[]; own: any[] }) => async (sql: string) => {
    if (/FROM `setes_\w+`\.tb_module m/.test(sql)) return [[]]
    if (/FROM `setes_\w+`\.tb_institution_has_interface ihi/.test(sql)) return [opts.ungrouped]
    if (/FROM setes_central\.tb_interface_has_privilege ihp/.test(sql)) {
      return [[{ interfaceId: 29, privilegeId: V, description: 'VISUALIZAR' },
        { interfaceId: IFACE, privilegeId: V, description: 'VISUALIZAR' }, { interfaceId: IFACE, privilegeId: A, description: 'ALTERAR' }]]
    }
    if (/i\.i18n_key IN \(\?\)/.test(sql) && /EXISTS/.test(sql)) return [opts.delegated]
    if (/FROM `setes_\w+`\.tb_user_has_privilege uhp/.test(sql)) return [opts.own]
    return [[]]
  }
  const flat = (menus: any[]) => menus.flatMap(m => m.interfaces.map((i: any) => [i.i18nKey, i.privileges]))
  const ADMIN_SETES = { institutionId: 1, userId: 2, role: 'admin', schemaName: 'setes_setes' } as any

  it('[RESISTIU] admin com SÓ VISUALIZAR marcado pelo Super: a tela aparece com [VISUALIZAR], nunca o catálogo [VISUALIZAR, ALTERAR]', async () => {
    q.mockImplementation(menuDb({
      ungrouped: [row(29, 'orders', 'Vendas')], delegated: [row(IFACE, 'institution-interfaces', 'Super')],
      own: [{ interfaceId: IFACE, privilegeId: V, description: 'VISUALIZAR' }],
    }))
    expect(flat(await getMenus(ADMIN_SETES))).toEqual([['orders', ['VISUALIZAR']], ['institution-interfaces', ['VISUALIZAR']]])
  })

  it.failing('[ACHADO LOW] se a tela delegável também estiver no CONTRATO da Setes fora do grupo Super, o admin a vê DUAS vezes — uma com o catálogo (ALTERAR)', async () => {
    q.mockImplementation(menuDb({
      ungrouped: [row(29, 'orders', 'Vendas'), row(IFACE, 'institution-interfaces', 'Sistema')],
      delegated: [row(IFACE, 'institution-interfaces', 'Sistema')],
      own: [{ interfaceId: IFACE, privilegeId: V, description: 'VISUALIZAR' }],
    }))
    const entries = flat(await getMenus(ADMIN_SETES)).filter(([k]: any) => k === 'institution-interfaces')
    expect(entries).toEqual([['institution-interfaces', ['VISUALIZAR']]])
  })
})

// =====================================================================================================================
// (9) flags sem o atalho da institution 1
// =====================================================================================================================
describe('(9) flags (D-PV10)', () => {
  it('[RESISTIU] flag desligada: o Super passa (nem consulta), o liberado da Setes é barrado mesmo com V+A', async () => {
    flagOn.mockResolvedValue(false)
    granted = new Set(['setes_setes:9:6', 'setes_setes:9:2'])
    expect((await request(app).get('/api/institution-interfaces').set('Authorization', SUPER)).status).toBe(200)
    const r = await request(app).get('/api/institution-interfaces').set('Authorization', SETES_USER)
    expect(r.status).toBe(403)
    expect(flagOn).toHaveBeenCalledWith(1, 'institution-interfaces')
  })

  it('[RESISTIU] admin da Setes sem a flag do módulo → 403 (users, modules, establishment, billing, orders)', async () => {
    flagOn.mockResolvedValue(false)
    for (const url of ['/api/users', '/api/modules', '/api/establishment', '/api/billing/validate', '/api/orders']) {
      expect([url, (await request(app).get(url).set('Authorization', SETES_ADMIN)).status]).toEqual([url, 403])
    }
  })

  it('[RESISTIU] variação de caixa no segmento do módulo não fura a flag (comparação exata → nega)', async () => {
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

  it('[RESISTIU] a tabela das rotas guardadas: só institution-interfaces é delegada, GET → 6 e PUT → 2', () => {
    const delegated = listGatedRoutes().filter(r => r.delegatedSuper)
    expect([...new Set(delegated.map(r => r.moduleKey))]).toEqual(['institution-interfaces'])
    expect(delegated.map(r => [r.method, r.path, r.privilegeId]).sort()).toEqual([['GET', '/', 6], ['GET', '/:id', 6], ['PUT', '/:id', 2]].sort())
  })
})

// =====================================================================================================================
// RE-PROVA (2026-10-18) — a barreira INTERINA da conta (`assertAccountManageable` em editUser/removeUser — Q-PV37)
// =====================================================================================================================
describe('(R2) barreira da conta — outras portas, desvínculo, vínculo adormecido, corrida', () => {
  const editBody = (email: string) => ({ nameCompany: 'U', nickTrade: 'U', email, password: 'nova-senha', active: 'S' })
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

  it('[RESISTIU] (a) admin trocando o e-mail da PRÓPRIA conta para o e-mail de login do Super → 409, nada gravado', async () => {
    const r = await request(app).put('/api/users/2').set('Authorization', SETES_ADMIN).send(editBody(SUPER_EMAIL))
    expect(r.status).toBe(409)
    expect(userWrites).toEqual([])
  })

  it('[RESISTIU] (a) a conta própria (só vínculos com o próprio estabelecimento, sem super) segue editável — controle', async () => {
    const r = await request(app).put('/api/users/32').set('Authorization', OTHER_ADMIN).send(editBody('u32@cliente.com'))
    expect(r.status).toBe(200)
    expect(passwordWrites().length).toBe(1)
  })

  it('[RESISTIU] (a) super × admin: o 403 da barreira vem com code USER_MANAGED_BY_SUPER; sem vínculo com o próprio = 404', async () => {
    const r = await request(app).put('/api/users/1').set('Authorization', SETES_ADMIN).send(editBody('x@x.com'))
    expect([r.status, r.body.code]).toEqual([403, 'USER_MANAGED_BY_SUPER'])
    const o = await request(app).put('/api/users/1').set('Authorization', OTHER_ADMIN).send(editBody('x@x.com'))
    expect(o.status).toBe(404)
    expect(userWrites).toEqual([])
  })

  it.failing('[ACHADO MEDIUM — pré-existente, fora do delta] (a) /auth/change-password: o código de 6 dígitos não morre depois de N tentativas erradas (força bruta só freada pelo limite por IP)', async () => {
    for (let i = 0; i < 25; i++) {
      const w = await request(app).post('/auth/change-password').send({ email: SUPER_EMAIL, code: String(100000 + i), newPassword: 'tomada' })
      expect(w.status).toBe(401)
    }
    // seguro: depois de uma rajada de erros o código fica inválido (ou a conta pede novo código) — o certo NÃO pode mais trocar a senha
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

  it('[RESISTIU] (b) admin não exclui (soft) conta multi-institution nem a do Super', async () => {
    LINKS[5] = [1, 7]
    try {
      for (const [token, uid] of [[SETES_ADMIN, 1], [OTHER_ADMIN, 5], [SETES_ADMIN, 5]] as const) {
        const r = await request(app).delete(`/api/users/${uid}`).set('Authorization', token)
        expect([uid, r.status]).toEqual([uid, 403])
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

  // ---- (c) vínculo ADORMECIDO em outro estabelecimento -----------------------------------------------------------------
  it('[RESISTIU — corrigido na re-prova] (c) vínculo REVOGADO de super com a Setes (active N) conta: o admin do cliente não troca a senha (o Super, ao reviver o vínculo, entregaria a conta)', async () => {
    LINKS[6] = [7]
    DORMANT_LINKS[6] = [{ institutionId: 1, kind: 'super', active: 'N', deleted: 'N' }]
    try {
      const r = await request(app).put('/api/users/6').set('Authorization', OTHER_ADMIN).send(editBody('u6@setes.com.br'))
      expect([r.status, r.body.code]).toEqual([403, 'USER_MANAGED_BY_SUPER'])
      expect(passwordWrites()).toEqual([])
    } finally { delete LINKS[6] }
  })

  it('[RESISTIU — corrigido na re-prova] (c) idem com o vínculo com OUTRO estabelecimento soft-deletado (deleted S)', async () => {
    LINKS[6] = [7]
    DORMANT_LINKS[6] = [{ institutionId: 1, kind: 'user', active: 'N', deleted: 'S' }]
    try {
      const r = await request(app).put('/api/users/6').set('Authorization', OTHER_ADMIN).send(editBody('u6@setes.com.br'))
      expect(r.status).toBe(403)
      expect(passwordWrites()).toEqual([])
    } finally { delete LINKS[6] }
  })

  // ---- (d) corrida entre ler os vínculos e gravar ----------------------------------------------------------------------
  it.failing('[ACHADO LOW] (d) a barreira lê os vínculos FORA da transação da gravação (sem FOR UPDATE nem releitura): o Super vinculando a conta à Setes no meio não barra a escrita', async () => {
    // antes da gravação o usuário 32 só tem o cliente 7; "no meio" o Super o vincula como super da Setes
    linksInTx = { 32: [{ institutionId: 7, kind: 'user' }, { institutionId: 1, kind: 'super' }] }
    const r = await request(app).put('/api/users/32').set('Authorization', OTHER_ADMIN).send(editBody('u32@cliente.com'))
    expect(r.status).toBe(403)
    expect(passwordWrites()).toEqual([])
  })
})
