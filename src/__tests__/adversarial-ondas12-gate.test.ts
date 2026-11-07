/// <reference types="jest" />
// GATE ADVERSARIAL — Ondas 1+2 do endurecer (ver o cabeçalho dos ataques abaixo). Dublê copiado de auth-login-lock-d-ea1.test.ts.
import fs from 'fs'
import path from 'path'
import request from 'supertest'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/mailer/mailer', () => ({
  __esModule: true, ...jest.requireActual('../shared/mailer/mailer'),   // maskEmail / mailErrorForLog reais (D-EA21)
  sendMail: jest.fn().mockResolvedValue(undefined), isMailerConfigured: jest.fn(() => true),
  isProduction: jest.fn(() => false),
}))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFLOGIN'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../shared/session-context/session-context.repository', () => ({
  __esModule: true, existsSalesman: jest.fn().mockResolvedValue(false),
}))

import pool from '../shared/db/connection'
import logger from '../shared/logger/logger'
import { sendMail } from '../shared/mailer/mailer'
import { recordCrash } from '../shared/errors/crash.repository'
import { setLockWaitSupported } from '../shared/db/counters'
import * as passwordPiece from '../shared/auth/password'
import app from '../app'
import {
  login, setLoginRefusalFloor, LOGIN_REFUSAL_FLOOR_MS, LOGIN_REFUSED_MESSAGE, LOGIN_BLOCK_NOTICE_SUBJECT, waitForPendingPasswordResets,
  assertLoginLockReady, switchInstitution, selectInstitution,
} from '../modules/auth/auth.service'
import {
  LOGIN_MAX_FAILURES, LOGIN_FAILURE_WINDOW_MINUTES, updatePassword,
} from '../modules/auth/auth.repository'
import {
  resetLoginWatch, setLoginWatchClock, LOGIN_ALARM_FAILURES_PER_MINUTE, waitForPendingLoginAlarms,
} from '../modules/auth/login-watch'

const q = (pool as any).query as jest.Mock
const getConn = (pool as any).getConnection as jest.Mock
const mail = sendMail as jest.Mock
const md5 = passwordPiece.md5Password

// ---- o mundo do dublê ---------------------------------------------------------------------------------------------------
interface User { id: number; password: string | null; active: string; deleted: string; email: string }
interface Row { userId: number; seq: number; createdAt: number }
interface Link { institutionId: number; schemaName: string; name: string; profile: string | null }

let now: number
let users: Map<number, User>
let links: Map<number, Link[]>
let failures: Row[]
let notices: Row[]
let failNext: { match: RegExp; err: any } | null
/** contagens da janela feitas FORA de transação (o pré-filtro) × DENTRO (sob a trava) */
let countsOutside: number
let countsInside: number
let lockCalls: number
/** gancho que roda ANTES de a trava ser concedida (corridas: falhas chegam / senha troca entre a conferência e a trava) */
let beforeLock: ((userId: number) => void) | null
/** linha presa por outra transação além do WAIT: o FOR UPDATE estoura com 1205 (ou o erro dado) */
let lockError: (() => any) | null
const locks = new Map<number, { owner: object; waiters: Array<() => void> }>()

const DAY = '2026-11-05T12:00:00Z'
const PASS = 'certa-123'
const setesLink: Link = { institutionId: 1, schemaName: 'setes_setes', name: 'SETES', profile: 'admin' }
const alphaLink: Link = { institutionId: 2, schemaName: 'setes_alpha', name: 'Alpha', profile: 'user' }

function seed(): void {
  users = new Map()
  links = new Map()
  const add = (id: number, email: string, extra: Partial<User> = {}, l: Link[] = [setesLink]) => {
    users.set(id, { id, password: md5(PASS), active: 'S', deleted: 'N', email, ...extra })
    links.set(id, l)
  }
  add(10, 'Valdo@Setes.com.br')                                         // e-mail GRAVADO com caixa diferente do digitado
  add(11, 'multi@x.com', {}, [setesLink, alphaLink])
  add(12, 'inativo@x.com', { active: 'N' })
  add(13, 'semvinculo@x.com', {}, [])
  add(14, 'semsenha@x.com', { password: null })
  add(15, 'vazia@x.com', { password: '' })
  add(16, 'super@setes.com.br', {}, [{ ...setesLink, profile: 'super' }])
  for (let i = 0; i < 40; i++) add(100 + i, `c${i}@x.com`)
}
const dbEq = (a: string, b: string) => a.toLowerCase().replace(/ +$/, '') === b.toLowerCase().replace(/ +$/, '')
const inWindow = (r: Row) => r.createdAt > now - LOGIN_FAILURE_WINDOW_MINUTES * 60_000

