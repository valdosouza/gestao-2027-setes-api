/// <reference types="jest" />
// Q-PV38 / D-PV13 (2026-10-18 — Infra-IA/prompts/prompt_privilegios_interfaces.md §13): força bruta no código de 6 dígitos do
// /auth/change-password. O pedido de troca de senha (setes_central.tb_user_password_reset, sql/67) aguenta N tentativas ERRADAS;
// a seguinte — mesmo com o código CERTO — é recusada; e-mail inexistente responde IGUAL; teto de emissões por conta; limite por
// e-mail em memória; o código vai ao e-mail GRAVADO; o código nunca é guardado (HMAC amarrado à senha e ao e-mail de login).
// Banco DUBLADO pelo texto do SQL (molde dos gates adversariais), com relógio do banco controlável e a trava de REGISTRO da linha
// do usuário em tb_user emulada (FOR UPDATE espera o dono até o COMMIT/ROLLBACK) — as corridas reais são provadas em schema
// descartável por scripts/prove-password-reset-lock.ts.
import request from 'supertest'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/mailer/mailer', () => ({
  __esModule: true, sendMail: jest.fn().mockResolvedValue(undefined), isMailerConfigured: jest.fn(() => true),
}))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFQPV38'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))

import pool from '../shared/db/connection'
import logger from '../shared/logger/logger'
import { sendMail } from '../shared/mailer/mailer'
import { recordCrash } from '../shared/errors/crash.repository'
import { setLockWaitSupported } from '../shared/db/counters'
import app from '../app'
import {
  changePassword, recoveryPassword, waitForPendingPasswordResets, assertPasswordResetReady, INVALID_PASSWORD_RESET_CODE,
  setPasswordResetResponseFloor, PASSWORD_RESET_RESPONSE_FLOOR_MS,
  PASSWORD_RESET_MAX_FAILED_ATTEMPTS, PASSWORD_RESET_MAX_PER_HOUR, PASSWORD_RESET_MAX_PER_DAY, PASSWORD_RESET_TTL_MINUTES,
} from '../modules/auth/auth.service'
import { CHANGE_PER_EMAIL, RECOVERY_PER_EMAIL } from '../modules/auth/auth.routes'
import { normalizeLoginEmail, loginEmailBucket } from '../shared/auth/login-email'

const q = (pool as any).query as jest.Mock
const getConn = (pool as any).getConnection as jest.Mock
const mail = sendMail as jest.Mock

// ---- o mundo do dublê ---------------------------------------------------------------------------------------------------
interface User { id: number; password: string | null; active: string; deleted: string; email: string }
interface ResetRow { userId: number; seq: number; codeHmac: string; failed: number; usedAt: number | null; createdAt: number; deleted: string }

let now: number                          // relógio do BANCO (NOW()) em ms
let users: Map<number, User>
let resets: ResetRow[]
let passwordWrites: Array<{ userId: number; hash: string }>
/** Injeta um erro no próximo statement que casar (falha do banco depois de achar a conta). */
let failNext: { match: string; err: any } | null
let seenSql: string[]
const locks = new Map<number, { owner: object; waiters: Array<() => void> }>()

/** A igualdade do banco para o e-mail de login (utf8mb4_general_ci): sem caixa, sem acento, ı = i, PAD SPACE. */
const dbEq = (a: string, b: string) => {
  const f = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').replace(/ı/g, 'i').toLowerCase().replace(/ +$/, '')
  return f(a) === f(b)
}

function seedUsers(): void {
  users = new Map()
  let id = 10
  for (const email of [
    'valdo@setes.com.br', 'a1@x.com', 'a2@x.com', 'a3@x.com', 'a4@x.com', 'a5@x.com', 'a6@x.com', 'a7@x.com', 'a8@x.com',
    'a9@x.com', 'a10@x.com', 'a11@x.com', 'a12@x.com', 'a13@x.com', 'a14@x.com', 'a15@x.com', 'a16@x.com', 'fulano@gmail.com',
  ]) {
    users.set(id, { id, password: `HASH${id}`, active: 'S', deleted: 'N', email })
    id++
  }
  users.set(90, { id: 90, password: 'HASH90', active: 'N', deleted: 'N', email: 'inativo@x.com' })
}
const userByEmail = (email: string) => [...users.values()].find(u => u.email === email)!

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

