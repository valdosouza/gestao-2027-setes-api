/// <reference types="jest" />
// Ondas 1+2 do endurecer — o LOGIN com limite POR CONTA (D-EA1/D-EA2), mensagem única (D-EA6), aviso ao dono (D-EA3/D-EA14/D-EA15), rastro
// forense no log (D-EA11) e o protocolo do parecer do guardião (§P.3 — A-EA2). Plano de testes: `Infra-IA/prompts/
// prompt_endurecer_autenticacao.md` §P.5 "Item 1 — Ondas 1+2", L1–L13 (o código no título de cada teste).
// Banco DUBLADO pelo texto do SQL (molde `auth-password-reset-q-pv38.test.ts`): relógio do banco controlável, a trava de REGISTRO da
// linha do usuário emulada (FOR UPDATE espera o dono até o COMMIT/ROLLBACK), SAVEPOINT com desfazer de verdade. As corridas reais (50
// erradas em paralelo = 10 linhas; contas em paralelo sem deadlock; a trava S das FKs — L13) são provadas em schema DESCARTÁVEL por
// `scripts/prove-login-lock.ts`.
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

describe('L1 — senha errada grava UMA falha; inexistente e sem credencial não abrem transação', () => {
  it('L1 senha errada → 401 "Email ou senha inválidos" + 1 linha de falha', async () => {
    const e = await refused(login('valdo@setes.com.br', 'errada'))
    expect([e.statusCode, e.message]).toEqual([401, LOGIN_REFUSED_MESSAGE])
    expect(failuresOf(10)).toEqual([{ userId: 10, seq: 1, createdAt: now }])
  })

  it('L1 e-mail inexistente e conta SEM credencial (NULL e "") → a MESMA 401, nenhuma transação, nenhuma linha (A-EA3)', async () => {
    for (const email of ['nao@existe.com', 'semsenha@x.com', 'vazia@x.com']) {
      const e = await refused(login(email, 'qualquer'))
      expect([email, e.statusCode, e.message]).toEqual([email, 401, LOGIN_REFUSED_MESSAGE])
    }
    expect(getConn).not.toHaveBeenCalled()
    expect(failures).toEqual([])
  })
})

describe('L2 — D-EA6: inativo e sem vínculo = a mesma 401; a senha certa não grava, a errada grava (A-EA1)', () => {
  it('L2 senha CERTA em conta inativa e sem vínculo vivo → a MESMA 401 (o 403 morreu), SEM linha de falha', async () => {
    for (const email of ['inativo@x.com', 'semvinculo@x.com']) {
      const e = await refused(login(email, PASS))
      expect([email, e.statusCode, e.message]).toEqual([email, 401, LOGIN_REFUSED_MESSAGE])
    }
    expect(failures).toEqual([])
  })

  it('L2 senha ERRADA em conta inativa ou sem vínculo → linha de falha (palpite julgado contra a credencial)', async () => {
    await refused(login('inativo@x.com', 'errada'))
    await refused(login('semvinculo@x.com', 'errada'))
    expect([failuresOf(12).length, failuresOf(13).length]).toEqual([1, 1])
  })
})

describe('L3 — corpo, status e cabeçalhos IGUAIS nos 6 caminhos de recusa (rota inteira)', () => {
  it('L3 errada · inexistente · sem credencial · inativo · sem vínculo · bloqueado → resposta idêntica', async () => {
    await wrongTimes('c0@x.com', LOGIN_MAX_FAILURES)                   // c0 bloqueada
    const post = (email: string, password: string) => request(app).post('/auth/login').send({ email, password })
    const replies = [
      await post('c1@x.com', 'errada'), await post('nao@existe.com', PASS), await post('semsenha@x.com', PASS),
      await post('inativo@x.com', PASS), await post('semvinculo@x.com', PASS), await post('c0@x.com', PASS),
    ]
    const shape = (r: request.Response) => {
      const h = { ...r.headers }
      delete h.date                                                    // o relógio
      for (const k of Object.keys(h)) if (/^ratelimit/i.test(k)) delete h[k]   // o limite POR IP do gateway (igual para todos)
      return { status: r.status, body: r.body, text: r.text, headers: h }
    }
    const first = shape(replies[0])
    expect(first.status).toBe(401)
    expect(first.body).toEqual({ error: 'Email ou senha inválidos' })
    for (const r of replies) expect(shape(r)).toEqual(first)
  })
})