async function acquire(userId: number, owner: object): Promise<void> {
  for (;;) {
    const l = locks.get(userId)
    if (!l) { locks.set(userId, { owner, waiters: [] }); return }
    if (l.owner === owner) return
    await new Promise<void>(r => l.waiters.push(r))
  }
}
function releaseAll(owner: object): void {
  for (const [userId, l] of [...locks.entries()]) {
    if (l.owner !== owner) continue
    locks.delete(userId)
    l.waiters.splice(0).forEach(w => w())
  }
}

type Undo = Array<(() => void) | { savepoint: string }>
async function run(sql: string, params: any[], owner: object | null, undo: Undo): Promise<any> {
  if (failNext && failNext.match.test(sql)) {
    const { err } = failNext
    failNext = null
    throw err
  }
  const sp = /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) (\w+)/.exec(sql)
  if (sp) {
    if (sp[1] === 'SAVEPOINT') undo.push({ savepoint: sp[2] })
    if (sp[1] === 'ROLLBACK TO SAVEPOINT') {
      for (;;) {
        const u = undo.pop()
        if (!u) break
        if (typeof u === 'function') u()
        else if (u.savepoint === sp[2]) { undo.push(u); break }
      }
    }
    return [[]]
  }
  if (/LIMIT 0/.test(sql)) return [[]]
  if (/FROM setes_central\.tb_user u\s/.test(sql) && /tb_mailing_group_id = 2/.test(sql)) {
    const u = [...users.values()].filter(x => x.deleted === 'N' && dbEq(x.email, String(params[0]))).sort((a, b) => a.id - b.id)[0]
    return [u ? [{ id: u.id, password: u.password, active: u.active, loginEmail: u.email }] : []]
  }
  if (/FROM setes_central\.vw_user_link l/.test(sql)) return [links.get(Number(params[0])) ?? []]
  if (/SELECT id, active, password FROM setes_central\.tb_user WHERE id = \? AND deleted = 'N' FOR UPDATE/.test(sql)) {
    if (!owner) throw new Error('FOR UPDATE fora de transação')
    lockCalls++
    const userId = Number(params[0])
    if (beforeLock) { const h = beforeLock; beforeLock = null; h(userId) }
    const injected = lockError?.()
    if (injected) throw injected
    const u = users.get(userId)
    if (!u || u.deleted !== 'N') return [[]]
    await acquire(u.id, owner)
    return [[{ id: u.id, active: u.active, password: u.password }]]
  }
  if (/SELECT COUNT\(\*\) AS n FROM setes_central\.tb_user_login_failure/.test(sql)) {
    if (owner) countsInside++
    else countsOutside++
    expect(sql).toMatch(new RegExp(`INTERVAL ${LOGIN_FAILURE_WINDOW_MINUTES} MINUTE`))
    return [[{ n: failures.filter(r => r.userId === Number(params[0]) && inWindow(r)).length }]]
  }
  for (const [table, list] of [['tb_user_login_failure', () => failures], ['tb_user_login_block_notice', () => notices]] as const) {
    if (!new RegExp(`setes_central\\.${table}\\b`).test(sql)) continue
    if (/AS recent/.test(sql)) {
      if (!owner) throw new Error('coalescência do aviso lida fora da trava')
      const [userId, minutes] = params
      return [[{ recent: list().some(r => r.userId === Number(userId) && r.createdAt > now - Number(minutes) * 60_000) ? 1 : 0 }]]
    }
    if (/AS nextSeq/.test(sql)) {
      const seqs = list().filter(r => r.userId === Number(params[0])).map(r => r.seq)
      return [[{ nextSeq: (seqs.length ? Math.max(...seqs) : 0) + 1 }]]
    }
    if (/^\s*INSERT INTO/.test(sql)) {
      if (!owner) throw new Error(`INSERT em ${table} fora de transação`)
      const row: Row = { userId: Number(params[0]), seq: Number(params[1]), createdAt: now }
      if (list().some(r => r.userId === row.userId && r.seq === row.seq)) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' })
      list().push(row)
      undo.push(() => { const arr = list(); arr.splice(arr.indexOf(row), 1) })
      return [{ affectedRows: 1 }]
    }
  }
  // D-EA9 (Onda 4): a REGRAVAÇÃO do hash no login certo — compare-and-set, SEM o instante T (exceção nomeada da cerca D-EA7)
  if (/UPDATE setes_central\.tb_user SET password = \? WHERE id = \? AND BINARY password = \?/.test(sql)) {
    const [hash, userId, from] = params
    const u = users.get(Number(userId))
    if (!u || u.password !== from) return [{ affectedRows: 0 }]
    const before = u.password
    u.password = hash
    undo.push(() => { u.password = before })
    return [{ affectedRows: 1 }]
  }
  if (/UPDATE setes_central\.tb_user SET password = \?/.test(sql)) {
    const [hash, , userId] = params
    const u = users.get(Number(userId))!
    const before = u.password
    u.password = hash
    undo.push(() => { u.password = before })
    return [{ affectedRows: 1 }]
  }
  return [[]]
}

