/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA da Rodada 4 da F2a + backend da Rodada 1 da F2b (2026-10-13 — skill
// Infra-IA/skills-genericas/testar-adversarial.md; prompt_apis_fiscais_isoladas.md §7 D-F130…D-F147, §22.13/§22.14).
// Alvo: setes-api-f2a 7abea48 (porta @shared/fiscal-voice tipada, lista que degrada, GET …/cancel-plan com guarda CANCELAR e espera
// curta, barreira tipada do plano, boot que confere os 9 gatilhos, script de aborto) + núcleo 24ab152 (D-F136 no mapa comum).
// Convenção: achado CONFIRMADO = `it.failing('[ACHADO F2AR4-ADV-NN SEV] …')` (o teste descreve o comportamento CERTO e hoje falha);
// `it('[RESISTIU] …')` = o ataque foi barrado; `it('[FATO …]')` = comportamento atual que depende de decisão (questão no relatório);
// `it('[CENÁRIO] …')` = prova que o cenário de um achado se monta (falha de verdade se não se montar).
// Banco MOCKADO na fronteira (pool/conn) na parte 1; a parte VIVA (opt-in, F2A_ADV_LIVE=1) só toca bancos DESCARTÁVEIS `f2a_advr4_*`,
// criados e apagados aqui (o schema real é só LIDO: CREATE TABLE … LIKE). Nada aqui escreve em setes_* nem no fiscal_api.
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import request from 'supertest'
import { testToken } from '../test-setup/test-token'
import { accessAnswer, ModelProfile } from '../test-setup/access-model'
import { rawServiceRow, TEST_KEY } from '../test-setup/fiscal-voice-rows'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVR4'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../shared/check', () => ({
  __esModule: true, ...jest.requireActual('../shared/check'), isCheckEventCurrent: jest.fn(), reverseCheckEvent: jest.fn(),
}))
jest.mock('../shared/commission', () => ({
  __esModule: true, ...jest.requireActual('../shared/commission'), getCommissionBalanceByItem: jest.fn(), insertCommissions: jest.fn(),
}))
jest.mock('../shared/bank-slip', () => ({ __esModule: true, ...jest.requireActual('../shared/bank-slip'), cancelBankSlip: jest.fn() }))
jest.mock('../modules/service-orders/service-orders.repository', () => ({
  __esModule: true, ...jest.requireActual('../modules/service-orders/service-orders.repository'), listOrders: jest.fn(),
}))

import pool from '../shared/db/connection'
import * as crash from '../shared/errors/crash.repository'
import * as chk from '../shared/check'
import * as com from '../shared/commission'
import * as soRepo from '../modules/service-orders/service-orders.repository'
import { buildCancelPlan, cancelInvoice, fiscalEffectOf } from '../shared/invoice'
import { readServiceVoiceOfLife, readServiceVoicesOfLives, FiscalVoiceUnavailableError } from '../shared/fiscal-voice'
import { fetchOrders } from '../modules/service-orders/service-orders.service'
import { getOrderCancelPlan, CANCEL_PLAN_LOCK_WAIT_SECONDS } from '../modules/billing/billing.service'
import { handleError } from '../shared/http/controller-utils'
import { pagedEnvelope } from '../shared/list'
import { HttpError } from '../shared/errors/http-error'
import { f2aFreezeTriggerSpecs, f2aFreezeTriggersMissing, assertF2aFreezeTriggers } from '../migrations/f2a-freeze-triggers'
import { splitStatements } from '../migrations/runner'
import { serviceView } from '../test-setup/fiscal-voice-rows'
import { PRIVILEGE_NAME_BY_ID } from '../shared/access'
import app from '../app'

// scripts/ fica fora do rootDir do tsc (src) — o import estático quebraria o `npm run build`; require com o tipo da função
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { abortF2aPassivo } = require(path.join(__dirname, '..', '..', 'scripts', 'f2a-abort-before-cutover')) as {
  abortF2aPassivo: (c: { query: (sql: string, p?: unknown[]) => Promise<any> }, schema: string, institutionId: number,
    opts: { vai: boolean; fiscalDb: string; centralDb?: string }) => Promise<{ dryRun: boolean; triggers: string[]; migrationRow: boolean; owners: number[] }>
}

/** ADV_SHOW=1 roda os achados como `it` comum — para LER a mensagem da falha (o motivo certo, não erro de mock). */
const failing: jest.It['failing'] = process.env.ADV_SHOW === '1' ? (it as any) : it.failing
const q = (pool as any).query as jest.Mock
const getConn = (pool as any).getConnection as jest.Mock
const REPO = path.join(__dirname, '..', '..')
const ORDER = 7400                                         // a OS da fixture (rawServiceRow nasce na nota 7400)

// =================================================================================================
// banco de mentira — molde do gate da A3 (adversarial-f2a-a3-gate.test.ts), com as falhas da Rodada 4
// =================================================================================================
const CATALOG: Record<string, number> = { orders: 29, 'service-orders': 20, 'order-returns': 31 }
const BRANCH: Record<number, string> = { 100: 'orders', [ORDER]: 'service-orders', 300: 'order-returns' }
let contracted: Set<number>
let privileged: Set<string>
let lifeRows: any[]
let lifeError: any
let fiscalRows: any[]
let fiscalError: any
const KEY_OF: Record<number, string> = Object.fromEntries(Object.entries(CATALOG).map(([k, id]) => [id, k]))
/** o perfil do vínculo (usuário 7, institution 1) é o do token da vez — a sessão viva devolve o do token (`access-session.mock`) */
let profile: ModelProfile = 'admin'
/** `privileged` (`${userId}:${interfaceId}:${privilegeId}`) → concessões por chave e NOME do verbo (D-PV53) */
function grantsOf(userId: number): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const g of privileged) {
    const [u, i, p] = g.split(':').map(Number)
    if (u === userId && KEY_OF[i]) (out[KEY_OF[i]] ??= []).push(PRIVILEGE_NAME_BY_ID[p])
  }
  return out
}

function routePool(): void {
  q.mockImplementation(async (sql: string, params: any[] = []) => {
    // costura A1 da auth-api (D-AU3/D-AU6): o veredito das guardas é a pilha de views (dublê `test-setup/access-model`)
    const a = accessAnswer(sql, params, (userId: number) => ({
      profile, contracted: [...contracted].map(id => KEY_OF[id]).filter(Boolean), granted: grantsOf(userId),
    }))
    if (a) return [a, []]
    if (/vw_order_interface/.test(sql)) { const k = BRANCH[Number(params[1])]; return [k ? [{ k }] : []] }
    if (/tb_invoice_cancel_waiver/.test(sql)) return [[]]
    if (/vw_invoice_life/.test(sql)) { if (lifeError) throw lifeError; const ids: number[] = (params[1] ?? []).map(Number); return [lifeRows.filter(r => ids.includes(Number(r.invoiceId)))] }
    if (/`fiscal_api`\.vw_invoice_service_transmission/.test(sql)) { if (fiscalError) throw fiscalError; return [fiscalRows] }
    throw new Error(`SQL inesperado no pool: ${String(sql).slice(0, 90)}`)
  })
}

interface PlanScenario {
  fiscal?: any[]; life?: any[]; failOn?: RegExp; failWith?: any
  /** depois da falha do `failOn`, a conexão está MORTA: todo comando seguinte rejeita (o que o mysql2 faz depois de ECONNRESET/KILL). */
  deadAfterFail?: boolean
  failSetPrev?: any; failSetShort?: any; failRestore?: any; rollbackRejects?: any
}
const CLOSED = () => Object.assign(new Error("Can't add new command when connection is in closed state"), { fatal: true })

/** A devolução da sessão (D-F131 + F2AR4-ADV-03) como a SEQUÊNCIA do planConn a registra (SQL cortado em 70). */
const RESTORE_SEQ = 'SET SESSION innodb_lock_wait_timeout = @setes_plan_prev_lw, lock_wait_timeout = @setes_plan_prev_mdl'.slice(0, 70)