async function run(sql: string, params: any[], owner: object | null, undo: Array<() => void>): Promise<any> {
  seenSql.push(sql)
  if (failNext && sql.includes(failNext.match)) {
    const { err } = failNext
    failNext = null
    throw err
  }
  if (/FROM setes_central\.tb_user_password_reset LIMIT 0/.test(sql)) return [[]]
  if (/FROM setes_central\.tb_user u\s/.test(sql) && /tb_mailing_group_id = 2/.test(sql)) {
    const [email] = params
    const u = [...users.values()].filter(x => x.deleted === 'N' && dbEq(x.email, String(email))).sort((a, b) => a.id - b.id)[0]
    return [u ? [{ id: u.id, password: u.password, active: u.active, loginEmail: u.email }] : []]
  }
  if (/SELECT id, active, password FROM setes_central\.tb_user WHERE id = \? AND deleted = 'N' FOR UPDATE/.test(sql)) {
    const [userId] = params
    if (!owner) throw new Error('FOR UPDATE fora de transação')
    const u = users.get(Number(userId))
    if (!u || u.deleted !== 'N') return [[]]          // PK inexistente: trava de intervalo — não serializa (não importa aqui)
    await acquire(u.id, owner)
    return [[{ id: u.id, active: u.active, password: u.password }]]
  }
  if (/FROM setes_central\.tb_user_password_reset/.test(sql) && /lastHour/.test(sql)) {
    const [userId] = params
    const mine = resets.filter(r => r.userId === Number(userId) && r.createdAt > now - 24 * 3600_000)
    return [[{ lastHour: String(mine.filter(r => r.createdAt > now - 3600_000).length), lastDay: mine.length }]]
  }
  if (/COALESCE\(MAX\(seq\), 0\) \+ 1 AS nextSeq/.test(sql)) {
    const [userId] = params
    const seqs = resets.filter(r => r.userId === Number(userId)).map(r => r.seq)
    return [[{ nextSeq: (seqs.length ? Math.max(...seqs) : 0) + 1 }]]
  }
  if (/INSERT INTO setes_central\.tb_user_password_reset/.test(sql)) {
    const [userId, seq, codeHmac] = params
    const row: ResetRow = { userId: Number(userId), seq: Number(seq), codeHmac, failed: 0, usedAt: null, createdAt: now, deleted: 'N' }
    if (!/^[0-9a-f]{64}$/.test(codeHmac)) throw new Error('CHECK ck_user_password_reset_code_hmac')
    if (resets.some(r => r.userId === row.userId && r.seq === row.seq)) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' })
    resets.push(row)
    undo.push(() => { resets = resets.filter(r => r !== row) })
    return [{ affectedRows: 1 }]
  }
  if (/ORDER BY seq DESC LIMIT 1/.test(sql)) {
    const [ttl, userId] = params
    const mine = resets.filter(r => r.userId === Number(userId)).sort((a, b) => b.seq - a.seq)
    const r = mine[0]
    if (!r) return [[]]
    return [[{
      seq: r.seq, codeHmac: r.codeHmac, failedAttempts: r.failed,
      isOpen: r.usedAt === null && r.deleted === 'N' ? 1 : 0,
      isFresh: r.createdAt > now - Number(ttl) * 60_000 ? 1 : 0,
    }]]
  }
  if (/SET failed_attempts = failed_attempts \+ 1/.test(sql)) {
    const [userId, seq] = params
    const r = resets.find(x => x.userId === Number(userId) && x.seq === Number(seq))!
    r.failed++
    undo.push(() => { r.failed-- })
    return [{ affectedRows: 1 }]
  }
  if (/SET used_at = NOW\(\)/.test(sql)) {
    const [userId, seq] = params
    const r = resets.find(x => x.userId === Number(userId) && x.seq === Number(seq) && x.usedAt === null)
    if (r) { r.usedAt = now; undo.push(() => { r.usedAt = null }) }
    return [{ affectedRows: r ? 1 : 0 }]
  }
  if (/UPDATE setes_central\.tb_user SET password = \?/.test(sql)) {
    const [hash, userId] = params
    const u = users.get(Number(userId))!
    const before = u.password
    u.password = hash
    passwordWrites.push({ userId: u.id, hash })
    undo.push(() => { u.password = before; passwordWrites.pop() })
    return [{ affectedRows: 1 }]
  }
  return [[]]
}

