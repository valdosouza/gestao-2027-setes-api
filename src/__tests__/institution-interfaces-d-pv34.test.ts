/// <reference types="jest" />
// D-PV34/D-PV35/D-PV37/D-PV38 (Valdo 2026-10-20 — prompt_privilegios_interfaces.md): o vínculo estabelecimento × interfaces grava
// POR MARCA (idempotente) nas DUAS portas; a porta delegada só vincula VENDÁVEIS e não revoga as ESTRUTURAIS (lista única na peça);
// a própria Setes é UM predicado (`isOwnVendorInstitution`) nas três portas — lista, leitura (403) e escrita (403).
import request from 'supertest'
import { bearer } from '../test-setup/test-token'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() } }))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({ __esModule: true, newCrashRef: jest.fn(() => 'REF'), recordCrash: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))

import pool from '../shared/db/connection'
import * as requirePrivilege from '../shared/auth/require-privilege'
import {
  STRUCTURAL_INTERFACE_KEYS, isStructuralInterface, isSellableInterface, isOwnVendorInstitution, SETES_INSTITUTION_ID,
} from '../shared/institution-interfaces'
import { STRUCTURAL_INTERFACE_KEYS as FROM_ONBOARDING } from '../modules/institutions/institutions.repository'
import { SETES_INSTITUTION_ID as FROM_ROLES, isOwnVendorInstitution as predicateFromRoles } from '../shared/auth/roles'
import app from '../app'

const q = (pool as any).query as jest.Mock
const getConn = (pool as any).getConnection as jest.Mock
const IFACE = 41
/** catálogo do dublê: id → { k, kind, g } */
const CAT: Record<number, { k: string; kind: string; g: string | null }> = {
  9: { k: 'customers', kind: 'T', g: 'Registers' }, 18: { k: 'partnerships', kind: 'R', g: 'Registers' },
  42: { k: 'users', kind: 'T', g: 'Sistema' }, 10: { k: 'interface-configs', kind: 'T', g: 'Sistema' },
  41: { k: 'institution-interfaces', kind: 'T', g: 'Super' }, 1: { k: 'institutions', kind: 'T', g: 'Super' },
}
let linked: Set<string>                                       // `${schema}:${institutionId}:${interfaceId}` vivos
let dormant: Set<string>                                      // linhas que existem com active N
let granted: Set<string>                                      // `${schema}:${userId}:${privilegeId}` na 41
let writes: Array<{ kind: 'insert' | 'update'; schema: string; institutionId: number; interfaceId: number; active?: string }>
let forUpdateSeen: string[]

const conn = {
  beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  query: jest.fn(async (sql: string, params: any[] = []) => {
    const schema = /`(setes_\w+)`/.exec(sql)?.[1] ?? ''
    if (/SELECT active, deleted FROM `setes_\w+`\.tb_institution_has_interface[\s\S]*FOR UPDATE/.test(sql)) {
      forUpdateSeen.push(`${schema}:${params[0]}:${params[1]}`)
      if (linked.has(`${schema}:${params[0]}:${params[1]}`)) return [[{ active: 'S', deleted: 'N' }]]
      if (dormant.has(`${schema}:${params[0]}:${params[1]}`)) return [[{ active: 'N', deleted: 'N' }]]
      return [[]]
    }
    if (/INSERT INTO `setes_\w+`\.tb_institution_has_interface/.test(sql)) { writes.push({ kind: 'insert', schema, institutionId: params[0], interfaceId: params[1] }); return [[]] }
    if (/UPDATE `setes_\w+`\.tb_institution_has_interface/.test(sql)) {
      const active = /SET active = 'S'/.test(sql) ? 'S' : 'N'
      writes.push({ kind: 'update', schema, institutionId: params[0], interfaceId: params[1], active }); return [[]]
    }
    return [[]]
  }),
}

