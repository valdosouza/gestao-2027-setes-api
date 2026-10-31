/// <reference types="jest" />
// =====================================================================================================================
// GATE ADVERSARIAL — D-RS4 / D-RS5 / D-PV46 (2026-10-21): o DELTA não commitado da branch `recuperacao-senha`.
//   D-RS4  aviso por e-mail ao DONO da conta (código esgotado por 5 erradas = kind E; teto de emissões = kind C), ≤ 1/h por conta,
//          fato durável em setes_central.tb_user_password_reset_notice (irmã do pedido), vaga lida+tomada na MESMA transação sob a
//          trava da linha de tb_user, e-mail NEUTRO depois do COMMIT em segundo plano; a resposta ao cliente NÃO muda (401/200, piso).
//   D-RS5  `assertMailerReady` no boot (produção sem SMTP não sobe); `describeMailerConfig` sem senha; `verifyMailerConnection`.
//   D-PV46 `scripts/reset-super-password.ts` + peça `super-password-reset.ts` (só o Super vivo e ativo da institution 1).
// Papel: QUEBRAR a implementação (skill testar-adversarial.md). Convenção da casa:
//   it          = [RESISTIU] — a defesa segura o ataque (o teste PASSA porque a promessa se cumpre).
//   it.failing  = [ACHADO]   — a asserção SEGURA que o código ATUAL quebra (jest marca verde: o achado está provado).
// Banco DUBLADO pelo texto do SQL — molde COPIADO de src/__tests__/adversarial-q-pv38-gate.test.ts (inclusive o handler da tabela
// irmã no TOPO de run() e a trava de REGISTRO emulada), com ganchos novos: falha injetada no INSERT do aviso e deadlock no aviso.
// A corrida REAL do InnoDB e a perda do +1 em banco de verdade são provadas à parte por scripts/adv-d-rs4-probe.ts (schema descartável).
// NÃO edita nenhum arquivo de produção nem os testes existentes. Tolerâncias de tempo folgadas (máquina carregada, suíte em paralelo).
// =====================================================================================================================
import request from 'supertest'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/mailer/mailer', () => ({
  __esModule: true, sendMail: jest.fn().mockResolvedValue(undefined), isMailerConfigured: jest.fn(() => true),
  isProduction: jest.fn(() => false),
}))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: () => 'REF00000', recordCrash: jest.fn().mockResolvedValue(undefined),
}))

import pool from '../shared/db/connection'
import { sendMail } from '../shared/mailer/mailer'
import app from '../app'
import {
  changePassword, recoveryPassword, waitForPendingPasswordResets, INVALID_PASSWORD_RESET_CODE, OWNER_NOTICE_SUBJECT,
  setPasswordResetResponseFloor, PASSWORD_RESET_RESPONSE_FLOOR_MS,
  PASSWORD_RESET_MAX_FAILED_ATTEMPTS, PASSWORD_RESET_MAX_PER_HOUR, PASSWORD_RESET_MAX_PER_DAY,
} from '../modules/auth/auth.service'
import { assertPasswordResetSchema, PASSWORD_RESET_NOTICE_WINDOW_MINUTES } from '../modules/auth/auth.repository'
import {
  resetSuperPasswordTx, generateInitialPassword, hashInitialPassword, INITIAL_PASSWORD_ALPHABET, INITIAL_PASSWORD_LENGTH,
} from '../modules/auth/super-password-reset'
import logger from '../shared/logger/logger'
import { recordCrash } from '../shared/errors/crash.repository'
import { md5Password } from '../shared/auth/password'

const q = (pool as any).query as jest.Mock
const getConn = (pool as any).getConnection as jest.Mock
const mail = sendMail as jest.Mock

// ---- o mundo do dublê (molde do gate da Q-PV38) ----------------------------------------------------------------------
interface User { id: number; password: string | null; active: string; deleted: string; email: string }
interface ResetRow { userId: number; seq: number; codeHmac: string; failed: number; usedAt: number | null; createdAt: number; deleted: string }

let now: number                                   // relógio do BANCO (NOW()) em ms
let users: Map<number, User>
let resets: ResetRow[]
let passwordWrites: Array<{ userId: number; hash: string }>
let activationKeyWrites: number[]
let notices: Array<{ userId: number; seq: number; kind: string; createdAt: number }>   // D-RS4: aviso ao dono (tabela irmã)
let deadlockOnce: string | null                   // injeta UM ER_LOCK_DEADLOCK no 1º statement que casar (depois limpa)
const locks = new Map<number, { owner: object; waiters: Array<() => void> }>()
let txLatencyMs = 0
let failUpdatePasswordWith: any = null
let releaseTimes: number[] = []
// ganchos NOVOS deste gate
let failNoticeInsertWith: any = null               // erro no INSERT do aviso (ex.: INSERT negado só nessa tabela — 1142; CHECK — 4025)
let noticeInserts = 0                              // quantas vezes o INSERT do aviso foi tentado

const dbEq = (a: string, b: string) => {
  const f = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/ß/g, 's').replace(/ı/g, 'i').toLowerCase().replace(/ +$/, '')
  return f(a) === f(b)
}