function newConn() {
  const owner = {}
  let undo: Array<() => void> = []
  return {
    beginTransaction: jest.fn(async () => { undo = [] }),
    commit:   jest.fn(async () => { undo = []; releaseAll(owner) }),
    rollback: jest.fn(async () => { undo.reverse().forEach(f => f()); undo = []; releaseAll(owner) }),
    release:  jest.fn(),
    query:    jest.fn((sql: string, params: any[] = []) => run(sql, params, owner, undo)),
  }
}

const lastCode = (to: string): string => {
  const call = [...mail.mock.calls].reverse().find(c => c[0].to === to)
  if (!call) throw new Error(`nenhum e-mail para ${to}`)
  return /código de recuperação é (\d{6})/.exec(call[0].text)![1]
}
const wrongOf = (code: string, i = 0) => String((Number(code) - 100000 + 1 + i) % 900000 + 100000)

beforeAll(() => setPasswordResetResponseFloor(0))   // o piso de tempo é provado no próprio teste
afterAll(() => setPasswordResetResponseFloor(PASSWORD_RESET_RESPONSE_FLOOR_MS))

beforeEach(() => {
  jest.clearAllMocks()
  now = Date.parse('2026-10-18T12:00:00Z')
  seedUsers()
  resets = []
  passwordWrites = []
  failNext = null
  seenSql = []
  locks.clear()
  q.mockImplementation((sql: string, params: any[] = []) => run(sql, params, null, []))
  getConn.mockImplementation(async () => newConn())
})

/** POST do recovery + a emissão em SEGUNDO PLANO terminada (o recovery responde antes dela — tempo neutro). */
const recover = async (email: any) => {
  const r = await request(app).post('/auth/recovery-password').send({ email })
  await waitForPendingPasswordResets()
  return r
}
const issue = async (email: string) => { await recoveryPassword(email); await waitForPendingPasswordResets() }
const lockWait = (code: string, errno: number) => Object.assign(new Error(code), { code, errno })
const change = (email: any, code: string, newPassword = 'nova-senha') =>
  request(app).post('/auth/change-password').send({ email, code, newPassword })