/** Conexão de transação roteada por SQL — registra a SEQUÊNCIA (SQL + ROLLBACK/RELEASE/DESTROY) e toda escrita. */
function planConn(sc: PlanScenario = {}) {
  const writes: string[] = []
  const seq: string[] = []
  let dead = false
  const conn: any = {
    beginTransaction: jest.fn(async () => { seq.push('BEGIN'); if (dead) throw CLOSED() }),
    commit: jest.fn(async () => { seq.push('COMMIT') }),
    rollback: jest.fn(async () => { seq.push('ROLLBACK'); if (sc.rollbackRejects) throw sc.rollbackRejects; if (dead) throw CLOSED() }),
    release: jest.fn(() => { seq.push('RELEASE') }),
    destroy: jest.fn(() => { seq.push('DESTROY') }),
    query: jest.fn(async (sql: string) => {
      seq.push(String(sql).trim().slice(0, 70))
      if (dead) throw CLOSED()
      if (sc.failOn && sc.failOn.test(sql)) { if (sc.deadAfterFail) dead = true; throw sc.failWith }
      if (/^SET @setes_plan_prev_lw/.test(sql)) { if (sc.failSetPrev) throw sc.failSetPrev; return [{}] }
      if (/^SET SESSION innodb_lock_wait_timeout = \?/.test(sql)) { if (sc.failSetShort) throw sc.failSetShort; return [{}] }
      if (/^SET SESSION innodb_lock_wait_timeout = @setes_plan_prev_lw/.test(sql)) { if (sc.failRestore) throw sc.failRestore; return [{}] }
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) { writes.push(String(sql).trim().slice(0, 80)); return [{ affectedRows: 1, insertId: 0 }] }
      if (/FROM `setes_setes`\.tb_invoice_cancel_waiver/.test(sql)) return [[]]
      if (/SELECT COALESCE\(MAX\(event\), 0\) \+ 1 AS nextEvent/.test(sql)) return [[{ nextEvent: 2 }]]
      if (/FROM `setes_setes`\.tb_order\s+WHERE id = \?/.test(sql)) return [[{ status: 'F' }]]
      if (/FROM `setes_setes`\.tb_invoice\s+WHERE id = \?/.test(sql)) return [[{ id: ORDER, number: '17', serie: '1', model: 'SE', value: '250.00', status: '0' }]]
      if (/FROM `setes_setes`\.vw_invoice_life/.test(sql)) return [sc.life ?? [{ lifeEvent: 1, lastEvent: 1, lastKind: 'E' }]]
      if (/tb_order_stock_adjust_return\s+WHERE id = \?/.test(sql)) return [[]]
      if (/tb_service_order c/.test(sql)) return [[]]
      if (/FROM `setes_setes`\.tb_financial\s+WHERE/.test(sql)) return [[{ parcel: 1 }]]
      if (/tb_check_event e/.test(sql)) return [[]]
      if (/tb_financial_payment/.test(sql)) return [[]]
      if (/tb_bank_slip_title t\s+JOIN/.test(sql)) return [[]]
      if (/tb_order_stock_adjust_return r/.test(sql)) return [[]]
      if (/`fiscal_api`\.vw_invoice_service_transmission/.test(sql)) return [sc.fiscal ?? []]
      if (/FROM `setes_setes`\.tb_cashier/.test(sql)) return [[{ id: 3 }]]
      throw new Error(`SQL inesperado na transação: ${String(sql).slice(0, 90)}`)
    }),
  }
  return { conn, writes, seq }
}

const USER = { institutionId: 1, userId: 7, role: 'user', schemaName: 'setes_setes' }
const ADMIN = { ...USER, role: 'admin' }
const bearer = (p: { role: string }) => { profile = p.role as ModelProfile; return `Bearer ${testToken(p)}` }
const err =(code: string, errno: number, msg = `${code} detalhe-interno-da-causa`) => Object.assign(new Error(msg), { code, errno })
const lockWait = err('ER_LOCK_WAIT_TIMEOUT', 1205, 'Lock wait timeout exceeded; try restarting transaction')
const deadlock = err('ER_LOCK_DEADLOCK', 1213, 'Deadlock found when trying to get lock')
const denied = err('ER_TABLEACCESS_DENIED_ERROR', 1142, "SELECT command denied to user 'setes'@'%' for table 'vw_invoice_service_transmission' detalhe-interno-da-causa")
const econnreset = Object.assign(new Error('read ECONNRESET detalhe-interno-da-causa'), { code: 'ECONNRESET', errno: -4077, fatal: true })
const voiceDown = (cause: RegExp) => expect.objectContaining({ statusCode: 503, code: 'FISCAL_VOICE_UNAVAILABLE', causeMessage: expect.stringMatching(cause) })
const row = (over: any = {}) => rawServiceRow({ invoiceId: ORDER, lifeEvent: 1, ...over })
const unrec = (over: any = {}) => row({ accessKey: null, authorityRecorded: 'N', nfseNumber: null, dhProc: null, ...over })

const ENV0 = { ...process.env }
beforeEach(() => {
  jest.clearAllMocks()
  contracted = new Set(Object.values(CATALOG)); privileged = new Set()
  lifeRows = [{ invoiceId: ORDER, invoiceDeleted: 'N', lifeEvent: 1, lastEvent: 1, lastKind: 'E' }]
  lifeError = undefined; fiscalRows = []; fiscalError = undefined
  routePool()
  ;(chk.isCheckEventCurrent as jest.Mock).mockResolvedValue(true)
  ;(com.getCommissionBalanceByItem as jest.Mock).mockResolvedValue([])
  ;(com.insertCommissions as jest.Mock).mockResolvedValue([1])
  ;(soRepo.listOrders as jest.Mock).mockResolvedValue({ rows: [
    { id: ORDER, status: 'F', webIssued: 1, invoiceNumber: 17 }, { id: 7401, status: 'A', webIssued: 0, invoiceNumber: null },
  ], total: 2 })
})
afterEach(() => { process.env = { ...ENV0 } })

const scope = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
/** A lista de OS como o controller a serve (sucesso → 200; erro → handleError) — status + corpo JSON. */
async function listAsServed(): Promise<{ status: number; body: any }> {
  const res: any = { statusCode: 200, body: null, req: { institution: USER }, status(c: number) { this.statusCode = c; return this }, json(b: any) { this.body = b; return this } }
  try { res.json(pagedEnvelope({ page: 1, pageSize: 25 } as any, await fetchOrders('', { page: 1, pageSize: 25 } as any, scope))) } catch (e) { handleError(res, e, 'service-orders GET') }
  return { status: res.statusCode, body: res.body }
}