function seedUsers(): void {
  users = new Map()
  let id = 10
  for (const email of [
    'valdo@setes.com.br', 'b1@x.com', 'b2@x.com', 'b3@x.com', 'b4@x.com', 'b5@x.com', 'b6@x.com', 'b7@x.com',
    'b8@x.com', 'b9@x.com', 'b10@x.com', 'b11@x.com', 'b12@x.com', 'b13@x.com', 'straße@x.com', 'b15@x.com', 'b16@x.com',
    'b17@x.com', 'b18@x.com', 'b19@x.com', 'b20@x.com',
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
  if (deadlockOnce && sql.includes(deadlockOnce)) {
    deadlockOnce = null
    throw Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 })
  }
  // D-RS4: a tabela IRMÃ do aviso ao dono — casada ANTES dos handlers do pedido (cujas regexes não param na fronteira do nome).
  if (/tb_user_password_reset_notice/.test(sql)) {
    if (/AS recent/.test(sql)) {
      const [userId, windowMinutes] = params
      if (!owner) throw new Error('coalescência do aviso fora da transação')
      return [[{ recent: notices.some(n => n.userId === Number(userId) && n.createdAt > now - Number(windowMinutes) * 60_000) ? 1 : 0 }]]
    }
    if (/nextSeq/.test(sql)) {
      const seqs = notices.filter(n => n.userId === Number(params[0])).map(n => n.seq)
      return [[{ nextSeq: (seqs.length ? Math.max(...seqs) : 0) + 1 }]]
    }
    if (/^\s*INSERT INTO/.test(sql)) {
      const [userId, seq, kind] = params
      if (!owner) throw new Error('vaga do aviso fora da transação')
      noticeInserts++
      if (failNoticeInsertWith) throw failNoticeInsertWith
      if (!['E', 'C'].includes(String(kind))) throw Object.assign(new Error('CONSTRAINT ck_user_password_reset_notice_kind failed'), { errno: 4025 })
      if (Number(seq) <= 0) throw Object.assign(new Error('CONSTRAINT ck_user_password_reset_notice_seq failed'), { errno: 4025 })
      if (notices.some(n => n.userId === Number(userId) && n.seq === Number(seq))) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', errno: 1062 })
      const row = { userId: Number(userId), seq: Number(seq), kind: String(kind), createdAt: now }
      notices.push(row)
      undo.push(() => { notices = notices.filter(n => n !== row) })
      return [{ affectedRows: 1 }]
    }
    return [[]]
  }
  if (/FROM setes_central\.tb_user u\s/.test(sql) && /tb_mailing_group_id = 2/.test(sql)) {
    const [email] = params
    const u = [...users.values()].filter(x => x.deleted === 'N' && dbEq(x.email, String(email))).sort((a, b) => a.id - b.id)[0]
    return [u ? [{ id: u.id, password: u.password, active: u.active, loginEmail: u.email }] : []]
  }
  if (/SELECT id, active, password FROM setes_central\.tb_user WHERE id = \? AND deleted = 'N' FOR UPDATE(?: WAIT \d+)?/.test(sql)) {
    const [userId] = params
    if (!owner) throw new Error('FOR UPDATE fora de transação')
    const u = users.get(Number(userId))
    if (!u || u.deleted !== 'N') return [[]]
    await acquire(u.id, owner)
    if (txLatencyMs) await new Promise(r => setTimeout(r, txLatencyMs))
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
    if (!/^[0-9a-f]{64}$/.test(codeHmac)) throw new Error('CHECK ck_user_password_reset_code_hmac')
    const row: ResetRow = { userId: Number(userId), seq: Number(seq), codeHmac, failed: 0, usedAt: null, createdAt: now, deleted: 'N' }
    if (resets.some(r => r.userId === row.userId && r.seq === row.seq)) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' })
    resets.push(row)
    undo.push(() => { resets = resets.filter(r => r !== row) })
    return [{ affectedRows: 1 }]
  }
  if (/ORDER BY seq DESC LIMIT 1/.test(sql)) {
    const [ttl, userId] = params
    const r = resets.filter(x => x.userId === Number(userId)).sort((a, b) => b.seq - a.seq)[0]
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
    if (failUpdatePasswordWith) throw failUpdatePasswordWith(params)
    const [hash, userId] = params
    const u = users.get(Number(userId))!
    const before = u.password
    u.password = hash
    passwordWrites.push({ userId: u.id, hash })
    if (/activation_key = NULL/.test(sql)) activationKeyWrites.push(u.id)
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
    release:  jest.fn(() => { releaseTimes.push(Date.now()) }),
    query:    jest.fn((sql: string, params: any[] = []) => run(sql, params, owner, undo)),
  }
}

const isNoticeMail = (c: any[]) => c[0].subject === OWNER_NOTICE_SUBJECT
const isCodeMail   = (c: any[]) => /código de recuperação é (\d{6})/.test(c[0].text ?? '')
const noticeMails  = () => mail.mock.calls.filter(isNoticeMail)
const codeMails    = () => mail.mock.calls.filter(isCodeMail)
const lastCode = (to: string): string => {
  const call = [...mail.mock.calls].reverse().find(c => c[0].to === to && isCodeMail(c))
  if (!call) throw new Error(`nenhum e-mail para ${to}`)
  return /código de recuperação é (\d{6})/.exec(call[0].text)![1]
}
const wrongOf = (code: string, i = 0) => String((Number(code) - 100000 + 1 + i) % 900000 + 100000)
const recover = async (email: string): Promise<void> => { await recoveryPassword(email); await waitForPendingPasswordResets() }
/** N tentativas ERRADAS em série (pelo service, piso 0); devolve os vereditos HTTP. */
async function wrongs(email: string, code: string, n: number, from = 0): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    try { await changePassword(email, wrongOf(code, from + i), 'nova-senha'); out.push(200) } catch (e: any) { out.push(e.statusCode) }
  }
  return out
}

beforeAll(() => setPasswordResetResponseFloor(0))
afterAll(() => setPasswordResetResponseFloor(PASSWORD_RESET_RESPONSE_FLOOR_MS))