function newConn() {
  const owner = {}
  let undo: Undo = []
  return {
    beginTransaction: jest.fn(async () => { undo = [] }),
    commit:   jest.fn(async () => { undo = []; releaseAll(owner) }),
    rollback: jest.fn(async () => {
      undo.reverse().forEach(f => { if (typeof f === 'function') f() })
      undo = []
      releaseAll(owner)
    }),
    release:  jest.fn(),
    query:    jest.fn((sql: string, params: any[] = []) => run(sql, params, owner, undo)),
  }
}

const failuresOf = (userId: number) => failures.filter(r => r.userId === userId)
const lockWaitErr = () => Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 })
const deadlockErr = () => Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 })
const blockNoticeMails = () => mail.mock.calls.filter(c => c[0].subject === LOGIN_BLOCK_NOTICE_SUBJECT)
const refusalLogs = () => (logger.warn as jest.Mock).mock.calls.filter(c => c[0] === 'Login recusado (D-EA11)')
async function refused(p: Promise<unknown>): Promise<any> {
  try { await p } catch (e) { return e }
  throw new Error('o login devia ter sido recusado')
}
async function wrongTimes(email: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await refused(login(email, `errada-${i}`))
}

beforeAll(() => { setLoginRefusalFloor(0); setLockWaitSupported(true) })   // o piso é provado no próprio teste (L4)
afterAll(() => setLoginRefusalFloor(LOGIN_REFUSAL_FLOOR_MS))

beforeEach(() => {
  jest.clearAllMocks()
  now = Date.parse(DAY)
  seed()
  failures = []
  notices = []
  failNext = null
  countsOutside = 0
  countsInside = 0
  lockCalls = 0
  beforeLock = null
  lockError = null
  locks.clear()
  resetLoginWatch()
  mail.mockResolvedValue(undefined)
  q.mockImplementation((sql: string, params: any[] = []) => run(sql, params, null, []))
  getConn.mockImplementation(async () => newConn())
})
afterEach(async () => { await waitForPendingPasswordResets(); await waitForPendingLoginAlarms() })

// =====================================================================================================================================
// GATE ADVERSARIAL das Ondas 1+2 do endurecer (branch `ondas12`, 1270ba0..07c2f7c; sql/74) — skill `testar-adversarial.md`.
// O mundo do dublê ACIMA é cópia do `auth-login-lock-d-ea1.test.ts` (o mesmo banco pelo texto do SQL). Abaixo: os ataques.
// Achado confirmado = `it.failing` (passa enquanto o defeito existir); ataque que não quebrou = `it` "[RESISTIU]".
// =====================================================================================================================================

/** Pool com TETO de conexões, na semântica do mysql2: `pool.query` também toma uma conexão; quem não acha vaga espera na FILA, sem prazo. */
function limitPool(limit: number): { inUse: () => number; waiting: () => number } {
  let free = limit
  const queue: Array<() => void> = []
  const take = () => (free > 0 ? (free--, Promise.resolve()) : new Promise<void>(r => queue.push(r)))
  const give = () => { const w = queue.shift(); if (w) w(); else free++ }
  q.mockImplementation(async (sql: string, params: any[] = []) => {
    await take()
    try { return await run(sql, params, null, []) } finally { give() }
  })
  getConn.mockImplementation(async () => {
    await take()
    const c = newConn()
    c.release.mockImplementation(() => give())
    return c
  })
  return { inUse: () => limit - free, waiting: () => queue.length }
}
const settleWithin = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p.then(() => 'resolvido', () => 'resolvido'), new Promise(r => setTimeout(() => r('PENDURADO'), ms))])