// =================================================================================================
// 1. D-F130 — voz ILEGÍVEL em execução: lista degrada, quem decide falha fechado com 503 tipado
// =================================================================================================
describe('1 — D-F130: a porta tipa a falha de LEITURA da voz (503 + ref + alarme); contenção e erro do ERP seguem o caminho de sempre', () => {
  it('[RESISTIU] DEVERIAM virar 503: ECONNRESET, conexão perdida, 1142/1146/1054, driver sem linhas (OkPacket), linha nula (TypeError do mapa), linha fora do domínio, A sem registro (D-F136) — nas DUAS leituras da porta, causa só no causeMessage', async () => {
    const lost = Object.assign(new Error('Connection lost: The server closed the connection. detalhe-interno-da-causa'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true })
    const throwers: [string, any][] = [
      ['ECONNRESET', econnreset], ['PROTOCOL_CONNECTION_LOST', lost], ['1142', denied],
      ['1146', err('ER_NO_SUCH_TABLE', 1146)], ['1054', err('ER_BAD_FIELD_ERROR', 1054)], ['1064', err('ER_PARSE_ERROR', 1064)],
    ]
    const returners: [string, any][] = [
      ['OkPacket', { affectedRows: 0 }], ['linha nula', [null]], ['environment X', [row({ environment: 'X' })]],
      ['authority_recorded s', [row({ authorityRecorded: 's' })]], ['terminal -1', [row({ terminal: -1 })]],
      ['A sem registro', [unrec({ lastKind: 'A' })]], ['N sem registro (H)', [unrec({ lastKind: 'N', environment: 'H' })]],
    ]
    const cases: [string, any][] = [
      ...throwers.map(([n, e]) => [n, { query: jest.fn().mockRejectedValue(e) }] as [string, any]),
      ...returners.map(([n, rows]) => [n, { query: jest.fn().mockResolvedValue([rows]) }] as [string, any]),
    ]
    for (const [name, fake] of cases) {
      for (const read of [() => readServiceVoiceOfLife(fake, 1, ORDER, 1), () => readServiceVoicesOfLives(fake, 1, [{ invoiceId: ORDER, lifeEvent: 1 }])]) {
        const e: any = await read().catch(x => x)
        expect([name, e instanceof FiscalVoiceUnavailableError, e?.statusCode, e?.code, e?.ref]).toEqual([name, true, 503, 'FISCAL_VOICE_UNAVAILABLE', 'REFADVR4'])
        expect([name, /detalhe-interno|D-F136|environment|authority_recorded|terminal/.test(String(e.message))]).toEqual([name, false])
      }
    }
    // um alarme por leitura que falhou — com o código tipado e o ref que o usuário vê
    expect((crash.recordCrash as jest.Mock).mock.calls.length).toBe(cases.length * 2)
    for (const [c] of (crash.recordCrash as jest.Mock).mock.calls) expect(c).toMatchObject({ ref: 'REFADVR4', code: 'FISCAL_VOICE_UNAVAILABLE', statusCode: 503, institutionId: 1 })
  })

  it('[RESISTIU] NÃO deveriam virar 503: lock wait (1205) e deadlock (1213) da leitura sobem CRUS — e no plano viram 409 RESOURCE_BUSY (deadlock reexecutado 3×), sem alarme de voz', async () => {
    for (const raw of [lockWait, deadlock]) {
      await expect(readServiceVoiceOfLife({ query: jest.fn().mockRejectedValue(raw) }, 1, ORDER, 1)).rejects.toBe(raw)
    }
    getConn.mockImplementation(async () => planConn({ failOn: /fiscal_api/, failWith: deadlock }).conn)
    const r = await request(app).get(`/api/billing/${ORDER}/cancel-plan`).set('Authorization', bearer(ADMIN))
    expect([r.status, r.body.code]).toEqual([409, 'RESOURCE_BUSY'])
    expect(getConn).toHaveBeenCalledTimes(3)
    expect((crash.recordCrash as jest.Mock).mock.calls.filter(([c]) => c.code === 'FISCAL_VOICE_UNAVAILABLE')).toEqual([])
  })

  it('[RESISTIU] erro do ERP ANTES da voz não vira "voz ilegível": tabela do ERP sumida no plano → 500 INTERNAL (sem ler a voz); vw_invoice_life fora na lista e no efeito → 500 (nunca degradado calado)', async () => {
    const { conn, seq } = planConn({ failOn: /FROM `setes_setes`\.tb_financial\s+WHERE/, failWith: err('ER_NO_SUCH_TABLE', 1146) })
    getConn.mockResolvedValue(conn)
    const r = await request(app).get(`/api/billing/${ORDER}/cancel-plan`).set('Authorization', bearer(ADMIN))
    expect([r.status, r.body.code]).toEqual([500, 'INTERNAL'])
    expect(seq.some(s => /fiscal_api/.test(s))).toBe(false)
    lifeError = err('ER_NO_SUCH_TABLE', 1146)
    expect((await listAsServed()).status).toBe(500)
    const e = await request(app).get(`/api/billing/${ORDER}/fiscal-effect`).set('Authorization', bearer(ADMIN))
    expect([e.status, e.body.code]).toEqual([500, 'INTERNAL'])
    expect((crash.recordCrash as jest.Mock).mock.calls.filter(([c]) => c.code === 'FISCAL_VOICE_UNAVAILABLE')).toEqual([])
  })

  it('[FATO — analisado] um HttpError JÁ tipado lançado DENTRO da leitura viraria 503 (o `guarded` só poupa a contenção) — hoje nenhum produtor: o núcleo de leitura só lança Error simples', async () => {
    const typed = new HttpError(409, 'x', undefined, 'QUALQUER')
    const e: any = await readServiceVoiceOfLife({ query: jest.fn().mockRejectedValue(typed) }, 1, ORDER, 1).catch(x => x)
    expect([e.statusCode, e.code]).toEqual([503, 'FISCAL_VOICE_UNAVAILABLE'])
    const reader = fs.readFileSync(path.join(REPO, 'node_modules', 'fiscal-api', 'dist', 'voice', 'family-reader.js'), 'utf8')
    expect(reader).not.toMatch(/HttpError/)
  })

  it('[RESISTIU] lista de OS com a voz ilegível (GRANT revogado / ECONNRESET / A sem registro): 200, selo `unavailable` só nas notas da web, nada inventado, causa e ref fora do corpo; UM alarme', async () => {
    for (const setup of [() => { fiscalError = denied }, () => { fiscalError = econnreset }, () => { fiscalRows = [unrec({ lastKind: 'A' })] }]) {
      jest.clearAllMocks(); routePool(); fiscalError = undefined; fiscalRows = []
      ;(soRepo.listOrders as jest.Mock).mockResolvedValue({ rows: [{ id: ORDER, status: 'F', webIssued: 1, invoiceNumber: 17 }, { id: 7401, status: 'A', webIssued: 0, invoiceNumber: null }], total: 2 })
      setup()
      const out = await listAsServed()
      expect(out.status).toBe(200)
      expect(out.body.data.map((r: any) => [r.id, r.fiscalState, r.fiscalEnvironment, r.nfseNumber])).toEqual([[ORDER, 'unavailable', null, null], [7401, null, null, null]])
      expect(JSON.stringify(out.body)).not.toMatch(/detalhe-interno|D-F136|REFADVR4|vw_invoice_service_transmission/)
      expect((crash.recordCrash as jest.Mock).mock.calls.map(([c]) => c.code)).toEqual(['FISCAL_VOICE_UNAVAILABLE'])
    }
  })

  it('[RESISTIU] as 4 rotas que DECIDEM com a voz ilegível → 503 FISCAL_VOICE_UNAVAILABLE com o ref do alarme (o MESMO gravado), sem a causa, sem escrita, sem commit, sem reexecutar', async () => {
    const calls: [string, () => request.Test][] = [
      ['GET cancel-plan', () => request(app).get(`/api/billing/${ORDER}/cancel-plan`).set('Authorization', bearer(ADMIN))],
      ['GET fiscal-effect', () => request(app).get(`/api/billing/${ORDER}/fiscal-effect`).set('Authorization', bearer(ADMIN))],
      ['POST cancel', () => request(app).post('/api/billing/cancel').set('Authorization', bearer(ADMIN)).send({ orderId: ORDER, reason: 'teste' })],
      ['POST cancel-waiver', () => request(app).post('/api/billing/cancel-waiver').set('Authorization', bearer(ADMIN)).send({ orderId: ORDER, reason: 'teste' })],
    ]
    for (const [name, call] of calls) {
      jest.clearAllMocks(); routePool()
      fiscalError = denied
      const pc = planConn({ failOn: /fiscal_api/, failWith: denied })
      getConn.mockResolvedValue(pc.conn)
      const r = await call()
      expect([name, r.status, r.body.code, r.body.ref]).toEqual([name, 503, 'FISCAL_VOICE_UNAVAILABLE', 'REFADVR4'])
      expect([name, JSON.stringify(r.body)]).not.toEqual([name, expect.stringMatching(/detalhe-interno|causeMessage|denied/)])
      expect([name, pc.writes, pc.conn.commit.mock.calls.length]).toEqual([name, [], 0])
      expect([name, getConn.mock.calls.length <= 1]).toEqual([name, true])                     // 503 não reexecuta (só deadlock)
      const voice = (crash.recordCrash as jest.Mock).mock.calls.filter(([c]) => c.code === 'FISCAL_VOICE_UNAVAILABLE')
      expect([name, voice.length, voice[0]?.[0]?.ref]).toEqual([name, 1, 'REFADVR4'])
      expect([name, (crash.recordCrash as jest.Mock).mock.calls.some(([c]) => c.code === 'INTERNAL')]).toEqual([name, false])
    }
  })

  it('[CENÁRIO] POST cancel com a voz ilegível e a conexão VIVA → 503 (a base do achado abaixo)', async () => {
    const pc = planConn({ failOn: /fiscal_api/, failWith: econnreset })
    getConn.mockResolvedValue(pc.conn)
    const r = await request(app).post('/api/billing/cancel').set('Authorization', bearer(ADMIN)).send({ orderId: ORDER, reason: 'teste' })
    expect([r.status, r.body.code]).toEqual([503, 'FISCAL_VOICE_UNAVAILABLE'])
  })

  it('[CORRIGIDO F2AR4-ADV-04 LOW] POST cancel / cancel-waiver: a voz perde a CONEXÃO da transação (ECONNRESET/KILL — o mysql2 marca a conexão como morta) → a porta tipa 503, mas o `await conn.rollback()` SEM catch de `cancelOrderInvoice`/`waiveOrderInvoiceCancel` rejeita na conexão morta e SUBSTITUI o 503 → 500 INTERNAL com um 2º alarme (o GET do plano já tem `.catch` no rollback)', async () => {
    const out: any[] = []
    for (const [url, body] of [['/api/billing/cancel', { orderId: ORDER, reason: 'teste' }], ['/api/billing/cancel-waiver', { orderId: ORDER, reason: 'teste' }]] as const) {
      jest.clearAllMocks(); routePool()
      const pc = planConn({ failOn: /fiscal_api/, failWith: econnreset, deadAfterFail: true })
      getConn.mockResolvedValue(pc.conn)
      const r = await request(app).post(url).set('Authorization', bearer(ADMIN)).send(body)
      out.push([url, r.status, r.body.code])
    }
    expect(out).toEqual([['/api/billing/cancel', 503, 'FISCAL_VOICE_UNAVAILABLE'], ['/api/billing/cancel-waiver', 503, 'FISCAL_VOICE_UNAVAILABLE']])
  })

  it('[CORRIGIDO F2AR4-ADV-05 LOW — o mapa da família recusa registro sem chave (ADV-05 da Rodada 4); a porta responde 503 da voz ilegível] linha da view "registrada SEM chave" (authority_recorded S, access_key NULL — o mapa do NÚCLEO não confere registro ⇔ chave, o `mapTx` da nfse-api confere): `fiscalRecordKey` lança Error simples FORA da porta → GET fiscal-effect e POST cancel-waiver respondem 500 INTERNAL, não o 503 tipado da D-F130', async () => {
    const incoherent = row({ accessKey: null, authorityRecorded: 'S', lastKind: 'C', lastCode: '105102', lastSource: 'Q' })
    expect(() => serviceView({ accessKey: null, authorityRecorded: 'S' })).toThrow()              // o mapa da FAMÍLIA recusa (registro ⇒ chave)
    fiscalRows = [incoherent]
    const e = await request(app).get(`/api/billing/${ORDER}/fiscal-effect`).set('Authorization', bearer(ADMIN))
    getConn.mockResolvedValue(planConn({ fiscal: [incoherent] }).conn)
    const w = await request(app).post('/api/billing/cancel-waiver').set('Authorization', bearer(ADMIN)).send({ orderId: ORDER, reason: 'teste' })
    expect([[e.status, e.body.code], [w.status, w.body.code]]).toEqual([[503, 'FISCAL_VOICE_UNAVAILABLE'], [503, 'FISCAL_VOICE_UNAVAILABLE']])
  })
})

