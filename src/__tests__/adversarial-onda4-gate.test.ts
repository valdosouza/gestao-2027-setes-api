/// <reference types="jest" />
// GATE ADVERSARIAL da Onda 4 do endurecer (scrypt — D-EA9/D-EA18/D-EA43; diff 48cddd6..onda4). Skill
// `Infra-IA/skills-genericas/testar-adversarial.md`. Achado confirmado = `it.failing` (passa enquanto o defeito existir); ataque que não
// quebrou = `it` "[RESISTIU]". Dublê do banco COPIADO de `auth-login-lock-d-ea1.test.ts` (trava da linha emulada, SAVEPOINT, CAS do rehash).
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
// ATAQUES DA ONDA 4 (scrypt)
// =====================================================================================================================================
import crypto from 'crypto'
import {
  hashPassword, checkPassword, storedPasswordForm, SCRYPT_CURRENT, currentScryptParams, setCurrentScryptParamsForTests, ScryptParams,
} from '../shared/auth/password'
import { changePassword, setPasswordResetResponseFloor, PASSWORD_RESET_RESPONSE_FLOOR_MS } from '../modules/auth/auth.service'

const TEST_WEIGHT: ScryptParams = { ...currentScryptParams() }
let scryptHashOfPass = ''
beforeAll(async () => { scryptHashOfPass = await hashPassword(PASS) })

/** conta as chamadas REAIS do crypto.scrypt (a peça chama `crypto_1.scrypt` na hora — o spy pega) */
function countScrypt(): { calls: () => number; restore: () => void } {
  const spy = jest.spyOn(crypto, 'scrypt')
  return { calls: () => spy.mock.calls.length, restore: () => spy.mockRestore() }
}
function useScrypt(userId: number, hash = scryptHashOfPass): void { users.get(userId)!.password = hash }

