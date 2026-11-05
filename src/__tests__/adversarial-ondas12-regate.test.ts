/// <reference types="jest" />
// RE-PROVA dos gates das Ondas 1+2 (delta 07c2f7c..444c253). Dublê copiado de adversarial-ondas12-gate.test.ts.
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

// =====================================================================================================================================
// RE-PROVA (2026-11-05) — só o DELTA 07c2f7c..444c253. Achado = `it.failing`; ataque que não quebrou = `it` "[RESISTIU]".
// =====================================================================================================================================
import { existsSalesman } from '../shared/session-context/session-context.repository'
import { invalidateSessionContext } from '../shared/session-context/session-context.service'
import { LOGIN_EMAIL_MAX_LENGTH } from '../modules/auth/auth.service'

const salesman = existsSalesman as jest.Mock

/** Instrumento: conta as conexões de TRANSAÇÃO presas (getConnection → release) e registra todo `pool.query`/contexto feito com uma presa. */
function watchHeld(): { held: () => number; violations: string[]; crashWhileHeld: () => number } {
  let held = 0
  const violations: string[] = []
  let crashHeld = 0
  q.mockImplementation((sql: string, params: any[] = []) => {
    if (held > 0) violations.push(`pool.query com transação aberta: ${sql.replace(/\s+/g, ' ').slice(0, 80)}`)
    return run(sql, params, null, [])
  })
  getConn.mockImplementation(async () => {
    if (held > 0) violations.push('2ª getConnection com transação aberta')
    held++
    const c = newConn()
    c.release.mockImplementation(() => { held-- })
    return c
  })
  salesman.mockImplementation(async () => {
    if (held > 0) violations.push('existsSalesman (pool) com transação aberta')
    return false
  })
  ;(recordCrash as jest.Mock).mockImplementation(async () => { if (held > 0) crashHeld++ })
  return { held: () => held, violations, crashWhileHeld: () => crashHeld }
}

beforeEach(() => {
  for (const id of [10, 11, ...Array.from({ length: 40 }, (_, i) => 100 + i)]) { invalidateSessionContext(1, id); invalidateSessionContext(2, id) }
  salesman.mockReset()
  salesman.mockResolvedValue(false)
})