beforeEach(() => {
  jest.clearAllMocks(); requirePrivilege.resetPrivilegeCache()
  linked = new Set(['setes_cliente:7:9']); dormant = new Set(['setes_cliente:7:18']); granted = new Set(); writes = []; forUpdateSeen = []
  getConn.mockResolvedValue(conn)
  q.mockImplementation(async (sql: string, params: any[] = []) => {
    if (/FROM setes_central\.tb_interface WHERE i18n_key/.test(sql)) return [params[0] === 'institution-interfaces' ? [{ id: IFACE }] : []]
    if (/SELECT id, i18n_key AS k, kind, group_default AS groupDefault\s+FROM setes_central\.tb_interface WHERE id = \?/.test(sql)) {
      const c = CAT[Number(params[0])]
      return [c ? [{ id: Number(params[0]), k: c.k, kind: c.kind, groupDefault: c.g }] : []]
    }
    if (/tb_institution_has_interface/.test(sql) && !/LEFT JOIN/.test(sql)) return [[]]       // nada contratado (a delegada não usa licença)
    if (/tb_user_has_privilege/.test(sql) && /tb_privilege_id = \?/.test(sql)) {
      const schema = /`(setes_\w+)`/.exec(sql)?.[1]
      return [granted.has(`${schema}:${params[0]}:${params[2]}`) && params[1] === IFACE ? [{ 1: 1 }] : []]
    }
    if (/SELECT schema_name AS schemaName/.test(sql)) return [[{ schemaName: Number(params[0]) === 1 ? 'setes_setes' : Number(params[0]) === 7 ? 'setes_cliente' : null }].filter(r => r.schemaName)]
    if (/LEFT JOIN `setes_\w+`\.tb_institution_has_interface/.test(sql)) {
      return [[{ id: 9, description: 'Clientes', groupDefault: 'Registers', kind: 'T', granted: 1, _sql: sql, _params: params }]]
    }
    if (/FROM setes_central\.tb_institution i\s+INNER JOIN setes_central\.tb_entity/.test(sql) && /LIMIT/.test(sql)) return [[{ id: 7, name: 'Cliente X', active: 'S' }]]
    if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: 1 }]]
    return [[]]
  })
})