describe('ADV-O4 A — parsing do valor gravado', () => {
  const salt = Buffer.alloc(16, 7).toString('base64'), key = Buffer.alloc(32, 9).toString('base64')
  it.each([
    ['dígito unicode no N (árabe-índico)', `scrypt$N=٣٢٧٦٨,r=8,p=3$${salt}$${key}`],
    ['quebra de linha no fim', `scrypt$N=32768,r=8,p=3$${salt}$${key}\n`],
    ['base64 url-safe', `scrypt$N=32768,r=8,p=3$${salt.replace(/A/g, '-')}_$${key}`],
    ['campo extra', `scrypt$N=32768,r=8,p=3$${salt}$${key}$x`],
    ['N gigante (2^24)', `scrypt$N=${2 ** 24},r=8,p=1$${salt}$${key}`],
    ['N negativo', `scrypt$N=-32768,r=8,p=1$${salt}$${key}`],
    ['N fracionário', `scrypt$N=32768.0,r=8,p=1$${salt}$${key}`],
    ['N não potência de 2 dentro da faixa', `scrypt$N=40000,r=8,p=1$${salt}$${key}`],
    ['r=1', `scrypt$N=32768,r=1,p=1$${salt}$${key}`],
    ['MD5 com espaço no fim (PAD SPACE)', 'E10ADC3949BA59ABBE56E057F20F883E '],
    ['MD5 com 33 hex', 'E10ADC3949BA59ABBE56E057F20F883EE'],
    ['NUL no meio', `scrypt$N=32768,r=8,p=3$${salt}\u0000$${key}`],
    ['valor de 1 MB', 'a'.repeat(1 << 20)],
  ])('[RESISTIU] %s → invalid, sem calcular', async (_n, stored) => {
    const c = countScrypt()
    try {
      expect(storedPasswordForm(stored)).toBe('invalid')
      expect((await checkPassword(PASS, stored)).ok).toBe(false)
      expect(c.calls()).toBe(0)
    } finally { c.restore() }
  })

  // ADV-O4-05 (LOW): o base64 é exigido CANÔNICO ("reescrever tem de dar o MESMO texto"), mas os PARÂMETROS aceitam zero à esquerda —
  // `N=032768,r=08,p=03` é aceito como o peso vigente. Sem efeito de segurança hoje (só a peça grava, sempre canônico); o mesmo princípio não
  // vale nas duas metades do valor.
  // CORRIGIDO na sessão (parâmetros canônicos na peça) — o it.failing virou teste comum
  it('[CORRIGIDO] ADV-O4-05 parâmetro com zero à esquerda (N=032768,r=08,p=01) é invalid', async () => {
    const real = await hashPassword(PASS)           // peso leve da suíte: N=16384,r=8,p=1
    const padded = real.replace('N=16384,r=8,p=1', 'N=016384,r=08,p=01')
    expect(padded).not.toBe(real)
    expect(storedPasswordForm(padded)).toBe('invalid')
  })

  it('[RESISTIU] senha DIGITADA com surrogate solitário não colide com U+FFFD via política (a política recusa gravar surrogate solitário)', async () => {
    // o Node converte surrogate solitário em U+FFFD antes do scrypt: '\uD800' e '\uDC00' derivam a MESMA chave. Quem grava passa pela política
    // (hasForbiddenChar recusa), então nenhuma senha NOVA tem surrogate solitário; a colisão só alcançaria senha com U+FFFD literal — e quem
    // a digita com U+FFFD já sabe a senha.
    const h = await hashPassword('ab�cd-xk9#')
    expect((await checkPassword('ab\uD800cd-xk9#', h)).ok).toBe(true)     // fato da conversão (conhecimento negativo)
    const { passwordProblems } = await import('../shared/auth/password-policy')
    expect(passwordProblems('ab\uD800cd-xk9#Qw', null, new Set())).toContain('invalid-char')
  })

  it('[RESISTIU] senha de 2 MB no login (sem teto de tamanho na rota) custa ≈ o mesmo que 1 caractere (o PBKDF2 condensa a chave uma vez)', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024)
    const t0 = performance.now(); await checkPassword('x', scryptHashOfPass); const small = performance.now() - t0
    const t1 = performance.now(); await checkPassword(big, scryptHashOfPass); const huge = performance.now() - t1
    console.log(`[ADV-O4] scrypt peso da suíte: 1 caractere ${small.toFixed(0)} ms × 2 MB ${huge.toFixed(0)} ms`)
    expect(huge).toBeLessThan(small * 3 + 200)
    const m0 = performance.now(); await checkPassword(big, 'E10ADC3949BA59ABBE56E057F20F883E'); const md = performance.now() - m0
    expect(md).toBeLessThan(200)                    // o MD5 de 2 MB roda na thread principal — barato
  })

  it('[RESISTIU] o MAIOR peso aceito (N=2^17, r=8, p=1) roda sem recusa do Node e NÃO envenena a fila do OpenSSL (a chave PEM lê depois)', async () => {
    const prev = setCurrentScryptParamsForTests({ N: 2 ** 17, r: 8, p: 1 })
    try {
      const h = await hashPassword(PASS)
      expect((await checkPassword(PASS, h)).ok).toBe(true)
    } finally { setCurrentScryptParamsForTests(prev) }
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(() => crypto.createPrivateKey(pem)).not.toThrow()
  }, 60_000)

  it('[RESISTIU] o setter de teste recusa peso fora da lista (nunca chega ao scrypt) e não é chamado fora dos testes', () => {
    expect(() => setCurrentScryptParamsForTests({ N: 2 ** 20, r: 8, p: 1 })).toThrow()
    expect(() => setCurrentScryptParamsForTests({ N: 2 ** 15, r: 8, p: 9 })).toThrow()
    expect(currentScryptParams()).toEqual(TEST_WEIGHT)
  })
})