describe('L4 — piso de tempo nas recusas (A-EA4)', () => {
  afterEach(() => setLoginRefusalFloor(0))

  it('L4 todo 401 responde ≥ piso (o bloqueado pelo pré-filtro também); o 200 sai sem esperar o piso', async () => {
    await wrongTimes('c2@x.com', LOGIN_MAX_FAILURES)
    const FLOOR = 250
    setLoginRefusalFloor(FLOOR)
    const time = async (p: Promise<unknown>) => { const t = Date.now(); await p.catch(() => undefined); return Date.now() - t }
    const refusals = [
      await time(login('c3@x.com', 'errada')), await time(login('nao@existe.com', PASS)), await time(login('semsenha@x.com', PASS)),
      await time(login('inativo@x.com', PASS)), await time(login('semvinculo@x.com', PASS)), await time(login('c2@x.com', PASS)),
    ]
    for (const ms of refusals) expect(ms).toBeGreaterThanOrEqual(FLOOR - 5)   // setTimeout pode adiantar ~1 ms
    expect(await time(login('c4@x.com', PASS))).toBeLessThan(FLOOR)
  })
})

describe('L4b — pré-filtro SEM trava e decisão refeita sob a trava', () => {
  it('L4b conta bloqueada: NÃO confere a senha (zero chamadas à peça) e NÃO toma a trava (nenhuma conexão)', async () => {
    await wrongTimes('c5@x.com', LOGIN_MAX_FAILURES)
    const spy = jest.spyOn(passwordPiece, 'checkPassword')
    getConn.mockClear()
    try {
      const e = await refused(login('c5@x.com', PASS))
      expect(e.statusCode).toBe(401)
      expect(spy).not.toHaveBeenCalled()
      expect(getConn).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })

  it('L4b pré-filtro diz "livre", 10 falhas chegam antes da trava → a tentativa é recusada SEM gravar (mesmo com a senha certa)', async () => {
    beforeLock = userId => { for (let i = 1; i <= LOGIN_MAX_FAILURES; i++) failures.push({ userId, seq: i, createdAt: now }) }
    const e = await refused(login('c6@x.com', PASS))
    expect(e.statusCode).toBe(401)
    expect(failuresOf(106)).toHaveLength(LOGIN_MAX_FAILURES)           // nada a mais
    expect([countsOutside, countsInside]).toEqual([1, 1])
  })
})

describe('L4c — o caminho CERTO também passa pela trava; hash trocado no meio é reconferido', () => {
  it('L4c linha presa além do WAIT (1205): a senha CERTA recebe a MESMA 401 (sem token) e a errada não grava', async () => {
    lockError = lockWaitErr
    const right = await refused(login('c7@x.com', PASS))
    const wrong = await refused(login('c7@x.com', 'errada'))
    expect([right.statusCode, right.message, wrong.statusCode, wrong.message]).toEqual([401, LOGIN_REFUSED_MESSAGE, 401, LOGIN_REFUSED_MESSAGE])
    expect(failuresOf(107)).toEqual([])
  })

  it('L4c hash trocado entre a conferência e a trava → reconfere contra o TRAVADO (a senha velha vira falha; a nova entra)', async () => {
    beforeLock = userId => { users.get(userId)!.password = md5('nova-senha-1') }
    const old = await refused(login('c8@x.com', PASS))                 // conferida certa contra o hash LIDO, errada contra o travado
    expect(old.statusCode).toBe(401)
    expect(failuresOf(108)).toHaveLength(1)
    users.get(109)!.password = md5(PASS)
    beforeLock = userId => { users.get(userId)!.password = md5('nova-senha-2') }
    const fresh = await login('c9@x.com', 'nova-senha-2')              // conferida errada contra o lido, certa contra o travado
    expect(fresh.status).toBe('ok')
    expect(failuresOf(109)).toEqual([])
  })
})

describe('L5 — 10 erradas bloqueiam; janela DESLIZANTE, sem botão', () => {
  it('L5 a 11ª com a senha CERTA = a mesma 401, sem token, sem linha nova; envelhecida a mais velha, a senha certa passa', async () => {
    expect([LOGIN_MAX_FAILURES, LOGIN_FAILURE_WINDOW_MINUTES]).toEqual([10, 15])   // D-EA1
    await wrongTimes('valdo@setes.com.br', 10)
    expect(failuresOf(10)).toHaveLength(10)
    const e = await refused(login('valdo@setes.com.br', PASS))
    expect([e.statusCode, e.message]).toEqual([401, LOGIN_REFUSED_MESSAGE])
    expect(failuresOf(10)).toHaveLength(10)
    now += 14 * 60_000                                                 // ainda dentro da janela
    expect((await refused(login('valdo@setes.com.br', PASS))).statusCode).toBe(401)
    now += 60_000 + 1000                                               // a mais velha envelheceu (15 min + 1 s)
    const ok = await login('valdo@setes.com.br', PASS)
    expect(ok.status).toBe('ok')
  })

  it('L5 janela deslizante de verdade: 9 antigas + 1 nova; quando as 9 envelhecem, a conta volta mesmo com a nova na janela', async () => {
    await wrongTimes('c10@x.com', 9)
    now += 10 * 60_000
    await wrongTimes('c10@x.com', 1)                                   // a 10ª — bloqueia
    expect((await refused(login('c10@x.com', PASS))).statusCode).toBe(401)
    now += 5 * 60_000 + 1000                                           // as 9 envelheceram; a 10ª segue na janela
    expect((await login('c10@x.com', PASS)).status).toBe('ok')
  })
})

describe('L6 / L10b — trocar a senha NÃO desbloqueia (conhecimento negativo do §P.3)', () => {
  it('L6 o escritor da senha do script do Super (updatePassword, com password_set_at) troca a senha e a conta SEGUE bloqueada', async () => {
    await wrongTimes('super@setes.com.br', 10)
    const conn = newConn()
    await conn.beginTransaction()
    await updatePassword(conn as any, 16, md5('Senha-Nova-Do-Super'))
    await conn.commit()
    expect((await refused(login('super@setes.com.br', 'Senha-Nova-Do-Super'))).statusCode).toBe(401)
    expect(failuresOf(16)).toHaveLength(10)
    now += 15 * 60_000 + 1000
    expect((await login('super@setes.com.br', 'Senha-Nova-Do-Super')).status).toBe('ok')
  })

  it('L10b a leitura que decide NÃO filtra por password_set_at nem por deleted (cerca no texto do repositório)', () => {
    const repo = fs.readFileSync(path.join(__dirname, '..', 'modules', 'auth', 'auth.repository.ts'), 'utf8')
    const fn = repo.slice(repo.indexOf('export async function countLoginFailuresInWindow'), repo.indexOf('export async function insertLoginFailure'))
    expect(fn).toMatch(/COUNT\(\*\)/)
    expect(fn).not.toMatch(/password_set_at|deleted/)
  })
})

describe('L7 — contenção nunca vira oráculo', () => {
  it('L7 lock wait (1205) na trava → a MESMA 401 + UMA linha de recusa com motivo "contenção" (D-EA11); nunca 409 RESOURCE_BUSY', async () => {
    lockError = lockWaitErr
    const r = await request(app).post('/auth/login').send({ email: 'c11@x.com', password: PASS })
    expect([r.status, r.body]).toEqual([401, { error: 'Email ou senha inválidos' }])
    // gate socrático das Ondas 1+2: a linha extra "contenção na trava" saiu — o motivo vai na ÚNICA linha da recusa
    const warns = (logger.warn as jest.Mock).mock.calls
    expect(warns.filter(c => /Login recusado \(D-EA11\)/.test(c[0])).map(c => c[1].reason)).toEqual(['contenção'])
    expect(warns.some(c => /contenção na trava/.test(c[0]))).toBe(false)
    expect(recordCrash).not.toHaveBeenCalled()
  })

  it('L7 deadlock (1213) → retentativa; esgotada (3×) → a mesma 401 + alarme com ref', async () => {
    let n = 0
    lockError = () => (++n === 1 ? deadlockErr() : null)
    const once = await login('c12@x.com', PASS)                        // 1 deadlock: o retry resolve
    expect(once.status).toBe('ok')
    lockError = deadlockErr
    const e = await refused(login('c12@x.com', PASS))
    expect([e.statusCode, e.message]).toEqual([401, LOGIN_REFUSED_MESSAGE])
    expect(recordCrash).toHaveBeenCalledWith(expect.objectContaining({ ref: 'REFLOGIN' }))
    expect(failuresOf(112)).toEqual([])
  })
})

describe('L8 — corpo não-texto = 400, nunca 500 (A-EA8)', () => {
  it.each([
    ['email em array', { email: ['c13@x.com', 'b@x.com'], password: PASS }],
    ['email objeto', { email: { a: 1 }, password: PASS }],
    ['email número', { email: 123, password: PASS }],
    ['password array', { email: 'c13@x.com', password: [PASS] }],
    ['password objeto', { email: 'c13@x.com', password: { toString: 1 } }],
    ['password número', { email: 'c13@x.com', password: 12345678 }],
    ['campo ausente', { email: 'c13@x.com' }],
  ])('L8 %s → 400 "obrigatórios", sem tocar o banco', async (_n, body) => {
    const r = await request(app).post('/auth/login').send(body)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/obrigatórios/)
    expect(q).not.toHaveBeenCalled()
  })
})