beforeEach(() => {
  jest.clearAllMocks()
  mail.mockImplementation(async () => undefined)
  now = Date.parse('2026-10-21T12:00:00Z')
  seedUsers()
  resets = []
  notices = []
  passwordWrites = []
  activationKeyWrites = []
  deadlockOnce = null
  txLatencyMs = 0
  failUpdatePasswordWith = null
  failNoticeInsertWith = null
  noticeInserts = 0
  releaseTimes = []
  locks.clear()
  q.mockImplementation((sql: string, params: any[] = []) => run(sql, params, null, []))
  getConn.mockImplementation(async () => newConn())
})
afterEach(async () => { await waitForPendingPasswordResets() })

const change = (email: any, code: string, newPassword = 'nova-senha') =>
  request(app).post('/auth/change-password').send({ email, code, newPassword })
const FLOOR = PASSWORD_RESET_RESPONSE_FLOOR_MS
async function withFloor<T>(fn: () => Promise<T>): Promise<T> {
  setPasswordResetResponseFloor(FLOOR)
  try { return await fn() } finally { setPasswordResetResponseFloor(0) }
}
const timed = async (p: PromiseLike<any>) => { const t = Date.now(); const r = await p; return { ms: Date.now() - t, r } }

// =====================================================================================================================
// (a) ORÁCULO DE EXISTÊNCIA PELO AVISO — a 5ª errada faz EXISTS + MAX + INSERT a mais e dispara SMTP: o tempo/status/corpo mudam?
// =====================================================================================================================
describe('[ataque] a 5ª errada (que toma a vaga) vaza pelo tempo, status ou corpo?', () => {
  it('[RESISTIU] 5ª errada (vaga tomada) × errada comum × conta inexistente: a MESMA 401 + corpo, todas no piso, diferença < 300 ms', async () => {
    const email = 'b1@x.com'
    await recover(email)
    const code = lastCode(email)
    await wrongs(email, code, PASSWORD_RESET_MAX_FAILED_ATTEMPTS - 2)                          // 3 erradas (piso 0)
    const out = await withFloor(async () => [
      await timed(change(email, wrongOf(code, 3))),                   // 4ª: errada comum
      await timed(change(email, wrongOf(code, 4))),                   // 5ª: ESGOTA e toma a vaga (3 statements a mais + SMTP em 2º plano)
      await timed(change('ninguem-rs4@x.com', '123456')),             // inexistente: só a busca
    ])
    expect(out.map(o => [o.r.status, o.r.body])).toEqual(Array(3).fill([401, { error: INVALID_PASSWORD_RESET_CODE }]))
    expect(Math.min(...out.map(o => o.ms))).toBeGreaterThanOrEqual(FLOOR - 5)
    expect(Math.max(...out.map(o => o.ms)) - Math.min(...out.map(o => o.ms))).toBeLessThan(300)
    expect(notices).toEqual([{ userId: 11, seq: 1, kind: 'E', createdAt: now }])
    expect(noticeMails()).toHaveLength(1)
  })

  it('[RESISTIU] SMTP LENTO (1,5 s) no aviso: a 401 da 5ª errada sai no piso (o e-mail corre em 2º plano, depois do COMMIT)', async () => {
    const email = 'b2@x.com'
    await recover(email)
    const code = lastCode(email)
    await wrongs(email, code, PASSWORD_RESET_MAX_FAILED_ATTEMPTS - 1)
    mail.mockImplementation((m: any) => m.subject === OWNER_NOTICE_SUBJECT ? new Promise(r => setTimeout(r, 1500)) : Promise.resolve())
    const { ms, r } = await withFloor(() => timed(change(email, wrongOf(code, 9))))
    expect([r.status, r.body]).toEqual([401, { error: INVALID_PASSWORD_RESET_CODE }])
    expect(ms).toBeLessThan(FLOOR + 400)                                                       // não esperou os 1,5 s do SMTP
    expect(notices).toHaveLength(1)                                                            // a vaga já estava COMMITADA
    await waitForPendingPasswordResets()
    expect(noticeMails()).toHaveLength(1)
  })

  it('[RESISTIU] recovery no TETO (4º pedido na hora, vaga C) com SMTP lento responde no piso — igual à conta inexistente', async () => {
    const email = 'b3@x.com'
    for (let i = 0; i < PASSWORD_RESET_MAX_PER_HOUR; i++) await recover(email)
    mail.mockImplementation((m: any) => m.subject === OWNER_NOTICE_SUBJECT ? new Promise(r => setTimeout(r, 1500)) : Promise.resolve())
    const [a, b] = await withFloor(async () => [
      await timed(request(app).post('/auth/recovery-password').send({ email })),
      await timed(request(app).post('/auth/recovery-password').send({ email: 'ninguem-rs4b@x.com' })),
    ])
    expect([a.r.status, b.r.status]).toEqual([200, 200])
    expect(a.r.body).toEqual(b.r.body)
    expect(Math.abs(a.ms - b.ms)).toBeLessThan(300)
    await waitForPendingPasswordResets()
    expect(notices).toEqual([expect.objectContaining({ userId: 13, seq: 1, kind: 'C' })])
    expect(noticeMails()).toHaveLength(1)
    expect(codeMails()).toHaveLength(PASSWORD_RESET_MAX_PER_HOUR)                             // o aviso NÃO entrou no teto de códigos
  })
})