describe('Q-PV38 — o código morre depois de N tentativas erradas', () => {
  it(`depois de ${PASSWORD_RESET_MAX_FAILED_ATTEMPTS} tentativas erradas, a seguinte com o código CERTO é recusada (401) e a senha não muda`, async () => {
    expect(PASSWORD_RESET_MAX_FAILED_ATTEMPTS).toBe(5)        // proposta da Q-PV38 — o valor é do Valdo (Q-RS1)
    const email = 'valdo@setes.com.br'
    expect((await recover(email)).status).toBe(200)
    const code = lastCode(email)
    for (let i = 0; i < PASSWORD_RESET_MAX_FAILED_ATTEMPTS; i++) {
      const w = await change(email, wrongOf(code, i))
      expect([w.status, w.body]).toEqual([401, { error: INVALID_PASSWORD_RESET_CODE }])
    }
    const sixth = await change(email, code)
    expect([sixth.status, sixth.body]).toEqual([401, { error: INVALID_PASSWORD_RESET_CODE }])
    expect(passwordWrites).toEqual([])
    expect(resets[0].failed).toBe(PASSWORD_RESET_MAX_FAILED_ATTEMPTS)   // esgotado não soma mais
  })

  it(`controle: ${PASSWORD_RESET_MAX_FAILED_ATTEMPTS - 1} erradas e a ${PASSWORD_RESET_MAX_FAILED_ATTEMPTS}ª certa troca a senha (o orçamento é de ERRADAS)`, async () => {
    const email = 'a1@x.com'
    await recover(email)
    const code = lastCode(email)
    for (let i = 0; i < PASSWORD_RESET_MAX_FAILED_ATTEMPTS - 1; i++) expect((await change(email, wrongOf(code, i))).status).toBe(401)
    const ok = await change(email, code)
    expect([ok.status, ok.body]).toEqual([200, { ok: true }])
    expect(passwordWrites).toHaveLength(1)
    expect(resets[0].usedAt).not.toBeNull()
  })

  it('o código esgotado só volta com um código NOVO (que zera o orçamento — e o antigo segue morto)', async () => {
    const email = 'a2@x.com'
    await recover(email)
    const old = lastCode(email)
    for (let i = 0; i < PASSWORD_RESET_MAX_FAILED_ATTEMPTS; i++) await change(email, wrongOf(old, i))
    await recover(email)
    const fresh = lastCode(email)
    if (fresh !== old) expect((await change(email, old)).status).toBe(401)
    expect((await change(email, fresh)).status).toBe(200)
  })

  it('rajada PARALELA de tentativas erradas não passa do orçamento (a tentativa é julgada e contada sob a trava do usuário)', async () => {
    const email = 'a3@x.com'
    await issue(email)
    const code = lastCode(email)
    const results = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => changePassword(email, wrongOf(code, i), 'nova-senha')))
    expect(results.every(r => r.status === 'rejected' && (r.reason as any).statusCode === 401)).toBe(true)
    expect(resets[0].failed).toBe(PASSWORD_RESET_MAX_FAILED_ATTEMPTS)
    await expect(changePassword(email, code, 'nova-senha')).rejects.toMatchObject({ statusCode: 401 })
    expect(passwordWrites).toEqual([])
  })

  it('a tentativa errada é COMMITADA antes da 401 (o +1 não se perde num rollback)', async () => {
    const email = 'a4@x.com'
    await recover(email)
    const code = lastCode(email)
    const conns: any[] = []
    getConn.mockImplementation(async () => { const c = newConn(); conns.push(c); return c })
    await change(email, wrongOf(code))
    expect(resets[0].failed).toBe(1)
    expect(conns[0].commit).toHaveBeenCalled()
    expect(conns[0].rollback).not.toHaveBeenCalled()
  })
})