describe('L9 — D-EA11: uma linha de log por falha, e-mail mascarado, nunca a senha', () => {
  it('L9 UMA linha por recusa com e-mail mascarado, IP, motivo interno e instante; nenhum log com a senha ou o e-mail inteiro', async () => {
    await wrongTimes('c14@x.com', 10)
    const cases: Array<[string, string, string]> = [
      ['c15@x.com', 'Senha-Errada-XYZ', 'senha errada'], ['ninguem@existe.com', PASS, 'inexistente'],
      ['semsenha@x.com', PASS, 'sem credencial'], ['inativo@x.com', PASS, 'inativo'], ['semvinculo@x.com', PASS, 'sem vínculo'],
      ['c14@x.com', PASS, 'bloqueado'],
    ]
    ;(logger.warn as jest.Mock).mockClear()
    for (const [email, pwd] of cases) {
      await request(app).post('/auth/login').send({ email, password: pwd })
    }
    const lines = refusalLogs()
    expect(lines).toHaveLength(cases.length)
    lines.forEach((l, i) => {
      const [email, , reason] = cases[i]
      expect(l[1]).toMatchObject({ email: `${email[0]}***${email.slice(email.indexOf('@'))}`, reason })
      expect(typeof l[1].ip).toBe('string')
      expect(new Date(l[1].at).toISOString()).toBe(l[1].at)
    })
    const all = JSON.stringify([(logger.warn as jest.Mock).mock.calls, (logger.error as jest.Mock).mock.calls, (logger.info as jest.Mock).mock.calls])
    for (const [email, pwd] of cases) {
      expect(all).not.toContain(email)
      if (pwd !== PASS) expect(all).not.toContain(pwd)
    }
    expect(all).not.toContain(PASS)
    expect(all).not.toContain(md5(PASS))
  })
})