describe('ADV-O12-01 — o caminho CERTO toma uma 2ª conexão do pool com a 1ª (e a trava) presa', () => {
  // ACHADO (HIGH, DISPONIBILIDADE): `loginOrRefuse` abre a transação numa conexão do pool e, AINDA DENTRO dela, chama
  // `getInstitutionsForUser` e `signFinalToken → getSessionContext` — os dois por `pool.query`, que precisa de OUTRA conexão. O pool tem
  // `connectionLimit: 20` e o mysql2 espera na fila SEM prazo. 20 logins CERTOS simultâneos de contas distintas (a manhã de um cliente
  // grande; ou quem tem 20 credenciais) prendem as 20 conexões e cada um espera a 21ª: o setes-api INTEIRO para (toda rota que lê o
  // banco entra na mesma fila) até reiniciar. Antes da onda o login não segurava conexão. A trava WAIT 5 não ajuda (a espera é no POOL).
  // Correção esperada: ler vínculos/contexto pela MESMA `conn` da transação (ou fora dela), nunca `pool.*` dentro de transação aberta.
  // CORRIGIDO (2026-11-05): sob a trava os vínculos vêm pela `conn` da transação e o `context` é lido depois do COMMIT
  it('[CORRIGIDO] ADV-O12-01 20 logins CERTOS simultâneos de contas distintas com pool de 20 → TODOS respondem', async () => {
    const p = limitPool(20)
    const all = Promise.all(Array.from({ length: 20 }, (_, i) => login(`c${i}@x.com`, PASS)))
    const outcome = await settleWithin(all, 1500)
    const snapshot = { inUse: p.inUse(), waiting: p.waiting() }
    // libera o mundo para o afterEach: as conexões presas nunca devolvem — ninguém mais usa este pool
    expect({ outcome, snapshot }).toEqual({ outcome: 'resolvido', snapshot: { inUse: 0, waiting: 0 } })
  })

  it('[RESISTIU] controle: 20 logins ERRADOS simultâneos (sem 2ª conexão) com pool de 20 → todos respondem 401', async () => {
    limitPool(20)
    const all = Promise.all(Array.from({ length: 20 }, (_, i) => refused(login(`c${i}@x.com`, 'errada'))))
    expect(await settleWithin(all, 3000)).toBe('resolvido')
    for (let i = 0; i < 20; i++) expect(failuresOf(100 + i).length).toBe(1)
  })

  // Evidência AO VIVO da premissa (biblioteca real, MariaDB do dev, só `SELECT 1` — nenhum schema tocado): o mysql2 não tem prazo de
  // aquisição — com a única conexão presa, um `pool.query` fica na fila para sempre.
  const hasEnv = fs.existsSync(path.join(__dirname, '..', '..', '.env'))
  // SEMÂNTICA da biblioteca (conhecimento negativo, fica como está): o mysql2 espera conexão SEM prazo — por isso a regra "nunca pool.*
  // dentro de transação aberta" (o login foi corrigido; este teste fixa o porquê e acusa se o pool um dia ganhar prazo de aquisição)
  ;(hasEnv ? it : it.skip)('[SEMÂNTICA] ADV-O12-01 ao vivo: pool real (limite 1) com a conexão presa → pool.query fica na fila (sem prazo)', async () => {
    const mysql = jest.requireActual('mysql2/promise') as typeof import('mysql2/promise')
    const dotenv = jest.requireActual('dotenv') as typeof import('dotenv')
    const env = dotenv.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.env')))
    const real = mysql.createPool({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD,
      connectionLimit: 1, waitForConnections: true })
    const held = await real.getConnection()
    await held.beginTransaction()
    const nested = real.query('SELECT 1')
    const outcome = await settleWithin(nested, 3000)
    await held.rollback(); held.release()
    await nested.catch(() => undefined)
    await real.end()
    expect(outcome).not.toBe('resolvido')
  }, 15000)
})