describe('Q-PV38 — resposta neutra (não revela se o e-mail existe)', () => {
  it('recovery: e-mail inexistente, inativo e existente respondem IGUAL (status e corpo); só o existente recebe código', async () => {
    const yes = await recover('a5@x.com')
    const no  = await recover('ninguem@x.com')
    const off = await recover('inativo@x.com')
    expect(no.status).toBe(yes.status)
    expect(no.body).toEqual(yes.body)
    expect(off.body).toEqual(yes.body)
    expect(mail).toHaveBeenCalledTimes(1)
    expect(resets.map(r => r.userId)).toEqual([userByEmail('a5@x.com').id])
  })

  it('change: e-mail inexistente, conta inativa, sem código, código errado, esgotado, vencido e já usado = a MESMA 401', async () => {
    const outcomes: any[] = []
    outcomes.push(await change('ninguem@x.com', '123456'))            // e-mail inexistente
    outcomes.push(await change('inativo@x.com', '123456'))            // conta inativa
    outcomes.push(await change('a6@x.com', '123456'))                 // conta sem código
    await recover('a7@x.com')
    const code7 = lastCode('a7@x.com')
    outcomes.push(await change('a7@x.com', wrongOf(code7)))           // errado
    for (let i = 1; i < PASSWORD_RESET_MAX_FAILED_ATTEMPTS; i++) await change('a7@x.com', wrongOf(code7, i))
    outcomes.push(await change('a7@x.com', code7))                    // esgotado (com o certo)
    await recover('a8@x.com')
    const code8 = lastCode('a8@x.com')
    now += (PASSWORD_RESET_TTL_MINUTES * 60 + 1) * 1000
    outcomes.push(await change('a8@x.com', code8))                    // vencido
    await recover('a9@x.com')
    const code9 = lastCode('a9@x.com')
    expect((await change('a9@x.com', code9)).status).toBe(200)
    outcomes.push(await change('a9@x.com', code9))                    // já usado
    for (const o of outcomes) expect([o.status, o.body]).toEqual([401, { error: INVALID_PASSWORD_RESET_CODE }])
  })

  it('falha do banco DEPOIS de achar a conta não vira oráculo (200 genérico / 401 neutra) — e a PANE vira alarme com ref na crashlytics', async () => {
    const generic = (await recover('ninguem@x.com')).body
    failNext = { match: 'lastHour', err: new Error('Connection lost: The server closed the connection.') }
    const r = await recover('a10@x.com')
    expect([r.status, r.body]).toEqual([200, generic])
    expect(mail).not.toHaveBeenCalled()
    expect(recordCrash).toHaveBeenCalledWith(expect.objectContaining({ ref: 'REFQPV38', userId: userByEmail('a10@x.com').id }))
    await recover('a10@x.com')
    failNext = { match: 'ORDER BY seq DESC LIMIT 1', err: new Error('boom') }
    const c = await change('a10@x.com', lastCode('a10@x.com'))
    expect([c.status, c.body]).toEqual([401, { error: INVALID_PASSWORD_RESET_CODE }])
    expect(recordCrash).toHaveBeenCalledTimes(2)
    // o log do alarme leva só código/mensagem — nunca o `sql` do mysql2 (com o MD5 da senha nova formatado)
    const logged = JSON.stringify((logger.error as jest.Mock).mock.calls)
    expect(logged).not.toMatch(/"sql"/)
  })

  it('CONTENÇÃO (lock wait na trava do usuário) é carga normal: resposta neutra, só aviso — sem alarme na crashlytics', async () => {
    await recover('a10@x.com')
    const code = lastCode('a10@x.com')
    failNext = { match: 'SELECT id, active, password FROM setes_central.tb_user', err: lockWait('ER_LOCK_WAIT_TIMEOUT', 1205) }
    const c = await change('a10@x.com', code)
    expect([c.status, c.body]).toEqual([401, { error: INVALID_PASSWORD_RESET_CODE }])
    expect(recordCrash).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('contenção'), expect.anything())
    expect((await change('a10@x.com', code)).status).toBe(200)          // a tentativa contida não contou
  })

  it('a trava da linha do usuário espera no máximo 5 s (FOR UPDATE WAIT 5 — rota pública não prende o pool)', async () => {
    setLockWaitSupported(true)
    try {
      await recover('a11@x.com')
      expect(seenSql.some(q => /FROM setes_central\.tb_user WHERE id = \? AND deleted = 'N' FOR UPDATE WAIT 5/.test(q))).toBe(true)
    } finally {
      setLockWaitSupported(false)
    }
  })

  it('TEMPO neutro: o recovery responde antes da emissão (a transação e o SMTP correm depois da resposta)', async () => {
    let releaseConn: () => void = () => undefined
    getConn.mockImplementationOnce(() => new Promise(r => { releaseConn = () => r(newConn()) }))
    const res = await request(app).post('/auth/recovery-password').send({ email: 'a12@x.com' })
    expect(res.status).toBe(200)                                        // respondeu com a conexão da emissão ainda presa
    expect(resets).toEqual([])
    releaseConn()
    await waitForPendingPasswordResets()
    expect(resets).toHaveLength(1)
  })

  it(`TEMPO neutro no change: toda resposta espera o piso (${PASSWORD_RESET_RESPONSE_FLOOR_MS} ms) — conta existente (com transação) e inexistente levam o mesmo tempo`, async () => {
    setPasswordResetResponseFloor(PASSWORD_RESET_RESPONSE_FLOOR_MS)
    try {
      await recover('a13@x.com')
      const time = async (email: string) => { const t = Date.now(); const r = await change(email, '000001'); return [Date.now() - t, r.status] as const }
      const [missing, s1] = await time('ninguem-tempo@x.com')
      const [existing, s2] = await time('a13@x.com')
      expect([s1, s2]).toEqual([401, 401])
      expect(missing).toBeGreaterThanOrEqual(PASSWORD_RESET_RESPONSE_FLOOR_MS - 5)
      expect(existing).toBeGreaterThanOrEqual(PASSWORD_RESET_RESPONSE_FLOOR_MS - 5)
      expect(Math.abs(existing - missing)).toBeLessThan(250)
      const t = Date.now()
      expect((await recover('ninguem-tempo@x.com')).status).toBe(200)
      expect(Date.now() - t).toBeGreaterThanOrEqual(PASSWORD_RESET_RESPONSE_FLOOR_MS - 5)
    } finally {
      setPasswordResetResponseFloor(0)
    }
  })

  it('o envio do e-mail não segura a resposta do recovery (o tempo do SMTP diria que a conta existe)', async () => {
    let releaseMail: () => void = () => undefined
    mail.mockImplementationOnce(() => new Promise<void>(r => { releaseMail = r }))
    const r = await request(app).post('/auth/recovery-password').send({ email: 'a11@x.com' })   // SMTP "pendurado"
    expect(r.status).toBe(200)
    for (let i = 0; i < 20 && mail.mock.calls.length === 0; i++) await new Promise(res => setImmediate(res))
    expect(mail).toHaveBeenCalledTimes(1)
    releaseMail()
    await waitForPendingPasswordResets()
  })
})