// =====================================================================================================================
// PROMESSAS DO E-MAIL — ao e-mail GRAVADO; texto sem código/contagem/causa/link; kind nunca no e-mail; inexistente/inativo nunca avisa
// =====================================================================================================================
describe('[ataque] o que o e-mail do aviso entrega a quem o lê (ou intercepta)', () => {
  it('[RESISTIU] aviso vai ao e-mail GRAVADO (pedido com variante da colação ß=s); texto idêntico para E e C, sem dígito, link, kind ou código', async () => {
    // E: esgotar o código da conta straße@x.com pedindo como "strase@x.com"
    await recover('strase@x.com')
    const code = lastCode('straße@x.com')
    await wrongs('strase@x.com', code, PASSWORD_RESET_MAX_FAILED_ATTEMPTS)
    await waitForPendingPasswordResets()
    // C: teto na conta b4 (hora seguinte para não coalescer com nada)
    for (let i = 0; i <= PASSWORD_RESET_MAX_PER_HOUR; i++) await recover('b4@x.com')
    const sent = noticeMails()
    expect(sent).toHaveLength(2)
    expect(sent[0][0].to).toBe('straße@x.com')
    expect(sent[1][0].to).toBe('b4@x.com')
    const [e, c] = sent.map(s => s[0])
    expect([e.text, e.html]).toEqual([c.text, c.html])                                        // a CAUSA não é inferível pelo texto
    for (const m of [e, c]) {
      expect(m.subject).toBe(OWNER_NOTICE_SUBJECT)
      expect(m.text).not.toMatch(/\d/)                                                         // nem código, nem contagem, nem "5"
      expect(m.text + m.html).not.toMatch(/https?:|href=/i)                                    // nenhum link de ação (anti-phishing)
      expect(m.text + m.html).not.toContain(code)
      expect(JSON.stringify(m)).not.toMatch(/"kind"|kind:/)
      expect(m.subject).not.toMatch(/código de recuperação/i)
    }
    expect(notices.map(n => n.kind)).toEqual(['E', 'C'])                                        // a causa fica só no banco (forense)
  })

  it('[RESISTIU] e-mail INEXISTENTE e conta INATIVA: 20 erradas + 6 pedidos = nenhuma linha, nenhum e-mail, nenhuma transação', async () => {
    for (const email of ['ninguem-rs4c@x.com', 'inativo@x.com']) {
      for (let i = 0; i < 20; i++) await expect(changePassword(email, String(100000 + i), 'nova-senha')).rejects.toMatchObject({ statusCode: 401 })
      for (let i = 0; i < 6; i++) await recover(email)
    }
    expect(notices).toEqual([])
    expect(mail).not.toHaveBeenCalled()
    expect(getConn).not.toHaveBeenCalled()
  })
})

// =====================================================================================================================
// (b) COALESCÊNCIA SOB CORRIDA — duas 5ªs em paralelo; esgotado + teto na mesma hora; fronteira dos 60 min; seq MAX+1; deadlock no aviso
// =====================================================================================================================
describe('[ataque] furar o "no máximo 1 aviso por hora por conta"', () => {
  it('[RESISTIU] duas 5ªs erradas em PARALELO = 1 vaga (a 2ª lê failed = 5 sob a trava e vira "exhausted" sem aviso); failed = 5', async () => {
    const email = 'b5@x.com'
    await recover(email)
    const code = lastCode(email)
    await wrongs(email, code, PASSWORD_RESET_MAX_FAILED_ATTEMPTS - 1)
    const r = await Promise.allSettled([changePassword(email, wrongOf(code, 7), 'x-nova'), changePassword(email, wrongOf(code, 8), 'x-nova')])
    expect(r.every(x => x.status === 'rejected' && (x.reason as any).statusCode === 401)).toBe(true)
    expect(resets[0].failed).toBe(PASSWORD_RESET_MAX_FAILED_ATTEMPTS)
    expect(notices).toHaveLength(1)
    expect(noticeInserts).toBe(1)
    await waitForPendingPasswordResets()
    expect(noticeMails()).toHaveLength(1)
  })

  it('[RESISTIU] esgotado (E) e teto (C) na MESMA hora = 1 aviso; os 2 gatilhos seguintes são calados ("já avisado nesta hora")', async () => {
    const email = 'b6@x.com'
    await recover(email)
    await wrongs(email, lastCode(email), PASSWORD_RESET_MAX_FAILED_ATTEMPTS)                  // E toma a vaga
    for (let i = 0; i < PASSWORD_RESET_MAX_PER_HOUR + 2; i++) await recover(email)             // 2 emitem, 3 calados → C sem vaga
    await wrongs(email, lastCode(email), PASSWORD_RESET_MAX_FAILED_ATTEMPTS + 2)              // esgota o 3º código → E sem vaga
    expect(notices.map(n => n.kind)).toEqual(['E'])
    expect(noticeMails()).toHaveLength(1)
    expect((logger.warn as jest.Mock).mock.calls.some(c => c[1]?.ownerNotice === 'já avisado nesta hora')).toBe(true)
  })

  it('[RESISTIU] fronteira: aos 59:59 do aviso nenhum novo; aos 60:00 exatos a vaga reabre com seq 2 — "1/h" = ≥ 60 min entre avisos', async () => {
    const email = 'b7@x.com'
    for (let i = 0; i <= PASSWORD_RESET_MAX_PER_HOUR; i++) await recover(email)                // 4º = C, vaga 1
    expect(notices).toHaveLength(1)
    now += (PASSWORD_RESET_NOTICE_WINDOW_MINUTES * 60 - 1) * 1000                             // 59:59 depois
    await recover(email)                                                                      // teto por hora ainda vale (3 na hora) → C calado
    expect(notices).toHaveLength(1)
    now += 1000                                                                               // 60:00 exatos
    await recover(email)                                                                      // os 3 códigos têm > 60 min → EMITE (não é teto)
    expect(codeMails()).toHaveLength(PASSWORD_RESET_MAX_PER_HOUR + 1)
    for (let i = 0; i < PASSWORD_RESET_MAX_PER_HOUR; i++) await recover(email)                 // 3 na nova hora → o último é C
    expect(notices.map(n => [n.seq, n.kind])).toEqual([[1, 'C'], [2, 'C']])
    expect(notices[1].createdAt - notices[0].createdAt).toBe(PASSWORD_RESET_NOTICE_WINDOW_MINUTES * 60_000)
  })

  it('[RESISTIU] seq = MAX+1 POR USUÁRIO (1,2,3 em 3 horas) e contas diferentes não compartilham numeração nem vaga', async () => {
    for (let h = 0; h < 3; h++) {
      now = Date.parse('2026-10-21T12:00:00Z') + h * 3600_000
      for (const email of ['b8@x.com', 'b9@x.com']) {
        await recover(email)
        await wrongs(email, lastCode(email), PASSWORD_RESET_MAX_FAILED_ATTEMPTS)
      }
    }
    expect(notices.filter(n => n.userId === 18).map(n => n.seq)).toEqual([1, 2, 3])
    expect(notices.filter(n => n.userId === 19).map(n => n.seq)).toEqual([1, 2, 3])
    expect(noticeMails()).toHaveLength(6)
  })

  it('[RESISTIU] deadlock injetado no INSERT do aviso: a transação REEXECUTA — 1 aviso, failed = 5 (nem 4 nem 6), 1 e-mail', async () => {
    const email = 'b10@x.com'
    await recover(email)
    const code = lastCode(email)
    await wrongs(email, code, PASSWORD_RESET_MAX_FAILED_ATTEMPTS - 1)
    deadlockOnce = 'INSERT INTO setes_central.tb_user_password_reset_notice'
    await expect(changePassword(email, wrongOf(code, 6), 'nova-senha')).rejects.toMatchObject({ statusCode: 401 })
    expect(resets[0].failed).toBe(PASSWORD_RESET_MAX_FAILED_ATTEMPTS)
    expect(notices).toHaveLength(1)
    expect(noticeInserts).toBe(1)                                                              // o INSERT abortado pelo deadlock não chega ao handler; a reexecução, sim
    expect((logger.warn as jest.Mock).mock.calls.some(c => /Deadlock em auth\/change-password/.test(c[0]))).toBe(true)
    await waitForPendingPasswordResets()
    expect(noticeMails()).toHaveLength(1)
    expect(recordCrash).not.toHaveBeenCalled()
  })
})