describe('ADV-O12-02 — contornar o bloqueio pela forma do e-mail', () => {
  it('[RESISTIU] variantes que o banco iguala (caixa, espaço do fim) somam na MESMA conta — a senha certa segue recusada', async () => {
    const variants = ['valdo@setes.com.br', 'VALDO@SETES.COM.BR', 'Valdo@Setes.com.br ', 'vAlDo@setes.com.br   ']
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await refused(login(variants[i % variants.length], `errada-${i}`))
    expect(failuresOf(10).length).toBe(LOGIN_MAX_FAILURES)
    for (const v of variants) {
      const e = await refused(login(v, PASS))
      expect([e.statusCode, e.message]).toEqual([401, LOGIN_REFUSED_MESSAGE])
    }
    expect(failuresOf(10).length).toBe(LOGIN_MAX_FAILURES)        // nada gravado no bloqueio
  })

  it('[RESISTIU] corrida: 40 erradas paralelas na mesma conta → exatamente 10 linhas (seq 1..10) e UM aviso', async () => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => refused(login('valdo@setes.com.br', `x${i}`))))
    expect(failuresOf(10).map(r => r.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(notices.filter(r => r.userId === 10).length).toBe(1)
    await waitForPendingPasswordResets()
    expect(blockNoticeMails().length).toBe(1)
  })

  it('[RESISTIU] corrida: 9 falhas + 5 certas e 5 erradas paralelas → a certa ou entra antes da 10ª ou é recusada; nunca passa de 10', async () => {
    for (let i = 0; i < 9; i++) await refused(login('valdo@setes.com.br', `e${i}`))
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      login('valdo@setes.com.br', i % 2 ? PASS : `z${i}`).then(r => r.status, (e: any) => e.statusCode)))
    expect(failuresOf(10).length).toBeLessThanOrEqual(LOGIN_MAX_FAILURES)
    expect(res.every(s => s === 'ok' || s === 401)).toBe(true)
  })
})

describe('ADV-O12-03 — o log da recusa (D-EA11)', () => {
  // ACHADO (LOW, DATA_EXPOSURE): `maskEmail` só mascara o ENDEREÇO dentro do texto; o resto do que foi digitado no campo e-mail vai cru ao
  // log. Quem cola "e-mail + senha" no campo (ou o gerenciador de senhas que preenche errado) deixa a senha no log, contra a letra da
  // D-EA11 ("nunca a senha"). Texto SEM endereço vira '***' — o vazamento é só quando há um endereço junto.
  // CORRIGIDO (2026-11-05): só um endereço ÚNICO (a regra da peça) vai mascarado ao log; outro texto vai como '***'
  it('[CORRIGIDO] ADV-O12-03 campo e-mail "joao@x.com MinhaSenha#2026" → o log não leva "MinhaSenha#2026"', async () => {
    await refused(login('joao@x.com MinhaSenha#2026', 'qualquer'))
    expect(JSON.stringify(refusalLogs())).not.toContain('MinhaSenha#2026')
  })

  it('[RESISTIU] campo e-mail só com a senha (sem @) → "***" no log; a senha do campo password nunca aparece', async () => {
    await refused(login('MinhaSenha#2026', 'OutraSenha!9'))
    await refused(login('valdo@setes.com.br', 'OutraSenha!9'))
    const all = JSON.stringify([(logger.warn as jest.Mock).mock.calls, (logger.info as jest.Mock).mock.calls, (logger.error as jest.Mock).mock.calls])
    expect(all).not.toContain('MinhaSenha#2026')
    expect(all).not.toContain('OutraSenha!9')
    expect(all).not.toContain('valdo@setes.com.br')
  })
})

describe('ADV-O12-04 — corpo malformado e oráculo na rota', () => {
  it.each([
    [{ email: 'valdo@setes.com.br', password: 0 }],
    [{ email: 'valdo@setes.com.br', password: false }],
    [{ email: ['valdo@setes.com.br'], password: PASS }],
    [{ email: { toString: 1 }, password: PASS }],
    [{ email: 'valdo@setes.com.br', password: ['x'] }],
  ])('[RESISTIU] %j → 400, sem tocar o banco nem gravar falha', async body => {
    const r = await request(app).post('/auth/login').send(body)
    expect(r.status).toBe(400)
    expect(q).not.toHaveBeenCalled()
    expect(failures).toEqual([])
  })

  it('[RESISTIU] JSON inválido → 400 INVALID_JSON (nada de 500 nem de motivo da conta)', async () => {
    const r = await request(app).post('/auth/login').set('Content-Type', 'application/json').send('{"email":"a@x.com",')
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('INVALID_JSON')
  })

  it('[RESISTIU] contenção (1205) no caminho certo e no errado = a mesma resposta da senha errada pela rota', async () => {
    const post = (email: string, password: string) => request(app).post('/auth/login').send({ email, password })
    const base = await post('c1@x.com', 'errada')
    lockError = () => lockWaitErr()
    const certa = await post('c2@x.com', PASS)
    lockError = () => lockWaitErr()
    const errada = await post('c3@x.com', 'errada')
    for (const r of [certa, errada]) expect([r.status, r.body]).toEqual([base.status, base.body])
    expect(failuresOf(102).length + failuresOf(103).length).toBe(0)
  })
})