describe('Q-PV38 — o código vai ao e-mail GRAVADO e nunca é guardado', () => {
  it('pedido com e-mail "parecido" (acento no domínio, caixa, espaço no fim) acha a conta mas o código vai ao e-mail GRAVADO', async () => {
    for (const variant of ['fulano@gmaíl.com', 'FULANO@Gmail.com ', 'fulano@gmaıl.com']) {
      mail.mockClear()
      now += 3600_000                                                  // fora do teto por hora
      await recover(variant)
      expect(mail).toHaveBeenCalledTimes(1)
      expect(mail.mock.calls[0][0].to).toBe('fulano@gmail.com')
    }
  })

  it('o banco guarda só o HMAC (64 hex), nunca o código; o HMAC amarra a linha (seq) e o código', async () => {
    await recover('a12@x.com')
    const code = lastCode('a12@x.com')
    expect(resets[0].codeHmac).toMatch(/^[0-9a-f]{64}$/)
    expect(resets[0].codeHmac).not.toContain(code)
  })

  it('trocar a senha por OUTRO caminho (PUT do admin) invalida o código aberto por construção', async () => {
    await recover('a13@x.com')
    const code = lastCode('a13@x.com')
    users.get(userByEmail('a13@x.com').id)!.password = 'HASH-TROCADO-PELO-ADMIN'
    expect((await change('a13@x.com', code)).status).toBe(401)
    expect(passwordWrites).toEqual([])
  })

  it('trocar o e-mail de login invalida o código aberto (pelo e-mail novo o HMAC não casa; pelo antigo a conta nem é achada)', async () => {
    await recover('a14@x.com')
    const code = lastCode('a14@x.com')
    userByEmail('a14@x.com').email = 'a14-novo@x.com'
    expect((await change('a14-novo@x.com', code)).status).toBe(401)
    expect((await change('a14@x.com', code)).status).toBe(401)
    expect(passwordWrites).toEqual([])
  })

  it('pedir código novo substitui o anterior (vale só o de maior seq)', async () => {
    await recover('a15@x.com')
    const first = lastCode('a15@x.com')
    await recover('a15@x.com')
    const second = lastCode('a15@x.com')
    if (first !== second) expect((await change('a15@x.com', first)).status).toBe(401)
    expect((await change('a15@x.com', second)).status).toBe(200)
    expect(resets.map(r => r.seq)).toEqual([1, 2])
  })
})