describe('ADV-O4 B — login', () => {
  it('[RESISTIU] valor gravado fora das formas → 401 + alarme, sem calcular, sem o valor no log/alarme', async () => {
    const weird = `scrypt$N=${2 ** 20},r=8,p=1$${Buffer.alloc(16, 1).toString('base64')}$${Buffer.alloc(32, 2).toString('base64')}`
    users.get(10)!.password = weird
    const c = countScrypt()
    try {
      const e = await refused(login('valdo@setes.com.br', PASS))
      expect([e.statusCode, e.message]).toEqual([401, LOGIN_REFUSED_MESSAGE])
      expect(c.calls()).toBe(0)
    } finally { c.restore() }
    expect(recordCrash).toHaveBeenCalled()
    const logged = JSON.stringify([(logger.error as jest.Mock).mock.calls, (logger.warn as jest.Mock).mock.calls, (recordCrash as jest.Mock).mock.calls])
    expect(logged).not.toContain(weird.slice(20, 40))
    expect(logged).not.toContain(PASS)
  })

  it('[RESISTIU] errada numa conta MD5 → nenhum scrypt (errada nunca recalcula), nada regravado', async () => {
    const before = users.get(10)!.password
    const c = countScrypt()
    try { await refused(login('valdo@setes.com.br', 'errada')) } finally { c.restore() }
    expect(c.calls()).toBe(0)
    expect(users.get(10)!.password).toBe(before)
  })

  it('[RESISTIU] certa numa conta MD5 INATIVA / SEM VÍNCULO → recusa e NÃO regrava', async () => {
    for (const email of ['inativo@x.com', 'semvinculo@x.com']) {
      const id = email.startsWith('inativo') ? 12 : 13
      const before = users.get(id)!.password
      await refused(login(email, PASS))
      expect(users.get(id)!.password).toBe(before)
    }
  })

  it('[RESISTIU] 6 logins CERTOS simultâneos numa conta MD5 → todos entram, UMA regravação, valor final scrypt que confere', async () => {
    const md5Before = users.get(10)!.password
    const res = await Promise.allSettled(Array.from({ length: 6 }, () => login('valdo@setes.com.br', PASS)))
    expect(res.filter(r => r.status === 'fulfilled').length).toBe(6)
    const after = users.get(10)!.password!
    expect(after).not.toBe(md5Before)
    expect(storedPasswordForm(after)).toBe('scrypt')
    expect((await checkPassword(PASS, after)).ok).toBe(true)
    expect(failuresOf(10)).toEqual([])
  })

  it('[RESISTIU] troca de senha entre a conferência e a trava (CAS): o login com a senha ANTIGA vira errada; a NOVA fica', async () => {
    const newHash = await hashPassword('nova-senha-Zx81!')
    beforeLock = (uid) => { users.get(uid)!.password = newHash }
    const e = await refused(login('valdo@setes.com.br', PASS))
    expect(e.statusCode).toBe(401)
    expect(users.get(10)!.password).toBe(newHash)
    expect(failuresOf(10).length).toBe(1)
  })

  it('[RESISTIU] hash mudando a cada rodada (laço stale esgotado) → 401 neutra, nenhuma falha gravada, nada regravado pelo login', async () => {
    let i = 0
    const hook = (uid: number) => { users.get(uid)!.password = md5(`outra-${i++}`); beforeLock = hook }
    beforeLock = hook
    const e = await refused(login('valdo@setes.com.br', PASS))
    beforeLock = null
    expect([e.statusCode, e.message]).toEqual([401, LOGIN_REFUSED_MESSAGE])
    expect(failuresOf(10)).toEqual([])
    expect(refusalLogs().some(c => JSON.stringify(c).includes('conten'))).toBe(true)
  })

  // ADV-O4-01 (MEDIUM): o pré-filtro (≥ 10 falhas = não calcula) olha as falhas JÁ GRAVADAS; uma RAJADA paralela passa inteira por ele antes
  // de a 1ª falha ser gravada — 30 erradas simultâneas numa conta limpa gravam 10 falhas (correto) mas calculam 30 scrypt. O §P.3/§819 diz
  // "bloqueada = sem conferir senha — o scrypt e a fila não amplificam o ataque"; a rajada amplifica até o teto do IP (300/min) por conta.
  // CORRIGIDO pela D-EA44 (Valdo 2026-11-07, '(a) contar'): tentativas em andamento por conta somam ao pré-filtro
  it('[CORRIGIDO D-EA44] ADV-O4-01 rajada de 30 erradas paralelas numa conta limpa calcula no máximo 10 scrypt', async () => {
    useScrypt(10)
    const c = countScrypt()
    try {
      await Promise.allSettled(Array.from({ length: 30 }, (_, k) => login('valdo@setes.com.br', `errada-${k}`)))
      console.log(`[ADV-O4-01] 30 erradas paralelas: falhas gravadas=${failuresOf(10).length}, scrypt calculados=${c.calls()}`)
      expect(failuresOf(10).length).toBe(10)
      expect(c.calls()).toBeLessThanOrEqual(10)
      expect(require('../modules/auth/auth.service').loginsInFlightSize()).toBe(0)   // nada vaza na memória
    } finally { c.restore() }
  }, 60_000)

  // ADV-O4-02 (MEDIUM): oráculo de existência PROVOCADO pelo atacante. O piso de 700 ms fica acima do p99 de UMA conferência; com 12 palpites
  // SIMULTÂNEOS para o mesmo e-mail a fila do pool do libuv (4 threads) empurra a conta EXISTENTE para bem acima do piso, enquanto o e-mail
  // inexistente responde em 700 ms cravados. O "limite conhecido" do comentário fala de carga do sistema; aqui a carga é do próprio atacante.
  // LIMITE CONHECIDO — D-EA45 (Valdo 2026-11-07, '(a) limite conhecido'): reavaliado com a medição no servidor real (D-EA17/H11). O it.failing
  // fixa a semântica: quando passar a falhar (o tempo deixou de distinguir), a decisão pode ser revista.
  it.failing('[LIMITE CONHECIDO — D-EA45] ADV-O4-02 12 palpites simultâneos: conta existente (peso de produção) não se distingue da inexistente pelo tempo', async () => {
    setLoginRefusalFloor(LOGIN_REFUSAL_FLOOR_MS)
    const prev = setCurrentScryptParamsForTests(SCRYPT_CURRENT)
    try {
      useScrypt(10, await hashPassword(PASS))
      const timed = async (email: string, k: number) => { const t = performance.now(); await refused(login(email, `errada-${k}`)); return performance.now() - t }
      const existing = await Promise.all(Array.from({ length: 12 }, (_, k) => timed('valdo@setes.com.br', k)))
      const missing  = await Promise.all(Array.from({ length: 12 }, (_, k) => timed('nao@existe.com', k)))
      const max = (a: number[]) => Math.max(...a).toFixed(0)
      console.log(`[ADV-O4-02] máx existente=${max(existing)} ms · máx inexistente=${max(missing)} ms (piso ${LOGIN_REFUSAL_FLOOR_MS})`)
      expect(Math.max(...existing)).toBeLessThan(Math.max(...missing) + 150)
    } finally { setCurrentScryptParamsForTests(prev); setLoginRefusalFloor(0) }
  }, 120_000)
})