describe('ADV-O12-05 — OPS_ALERT_EMAIL (D-EA4/D-EA26)', () => {
  const real = jest.requireActual('../shared/mailer/mailer') as typeof import('../shared/mailer/mailer')
  const saved = { env: process.env.NODE_ENV, ops: process.env.OPS_ALERT_EMAIL }
  afterEach(() => {
    process.env.NODE_ENV = saved.env
    if (saved.ops === undefined) delete process.env.OPS_ALERT_EMAIL
    else process.env.OPS_ALERT_EMAIL = saved.ops
  })
  it.each([
    [''], ['   '], ['ops@x.com, outro@y.com'], ['Ops <ops@x.com>'], ['ops@x.com\r\nBcc: evil@y.com'], [' ops@x.com'], ['ops'],
  ])('[RESISTIU] produção com OPS_ALERT_EMAIL=%j → o boot recusa e o valor cru não aparece na mensagem', raw => {
    process.env.NODE_ENV = 'production'
    process.env.OPS_ALERT_EMAIL = raw
    let msg = ''
    try { real.assertOpsAlertReady() } catch (e: any) { msg = e.message }
    expect(msg).toMatch(/obrigatório em produção/)
    if (/@/.test(raw)) expect(msg).not.toContain('ops@x.com')
    expect(real.opsAlertPreflight().blocking).toBe(true)
  })
  it('[RESISTIU] produção com "ops@x.com " (espaço do fim — D-EA27) → sobe e manda a "ops@x.com"', () => {
    process.env.NODE_ENV = 'production'
    process.env.OPS_ALERT_EMAIL = 'ops@x.com '
    expect(real.assertOpsAlertReady()).toMatch(/o\*\*\*@x\.com/)
    expect(real.opsAlertEmail()).toBe('ops@x.com')
  })
})

describe('ADV-O12-06 — o alarme (D-EA4): memória, inundação, relógio', () => {
  it('[RESISTIU] 50 mil recusas de e-mails distintos de 2 KB em 1 min → estrutura com teto, UM e-mail à operação, nunca com o endereço', async () => {
    const watch = jest.requireActual('../modules/auth/login-watch') as typeof import('../modules/auth/login-watch')
    process.env.OPS_ALERT_EMAIL = 'ops@x.com'
    let t = Date.parse(DAY)
    watch.setLoginWatchClock(() => t)
    const big = 'a'.repeat(2048)
    for (let i = 0; i < 50_000; i++) { t += 1; watch.recordLoginRefusal(`${big}${i}@x.com`) }
    expect(watch.loginWatchSize().failures).toBeLessThanOrEqual(LOGIN_ALARM_FAILURES_PER_MINUTE + 1)
    expect(watch.loginWatchSize().accounts).toBeLessThanOrEqual(31)
    await waitForPendingLoginAlarms()
    const opsMails = mail.mock.calls.filter(c => /ALARME LOGIN/.test(c[0].subject))
    expect(opsMails.length).toBe(1)
    expect(JSON.stringify(opsMails)).not.toContain(big.slice(0, 64))
    delete process.env.OPS_ALERT_EMAIL
  })

  it('[RESISTIU] relógio que VOLTA (NTP) depois do alarme → não lança e o login segue', async () => {
    const watch = jest.requireActual('../modules/auth/login-watch') as typeof import('../modules/auth/login-watch')
    let t = Date.parse(DAY)
    watch.setLoginWatchClock(() => t)
    for (let i = 0; i < 200; i++) watch.recordLoginRefusal(`u${i}@x.com`)
    t -= 3_600_000
    expect(() => { for (let i = 0; i < 200; i++) watch.recordLoginRefusal(`v${i}@x.com`) }).not.toThrow()
    watch.resetLoginWatch()
    const ok = await login('valdo@setes.com.br', PASS)
    expect(ok.status).toBe('ok')
  })
})