describe('REGATE-01 — nenhum caminho do login pede o pool com a transação aberta (HIGH anterior)', () => {
  it('[RESISTIU] certo (1 vínculo), certo (N vínculos), errado, inativo, sem vínculo, 10ª com aviso, bloqueado → zero pool.* sob a trava', async () => {
    const w = watchHeld()
    expect((await login('c1@x.com', PASS)).status).toBe('ok')
    expect((await login('multi@x.com', PASS)).status).toBe('select')
    await refused(login('c2@x.com', 'errada'))
    await refused(login('inativo@x.com', PASS))
    await refused(login('semvinculo@x.com', PASS))
    await wrongTimes('c3@x.com', LOGIN_MAX_FAILURES)                     // a 10ª toma a vaga do aviso (SAVEPOINT) dentro da transação
    await refused(login('c3@x.com', PASS))                              // bloqueada (pré-filtro)
    expect(notices.length).toBe(1)
    expect(w.violations).toEqual([])
    expect(w.held()).toBe(0)
    expect(salesman).toHaveBeenCalledTimes(1)                           // o contexto FOI lido (só no caminho de 1 vínculo) — depois do COMMIT
  })

  it('[RESISTIU] 1213 dentro da transação → a 1ª conexão volta ANTES de pedir a 2ª; o login entra; nada de pool sob a trava', async () => {
    const w = watchHeld()
    let n = 0
    const conns: any[] = []
    const inner = getConn.getMockImplementation()!
    getConn.mockImplementation(async () => {
      const c = await inner()
      const orig = c.query.getMockImplementation()!
      c.query.mockImplementation((sql: string, params: any[] = []) => {
        if (/COUNT\(\*\) AS n/.test(sql) && n++ === 0) return Promise.reject(deadlockErr())
        return orig(sql, params)
      })
      conns.push(c)
      return c
    })
    const r = await login('c4@x.com', PASS)
    expect(r.status).toBe('ok')
    expect(conns.length).toBe(2)
    expect(w.violations).toEqual([])
  })

  it('[RESISTIU] 1213 esgotado (3×) → recusa neutra; as 3 conexões devolvidas; alarme fora da transação', async () => {
    const w = watchHeld()
    const inner = getConn.getMockImplementation()!
    getConn.mockImplementation(async () => {
      const c = await inner()
      const orig = c.query.getMockImplementation()!
      c.query.mockImplementation((sql: string, params: any[] = []) =>
        (/COUNT\(\*\) AS n/.test(sql) ? Promise.reject(deadlockErr()) : orig(sql, params)))
      return c
    })
    const e = await refused(login('c4@x.com', PASS))
    expect(e.statusCode).toBe(401)
    expect(w.held()).toBe(0)
    expect(w.violations).toEqual([])
    expect(w.crashWhileHeld()).toBe(0)
  })

  it('[RESISTIU] falha do INSERT do aviso (sob SAVEPOINT) → a 10ª falha fica; o alarme sai SEM await (não espera conexão com a trava presa)', async () => {
    const w = watchHeld()
    await wrongTimes('c5@x.com', LOGIN_MAX_FAILURES - 1)
    failNext = { match: /INSERT INTO setes_central\.tb_user_login_block_notice/, err: Object.assign(new Error('denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' }) }
    await refused(login('c5@x.com', 'errada-x'))
    expect(failuresOf(105).length).toBe(LOGIN_MAX_FAILURES)
    expect(w.violations).toEqual([])
    // recordCrash é chamado com a transação aberta, mas por `void` — pede conexão ao pool sem que a transação espere por ela (não trava)
    expect(w.crashWhileHeld()).toBe(1)
  })

  it('[RESISTIU] pool de 20, 20 logins CERTOS simultâneos COM o contexto tomando conexão do pool (como o existsSalesman real) → todos respondem', async () => {
    const p = limitPool(20)
    salesman.mockImplementation(async () => {
      await q('SELECT 1 FROM setes_setes.tb_salesman WHERE 1', [])
      return false
    })
    const all = Promise.all(Array.from({ length: 20 }, (_, i) => login(`c${i + 10}@x.com`, PASS)))
    expect(await settleWithin(all, 2000)).toBe('resolvido')
    expect({ inUse: p.inUse(), waiting: p.waiting() }).toEqual({ inUse: 0, waiting: 0 })
  })

  it('[RESISTIU] pool de 20, 20 contas na 10ª errada com o INSERT do aviso falhando (alarme pede o pool) → todos respondem', async () => {
    for (let i = 0; i < 20; i++) await wrongTimes(`c${i + 10}@x.com`, LOGIN_MAX_FAILURES - 1)
    const p = limitPool(20)
    ;(recordCrash as jest.Mock).mockImplementation(async () => { await q('INSERT INTO setes_central.tb_crashlytics VALUES (1)', []) })
    const insertDenied = () => Object.assign(new Error('denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' })
    const inner = getConn.getMockImplementation()!
    getConn.mockImplementation(async () => {
      const c = await inner()
      const orig = c.query.getMockImplementation()!
      c.query.mockImplementation((sql: string, params: any[] = []) =>
        (/INSERT INTO setes_central\.tb_user_login_block_notice/.test(sql) ? Promise.reject(insertDenied()) : orig(sql, params)))
      return c
    })
    const all = Promise.all(Array.from({ length: 20 }, (_, i) => refused(login(`c${i + 10}@x.com`, 'errada-x'))))
    expect(await settleWithin(all, 2000)).toBe('resolvido')
    await new Promise(r => setTimeout(r, 50))
    expect({ inUse: p.inUse(), waiting: p.waiting() }).toEqual({ inUse: 0, waiting: 0 })
  })
})