describe('L10 — aviso ao dono (D-EA3/D-EA14/D-EA15)', () => {
  it('L10 a vaga é tomada na falha que LEVA a janela a 10; e-mail ao e-mail GRAVADO, neutro, sem link, depois do COMMIT', async () => {
    await wrongTimes('valdo@setes.com.br', 9)
    expect(notices).toEqual([])
    await wrongTimes('valdo@setes.com.br', 1)
    expect(notices).toEqual([{ userId: 10, seq: 1, createdAt: now }])
    await waitForPendingPasswordResets()
    const sent = blockNoticeMails()
    expect(sent).toHaveLength(1)
    expect(sent[0][0].to).toBe('Valdo@Setes.com.br')                   // o GRAVADO, nunca o texto da requisição
    expect(`${sent[0][0].text}${sent[0][0].html}`).not.toMatch(/https?:\/\//)
    expect(sent[0][0].text).toMatch(/tentativas de acesso .* não foram concluídas/)
    expect(sent[0][0].text).toMatch(/troque a sua senha/)
  })

  it('L10 tentativas DURANTE o bloqueio não gravam nem avisam; no máximo 1 aviso por hora; depois da hora, outro (seq 2)', async () => {
    await wrongTimes('c16@x.com', 10)
    await wrongTimes('c16@x.com', 5)                                   // durante o bloqueio
    expect([failuresOf(116).length, notices.length]).toEqual([10, 1])
    now += 16 * 60_000                                                 // desbloqueia; novo ciclo dentro da MESMA hora do aviso
    await wrongTimes('c16@x.com', 10)
    expect([failuresOf(116).length, notices.length]).toEqual([20, 1])
    now += 61 * 60_000
    await wrongTimes('c16@x.com', 10)
    expect(notices.map(n => n.seq)).toEqual([1, 2])
    await waitForPendingPasswordResets()
    expect(blockNoticeMails()).toHaveLength(2)
  })

  it('L10 a 401 NÃO espera o SMTP (o e-mail sai em segundo plano)', async () => {
    let release!: () => void
    mail.mockImplementation(() => new Promise<void>(r => { release = r }))
    await wrongTimes('c17@x.com', 9)
    const e = await refused(login('c17@x.com', 'errada'))              // a 10ª — responde com o SMTP mudo
    expect(e.statusCode).toBe(401)
    expect(blockNoticeMails()).toHaveLength(1)
    release()
  })

  it('L10 falha do INSERT do aviso (GRANT ausente, 1142) → o SAVEPOINT desfaz SÓ o aviso; a 10ª falha SOBREVIVE e a conta bloqueia', async () => {
    await wrongTimes('c18@x.com', 9)
    failNext = { match: /INSERT INTO setes_central\.tb_user_login_block_notice/, err: Object.assign(new Error('INSERT command denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 }) }
    await wrongTimes('c18@x.com', 1)
    expect([failuresOf(118).length, notices.length]).toEqual([10, 0])
    expect(recordCrash).toHaveBeenCalledWith(expect.objectContaining({ origen: expect.stringMatching(/auth\/login \(aviso ao dono\)/) }))
    expect((await refused(login('c18@x.com', PASS))).statusCode).toBe(401)   // bloqueada
    await waitForPendingPasswordResets()
    expect(blockNoticeMails()).toHaveLength(0)
  })

  it('L10 e-mail inexistente nunca gera aviso (nem linha)', async () => {
    for (let i = 0; i < 15; i++) await refused(login('fantasma@x.com', `e${i}`))
    expect([failures.length, notices.length]).toEqual([0, 0])
  })

  it('L10 falha do SMTP no aviso = log mascarado; nada muda na resposta', async () => {
    mail.mockRejectedValue(Object.assign(new Error('550 rejected <c19@x.com>'), { code: 'EENVELOPE', responseCode: 550 }))
    await wrongTimes('c19@x.com', 10)
    await waitForPendingPasswordResets()
    const err = (logger.error as jest.Mock).mock.calls.find(c => /aviso de bloqueio do login/.test(c[0]))
    expect(err).toBeDefined()
    expect(JSON.stringify(err)).not.toContain('c19@x.com')
  })
})

describe('L11 — seleção/troca inalteradas; boot confere as duas tabelas', () => {
  it('L11 N estabelecimentos: token de seleção; selecionar e trocar seguem emitindo o final', async () => {
    const r = await login('multi@x.com', PASS)
    expect([r.status, r.institutions?.length]).toEqual(['select', 2])
    expect((await selectInstitution(r.token, 2)).token).toEqual(expect.any(String))
    expect((await switchInstitution(11, 1)).token).toEqual(expect.any(String))
  })

  it('L11 boot: sem tb_user_login_failure ou sem tb_user_login_block_notice o setes-api NÃO sobe (cita o script 74)', async () => {
    await expect(assertLoginLockReady()).resolves.toMatch(/^ok/)
    for (const table of ['tb_user_login_failure', 'tb_user_login_block_notice']) {
      q.mockImplementation(async (sql: string) => {
        if (sql.includes(`setes_central.${table} LIMIT 0`)) throw Object.assign(new Error('no table'), { errno: 1146, code: 'ER_NO_SUCH_TABLE' })
        return [[]]
      })
      await expect(assertLoginLockReady()).rejects.toThrow(new RegExp(`setes_central\\.${table} ausente[\\s\\S]*sql/74_user_login_failure_ddl\\.sql`))
    }
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8')
    expect(server).toMatch(/await assertLoginLockReady\(\)/)
  })
})

describe('L12 — D-UC12 ainda não existe; a ordem do login fica pronta para ele', () => {
  it('L12 a leitura dos vínculos vem DEPOIS do julgamento sob a trava (aceite do convite, quando entrar, só depois da admissão)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'auth', 'auth.service.ts'), 'utf8')
    const body = src.slice(src.indexOf('async function loginOrRefuse'), src.indexOf('/** Assunto do aviso de bloqueio do login'))
    const judged = body.indexOf('judgeLoginAttempt(conn')
    const linksAt = body.indexOf('getInstitutionsForUser(user.id, conn)')   // gates: pela conexão da transação, nunca pelo pool
    expect(judged).toBeGreaterThan(0)
    expect(linksAt).toBeGreaterThan(judged)
    expect(body).not.toMatch(/getInstitutionsForUser\(user\.id\)/)
    expect(src).not.toMatch(/acceptInvite|aceitarConvite/)
  })
})

describe('A4/A5 — o alarme global (D-EA4) conta o e-mail inexistente e NUNCA bloqueia', () => {
  it('A5 e-mail INEXISTENTE conta no contador; A4 com o alarme no ar, o login certo de outra conta passa', async () => {
    let t = Date.parse(DAY)
    setLoginWatchClock(() => t)
    for (let i = 0; i <= LOGIN_ALARM_FAILURES_PER_MINUTE; i++) { t += 100; await refused(login(`fantasma${i}@x.com`, 'x')) }
    expect((logger.error as jest.Mock).mock.calls.filter(c => /^\[ALARME LOGIN\]/.test(c[0]))).toHaveLength(1)
    expect((await login('c20@x.com', PASS)).status).toBe('ok')
  })
})