// =================================================================================================
// 2. D-F131 — GET …/cancel-plan: a guarda do POST e a espera curta que nunca volta ao pool
// =================================================================================================
describe('2 — D-F131: guarda CANCELAR do ramo e a sessão encurtada (devolvida ou descartada — nunca ao pool encurtada)', () => {
  const plan = (who: { role: string } = USER) => request(app).get(`/api/billing/${ORDER}/cancel-plan`).set('Authorization', bearer(who))

  it('[RESISTIU] privilégio do RAMO: sem nada / CANCELAR só em `orders` / FATURAR (5) na OS → 403 sem abrir conexão; CANCELAR (7) na OS → 200; ramo não contratado → 403 até para o admin', async () => {
    for (const grants of [[], ['7:29:7'], ['7:20:5'], ['7:31:7']]) {
      privileged = new Set(grants)
      const r = await plan()
      expect([grants, r.status, r.body.code]).toEqual([grants, 403, 'PRIVILEGE_REQUIRED'])
    }
    expect(getConn).not.toHaveBeenCalled()
    privileged = new Set(['7:20:7'])
    getConn.mockResolvedValue(planConn({ fiscal: [] }).conn)
    expect((await plan()).status).toBe(200)
    contracted.delete(CATALOG['service-orders']); getConn.mockClear()
    const r = await plan(ADMIN)
    expect([r.status, r.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED']); expect(getConn).not.toHaveBeenCalled()
  })

  const run = async (sc: PlanScenario) => {
    const pc = planConn(sc)
    getConn.mockResolvedValue(pc.conn)
    const out = await getOrderCancelPlan(ADMIN as any, ORDER).then(v => ({ ok: v }), e => ({ err: e }))
    return { ...pc, out }
  }

  it('[RESISTIU] ordem: guarda o valor ANTERIOR, encurta para 3 s ANTES do BEGIN e do 1º SQL do plano; no fim ROLLBACK → devolve → RELEASE (nunca DESTROY)', async () => {
    const { seq, out } = await run({ fiscal: [] })
    expect('ok' in out).toBe(true)
    expect(CANCEL_PLAN_LOCK_WAIT_SECONDS).toBe(3)
    const at = (re: RegExp) => seq.findIndex(s => re.test(s))
    expect(at(/^SET @setes_plan_prev_lw/)).toBe(0)
    expect(at(/innodb_lock_wait_timeout = \?/)).toBe(1)
    expect(at(/^BEGIN$/)).toBe(2)
    expect(seq.slice(-3)).toEqual(['ROLLBACK', RESTORE_SEQ, 'RELEASE'])
  })

  it('[RESISTIU] falha no 1º SET (nada encurtado) → RELEASE sem tentar devolver; falha no 2º SET → devolve e RELEASE; 2º SET + devolução falham → DESTROY (nunca RELEASE)', async () => {
    const a = await run({ failSetPrev: err('PROTOCOL_CONNECTION_LOST', 0) })
    expect(['err' in a.out, a.seq.filter(s => /^SET SESSION innodb_lock_wait_timeout = @setes_plan_prev_lw/.test(s)), a.conn.release.mock.calls.length, a.conn.destroy.mock.calls.length]).toEqual([true, [], 1, 0])
    const b = await run({ failSetShort: err('ER_UNKNOWN_SYSTEM_VARIABLE', 1193) })
    expect(['err' in b.out, b.seq.slice(-2), b.conn.destroy.mock.calls.length]).toEqual([true, [RESTORE_SEQ, 'RELEASE'], 0])
    const c = await run({ failSetShort: econnreset, failRestore: econnreset })
    expect(['err' in c.out, c.conn.release.mock.calls.length, c.conn.destroy.mock.calls.length]).toEqual([true, 0, 1])
  })

  it('[RESISTIU] plano OK mas a devolução falha → a resposta sai (200) e a conexão é DESTRUÍDA; ROLLBACK que rejeita é engolido e a devolução ainda roda', async () => {
    const a = await run({ fiscal: [], failRestore: econnreset })
    expect(['ok' in a.out, a.conn.release.mock.calls.length, a.conn.destroy.mock.calls.length]).toEqual([true, 0, 1])
    const b = await run({ fiscal: [], rollbackRejects: err('ER_X', 1) })
    expect(['ok' in b.out, b.seq.slice(-3), b.conn.destroy.mock.calls.length]).toEqual([true, ['ROLLBACK', RESTORE_SEQ, 'RELEASE'], 0])
  })

  it('[RESISTIU] voz ilegível com a conexão MORTA no meio do plano (ECONNRESET) → 503 tipado (o rollback do GET tem catch) e a conexão é DESTRUÍDA (a devolução falha)', async () => {
    const { out, conn } = await run({ failOn: /fiscal_api/, failWith: econnreset, deadAfterFail: true })
    expect((out as any).err).toEqual(voiceDown(/ECONNRESET/))
    expect([conn.release.mock.calls.length, conn.destroy.mock.calls.length]).toEqual([0, 1])
  })

  it('[RESISTIU] lock wait (1205) no plano → 409 RESOURCE_BUSY sem reexecutar; deadlock 3× → 3 conexões, cada uma ROLLBACK → devolve → RELEASE', async () => {
    const a = await run({ failOn: /tb_check_event e/, failWith: lockWait })
    expect(contentionCode((a.out as any).err)).toBe('RESOURCE_BUSY')
    expect(getConn).toHaveBeenCalledTimes(1)
    expect(a.seq.slice(-3)).toEqual(['ROLLBACK', RESTORE_SEQ, 'RELEASE'])
    getConn.mockClear()
    const conns: any[] = []
    getConn.mockImplementation(async () => { const pc = planConn({ failOn: /tb_check_event e/, failWith: deadlock }); conns.push(pc); return pc.conn })
    const r = await request(app).get(`/api/billing/${ORDER}/cancel-plan`).set('Authorization', bearer(ADMIN))
    expect([r.status, r.body.code, conns.length]).toEqual([409, 'RESOURCE_BUSY', 3])
    for (const pc of conns) expect(pc.seq.slice(-3)).toEqual(['ROLLBACK', RESTORE_SEQ, 'RELEASE'])
  })
})

function contentionCode(e: any): string | undefined {
  const res: any = { req: {}, status() { return this }, json(b: any) { this.body = b; return this } }
  handleError(res, e, 'x')
  return res.body?.code
}

// =================================================================================================
// 3. D-F141 — a barreira TIPADA do plano (GET e 409 do POST)
// =================================================================================================
describe('3 — D-F141: barrier {kind, reason?, attempt} sem dado indevido', () => {
  const F = { lastKind: 'F', lastSource: 'Q', createdAt: '2026-10-10 12:00:00', lastEventAt: '2026-10-10 12:10:00' }
  const fiscalOf = async (fiscal: any[]) => (await buildCancelPlan(planConn({ fiscal }).conn, 'setes_setes', 1, ORDER)).blocks.filter(b => b.field === 'fiscal')

  it('[RESISTIU] um kind por barreira; `reason` SÓ em reconfirm (lista fechada do núcleo); nada de chave, Id do DPS, número da NFS-e ou código do fisco DENTRO do barrier', async () => {
    const cases: [string, any[], object][] = [
      ['autorizada P', [row()], { kind: 'authorized', attempt: 1 }],
      ['em voo', [unrec({ lastEvent: null, lastKind: null, lastCode: null, lastSource: null, lastDh: null, lastEventAt: null })], { kind: 'in-flight', attempt: 1 }],
      ['K', [row({ lastKind: 'K', lastSource: 'P' })], { kind: 'cancel-in-flight', attempt: 1 }],
      ['F sem E2404', [unrec(F)], { kind: 'reconfirm', attempt: 1, reason: 'sem-e2404' }],
      ['F E2404 anterior', [unrec({ ...F, nfseNotGeneratedAt: '2026-10-10 12:05:00' })], { kind: 'reconfirm', attempt: 1, reason: 'apresentada-depois' }],
      ['F + irmã sem identidade', [unrec({ ...F, attempt: 2 }), unrec({ attempt: 1, dpsId: null, lastKind: 'R', lastSource: 'P', createdAt: '2026-10-10 11:00:00', lastEventAt: '2026-10-10 11:00:05' })], { kind: 'reconfirm', attempt: 2, reason: 'sem-identidade' }],
      ['F instante ISO', [unrec({ ...F, nfseNotGeneratedAt: '2026-10-11T08:00:00Z' })], { kind: 'reconfirm', attempt: 1, reason: 'instante-invalido' }],
    ]
    for (const [name, fiscal, want] of cases) {
      const blocks = await fiscalOf(fiscal)
      expect([name, blocks.length]).toEqual([name, 1])
      expect([name, blocks[0].barrier]).toEqual([name, want])
      const json = JSON.stringify(blocks[0].barrier)
      expect([name, json.includes(TEST_KEY) || /DPS|710|E2404|101101/.test(json)]).toEqual([name, false])
    }
  })

  it('[RESISTIU] o 409 INVOICE_CANCEL_BLOCKED do POST /api/billing/cancel carrega o MESMO barrier no fields[] — e nada foi escrito', async () => {
    const pc = planConn({ fiscal: [unrec(F)] })
    getConn.mockResolvedValue(pc.conn)
    const r = await request(app).post('/api/billing/cancel').set('Authorization', bearer(ADMIN)).send({ orderId: ORDER, reason: 'teste' })
    expect([r.status, r.body.code]).toEqual([409, 'INVOICE_CANCEL_BLOCKED'])
    expect(r.body.fields).toEqual([expect.objectContaining({ field: 'fiscal', barrier: { kind: 'reconfirm', attempt: 1, reason: 'sem-e2404' } })])
    expect(pc.writes).toEqual([])
    getConn.mockResolvedValue(planConn({ fiscal: [row()] }).conn)
    const g = await request(app).get(`/api/billing/${ORDER}/cancel-plan`).set('Authorization', bearer(ADMIN))
    expect(g.body.data.blocks).toEqual([expect.objectContaining({ field: 'fiscal', barrier: { kind: 'authorized', attempt: 1 } })])
  })
})

// =================================================================================================
// 4. D-F135 — o boot confere os 9 gatilhos de TRAVA
// =================================================================================================
describe('4 — D-F135: furar a conferência do boot', () => {
  const SPECS = f2aFreezeTriggerSpecs()
  // corrigido (F2AR4-ADV-02): a conferência compara o CORPO com o da migration — a fixture serve o corpo REAL de cada gatilho
  const rowsOf = (over: Record<string, object> = {}) => SPECS.map(t => ({ name: t.name, tbl: t.table, ev: t.event, timing: 'BEFORE', body: t.body, ...(over[t.name] ?? {}) }))
  const se = 'tg_f2a_freeze_issuer_se_bu'

  it('[CORRIGIDO F2AR4-ADV-02 MEDIUM] gatilho com o NOME, a tabela, o BEFORE e o evento certos e o CORPO trocado passa: SIGNAL sob IF que nunca vale, SIGNAL em comentário, a trava da SE sem a cláusula do contador/dono (o corpo de uma versão ANTERIOR da 069) → `f2aFreezeTriggersMissing` devolve [] e o boot sobe com o ERP descongelado', async () => {
    const bodies = [
      "BEGIN\n  IF OLD.`model` = 'XX' THEN\n    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'x';\n  END IF;\nEND",
      "BEGIN\n  /* SIGNAL SQLSTATE '45000' */ SET @adv = 1;\nEND",
      "BEGIN\n  IF OLD.`model` = 'SE' OR NEW.`model` = 'SE' THEN\n    IF NOT (NEW.`model` <=> OLD.`model`) THEN\n      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'x';\n    END IF;\n  END IF;\nEND",
    ]
    const out: string[][] = []
    for (const body of bodies) out.push(await f2aFreezeTriggersMissing({ query: jest.fn(async () => [rowsOf({ [se]: { body } })]) }, 'setes_setes'))
    expect(out.map(m => m.length)).toEqual([1, 1, 1])
  })

  it('[RESISTIU] AFTER no lugar de BEFORE, tabela errada, evento trocado, nome em MAIÚSCULAS (outro gatilho) e nenhum visível (sem o privilégio TRIGGER) → acusados', async () => {
    for (const over of [{ timing: 'AFTER' }, { tbl: 'tb_invoice' }, { ev: 'INSERT' }]) {
      expect(await f2aFreezeTriggersMissing({ query: jest.fn(async () => [rowsOf({ [se]: over })]) }, 'setes_setes')).toEqual([expect.stringMatching(new RegExp(`^${se} diferente`))])
    }
    const upper = rowsOf().map(r => (r.name === se ? { ...r, name: se.toUpperCase() } : r))
    expect(await f2aFreezeTriggersMissing({ query: jest.fn(async () => [upper]) }, 'setes_setes')).toEqual([`${se} ausente`])
    expect(await f2aFreezeTriggersMissing({ query: jest.fn(async () => [[]]) }, 'setes_setes')).toHaveLength(9)
  })

  it('[RESISTIU] schema hostil/nulo vindo de tb_institution → o boot FALHA antes de consultar o information_schema dele; a lista de schemas é a MESMA consulta do runner', async () => {
    for (const bad of ['setes_x`; DROP DATABASE setes_setes; --', null, 'fiscal_api', 'SETES_SETES']) {
      const fake = { query: jest.fn(async (sql: string, p?: any[]) => (/tb_institution/.test(sql) ? [[{ schema_name: 'setes_setes' }, { schema_name: bad }]] : [rowsOf()])) }
      await expect(assertF2aFreezeTriggers(fake)).rejects.toThrow(/schemaName inválido/)
      expect(fake.query.mock.calls.filter((c: any[]) => /information_schema/.test(c[0]) && c[1]?.[0] !== 'setes_setes')).toEqual([])
    }
    const runner = fs.readFileSync(path.join(REPO, 'src', 'migrations', 'runner.ts'), 'utf8')
    const boot = fs.readFileSync(path.join(REPO, 'src', 'migrations', 'f2a-freeze-triggers.ts'), 'utf8')
    const instSql = "SELECT schema_name FROM setes_central.tb_institution WHERE active = 'S' AND deleted = 'N'"
    expect([runner.includes(instSql), boot.includes(instSql)]).toEqual([true, true])
  })
})

// =================================================================================================
// 5. D-F134 — o script de aborto (função e linha de comando)
// =================================================================================================
describe('5 — D-F134: aborto antes do --vai', () => {
  /** Banco falso do aborto: [seInst] = linhas SE do ERP por institution; [cutInst] = institutions com cutover_at no fiscal_api. */
  const fakeAbort = (seRows: Record<number, string[]>, cut: number[], triggers: string[] = f2aFreezeTriggerSpecs().map(t => t.name), mig = 1) => {
    const sqls: string[] = []
    const c = { query: jest.fn(async (sql: string, p: any[] = []) => {
      sqls.push(sql)
      if (/FROM `setes_central`\.tb_institution WHERE schema_name/.test(sql)) return [[{ id: 1 }]]        // a dona de setes_setes
      if (/FROM `setes_\w+`\.tb_establishment_issuer/.test(sql)) return [(seRows[Number(p[0])] ?? []).map(d => ({ deleted: d }))]
      if (/cutover_at IS NOT NULL/.test(sql)) return [[{ n: cut.includes(Number(p[0])) ? 1 : 0 }]]
      if (/information_schema\.TRIGGERS/.test(sql)) return [triggers.map(name => ({ name }))]
      if (/SELECT name FROM `setes_\w+`\._migrations/.test(sql)) return [mig ? [{ name: 'f2a_fiscal_passivo' }] : []]   // D-F153: a linha e a lápide pelo nome
      return [{ affectedRows: 1 }]
    }) }
    return { c, sqls, drops: () => sqls.filter(s => /^DROP TRIGGER/.test(s)) }
  }

  it('[RESISTIU] virada feita na institution pedida (SE aposentada no ERP, ou cutover_at no fiscal_api) → RECUSA sem DDL; schema/banco hostis e institution inválida → recusa antes do SQL', async () => {
    for (const [se, cut] of [[{ 1: ['S'] }, []], [{ 1: ['N'] }, [1]], [{ 1: ['s'] }, []]] as [Record<number, string[]>, number[]][]) {
      const f = fakeAbort(se, cut)
      await expect(abortF2aPassivo(f.c, 'setes_setes', 1, { vai: true, fiscalDb: 'fiscal_api' })).rejects.toThrow(/D-F50/)
      expect(f.drops()).toEqual([])
    }
    for (const [schema, db, id] of [['setes_x`; DROP', 'fiscal_api', 1], ['setes_setes', 'fiscal_api`.x', 1], ['setes_setes', 'fiscal_api', 0], ['setes_setes', 'fiscal_api', 1.5], ['setes_setes', 'fiscal_api', 2 ** 53]] as [string, string, number][]) {
      const f = fakeAbort({}, [])
      await expect(abortF2aPassivo(f.c, schema, id, { vai: true, fiscalDb: db })).rejects.toThrow(/inválid/)
      expect(f.sqls).toEqual([])
    }
  })

  it('[CORRIGIDO F2AR4-ADV-01 MEDIUM] o aborto derruba os gatilhos do SCHEMA inteiro conferindo a virada de UMA institution — o id que o operador digita, sem conferir que é o dono do schema: `setes_setes 2` (typo do 1, ou a filial que ainda não virou) passa DEPOIS da virada da institution 1 e tira a trava — o rollback que a D-F50 proíbe', async () => {
    const f = fakeAbort({ 1: ['S'] }, [1])                       // a institution 1 (dona de setes_setes) JÁ VIROU
    let refused = false
    try { await abortF2aPassivo(f.c, 'setes_setes', 2, { vai: true, fiscalDb: 'fiscal_api' }) } catch { refused = true }
    expect([refused, f.drops()]).toEqual([true, []])
  })

  it('[CORRIGIDO F2AR4-ADV-06 LOW] estado incoerente: a linha `f2a_fiscal_passivo` está no _migrations mas NENHUM gatilho é visível (usuário sem o privilégio TRIGGER, ou gatilhos já derrubados à mão) → o `--vai` tira a linha e "conclui" com os gatilhos (se existirem) intactos; deveria RECUSAR e dizer por quê', async () => {
    const f = fakeAbort({ 1: ['N'] }, [], [], 1)
    let refused = false
    try { await abortF2aPassivo(f.c, 'setes_setes', 1, { vai: true, fiscalDb: 'fiscal_api' }) } catch { refused = true }
    expect([refused, f.sqls.some(s => /^DELETE FROM/.test(s))]).toEqual([true, false])
  })

  // ---- linha de comando: o script de verdade, com o banco APONTADO para uma porta morta (127.0.0.1:1) — passar do parser = ECONNREFUSED
  const tsxCli = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [tsxCli, '--require', 'tsconfig-paths/register', 'scripts/f2a-abort-before-cutover.ts', ...args], {
      cwd: REPO, encoding: 'utf8', timeout: 60000, env: { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'nobody', DB_PASSWORD: 'x' },
    })
    const txt = `${r.stdout}${r.stderr}`
    return { code: r.status, parsed: !/uso: npx tsx/.test(txt), txt }
  }
  const NOSCHEMA = 'setes_advr4_naoexiste'                       // nem existe — se algum dia conectar, a 1ª leitura falha antes de qualquer DDL

  it('[RESISTIU] argumentos: `--VAI`, `--vai=1`, `vai`, `-vai`, argumento a mais, schema fora de setes_*, id não inteiro / negativo / vazio → "uso:" sem conectar', () => {
    for (const args of [[NOSCHEMA, '1', '--VAI'], [NOSCHEMA, '1', '--vai=1'], [NOSCHEMA, '1', 'vai'], [NOSCHEMA, '1', '-vai'], [NOSCHEMA, '1', '--vai', 'x'],
      ['fiscal_api', '1'], ['setes_x;', '1'], [NOSCHEMA, '1.5'], [NOSCHEMA, '-1'], [NOSCHEMA, ''], ['--vai', NOSCHEMA, '1']]) {
      const r = cli(...args)
      expect([args, r.code, r.parsed]).toEqual([args, 1, false])
    }
  }, 120000)

  it('[CORRIGIDO F2AR4-ADV-07 LOW] `--vai --vai` (flag repetida) passa do parser e CONECTA — o ato da nfse-api recusa argumento repetido (ADV-R8 — "npm engolindo flag"); o aborto, que também é irreversível, aceita', () => {
    const r = cli(NOSCHEMA, '1', '--vai', '--vai')
    expect(/ECONNREFUSED|connect/i.test(r.txt) ? 'conectou' : 'recusou').toBe('recusou')
  }, 60000)
})