describe('REGATE-02 — o contexto lido DEPOIS do COMMIT', () => {
  // ACHADO (LOW, ORÁCULO DE SENHA em dado degenerado + resposta fora da D-EA6): antes do delta a falha do contexto acontecia DENTRO da
  // transação → alarme com ref + a MESMA 401 (D-EA6). Agora acontece depois do COMMIT, fora do try da recusa → sobe crua → 500 "Erro
  // interno" sem ref na crashlytics. Na conta de 1 vínculo cujo schema não lê `tb_salesman` (ER_NO_SUCH_TABLE determinístico), a senha
  // CERTA dá 500 e a errada 401: quem testa senhas aprende a certa (sem ganhar token).
  // D-EA30 (Valdo 2026-11-05, "(a) Entra com padrão"): a admissão já decidida sob a trava fica; contexto ilegível = contexto padrão
  // + alarme com ref. Nunca 500 (o oráculo da senha certa acabou: a certa entra, a errada recebe a 401 de sempre)
  it('[CORRIGIDO D-EA30] ADV-REGATE-02 contexto ilegível (ER_NO_SUCH_TABLE) → senha certa ENTRA com o contexto padrão + alarme com ref', async () => {
    salesman.mockRejectedValue(Object.assign(new Error("Table 'setes_setes.tb_salesman' does not exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 }))
    const certa = await request(app).post('/auth/login').send({ email: 'c6@x.com', password: PASS })
    expect(certa.status).toBe(200)
    expect(certa.body.context).toEqual({ isSalesman: false })
    expect(typeof certa.body.token).toBe('string')
    expect(recordCrash).toHaveBeenCalledTimes(1)
  })

  it('[CORRIGIDO D-EA30] ADV-REGATE-02 a senha errada, com o mesmo contexto ilegível, segue a 401 de sempre (nunca 500)', async () => {
    salesman.mockRejectedValue(Object.assign(new Error("Table 'setes_setes.tb_salesman' does not exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 }))
    const errada = await request(app).post('/auth/login').send({ email: 'c7@x.com', password: 'errada' })
    expect(errada.status).toBe(401)
  })

  it('[RESISTIU] usuário inativado entre o COMMIT e o contexto → o token sai (veredito tomado sob a trava); o contexto é só UX', async () => {
    salesman.mockImplementation(async () => { users.get(108)!.active = 'N'; return false })
    const r = await login('c8@x.com', PASS)
    expect(r.status).toBe('ok')
  })
})

describe('REGATE-03 — teto de 320 caracteres do e-mail digitado', () => {
  it('[RESISTIU] 321 caracteres → 401 neutra, sem tocar o banco, UMA linha de log com "***"', async () => {
    const big = 'a'.repeat(LOGIN_EMAIL_MAX_LENGTH - 6) + '@x.com' + 'x'
    const e = await refused(login(big, PASS))
    expect(e.statusCode).toBe(401)
    expect(e.message).toBe(LOGIN_REFUSED_MESSAGE)
    expect(q).not.toHaveBeenCalled()
    expect(getConn).not.toHaveBeenCalled()
    expect(refusalLogs().map(c => [c[1].email, c[1].reason])).toEqual([['***', 'inexistente']])
  })

  it('[RESISTIU] exatamente 320 → segue para o banco (fronteira); e-mail legítimo com espaço do fim ainda entra', async () => {
    const at320 = 'a'.repeat(LOGIN_EMAIL_MAX_LENGTH - 6) + '@x.com'
    expect(at320.length).toBe(LOGIN_EMAIL_MAX_LENGTH)
    await refused(login(at320, PASS))
    expect(q).toHaveBeenCalled()
    expect((await login('c9@x.com  ', PASS)).status).toBe('ok')
  })

  it('[RESISTIU] conta real + 400 espaços (o banco iguala por PAD SPACE) → recusada sem linha de falha na conta', async () => {
    const e = await refused(login('c11@x.com' + ' '.repeat(400), PASS))
    expect(e.statusCode).toBe(401)
    expect(failuresOf(111)).toEqual([])
  })

  it('[RESISTIU] oráculo: e-mail de 406 caracteres × e-mail inexistente curto → mesmo status e corpo pela rota', async () => {
    const a = await request(app).post('/auth/login').send({ email: 'x'.repeat(400) + '@x.com', password: PASS })
    const b = await request(app).post('/auth/login').send({ email: 'ninguem@x.com', password: PASS })
    expect([a.status, a.body]).toEqual([b.status, b.body])
  })
})

describe('REGATE-04 — log da recusa (D-EA11)', () => {
  it('[RESISTIU] contenção (1205) → exatamente UMA linha de log por recusa', async () => {
    lockError = () => lockWaitErr()
    await refused(login('c12@x.com', PASS))
    const warns = (logger.warn as jest.Mock).mock.calls
    expect(warns.filter(c => /Login recusado/.test(c[0])).length).toBe(1)
    expect(warns.filter(c => /contenção/.test(c[0])).length).toBe(0)
  })

  it('[RESISTIU] perícia: conta achada leva userId; endereço com espaço do fim segue mascarado; lista vira "***"', async () => {
    await refused(login('Valdo@Setes.com.br ', 'errada'))
    await refused(login('joao@x.com, maria@x.com', 'errada'))
    expect(refusalLogs().map(c => [c[1].email, c[1].userId])).toEqual([['V***@Setes.com.br', 10], ['***', undefined]])
  })
})