const SUPER = bearer({ institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' })
const SETES_USER = bearer({ institutionId: 1, userId: 9, role: 'user', schemaName: 'setes_setes' })
const mark = (token: string, inst: number | string, iface: number | string, linkedTo: boolean) =>
  request(app).put(`/api/institution-interfaces/${inst}/interfaces/${iface}`).set('Authorization', token).send({ linked: linkedTo })

describe('D-PV37 — a própria Setes é UMA constante/predicado (re-exportados pela peça do vínculo)', () => {
  it('a peça re-exporta a constante e o predicado de roles.ts — a troca pelo grupo é um ato só', () => {
    expect(SETES_INSTITUTION_ID).toBe(FROM_ROLES)
    expect(isOwnVendorInstitution).toBe(predicateFromRoles)
    expect([isOwnVendorInstitution(1), isOwnVendorInstitution(7), isOwnVendorInstitution(null), isOwnVendorInstitution(undefined)]).toEqual([true, false, false, false])
  })
  it('D-PV35: a lista das estruturais é UMA — o onboarding lê a da peça', () => {
    expect(FROM_ONBOARDING).toBe(STRUCTURAL_INTERFACE_KEYS)
    expect([...STRUCTURAL_INTERFACE_KEYS].sort()).toEqual(['establishment', 'interface-configs', 'modules', 'users'])
    expect([isStructuralInterface('users'), isStructuralInterface('customers'), isStructuralInterface(null)]).toEqual([true, false, false])
    const sell = (id: number) => isSellableInterface({ kind: CAT[id].kind, groupDefault: CAT[id].g })
    expect([sell(9), sell(18), sell(41), isSellableInterface({ kind: 'X', groupDefault: null })]).toEqual([true, true, false, false])
  })
})

describe('D-PV34 — UMA marca por vez, idempotente, nas duas portas', () => {
  it('conceder o que não existe INSERE; conceder o já concedido não escreve (changed false); revogar faz UPDATE active N; revogar o revogado não escreve', async () => {
    let r = await mark(SUPER, 7, 18, true)
    expect([r.status, r.body.data]).toEqual([200, { interfaceId: 18, linked: true, changed: true }])
    expect(writes).toEqual([{ kind: 'update', schema: 'setes_cliente', institutionId: 7, interfaceId: 18, active: 'S' }])   // linha adormecida: religa
    writes = []
    r = await mark(SUPER, 7, 9, true)
    expect([r.status, r.body.data]).toEqual([200, { interfaceId: 9, linked: true, changed: false }])
    expect(writes).toEqual([])
    r = await mark(SUPER, 7, 9, false)
    expect([r.status, r.body.data]).toEqual([200, { interfaceId: 9, linked: false, changed: true }])
    expect(writes).toEqual([{ kind: 'update', schema: 'setes_cliente', institutionId: 7, interfaceId: 9, active: 'N' }])
    writes = []
    linked.delete('setes_cliente:7:9')
    r = await mark(SUPER, 7, 9, false)
    expect([r.status, r.body.data.changed]).toEqual([200, false])
    expect(writes).toEqual([])
    // a linha que nunca existiu nasce com INSERT
    r = await mark(SUPER, 7, 42, true)
    expect([r.status, writes]).toEqual([200, [{ kind: 'insert', schema: 'setes_cliente', institutionId: 7, interfaceId: 42 }]])
    expect(conn.commit).toHaveBeenCalled()
    expect(forUpdateSeen.length).toBeGreaterThan(0)                                 // leitura TRAVANTE da linha da marca
  })
  it('a marca derruba o cache do veredito da institution alvo (D-PV29)', async () => {
    const spy = jest.spyOn(requirePrivilege, 'invalidatePrivilegeVerdicts')
    await mark(SUPER, 7, 42, true)
    expect(spy).toHaveBeenCalledWith({ institutionId: 7 })
    spy.mockClear()
    await mark(SUPER, 7, 9, true)                                                      // sem mudança: nada a derrubar
    expect(spy).not.toHaveBeenCalled()
  })
  it('a porta do Super em /api/admin grava pela MESMA peça por marca; a lista inteira não existe mais em nenhuma das portas', async () => {
    const r = await request(app).put('/api/admin/institutions/7/interfaces/42').set('Authorization', SUPER).send({ linked: true })
    expect([r.status, r.body.data]).toEqual([200, { interfaceId: 42, linked: true, changed: true }])
    expect(writes).toEqual([{ kind: 'insert', schema: 'setes_cliente', institutionId: 7, interfaceId: 42 }])
    expect((await request(app).put('/api/admin/institutions/7/interfaces').set('Authorization', SUPER).send({ interfaceIds: [9] })).status).toBe(404)
    expect((await request(app).put('/api/institution-interfaces/7').set('Authorization', SUPER).send({ interfaceIds: [9] })).status).toBe(404)
  })
  it('corpo inválido (linked ausente/texto), interfaceId inválido (0, -1, 1.5, abc) e fora do catálogo → 400, nada gravado', async () => {
    for (const body of [{}, { linked: 'S' }, { linked: 1 }]) expect((await request(app).put('/api/institution-interfaces/7/interfaces/9').set('Authorization', SUPER).send(body)).status).toBe(400)
    for (const id of ['0', '-1', '1.5', 'abc']) expect([id, (await mark(SUPER, 7, id, true)).status]).toEqual([id, 400])
    const r = await mark(SUPER, 7, 500, true)
    expect([r.status, r.body.code, r.body.fields?.[0]?.field]).toEqual([400, 'VALIDATION_FAILED', 'interfaceId'])
    expect(writes).toEqual([])
  })
})

describe('D-PV35 — a porta delegada: só vendáveis, estruturais não se revogam', () => {
  beforeEach(() => { granted = new Set(['setes_setes:9:6', 'setes_setes:9:2']) })
  it('revogar estrutural (users) → 409 INTERFACE_STRUCTURAL_LOCKED; concedê-la pode', async () => {
    linked.add('setes_cliente:7:42')
    const r = await mark(SETES_USER, 7, 42, false)
    expect([r.status, r.body.code]).toEqual([409, 'INTERFACE_STRUCTURAL_LOCKED'])
    expect(writes).toEqual([])
    expect((await mark(SETES_USER, 7, 42, true)).status).toBe(200)
  })
  it('tela do grupo Super (inclusive a própria delegável) → 400 INTERFACE_NOT_SELLABLE; recurso R vendável passa', async () => {
    for (const id of [41, 1]) {
      const r = await mark(SETES_USER, 7, id, true)
      expect([id, r.status, r.body.code]).toEqual([id, 400, 'INTERFACE_NOT_SELLABLE'])
    }
    expect(writes).toEqual([])
    expect((await mark(SETES_USER, 7, 18, true)).status).toBe(200)
  })
  it('a lista da porta delegada vem com o filtro de vendáveis no SQL (o grupo Super não aparece); a do Super em /api/admin, sem filtro', async () => {
    const r = await request(app).get('/api/institution-interfaces/7').set('Authorization', SETES_USER)
    expect(r.status).toBe(200)
    const sql = String(r.body.data[0]._sql)
    expect(sql).toMatch(/i\.kind IN \('T', 'R'\)/)
    expect(r.body.data[0]._params).toEqual([7, 'Super'])
    const a = await request(app).get('/api/admin/institutions/7/interfaces').set('Authorization', SUPER)
    expect(String(a.body.data[0]._sql)).not.toMatch(/i\.kind IN/)
  })
  it('o Super na porta delegada também obedece a regra DELA (estrutural não se revoga, Super não se vende) — a aba do Estabelecimento é a porta sem regra', async () => {
    linked.add('setes_cliente:7:42')
    expect((await mark(SUPER, 7, 42, false)).body.code).toBe('INTERFACE_STRUCTURAL_LOCKED')
    expect((await request(app).put('/api/admin/institutions/7/interfaces/42').set('Authorization', SUPER).send({ linked: false })).status).toBe(200)
  })
})

describe('D-PV38 — a própria Setes: um predicado nas três portas', () => {
  beforeEach(() => { granted = new Set(['setes_setes:9:6', 'setes_setes:9:2']) })
  it('o liberado NÃO lê o vínculo da Setes (403 SETES_INTERFACES_SUPER_ONLY — o mesmo do salvar) e a lista a esconde; o Super lê', async () => {
    const r = await request(app).get('/api/institution-interfaces/1').set('Authorization', SETES_USER)
    expect([r.status, r.body.code]).toEqual([403, 'SETES_INTERFACES_SUPER_ONLY'])
    for (const id of ['1', '01', '1.0', '0x1']) {
      const w = await mark(SETES_USER, id, 9, true)
      expect([id, [400, 403].includes(w.status)]).toEqual([id, true])
      if (w.status === 403) expect(w.body.code).toBe('SETES_INTERFACES_SUPER_ONLY')
    }
    expect(writes).toEqual([])
    await request(app).get('/api/institution-interfaces').set('Authorization', SETES_USER)
    const listSql = q.mock.calls.find(c => /FROM setes_central\.tb_institution i\s+INNER JOIN/.test(String(c[0])) && /LIMIT/.test(String(c[0])))!
    expect(listSql[1].slice(0, 2)).toEqual([1, 1])
    expect((await request(app).get('/api/institution-interfaces/1').set('Authorization', SUPER)).status).toBe(200)
  })
})