// =================================================================================================
// 6. D-F136 — A/N sem registro em TODO leitor do setes-api; e o C sem registro (fora da decisão)
// =================================================================================================
describe('6 — D-F136: voz A/N ⇒ registro em todo leitor (falha fechada)', () => {
  const incoherent: [string, any[]][] = [
    ['A sem registro em P', [unrec({ lastKind: 'A' })]],
    ['N sem registro em P', [unrec({ lastKind: 'N' })]],
    ['A sem registro em H', [unrec({ lastKind: 'A', environment: 'H' })]],
    ['A sem registro na tentativa ANTIGA (vigente é a R)', [unrec({ attempt: 1, lastKind: 'A' }), unrec({ attempt: 2, lastKind: 'R', dpsId: 'DPS2' })]],
  ]
  it('[RESISTIU] plano (GET), POST cancel, "manter a nota", efeito e lista → 503/degradado; NENHUMA escrita, nenhum soft-delete', async () => {
    for (const [name, fiscal] of incoherent) {
      jest.clearAllMocks(); routePool(); fiscalRows = fiscal
      ;(soRepo.listOrders as jest.Mock).mockResolvedValue({ rows: [{ id: ORDER, status: 'F', webIssued: 1, invoiceNumber: 17 }], total: 1 })
      const conns: any[] = []
      getConn.mockImplementation(async () => { const pc = planConn({ fiscal }); conns.push(pc); return pc.conn })
      const rs = [
        await request(app).get(`/api/billing/${ORDER}/cancel-plan`).set('Authorization', bearer(ADMIN)),
        await request(app).post('/api/billing/cancel').set('Authorization', bearer(ADMIN)).send({ orderId: ORDER, reason: 'teste' }),
        await request(app).post('/api/billing/cancel-waiver').set('Authorization', bearer(ADMIN)).send({ orderId: ORDER, reason: 'teste' }),
        await request(app).get(`/api/billing/${ORDER}/fiscal-effect`).set('Authorization', bearer(ADMIN)),
      ]
      expect([name, rs.map(r => [r.status, r.body.code])]).toEqual([name, Array(4).fill([503, 'FISCAL_VOICE_UNAVAILABLE'])])
      expect([name, conns.flatMap(pc => pc.writes)]).toEqual([name, []])
      expect([name, (await listAsServed()).body.data[0].fiscalState]).toEqual([name, 'unavailable'])
    }
  })

  it('[RESISTIU] a letra torta não "desautoriza": "a", "A ", "n" sem registro → viva (bloqueia o cancelamento local), nunca liberada', async () => {
    for (const k of ['a', 'A ', 'n']) {
      const pc = planConn({ fiscal: [unrec({ lastKind: k })] })
      await expect(cancelInvoice(pc.conn, 'setes_setes', 1, 7, { orderId: ORDER, reason: 'x' })).rejects.toMatchObject({ code: 'INVOICE_CANCEL_BLOCKED' })
      expect(pc.writes).toEqual([])
    }
  })

  it('[DECIDIDO — D-F154 (= Q-F159 (a))] voz C (e K) SEM registro é linha incoerente como a A/N: o mapa da família falha ALTO → plano, POST cancel, "manter a nota", efeito → 503 e o selo degrada; NENHUMA escrita (antes: efeito "apply" e o POST SOFT-DELETAVA a nota)', async () => {
    expect(() => serviceView({ accessKey: null, authorityRecorded: 'N', lastKind: 'C' })).toThrow(/D-F154/)
    for (const kind of ['C', 'K']) {
      const fiscal = [unrec({ lastKind: kind, lastCode: kind === 'C' ? '101101' : null, lastSource: 'Q' })]
      jest.clearAllMocks(); routePool(); fiscalRows = fiscal
      ;(soRepo.listOrders as jest.Mock).mockResolvedValue({ rows: [{ id: ORDER, status: 'F', webIssued: 1, invoiceNumber: 17 }], total: 1 })
      const conns: any[] = []
      getConn.mockImplementation(async () => { const pc = planConn({ fiscal }); conns.push(pc); return pc.conn })
      const rs = [
        await request(app).get(`/api/billing/${ORDER}/cancel-plan`).set('Authorization', bearer(ADMIN)),
        await request(app).post('/api/billing/cancel').set('Authorization', bearer(ADMIN)).send({ orderId: ORDER, reason: 'teste' }),
        await request(app).post('/api/billing/cancel-waiver').set('Authorization', bearer(ADMIN)).send({ orderId: ORDER, reason: 'teste' }),
        await request(app).get(`/api/billing/${ORDER}/fiscal-effect`).set('Authorization', bearer(ADMIN)),
      ]
      expect([kind, rs.map(r => [r.status, r.body.code])]).toEqual([kind, Array(4).fill([503, 'FISCAL_VOICE_UNAVAILABLE'])])
      // D-F151: incoerência do dado = CONTRATO — "tentar de novo não resolve"
      expect([kind, rs[0].body.error]).toEqual([kind, expect.stringMatching(/INCOERENTE/)])
      expect([kind, conns.flatMap(pc => pc.writes)]).toEqual([kind, []])
      expect([kind, (await listAsServed()).body.data[0].fiscalState]).toEqual([kind, 'unavailable'])
    }
  })
})