// =====================================================================================================================
// (d) FALHA DO INSERT DO AVISO DEPOIS DO +1 — o fato de SEGURANÇA (a tentativa errada contada) virou refém do fato de CONVENIÊNCIA (o aviso)
// =====================================================================================================================
describe('[ataque] derrubar o aviso para reabrir a força bruta', () => {
  const denied = () => Object.assign(new Error("INSERT command denied to user 'setes_api'@'%' for table 'tb_user_password_reset_notice'"),
    { code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 })

  // Promessa 1 do gate da Q-PV38: "5 erradas e a 6ª com o código CERTO = 401; o +1 é COMMITADO". Com o INSERT do aviso falhando de forma
  // DETERMINÍSTICA (ex.: usuário de banco de produção — Onda 4 — com SELECT mas sem INSERT na tabela NOVA: o boot só faz SELECT … LIMIT 0 e
  // passa; CHECK/coluna divergente; tablespace cheio só nela), a 5ª errada lança → ROLLBACK → o +1 volta a 4 → o código NUNCA esgota.
  it('[CORRIGIDO·MEDIUM] INSERT do aviso negado (1142): a vaga fica sob SAVEPOINT (Q-RS10) — o +1 da 5ª errada SOBREVIVE, failed chega a 5 e o código CERTO depois é recusado', async () => {
    const email = 'b11@x.com'
    await recover(email)
    const code = lastCode(email)
    failNoticeInsertWith = denied()
    const verdicts = await wrongs(email, code, PASSWORD_RESET_MAX_FAILED_ATTEMPTS + 3)       // 8 erradas: a 5ª, 6ª, 7ª e 8ª "esgotariam"
    expect(verdicts.every(v => v === 401)).toBe(true)                                           // o atacante vê a MESMA 401 em todas
    expect(resets[0].failed).toBe(PASSWORD_RESET_MAX_FAILED_ATTEMPTS)                           // SEGURA: o contador tem de chegar ao teto…
    await expect(changePassword(email, code, 'tomada')).rejects.toMatchObject({ statusCode: 401 }) // …e o certo depois tem de ser recusado
    expect(passwordWrites).toEqual([])
  })

  it('[RESISTIU] …mas a pane NÃO fica muda nem vaza: cada 5ª errada que falha vira alarme (recordCrash) e a resposta segue a MESMA 401', async () => {
    const email = 'b12@x.com'
    await recover(email)
    const code = lastCode(email)
    failNoticeInsertWith = denied()
    const out = await withFloor(async () => [
      await timed(change(email, wrongOf(code, 0))), await timed(change(email, wrongOf(code, 1))), await timed(change(email, wrongOf(code, 2))),
      await timed(change(email, wrongOf(code, 3))), await timed(change(email, wrongOf(code, 4))),   // a 5ª: INSERT falha
    ])
    expect(out.map(o => [o.r.status, o.r.body])).toEqual(Array(5).fill([401, { error: INVALID_PASSWORD_RESET_CODE }]))
    expect(Math.max(...out.map(o => o.ms)) - Math.min(...out.map(o => o.ms))).toBeLessThan(300)
    expect(recordCrash).toHaveBeenCalledTimes(1)
    expect((recordCrash as jest.Mock).mock.calls[0][0]).toMatchObject({ userId: 22, origen: expect.stringContaining('change-password') })
    expect(noticeMails()).toHaveLength(0)                                                       // nenhum e-mail sem a vaga gravada
  })

  it('[RESISTIU] INSERT do aviso negado no RECOVERY (teto): 200 genérico no piso, nenhum código emitido a mais, alarme — o teto segue valendo', async () => {
    const email = 'b13@x.com'
    for (let i = 0; i < PASSWORD_RESET_MAX_PER_HOUR; i++) await recover(email)
    failNoticeInsertWith = denied()
    const [a, b] = await withFloor(async () => [
      await timed(request(app).post('/auth/recovery-password').send({ email })),
      await timed(request(app).post('/auth/recovery-password').send({ email: 'ninguem-rs4d@x.com' })),
    ])
    expect([a.r.status, b.r.status, a.r.body]).toEqual([200, 200, b.r.body])
    expect(Math.abs(a.ms - b.ms)).toBeLessThan(300)
    await waitForPendingPasswordResets()
    expect(resets.filter(r => r.userId === 23)).toHaveLength(PASSWORD_RESET_MAX_PER_HOUR)       // o teto não abriu (o veredito capped vem antes)
    expect(codeMails()).toHaveLength(PASSWORD_RESET_MAX_PER_HOUR)
    expect(recordCrash).toHaveBeenCalledTimes(1)
  })
})