describe('Q-PV38 — limite por e-mail (durável por conta + memória por e-mail canônico)', () => {
  it(`teto DURÁVEL de emissões: ${PASSWORD_RESET_MAX_PER_HOUR} por hora e ${PASSWORD_RESET_MAX_PER_DAY} por 24 h por conta — acima disso o pedido é calado (mesma resposta)`, async () => {
    const email = 'a16@x.com'
    const generic = (await recover('ninguem@x.com')).body
    for (let i = 0; i < PASSWORD_RESET_MAX_PER_HOUR; i++) await issue(email)
    await issue(email)
    expect(resets).toHaveLength(PASSWORD_RESET_MAX_PER_HOUR)
    expect(mail).toHaveBeenCalledTimes(PASSWORD_RESET_MAX_PER_HOUR)
    // a resposta HTTP do pedido calado é a genérica
    const capped = await recover(email)
    expect([capped.status, capped.body]).toEqual([200, generic])
    // passando as horas, o teto por DIA segura
    for (let h = 0; h < 30 && resets.length < PASSWORD_RESET_MAX_PER_DAY + 2; h++) {
      now += 3600_000 + 1
      for (let i = 0; i < PASSWORD_RESET_MAX_PER_HOUR; i++) await issue(email)
      const lastDay = resets.filter(r => r.createdAt > now - 24 * 3600_000).length
      expect(lastDay).toBeLessThanOrEqual(PASSWORD_RESET_MAX_PER_DAY)
    }
  })

  it(`memória: o ${CHANGE_PER_EMAIL.max + 1}º POST /change-password do mesmo e-mail em ${CHANGE_PER_EMAIL.windowMinutes} min = 429 — variações de caixa/acento contam no MESMO balde`, async () => {
    const variants = ['limite@x.com', 'LIMITE@x.com', 'límite@x.com ', 'limite@X.COM']
    for (let i = 0; i < CHANGE_PER_EMAIL.max; i++) expect((await change(variants[i % variants.length], '123456')).status).toBe(401)
    const blocked = await change('Limite@x.com', '123456')
    expect(blocked.status).toBe(429)
    expect(normalizeLoginEmail('límite@x.com ')).toBe('limite@x.com')
  })

  it('memória: a 429 é a MESMA para e-mail que existe e que não existe (o limite não diz quem existe)', async () => {
    const existing = 'valdo@setes.com.br', missing = 'nao-existe-mesmo@x.com'
    let a: any, b: any
    for (let i = 0; i <= RECOVERY_PER_EMAIL.max; i++) { a = await recover(existing); b = await recover(missing) }
    expect([a.status, b.status]).toEqual([429, 429])
    expect(a.body).toEqual(b.body)
  })

  it('memória: a chave do balde tem TAMANHO FIXO (o corpo aceita 2 MB) e segue as dobras da colação (ß = s, ı = i, espaço só no fim)', () => {
    expect(loginEmailBucket('x'.repeat(2_000_000) + '@x.com')).toMatch(/^[0-9a-f]{64}$/)
    expect(loginEmailBucket('straße@x.com')).toBe(loginEmailBucket('STRASE@x.com'))
    expect(loginEmailBucket('STRAẞE@x.com')).not.toBe(loginEmailBucket('strase@x.com'))   // ẞ (U+1E9E): o banco também NÃO iguala
    expect(loginEmailBucket('fulano@gmaıl.com')).toBe(loginEmailBucket('fulano@gmail.com'))
    expect(loginEmailBucket('a@x.com   ')).toBe(loginEmailBucket('a@x.com'))
    expect(normalizeLoginEmail(' a@x.com')).toBe(' a@x.com')               // o banco NÃO ignora o espaço do início
  })

  it('memória: o limite por e-mail não escreve cabeçalhos RateLimit-* (o "restante" diria se outra pessoa usou aquele e-mail)', async () => {
    const r = await change('cabecalho@x.com', '123456')
    expect(r.headers['ratelimit-limit']).toBe('300')                      // só o do limite por IP (app.ts)
  })

  it('memória: e-mail em array não escapa do balde (mesma coerção da rota)', async () => {
    for (let i = 0; i < CHANGE_PER_EMAIL.max; i++) await change(['array@x.com'], '123456')
    expect((await change('array@x.com', '123456')).status).toBe(429)
  })
})

describe('Q-PV38 — boot', () => {
  it('o boot confere a tabela (sql/67) e o HMAC; sem a tabela, a mensagem manda aplicar o script', async () => {
    await expect(assertPasswordResetReady()).resolves.toBe('ok')
    q.mockImplementationOnce(async () => { throw Object.assign(new Error("Table 'setes_central.tb_user_password_reset' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 }) })
    await expect(assertPasswordResetReady()).rejects.toThrow(/sql\/67_user_password_reset_ddl\.sql/)
  })
})

describe('Q-PV38 — o 400 do payload não vira oráculo do código', () => {
  it('senha curta = 400 ANTES de tocar o código (não soma tentativa nem diz se o código estava certo)', async () => {
    await recover('a5@x.com')
    const code = lastCode('a5@x.com')
    const r = await change('a5@x.com', code, 'abc')
    expect(r.status).toBe(400)
    expect(resets[0].failed).toBe(0)
    expect((await change('ninguem@x.com', '000000', 'abc')).status).toBe(400)
  })
})