// =================================================================================================
// 7. Swagger do delta — o contrato que a F2b consome (regra da casa: todo endpoint alterado com @swagger válido)
// =================================================================================================
describe('7 — OpenAPI das rotas tocadas pela Rodada 4', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const spec = () => (require('../shared/swagger/swagger-config').swaggerSpec as any).paths ?? {}

  it('[RESISTIU] cancel-waiver, cancel-plan e fiscal-effect publicam o 503 FISCAL_VOICE_UNAVAILABLE e o 403 do privilégio', () => {
    const p = spec()
    expect(Object.keys(p['/api/billing/cancel-waiver']?.post?.responses ?? {})).toEqual(expect.arrayContaining(['403', '503']))
    expect(Object.keys(p['/api/billing/{orderId}/cancel-plan']?.get?.responses ?? {})).toEqual(expect.arrayContaining(['403', '409', '503']))
    expect(Object.keys(p['/api/billing/{orderId}/fiscal-effect']?.get?.responses ?? {})).toEqual(expect.arrayContaining(['503']))
  })

  it('[CORRIGIDO F2AR4-ADV-08 LOW] o `@swagger` do POST /api/billing/cancel ganhou `barrier {kind, reason?, attempt}` SEM aspas dentro do mapa YAML `409: { description: … }` → YAMLSemanticError no swagger-jsdoc ("Error in billing.routes.ts" em todo boot) e o bloco CAI: a rota do cancelamento — a que a F2b chama — SUMIU do OpenAPI (no 6cf877c ela estava lá)', () => {
    expect(Object.keys(spec()['/api/billing/cancel']?.post?.responses ?? {})).toEqual(expect.arrayContaining(['200', '409', '503']))
  })
})