describe('ADV-O4 C — troca pelo código', () => {
  beforeAll(() => setPasswordResetResponseFloor(0))
  afterAll(() => setPasswordResetResponseFloor(PASSWORD_RESET_RESPONSE_FLOOR_MS))

  // ADV-O4-03 (MEDIUM): os DOIS scrypt da troca são calculados ANTES de olhar se existe código aberto — qualquer um que conheça um e-mail
  // ativo compra 2 scrypt por requisição sem nunca ter pedido código (e sem o teto de 5 erradas do código, que só conta com código aberto).
  // Contido por 10/15 min por e-mail (em memória, por instância) e 300/min por IP (registrado no §P.14 item 4).
  it.failing('[FALHOU] ADV-O4-03 troca com e-mail ativo SEM código aberto não calcula scrypt', async () => {
    useScrypt(10)
    const c = countScrypt()
    try {
      const e = await refused(changePassword('valdo@setes.com.br', '123456', 'Zq8#vLp2!mRtW'))
      expect(e.statusCode).toBe(401)
      console.log(`[ADV-O4-03] troca sem código aberto: scrypt calculados=${c.calls()}`)
      expect(c.calls()).toBe(0)
    } finally { c.restore() }
  })

  // ADV-O4-04 (LOW): falha do scrypt (memória no pool do libuv) fora do try da troca → 500 só para conta EXISTENTE (a inexistente dá 401):
  // oráculo de existência sob falha de ambiente. O mesmo no login (judgeRound chama checkStoredPassword/hashPassword fora do try → 500).
  it('[RESISTIU] ADV-O4-04 (corrigido na árvore pelo gate socrático, ainda sem commit) scrypt que falha na troca vira a MESMA 401 (nunca outro status para a conta existente)', async () => {
    useScrypt(10)
    const spy = jest.spyOn(crypto, 'scrypt').mockImplementation(((..._a: any[]) => {
      const cb = _a[_a.length - 1]; setImmediate(() => cb(Object.assign(new Error('memory limit exceeded'), { code: 'ERR_CRYPTO_SCRYPT' })))
    }) as any)
    try {
      const e = await refused(changePassword('valdo@setes.com.br', '123456', 'Zq8#vLp2!mRtW'))
      expect(e.statusCode).toBe(401)
    } finally { spy.mockRestore() }
  })

  it('[RESISTIU] ADV-O4-04b (idem) scrypt que falha no login vira HttpError 401 (não erro cru → 500 na rota)', async () => {
    useScrypt(10)
    const spy = jest.spyOn(crypto, 'scrypt').mockImplementation(((..._a: any[]) => {
      const cb = _a[_a.length - 1]; setImmediate(() => cb(new Error('memory limit exceeded')))
    }) as any)
    try {
      const e = await refused(login('valdo@setes.com.br', PASS))
      expect(e.statusCode).toBe(401)
    } finally { spy.mockRestore() }
  })
})

describe('ADV-O4 D — script do Super', () => {
  it('[RESISTIU] resetSuperPasswordTx recusa MD5 legado, scrypt malformado e peso fora da lista ANTES de tocar o banco', async () => {
    const { resetSuperPasswordTx } = await import('../modules/auth/super-password-reset')
    const conn = newConn()
    const salt = Buffer.alloc(16, 3).toString('base64'), key = Buffer.alloc(32, 4).toString('base64')
    for (const bad of [md5(PASS), 'texto', `scrypt$N=${2 ** 20},r=8,p=1$${salt}$${key}`, `scrypt$N=32768,r=8,p=3$${salt}$${key}x`]) {
      await expect(resetSuperPasswordTx(conn as any, 16, bad)).rejects.toThrow(/fora da forma/)
    }
    expect(conn.query).not.toHaveBeenCalled()
  })
})