// =====================================================================================================================
// (c) SPAM CONTRA A VÍTIMA — quantos e-mails por hora/dia o atacante provoca com códigos + avisos?
// =====================================================================================================================
describe('[ataque] usar o aviso para encher a caixa da vítima', () => {
  it('[RESISTIU] 24 h de ataque contínuo (5 pedidos + 6 erradas por hora): avisos ≤ 1/h (24), códigos = 10 (teto/dia) — total 34 e-mails/dia', async () => {
    const email = 'b15@x.com'
    const base = Date.parse('2026-10-21T00:00:00Z')
    const noticesPerHour: number[] = []
    for (let h = 0; h < 24; h++) {
      now = base + h * 3600_000
      const before = notices.length
      for (let i = 0; i < 5; i++) await recover(email)
      const latest = resets.filter(r => r.userId === 25).sort((a, b) => b.seq - a.seq)[0]
      if (latest && latest.createdAt === now) await wrongs(email, lastCode(email), PASSWORD_RESET_MAX_FAILED_ATTEMPTS + 1)
      noticesPerHour.push(notices.length - before)
    }
    expect(noticesPerHour.every(n => n <= 1)).toBe(true)
    expect(notices).toHaveLength(24)                                                            // 1 por hora, inclusive depois do teto/dia (kind C)
    expect(codeMails()).toHaveLength(PASSWORD_RESET_MAX_PER_DAY)
    expect(noticeMails()).toHaveLength(24)
    expect(mail).toHaveBeenCalledTimes(PASSWORD_RESET_MAX_PER_DAY + 24)                        // limite conhecido: 34/dia (antes do D-RS4: 10)
    expect(notices.slice(PASSWORD_RESET_MAX_PER_DAY).every(n => n.kind === 'C')).toBe(true)     // depois do teto/dia, 1 pedido/h basta
  })
})