// =================================================================================================
// PARTE VIVA (opt-in): F2A_ADV_LIVE=1 — bancos DESCARTÁVEIS f2a_advr4_*, criados e apagados aqui
// =================================================================================================
const live = process.env.F2A_ADV_LIVE === '1'
;(live ? describe : describe.skip)('ao vivo (MariaDB do dev, bancos descartáveis f2a_advr4_*)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mysql = jest.requireActual('mysql2/promise') as typeof import('mysql2/promise')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv') as typeof import('dotenv')
  const env = dotenv.parse(fs.readFileSync(path.join(REPO, '.env')))
  const TAG = Date.now().toString(36)
  const DBE = `f2a_advr4_${TAG}_erp`                 // a FORMA das tabelas do ERP + a 069 + tb_lock (o "plano" do D-F131)
  const DBF = `f2a_advr4_${TAG}_fis`                 // a habilitação do fiscal_api (só as colunas que o aborto lê)
  const DBC = `f2a_advr4_${TAG}_cen`                 // o central: tb_institution (id, schema_name) — as DONAS do schema que o aborto confere
  const cfg = () => ({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD })
  let admin: any
  let e: any
  let realPool: any
  const opened: any[] = []
  const connTo = async (db: string) => {
    const c = await mysql.createConnection(cfg()); opened.push(c); await c.query(`USE \`${db}\``)
    const [[cur]] = await c.query<any[]>('SELECT DATABASE() AS db')
    if (cur.db !== db || !/^f2a_advr4_/.test(cur.db)) throw new Error(`conexão fora do banco descartável: ${cur.db}`)   // nunca setes_*
    return c
  }
  const trgCount = async () => Number(((await e.query(`SELECT COUNT(*) n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`, [DBE]))[0] as any[])[0].n)
  const migRow = async () => Number(((await e.query(`SELECT COUNT(*) n FROM _migrations WHERE name = 'f2a_fiscal_passivo'`))[0] as any[])[0].n)
  const apply069 = async () => {
    for (const s of splitStatements(fs.readFileSync(path.join(REPO, 'src', 'migrations', 'sql', '069_f2a_fiscal_passivo.sql'), 'utf8'))) await e.query(s)
    await e.query(`INSERT INTO _migrations (version, name) VALUES ('069', 'f2a_fiscal_passivo') ON DUPLICATE KEY UPDATE name = VALUES(name)`)
  }
  const errno = async (c: any, sql: string, p: unknown[] = []) => { try { await c.query(sql, p); return 0 } catch (x: any) { return Number(x?.errno ?? -1) } }

  beforeAll(async () => {
    admin = await mysql.createConnection(cfg())
    for (const db of [DBE, DBF, DBC]) await admin.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    e = await connTo(DBE)
    for (const t of ['tb_establishment_issuer', 'tb_invoice_service', 'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event']) {
      await e.query(`CREATE TABLE \`${t}\` LIKE setes_setes.\`${t}\``)
    }
    await e.query(`CREATE TABLE _migrations (id INT AUTO_INCREMENT PRIMARY KEY, version VARCHAR(10) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`)
    await e.query(`CREATE TABLE tb_lock (id INT PRIMARY KEY) ENGINE=InnoDB`)
    await e.query(`INSERT INTO tb_lock VALUES (1)`)
    await e.query(`INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, created_at, updated_at, deleted)
                   VALUES (1, 'SE', 'P', '1', 10, NOW(), NOW(), 'N'), (1, '55', 'H', '1', 0, NOW(), NOW(), 'N')`)
    await apply069()
    const f = await connTo(DBF)
    await f.query(`CREATE TABLE tb_establishment_issuer (tb_institution_id INT NOT NULL, model VARCHAR(2) NOT NULL, cutover_at DATETIME NULL, PRIMARY KEY (tb_institution_id, model))`)
    await f.query(`INSERT INTO tb_establishment_issuer VALUES (1, 'SE', NULL)`)
    const cen = await connTo(DBC)
    await cen.query(`CREATE TABLE tb_institution (id INT PRIMARY KEY, schema_name VARCHAR(64) NOT NULL)`)
    await cen.query(`INSERT INTO tb_institution VALUES (1, ?), (3, 'setes_outro')`, [DBE])
    realPool = mysql.createPool({ ...cfg(), connectionLimit: 1 })
  }, 60000)

  afterAll(async () => {
    if (realPool) await realPool.end()
    for (const c of opened) { try { await c.end() } catch { /* */ } }
    if (admin) {
      for (const db of [DBE, DBF, DBC]) await admin.query(`DROP DATABASE IF EXISTS \`${db}\``)
      const [left] = await admin.query(`SHOW DATABASES LIKE 'f2a\\_advr4%'`)
      await admin.end()
      if ((left as any[]).length) throw new Error(`sobrou banco descartável: ${JSON.stringify(left)}`)
    }
  }, 60000)

  // ------------------------------------------------------------------ D-F131: a espera curta contra trava REAL
  describe('D-F131 — trava real na sessão do plano', () => {
    let spy: jest.SpyInstance
    let lockSql = ''
    beforeAll(() => {
      // o plano de verdade lê setes_*; aqui a 1ª leitura travante do plano é trocada por uma trava REAL no banco descartável — o que se prova é
      // o mecanismo da D-F131 (a sessão encurtada na MESMA conexão, 1205 → 409, devolução), com a guarda e o controller reais
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      spy = jest.spyOn(require('../shared/invoice/invoice-cancel'), 'buildCancelPlan').mockImplementation(async (conn: any) => {
        await conn.query(lockSql)
        return { orderId: ORDER, invoice: { number: '17' }, blocks: [], bankSlipsToCancel: [], releasedTitles: [], checksToReverse: [],
          commissionEntries: [], touchesCash: false, fiscalRecord: false, serviceOrder: null } as any
      })
      lockSql = `SELECT id FROM \`${DBE}\`.tb_lock WHERE id = 1 FOR UPDATE`
    })
    afterAll(() => spy.mockRestore())
    beforeEach(() => { getConn.mockImplementation(() => realPool.getConnection()) })

    it('[RESISTIU] outra sessão segura a linha: o GET do plano estoura em ~3 s com 409 RESOURCE_BUSY (nunca 50 s) e a conexão volta ao pool com o valor que ELA tinha (37), não 3', async () => {
      const c0 = await realPool.getConnection(); await c0.query('SET SESSION innodb_lock_wait_timeout = 37')
      const [[{ id: idBefore }]] = await c0.query('SELECT CONNECTION_ID() AS id'); c0.release()
      const holder = await mysql.createConnection(cfg()); opened.push(holder)
      await holder.query('START TRANSACTION'); await holder.query(`SELECT id FROM \`${DBE}\`.tb_lock WHERE id = 1 FOR UPDATE`)
      try {
        const t0 = Date.now()
        const r = await request(app).get(`/api/billing/${ORDER}/cancel-plan`).set('Authorization', bearer(ADMIN))
        const dt = Date.now() - t0
        if (process.env.ADV_SHOW === '1') process.stdout.write(`D-F131 ao vivo: ${r.status} ${r.body.code} em ${dt} ms\n`)
        expect([r.status, r.body.code]).toEqual([409, 'RESOURCE_BUSY'])
        expect(dt).toBeGreaterThanOrEqual(2500); expect(dt).toBeLessThan(8000)
      } finally { await holder.query('ROLLBACK') }
      const c1 = await realPool.getConnection()
      const [[after]] = await c1.query('SELECT CONNECTION_ID() AS id, @@session.innodb_lock_wait_timeout AS lw'); c1.release()
      expect([after.id, Number(after.lw)]).toEqual([idBefore, 37])
      // sem trava: o mesmo GET passa (200) — e a conexão continua com 37
      const ok = await request(app).get(`/api/billing/${ORDER}/cancel-plan`).set('Authorization', bearer(ADMIN))
      expect(ok.status).toBe(200)
    }, 30000)

    it('[CENÁRIO] trava de METADADOS (LOCK TABLES … WRITE — o mesmo de um ALTER/dump com --lock-tables) NÃO obedece o innodb_lock_wait_timeout: com 3 s nele e lock_wait_timeout = 5, o SELECT … FOR UPDATE espera ~5 s e sai com o MESMO 1205', async () => {
      const holder = await mysql.createConnection(cfg()); opened.push(holder)
      const w = await mysql.createConnection(cfg()); opened.push(w)
      await w.query('SET SESSION innodb_lock_wait_timeout = 3'); await w.query('SET SESSION lock_wait_timeout = 5')
      await holder.query(`LOCK TABLES \`${DBE}\`.tb_lock WRITE`)
      try {
        const t0 = Date.now()
        const no = await errno(w, `SELECT id FROM \`${DBE}\`.tb_lock WHERE id = 1 FOR UPDATE`)
        const dt = Date.now() - t0
        if (process.env.ADV_SHOW === '1') process.stdout.write(`MDL: errno ${no} em ${dt} ms\n`)
        expect(no).toBe(1205); expect(dt).toBeGreaterThanOrEqual(4500)
      } finally { await holder.query('UNLOCK TABLES') }
    }, 30000)

    it('[CORRIGIDO F2AR4-ADV-03 LOW] o GET do plano só encurta o `innodb_lock_wait_timeout`: sob trava de METADADOS (LOCK TABLES/ALTER/dump) ele espera o `lock_wait_timeout` do servidor (86400 s no dev) segurando a conexão e as travas que já pegou — a D-F131 promete 409 "em segundos"', async () => {
      const holder = await mysql.createConnection(cfg()); opened.push(holder)
      await holder.query(`LOCK TABLES \`${DBE}\`.tb_lock WRITE`)
      let settled = false
      const pending = request(app).get(`/api/billing/${ORDER}/cancel-plan`).set('Authorization', bearer(ADMIN)).then(r => { settled = true; return r })
      let early = false
      try {
        await new Promise(res => setTimeout(res, 6000))
        early = settled
      } finally {
        await holder.query('UNLOCK TABLES')
        await pending
      }
      expect(early).toBe(true)
    }, 40000)
  })

  // ------------------------------------------------------------------ D-F130: a conexão morta rejeita também o ROLLBACK (base do ADV-04)
  it('[CENÁRIO] (base do F2AR4-ADV-04) conexão morta por KILL: o comando seguinte rejeita E o rollback também rejeita (mysql2 real)', async () => {
    const c = await mysql.createConnection(cfg()); opened.push(c)
    await c.query('START TRANSACTION')
    const [[{ id }]] = await c.query<any[]>('SELECT CONNECTION_ID() AS id')
    await admin.query(`KILL CONNECTION ${Number(id)}`)
    const first = await c.query('SELECT 1').then(() => 'ok', (x: any) => String(x?.code ?? x?.message))
    const rb = await c.rollback().then(() => 'ok', (x: any) => String(x?.message))
    expect(first).not.toBe('ok')
    expect(rb).toMatch(/closed state|Connection lost|ECONNRESET/i)
  }, 30000)

  // ------------------------------------------------------------------ D-F134: o aborto em banco descartável
  describe('D-F134 — aborto contra a 069 aplicada de verdade', () => {
    it('[RESISTIU] ensaio (sem --vai): relata os 9 gatilhos e a linha; nada muda e a voz segue barrada (1644)', async () => {
      const r = await abortF2aPassivo(e, DBE, 1, { vai: false, fiscalDb: DBF, centralDb: DBC })
      expect([r.dryRun, r.triggers.length, r.migrationRow, await trgCount(), await migRow()]).toEqual([true, 9, true, 9, 1])
      expect(await errno(e, `INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, message, source, created_at, deleted) VALUES (1, 1, 0, 1, 1, 'A', 'x', 'P', NOW(), 'N')`)).toBe(1644)
    })

    it('[RESISTIU] cutover_at no fiscal_api para a institution 1 → `abort 1 --vai` RECUSA e nada cai', async () => {
      await admin.query(`UPDATE \`${DBF}\`.tb_establishment_issuer SET cutover_at = UTC_TIMESTAMP() WHERE tb_institution_id = 1`)
      await expect(abortF2aPassivo(e, DBE, 1, { vai: true, fiscalDb: DBF, centralDb: DBC })).rejects.toThrow(/já VIROU/)
      expect([await trgCount(), await migRow()]).toEqual([9, 1])
    })

    it('[CORRIGIDO F2AR4-ADV-01 MEDIUM, prova viva] com a institution 1 JÁ VIRADA, `abort 2 --vai` no MESMO schema derruba os 9 gatilhos e tira a linha do _migrations', async () => {
      try {
        await expect(abortF2aPassivo(e, DBE, 2, { vai: true, fiscalDb: DBF, centralDb: DBC })).rejects.toThrow()
        expect([await trgCount(), await migRow()]).toEqual([9, 1])
      } finally {
        if ((await trgCount()) !== 9 || (await migRow()) !== 1) await apply069()      // devolve a trava para os próximos ataques
      }
    })

    it('[RESISTIU] idempotência: sem virada, `--vai` 2× → a 1ª derruba 9 + a linha (a escrita volta), a 2ª é no-op ([] / false); fiscal_api inexistente → recusa', async () => {
      await admin.query(`UPDATE \`${DBF}\`.tb_establishment_issuer SET cutover_at = NULL WHERE tb_institution_id = 1`)
      await expect(abortF2aPassivo(e, DBE, 1, { vai: true, fiscalDb: `${DBF}_nao_existe`, centralDb: DBC })).rejects.toThrow()
      expect(await trgCount()).toBe(9)
      const a = await abortF2aPassivo(e, DBE, 1, { vai: true, fiscalDb: DBF, centralDb: DBC })
      const b = await abortF2aPassivo(e, DBE, 1, { vai: true, fiscalDb: DBF, centralDb: DBC })
      expect([a.triggers.length, a.migrationRow, b.triggers, b.migrationRow, await trgCount(), await migRow()]).toEqual([9, true, [], false, 0, 0])
      expect(await errno(e, `UPDATE tb_establishment_issuer SET environment = environment WHERE tb_institution_id = 1 AND model = 'SE'`)).toBe(0)
      await apply069()
      expect(await trgCount()).toBe(9)
    })
  })

  // ------------------------------------------------------------------ D-F135: corpo trocado, lido do information_schema REAL
  describe('D-F135 — o corpo do gatilho como o MariaDB o guarda', () => {
    const se = 'tg_f2a_freeze_issuer_se_bu'
    const vbi = 'tg_f2a_freeze_voice_bi'
    /** O `information_schema` REAL do banco descartável, servido à conferência sob um nome setes_* (o `assertSchema` exige o prefixo). */
    const realQ = { query: (sql: string, p: any[] = []) => e.query(sql, [DBE, ...p.slice(1)]) }
    beforeAll(async () => {
      await e.query(`DROP TRIGGER IF EXISTS \`${se}\``)
      await e.query(`CREATE TRIGGER \`${se}\` BEFORE UPDATE ON \`tb_establishment_issuer\`
FOR EACH ROW
BEGIN
  IF OLD.\`model\` = 'XX' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'neutralizado';
  END IF;
END`)
      await e.query(`DROP TRIGGER IF EXISTS \`${vbi}\``)
      await e.query(`CREATE TRIGGER \`${vbi}\` BEFORE INSERT ON \`tb_invoice_service_transmission_event\`
FOR EACH ROW
BEGIN
  /* SIGNAL SQLSTATE '45000' */ SET @adv_r4 = 1;
END`)
    })

    it('[CENÁRIO] os dois gatilhos neutralizados deixam a escrita passar: contador da SE alterado e voz inserida no ERP "congelado"', async () => {
      expect(await errno(e, `UPDATE tb_establishment_issuer SET dps_last_number = 999 WHERE tb_institution_id = 1 AND model = 'SE'`)).toBe(0)
      expect(await errno(e, `INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, message, source, created_at, deleted) VALUES (1, 9, 0, 1, 1, 'A', 'x', 'P', NOW(), 'N')`)).not.toBe(1644)
      const [rows] = await e.query(`SELECT TRIGGER_NAME n, ACTION_STATEMENT b FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND TRIGGER_NAME IN (?)`, [DBE, [se, vbi]])
      if (process.env.ADV_SHOW === '1') process.stdout.write(`corpos guardados: ${JSON.stringify(rows)}\n`)
      expect((rows as any[]).length).toBe(2)
    })

    it('[CORRIGIDO F2AR4-ADV-02 MEDIUM, prova viva] a conferência do boot (`f2aFreezeTriggersMissing`) lê esses corpos do information_schema REAL e devolve [] — o setes-api subiria dizendo "9 gatilho(s)"', async () => {
      const missing = await f2aFreezeTriggersMissing(realQ, 'setes_advr4_alvo')
      expect(missing).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^${se}`))]))
      // e SÓ os dois neutralizados: os outros 7, como o MariaDB os GUARDA (ACTION_STATEMENT), normalizam igual ao corpo da migration
      expect(missing.map(m => m.split(' ')[0]).sort()).toEqual([se, vbi].sort())
    })
  })
})