// ---- script 74 re-executado AO VIVO em schema DESCARTÁVEL (setes_central só LIDA: CHECKSUM antes/depois; DROP no fim) ----------------
const hasEnv74 = fs.existsSync(path.join(__dirname, '..', '..', '.env'))
;(hasEnv74 ? describe : describe.skip)('ADV-O12-07 — sql/74 sobre banco que JÁ o passou (ao vivo, descartável)', () => {
  const mysql = jest.requireActual('mysql2/promise') as typeof import('mysql2/promise')
  const dotenv = jest.requireActual('dotenv') as typeof import('dotenv')
  const { splitStatements } = jest.requireActual('../migrations/runner') as typeof import('../migrations/runner')
  const env = dotenv.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.env')))
  const PROBE = `setes_o12adv_probe_${Date.now().toString(36)}`
  const sql74 = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sql', '74_user_login_failure_ddl.sql'), 'utf8')
    .replace(/USE `setes_central`;/, `USE \`${PROBE}\`;`)
  let admin: import('mysql2/promise').Connection
  let before = ''
  const fingerprint = async () => JSON.stringify((await admin.query<any[]>('CHECKSUM TABLE setes_central.tb_user'))[0])

  beforeAll(async () => {
    admin = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD,
      multipleStatements: false })
    before = await fingerprint()
    await admin.query(`CREATE DATABASE \`${PROBE}\``)
    await admin.query(`CREATE TABLE \`${PROBE}\`.tb_user LIKE setes_central.tb_user`)
  }, 30000)
  afterAll(async () => {
    try { await admin.query(`DROP DATABASE IF EXISTS \`${PROBE}\``) } finally { await admin.end() }
  }, 30000)

  it('[RESISTIU] aplica 3× sem erro; uma tabela sem o índice da janela é CONSERTADA; dados e índice únicos; CHECK recusa seq 0', async () => {
    const apply = async () => { for (const s of splitStatements(sql74)) await admin.query(s) }
    await apply()
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_user (id) VALUES (1)`).catch(async () => {
      // tb_user com colunas NOT NULL sem default: cria a linha com o mínimo aceito
      const [cols] = await admin.query<any[]>(`SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_user' AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL AND EXTRA NOT LIKE '%auto%'`, [PROBE])
      const names = cols.map(c => `\`${c.COLUMN_NAME}\``).join(', ')
      const vals = cols.map(c => (c.COLUMN_NAME === 'id' ? 1 : /int|dec|float|double/.test(c.DATA_TYPE) ? 0 : /date|time/.test(c.DATA_TYPE) ? 'NOW()' : "''"))
      await admin.query(`INSERT INTO \`${PROBE}\`.tb_user (${names}) VALUES (${vals.map(v => (v === 'NOW()' ? v : `'${v}'`)).join(', ')})`)
    })
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_user_login_failure (tb_user_id, seq, created_at) VALUES (1, 1, NOW())`)
    await admin.query(`ALTER TABLE \`${PROBE}\`.tb_user_login_failure DROP INDEX idx_user_login_failure_window`)
    await apply()
    await apply()
    const [idx] = await admin.query<any[]>(`SELECT COUNT(DISTINCT INDEX_NAME) AS n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_user_login_failure' AND INDEX_NAME = 'idx_user_login_failure_window'`, [PROBE])
    expect(Number(idx[0].n)).toBe(1)
    const [rows] = await admin.query<any[]>(`SELECT COUNT(*) AS n FROM \`${PROBE}\`.tb_user_login_failure`)
    expect(Number(rows[0].n)).toBe(1)
    await expect(admin.query(`INSERT INTO \`${PROBE}\`.tb_user_login_failure (tb_user_id, seq, created_at) VALUES (1, 0, NOW())`))
      .rejects.toMatchObject({ errno: expect.any(Number) })
    await expect(admin.query(`INSERT INTO \`${PROBE}\`.tb_user_login_block_notice (tb_user_id, seq, created_at) VALUES (999, 1, NOW())`))
      .rejects.toMatchObject({ errno: expect.any(Number) })
    expect(await fingerprint()).toBe(before)                            // setes_central intacta
  }, 60000)
})