// =====================================================================================================================
// (i) BOOT — as DUAS tabelas conferidas, cada ausência com o nome certo
// =====================================================================================================================
describe('[ataque] subir o setes-api com o 67 pela metade (banco que já passou pela versão anterior do 67)', () => {
  const noTable = (t: string) => Object.assign(new Error(`Table 'setes_central.${t}' doesn't exist`), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
  it('[RESISTIU] só a tabela irmã ausente → mensagem nomeia tb_user_password_reset_notice (D-RS4) e o sql/67; só a do pedido → Q-PV38', async () => {
    q.mockImplementation(async (sql: string) => { if (/tb_user_password_reset_notice/.test(sql)) throw noTable('tb_user_password_reset_notice'); return [[]] })
    await expect(assertPasswordResetSchema()).rejects.toThrow(/tb_user_password_reset_notice ausente ou incompleta.*sql\/67.*D-RS4/)
    q.mockImplementation(async (sql: string) => { if (/tb_user_password_reset LIMIT 0/.test(sql)) throw noTable('tb_user_password_reset'); return [[]] })
    await expect(assertPasswordResetSchema()).rejects.toThrow(/setes_central\.tb_user_password_reset ausente.*Q-PV38/)
    // coluna `kind` ausente na irmã (versão divergente) → mesma mensagem, pelo nome
    q.mockImplementation(async (sql: string) => { if (/_notice/.test(sql)) throw Object.assign(new Error("Unknown column 'kind'"), { code: 'ER_BAD_FIELD_ERROR', errno: 1054 }); return [[]] })
    await expect(assertPasswordResetSchema()).rejects.toThrow(/tb_user_password_reset_notice ausente ou incompleta/)
  })
})

// =====================================================================================================================
// (f) D-RS5 — a peça REAL do mailer (nodemailer real; sem enviar nada): variantes de ambiente e a senha fora de todo texto
// =====================================================================================================================
describe('[ataque] D-RS5 — variantes do .env contra assertMailerReady / mailerConfigProblems / verifyMailerConnection', () => {
  const real = jest.requireActual('../shared/mailer/mailer') as typeof import('../shared/mailer/mailer')
  const KEYS = ['NODE_ENV', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'] as const
  const saved: Record<string, string | undefined> = {}
  const SECRET = 'S3nh4-d0-SMTP-adv'
  const env = (vars: Partial<Record<typeof KEYS[number], string>>) => {
    for (const k of KEYS) delete process.env[k]
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v
  }
  const complete = { SMTP_HOST: 'smtp.setes.com.br', SMTP_PORT: '587', SMTP_USER: 'nao-responda@setes.com.br', SMTP_PASSWORD: SECRET, SMTP_FROM: 'Setes ERP <x@setes.com.br>' }
  beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k] })
  afterAll(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

  it('[RESISTIU] SMTP_PORT: "0", "-1", "1e3", "65536", "abc", "587.0" inválidas; " 587 ", "00587", "" aceitas (587) — em produção o boot recusa as inválidas', () => {
    for (const bad of ['0', '-1', '1e3', '65536', 'abc', '587.0', '0x24B']) {
      env({ NODE_ENV: 'production', ...complete, SMTP_PORT: bad })
      expect(real.mailerConfigProblems().join(';')).toMatch(/SMTP_PORT inválida/)
      expect(() => real.assertMailerReady()).toThrow(/SMTP_PORT inválida/)
    }
    for (const ok of [' 587 ', '00587', '']) {
      env({ NODE_ENV: 'production', ...complete, SMTP_PORT: ok })
      expect(real.mailerConfigProblems()).toEqual([])
      expect(real.assertMailerReady()).toMatch(/:587 \(STARTTLS\)/)
    }
  })

  it('[RESISTIU] credencial pela metade: SMTP_PASSWORD="" (presente mas vazia) = ausente; só SMTP_PASSWORD = recusa; remetente só por SMTP_USER vale', () => {
    env({ NODE_ENV: 'production', ...complete, SMTP_PASSWORD: '' })
    expect(() => real.assertMailerReady()).toThrow(/SMTP_USER informado sem SMTP_PASSWORD/)
    env({ NODE_ENV: 'production', SMTP_HOST: 'h', SMTP_PORT: '465', SMTP_PASSWORD: SECRET, SMTP_FROM: 'x@y' })
    expect(() => real.assertMailerReady()).toThrow(/SMTP_PASSWORD informada sem SMTP_USER/)
    env({ NODE_ENV: 'production', SMTP_HOST: 'h', SMTP_PORT: '465', SMTP_USER: 'u@y', SMTP_PASSWORD: SECRET })
    expect(real.assertMailerReady()).toMatch(/de u@y, com autenticação/)
  })

  it('[RESISTIU] a senha SMTP não aparece em assertMailerReady, describeMailerConfig, nos problemas nem no erro REAL do verify (ECONNREFUSED em 127.0.0.1:1)', async () => {
    env({ NODE_ENV: 'production', ...complete, SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' })
    const texts = [real.assertMailerReady(), real.describeMailerConfig(), real.mailerConfigProblems().join(';')]
    const v = await real.verifyMailerConnection(4000)                                           // nodemailer REAL: conexão recusada/sem resposta
    texts.push(v.detail)
    expect(v.ok).toBe(false)
    for (const t of texts) { expect(t).not.toContain(SECRET); expect(t).not.toContain(Buffer.from(SECRET).toString('base64')) }
    expect(v.detail).toMatch(/127\.0\.0\.1:1/)
  }, 15000)

  // D-RS5 promete "em produção o código NUNCA vai ao log". A promessa é amarrada à grafia EXATA `production`: qualquer variante que um
  // operador escreva no .env de produção ("Production", "PRODUCTION", "prod", "production " via shell) desliga a exigência em SILÊNCIO —
  // o boot sobe em "modo DEV", o código de recuperação vai ao LOG e nenhum alarme diz que o NODE_ENV não foi reconhecido.
  it('[CORRIGIDO·LOW] NODE_ENV "Production"/"PRODUCTION"/"production " são produção (normalizado — o boot RECUSA sem SMTP); "prod" NÃO é, e o resumo do boot NOMEIA o NODE_ENV estranho', () => {
    for (const variant of ['Production', 'PRODUCTION', 'prod', 'production ']) {
      env({ NODE_ENV: variant })
      let msg = ''
      try { msg = real.assertMailerReady() } catch (e: any) { msg = `THREW ${e.message}` }
      expect(msg).toMatch(/THREW|NODE_ENV/)                                                       // SEGURA: recusar ou nomear o NODE_ENV estranho
    }
  })

  // `isMailerConfigured()` = Boolean(SMTP_HOST) e `mailerConfigProblems()` apara o host: com SMTP_HOST só de espaços (shell/aspas) o boot em dev
  // diz "incompleta", `sendMail` tenta um transporte com host em branco (falha), e o cinto do modo dev NÃO loga o código (configurado = true):
  // o código não vai ao e-mail NEM ao log, e consome o teto 3/h. Em produção o boot recusa (host ausente) — só o dev é atingido.
  it('[CORRIGIDO·LOW] SMTP_HOST só espaços: isMailerConfigured() concorda com mailerConfigProblems() (host aparado = não configurado)', () => {
    env({ SMTP_HOST: '   ', SMTP_PORT: '587', SMTP_FROM: 'x@y' })
    expect(real.mailerConfigProblems()).toContain('SMTP_HOST ausente')
    expect(real.isMailerConfigured()).toBe(false)
  })
})

// =====================================================================================================================
// (g) D-PV46 — a peça do Super: viés da senha, forma do hash = o que o login compara, e o "ativo" do vínculo
// =====================================================================================================================
describe('[ataque] D-PV46 — a senha inicial e a definição de "Super ativo"', () => {
  it('[RESISTIU] senha inicial: 16 do alfabeto (55 símbolos, sem 0/O/1/l/I), sem viés mensurável (χ² em 110.000 símbolos), cabe no DTO 5–100, hash = login', () => {
    const counts = new Map<string, number>()
    const N = 110_000 / INITIAL_PASSWORD_LENGTH
    for (let i = 0; i < N; i++) {
      const p = generateInitialPassword()
      expect(p).toHaveLength(INITIAL_PASSWORD_LENGTH)
      expect(p.length).toBeGreaterThanOrEqual(5); expect(p.length).toBeLessThanOrEqual(100)
      for (const ch of p) { expect(INITIAL_PASSWORD_ALPHABET).toContain(ch); counts.set(ch, (counts.get(ch) ?? 0) + 1) }
    }
    expect(INITIAL_PASSWORD_ALPHABET).not.toMatch(/[0OIl1]/)
    expect(new Set(INITIAL_PASSWORD_ALPHABET).size).toBe(INITIAL_PASSWORD_ALPHABET.length)
    const total = N * INITIAL_PASSWORD_LENGTH, expected = total / INITIAL_PASSWORD_ALPHABET.length
    const chi2 = [...INITIAL_PASSWORD_ALPHABET].reduce((s, ch) => s + ((counts.get(ch) ?? 0) - expected) ** 2 / expected, 0)
    expect(chi2).toBeLessThan(110)                                                               // 54 graus de liberdade: p ≈ 0,9999 → sem viés de módulo
    const p = generateInitialPassword()
    expect(hashInitialPassword(p)).toBe(md5Password(p))
    expect(hashInitialPassword(p).toUpperCase()).toBe(md5Password(p))                             // o login compara password.toUpperCase() === md5(…)
  })

  function superConn(world: { user?: { id: number; active: string; password: string | null }; link?: { active: string; deleted: string } }) {
    const sql: string[] = []
    const query = jest.fn(async (s: string, params: any[] = []) => {
      sql.push(s)
      if (/FROM setes_central\.tb_user WHERE id = \? AND deleted = 'N' FOR UPDATE/.test(s)) {
        return [world.user ? [{ id: world.user.id, active: world.user.active, password: world.user.password }] : []]
      }
      if (/FROM setes_central\.tb_institution_has_user/.test(s) && /kind = 'super'/.test(s)) {
        expect(params[1]).toBe(1)
        const l = world.link
        const matches = l && l.deleted === 'N' && (!/active = 'S'/.test(s) || l.active === 'S')   // o dublê honra o filtro que o SQL trouxer
        return [matches ? [{ 1: 1 }] : []]
      }
      if (/UPDATE setes_central\.tb_user SET password = \?, activation_key = NULL/.test(s)) { world.user!.password = params[0]; return [{ affectedRows: 1 }] }
      throw new Error(`SQL inesperado: ${s}`)
    })
    return { c: { query } as any, sql, world }
  }
  const HASH = md5Password('qualquer')

  it('[RESISTIU] hash fora da forma (minúsculo/curto/senha em claro) recusado ANTES da trava; conta inexistente e admin = not-super sem escrita', async () => {
    const a = superConn({ user: { id: 7, active: 'S', password: 'OLD' }, link: { active: 'S', deleted: 'N' } })
    for (const bad of [HASH.toLowerCase(), HASH.slice(1), 'senha-em-claro', HASH + 'A']) await expect(resetSuperPasswordTx(a.c, 7, bad)).rejects.toThrow(/fora da forma/)
    expect(a.sql).toEqual([])
    const b = superConn({ user: { id: 8, active: 'S', password: 'OLD' } })
    await expect(resetSuperPasswordTx(b.c, 8, HASH)).resolves.toEqual({ status: 'not-super', userId: 8 })
    expect(b.world.user!.password).toBe('OLD')
    const c = superConn({})
    await expect(resetSuperPasswordTx(c.c, 999, HASH)).resolves.toEqual({ status: 'not-super', userId: 999 })
    expect(c.sql).toHaveLength(1)
  })

  // "Super inativo" na peça = tb_user.active; o vínculo `tb_institution_has_user.active = 'N'` (a INATIVAÇÃO da casa — D-UC2: "inativar =
  // tb_institution_has_user.active='N'"; o login exige ihu.active = 'S' em getInstitutionsForUser) NÃO é olhado nem pela peça nem por
  // listSuperAccounts: uma conta cujo vínculo de Super foi desativado conta como "Super ATIVO" (bloqueia o script quando há outro Super
  // vivo — "há 2 Supers ATIVOS") e tem a senha REDEFINIDA pelo operador embora não consiga logar como Super (só nos outros vínculos dela).
  it('[CORRIGIDO·LOW] vínculo super com active = N (inativação da casa) é recusado como inativo — A-RS10: o predicado de "ativo" é o do login', async () => {
    const w = superConn({ user: { id: 7, active: 'S', password: 'OLD' }, link: { active: 'N', deleted: 'N' } })
    const v = await resetSuperPasswordTx(w.c, 7, HASH)
    expect(v.status).not.toBe('reset')                                                            // SEGURA: não redefinir quem não é Super ativo
    expect(w.world.user!.password).toBe('OLD')
  })
})
