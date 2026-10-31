/// <reference types="jest" />
// =====================================================================================================================
// GATE ADVERSARIAL — Q-PV38 / D-PV13 (2026-10-18): força bruta no código de 6 dígitos de POST /auth/change-password.
// Ataca a versão NOVA (retrabalho do gate socrático): chave do limite por e-mail = SHA-256 da forma canônica
// (ß→s, ı→i, corte 320, sem RateLimit-*); recovery responde ANTES da emissão (transação + e-mail em segundo plano,
// `waitForPendingPasswordResets`); `FOR UPDATE WAIT 5`; `updatePassword` limpa `activation_key`; falha depois de achar a
// conta vira alarme NEUTRO (tb_crashlytics); boot confere tabela + autoteste do HMAC.
// Papel: QUEBRAR a implementação (skill testar-adversarial.md). Convenção da casa:
//   it          = [RESISTIU] — a defesa segura o ataque (o teste PASSA porque a promessa se cumpre).
//   it.failing  = [ACHADO]   — a asserção SEGURA que o código ATUAL quebra (jest marca verde: o achado está provado).
// Banco DUBLADO pelo texto do SQL (molde de src/__tests__/auth-password-reset-q-pv38.test.ts e dos gates anteriores),
// com relógio do banco controlável e a trava de REGISTRO da linha do usuário em tb_user emulada (FOR UPDATE[ WAIT n]
// espera o dono até o COMMIT/ROLLBACK). A corrida REAL do InnoDB é provada à parte por scripts/prove-password-reset-lock.ts.
// NÃO edita nenhum arquivo de produção nem os testes existentes. Tolerâncias de tempo folgadas (a suíte inteira roda com a máquina carregada).
// =====================================================================================================================
import request from 'supertest'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/mailer/mailer', () => ({
  __esModule: true, sendMail: jest.fn().mockResolvedValue(undefined), isMailerConfigured: jest.fn(() => true),
  isProduction: jest.fn(() => false),     // D-RS5: a peça do mailer ganhou o predicado de produção (o service o consome)
}))
// recordCrash grava no banco (alarme neutro); mocka para o dublê não ter de modelar a tb_crashlytics.
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: () => 'REF00000', recordCrash: jest.fn().mockResolvedValue(undefined),
}))

import pool from '../shared/db/connection'
import { sendMail } from '../shared/mailer/mailer'
import app from '../app'
import {
  changePassword, recoveryPassword, waitForPendingPasswordResets, INVALID_PASSWORD_RESET_CODE,
  setPasswordResetResponseFloor, PASSWORD_RESET_RESPONSE_FLOOR_MS,
  PASSWORD_RESET_MAX_FAILED_ATTEMPTS, PASSWORD_RESET_MAX_PER_HOUR, PASSWORD_RESET_TTL_MINUTES,
} from '../modules/auth/auth.service'
import { RECOVERY_PER_EMAIL } from '../modules/auth/auth.routes'
import { normalizeLoginEmail, loginEmailBucket } from '../shared/auth/login-email'
import logger from '../shared/logger/logger'
import { recordCrash } from '../shared/errors/crash.repository'
import { isMailerConfigured } from '../shared/mailer/mailer'
import { md5Password } from '../shared/auth/password'

const q = (pool as any).query as jest.Mock
const getConn = (pool as any).getConnection as jest.Mock
const mail = sendMail as jest.Mock

// ---- o mundo do dublê -----------------------------------------------------------------------------------------------
interface User { id: number; password: string | null; active: string; deleted: string; email: string }
interface ResetRow { userId: number; seq: number; codeHmac: string; failed: number; usedAt: number | null; createdAt: number; deleted: string }

let now: number                                   // relógio do BANCO (NOW()) em ms
let users: Map<number, User>
let resets: ResetRow[]
let passwordWrites: Array<{ userId: number; hash: string }>
let activationKeyWrites: number[]                  // ids cujo activation_key foi limpo no updatePassword
let notices: Array<{ userId: number; seq: number; kind: string; createdAt: number }>   // D-RS4: aviso ao dono (tabela irmã)
let deadlockOnce: string | null                   // injeta UM ER_LOCK_DEADLOCK no 1º statement que casar (depois limpa)
const locks = new Map<number, { owner: object; waiters: Array<() => void> }>()
// ganchos do re-ataque do DELTA (piso de resposta)
let txLatencyMs = 0                                // duração emulada da transação SEGURANDO a trava (banco remoto/carregado)
let failUpdatePasswordWith: any = null             // erro estilo mysql2 (com `sql` formatado) no UPDATE da senha
let releaseTimes: number[] = []                    // instante em que cada conexão volta ao pool

/** A igualdade do banco para o e-mail (CONFIRMADA ao vivo: tb_mailing.email é utf8mb4_general_ci): sem caixa, sem acento
 *  Latin-1, ß→s, ı→i, PAD SPACE (só no fim). */
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
    'b8@x.com', 'b9@x.com', 'b10@x.com', 'b11@x.com', 'b12@x.com', 'b13@x.com', 'straße@x.com',
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
  // D-RS4 (2026-10-21): a tabela IRMÃ do aviso ao dono — casada ANTES dos handlers do pedido (cujas regexes não param na fronteira
  // do nome e engoliriam `…_notice`). Vaga da hora lida/tomada só dentro da transação (sob a trava do usuário).
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
  // trava de REGISTRO da linha do usuário — aceita o `FOR UPDATE` com ou sem ` WAIT n` (novo: WAIT 5 quando suportado)
  if (/SELECT id, active, password FROM setes_central\.tb_user WHERE id = \? AND deleted = 'N' FOR UPDATE(?: WAIT \d+)?/.test(sql)) {
    const [userId] = params
    if (!owner) throw new Error('FOR UPDATE fora de transação')
    const u = users.get(Number(userId))
    if (!u || u.deleted !== 'N') return [[]]
    await acquire(u.id, owner)
    if (txLatencyMs) await new Promise(r => setTimeout(r, txLatencyMs))   // a transação dura isto com a trava na mão
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
    if (!/^[0-9a-f]{64}$/.test(codeHmac)) throw new Error('CHECK ck_user_password_reset_code_hmac')  // espelho do CHECK do sql/67
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
  // novo: o UPDATE da senha limpa activation_key junto (código antigo em texto puro não revive)
  if (/UPDATE setes_central\.tb_user SET password = \?/.test(sql)) {
    if (failUpdatePasswordWith) throw failUpdatePasswordWith(params)
    const [hash, setAt, userId] = params                 // D-EA7: a senha e o instante T vão JUNTOS (a peça "definir a senha")
    if (!/password_set_at = \?/.test(sql) || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(setAt))) throw new Error('senha sem o instante T (D-EA7)')
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

const lastCode = (to: string): string => {
  // D-RS4: o aviso ao dono sai pelo mesmo `sendMail` (outro assunto, sem código) — aqui só os e-mails do CÓDIGO contam
  const call = [...mail.mock.calls].reverse().find(c => c[0].to === to && /código de recuperação é (\d{6})/.test(c[0].text ?? ''))
  if (!call) throw new Error(`nenhum e-mail para ${to}`)
  return /código de recuperação é (\d{6})/.exec(call[0].text)![1]
}
const wrongOf = (code: string, i = 0) => String((Number(code) - 100000 + 1 + i) % 900000 + 100000)

// Recovery agora é DEFERIDO: dispara e espera a emissão em segundo plano antes de ler o código.
const recover = async (email: string): Promise<void> => { await recoveryPassword(email); await waitForPendingPasswordResets() }

beforeAll(() => setPasswordResetResponseFloor(0))   // o piso de tempo é provado no próprio teste
afterAll(() => setPasswordResetResponseFloor(PASSWORD_RESET_RESPONSE_FLOOR_MS))

beforeEach(() => {
  jest.clearAllMocks()
  now = Date.parse('2026-10-18T12:00:00Z')
  seedUsers()
  resets = []
  notices = []
  passwordWrites = []
  activationKeyWrites = []
  deadlockOnce = null
  txLatencyMs = 0
  failUpdatePasswordWith = null
  releaseTimes = []
  locks.clear()
  q.mockImplementation((sql: string, params: any[] = []) => run(sql, params, null, []))
  getConn.mockImplementation(async () => newConn())
})
afterEach(async () => { await waitForPendingPasswordResets() })   // nenhum trabalho de fundo vaza para o próximo teste

const change = (email: any, code: string, newPassword = 'nova-senha') =>
  request(app).post('/auth/change-password').send({ email, code, newPassword })

// =====================================================================================================================
// PROMESSA 1 — N erradas matam o código; a seguinte, mesmo com o certo, é recusada; só um código novo destrava
// =====================================================================================================================
describe('[ataque] força bruta do código de 6 dígitos', () => {
  it('[RESISTIU] 5 erradas e a 6ª com o código CERTO = 401; a senha não muda; o contador para em 5', async () => {
    const email = 'b1@x.com'
    await recover(email)
    const code = lastCode(email)
    for (let i = 0; i < PASSWORD_RESET_MAX_FAILED_ATTEMPTS; i++) {
      await expect(changePassword(email, wrongOf(code, i), 'nova-senha')).rejects.toMatchObject({ statusCode: 401 })
    }
    await expect(changePassword(email, code, 'nova-senha')).rejects.toMatchObject({ statusCode: 401 })
    expect(passwordWrites).toEqual([])
    expect(resets[0].failed).toBe(PASSWORD_RESET_MAX_FAILED_ATTEMPTS)
  })

  it('[RESISTIU] rajada PARALELA de 30 erradas não ultrapassa o teto (julgada e contada sob a trava do usuário)', async () => {
    const email = 'b2@x.com'
    await recover(email)
    const code = lastCode(email)
    const r = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => changePassword(email, wrongOf(code, i), 'nova-senha')))
    expect(r.every(x => x.status === 'rejected' && (x.reason as any).statusCode === 401)).toBe(true)
    expect(resets[0].failed).toBe(PASSWORD_RESET_MAX_FAILED_ATTEMPTS)
    await expect(changePassword(email, code, 'nova-senha')).rejects.toMatchObject({ statusCode: 401 })
    expect(passwordWrites).toEqual([])
  })

  it('[RESISTIU] palpites efetivos ≤ emissões/hora × teto (15/h) num espaço de 900.000 códigos — brute-force inviável', async () => {
    const email = 'b3@x.com'
    let guesses = 0
    for (let emission = 0; emission < PASSWORD_RESET_MAX_PER_HOUR + 2; emission++) {
      await recover(email)                            // 4ª/5ª emissões na mesma hora são CALADAS (teto 3/h)
      const code = lastCode(email)
      for (let i = 0; i < PASSWORD_RESET_MAX_FAILED_ATTEMPTS + 3; i++) {
        try { await changePassword(email, wrongOf(code, i + 1), 'nova-senha') } catch { guesses++ }
      }
    }
    expect(resets.length).toBe(PASSWORD_RESET_MAX_PER_HOUR)
    expect(resets.reduce((s, r) => s + r.failed, 0)).toBe(PASSWORD_RESET_MAX_PER_HOUR * PASSWORD_RESET_MAX_FAILED_ATTEMPTS)
    expect(passwordWrites).toEqual([])
    expect(guesses).toBeGreaterThan(0)
  })
})

// =====================================================================================================================
// retry de deadlock — a tentativa errada não é contada em DOBRO quando a transação é reexecutada
// =====================================================================================================================
describe('[ataque] deadlock no meio do julgamento conta a tentativa em dobro?', () => {
  it('[RESISTIU] UM deadlock no +1 reexecuta a transação e a errada soma 1 (não 2)', async () => {
    const email = 'b4@x.com'
    await recover(email)
    const code = lastCode(email)
    deadlockOnce = 'SET failed_attempts = failed_attempts + 1'   // 1ª aplicação do +1 explode → rollback → retry
    await expect(changePassword(email, wrongOf(code), 'nova-senha')).rejects.toMatchObject({ statusCode: 401 })
    expect(resets[0].failed).toBe(1)
  })
})

// =====================================================================================================================
// PROMESSA 4 — o código é amarrado à senha e ao e-mail de login GRAVADO; nunca é guardado; activation_key é limpa
// =====================================================================================================================
describe('[ataque] código que sobrevive à troca de senha/e-mail por outro caminho', () => {
  it('[RESISTIU] senha trocada por fora (PUT do admin) invalida o código aberto por construção (HMAC não casa)', async () => {
    const email = 'b5@x.com'
    await recover(email)
    const code = lastCode(email)
    userByEmail(email).password = 'HASH-TROCADO-PELO-ADMIN'
    await expect(changePassword(email, code, 'nova-senha')).rejects.toMatchObject({ statusCode: 401 })
    expect(passwordWrites).toEqual([])
  })

  it('[RESISTIU] o banco guarda só o HMAC (64 hex), nunca o código', async () => {
    await recover('b6@x.com')
    const code = lastCode('b6@x.com')
    expect(resets[0].codeHmac).toMatch(/^[0-9a-f]{64}$/)
    expect(resets[0].codeHmac).not.toContain(code)
  })

  it('[RESISTIU] a troca de senha pelo código limpa o activation_key (código antigo em texto puro não revive)', async () => {
    const email = 'b13@x.com'
    await recover(email)
    const code = lastCode(email)
    await changePassword(email, code, 'nova-senha')
    expect(activationKeyWrites).toContain(userByEmail(email).id)
  })
})

// =====================================================================================================================
// PROMESSA 5 — o código vai ao e-mail GRAVADO; e-mail "parecido" pela colação acha a conta mas não desvia o envio
// =====================================================================================================================
describe('[ataque] desviar o código para o domínio de quem pede', () => {
  it('[RESISTIU] pedido com e-mail equivalente pela colação (ß=s, confirmado ao vivo) manda o código ao e-mail GRAVADO', async () => {
    await recover('strase@x.com')                      // general_ci: strase == straße (a conta é straße@x.com)
    expect(mail).toHaveBeenCalledTimes(1)
    expect(mail.mock.calls[0][0].to).toBe('straße@x.com')
  })
})

// =====================================================================================================================
// PROMESSA 3 — resposta neutra: toda recusa do change é a MESMA 401; recovery não revela existência por tempo nem status
// =====================================================================================================================
describe('[ataque] oráculo de existência pelo status/corpo/tempo', () => {
  it('[RESISTIU] e-mail inexistente, inativo, errado, esgotado, vencido e já usado = a MESMA 401 (status + corpo)', async () => {
    const out: any[] = []
    out.push(await change('ninguem@x.com', '123456'))
    out.push(await change('inativo@x.com', '123456'))
    out.push(await change('b7@x.com', '123456'))                        // sem código
    await recover('b8@x.com'); const c8 = lastCode('b8@x.com')
    out.push(await change('b8@x.com', wrongOf(c8)))                     // errado
    for (let i = 1; i < PASSWORD_RESET_MAX_FAILED_ATTEMPTS; i++) await change('b8@x.com', wrongOf(c8, i))
    out.push(await change('b8@x.com', c8))                              // esgotado (com o certo)
    await recover('b9@x.com'); const c9 = lastCode('b9@x.com')
    now += (PASSWORD_RESET_TTL_MINUTES * 60 + 1) * 1000
    out.push(await change('b9@x.com', c9))                              // vencido
    now = Date.parse('2026-10-18T12:00:00Z')
    await recover('b10@x.com'); const c10 = lastCode('b10@x.com')
    expect((await change('b10@x.com', c10)).status).toBe(200)
    out.push(await change('b10@x.com', c10))                            // já usado
    for (const o of out) expect([o.status, o.body]).toEqual([401, { error: INVALID_PASSWORD_RESET_CODE }])
  })

  it('[RESISTIU] corpo com tipos estranhos (email objeto/array, code número) não crasha (nunca 500) e sai 401 neutro', async () => {
    const r1 = await request(app).post('/auth/change-password').send({ email: { a: 1 }, code: 123456, newPassword: 'nova-senha' })
    const r2 = await request(app).post('/auth/change-password').send({ email: ['ninguem@x.com'], code: '123456', newPassword: 'nova-senha' })
    expect([r1.status, r2.status]).toEqual([401, 401])
    expect([r1.body, r2.body]).toEqual([{ error: INVALID_PASSWORD_RESET_CODE }, { error: INVALID_PASSWORD_RESET_CODE }])
  })

  it('[RESISTIU] recovery DEFERE a emissão: a resposta sai ANTES do COMMIT e do e-mail (tempo neutro vs conta inexistente)', async () => {
    await recoveryPassword('b11@x.com')                // NÃO espera a emissão
    expect(resets).toHaveLength(0)                      // nenhuma linha gravada ainda — a transação é de segundo plano
    expect(mail).not.toHaveBeenCalled()                // nem o e-mail segurou a resposta
    await waitForPendingPasswordResets()
    expect(resets).toHaveLength(1)                      // só agora, fora do caminho da resposta
    expect(mail).toHaveBeenCalledTimes(1)
  })
})

// =====================================================================================================================
// [ACHADO] ORÁCULO DE EXISTÊNCIA POR TEMPO/TRABALHO NO change-password — a promessa é "a contenção não pode virar oráculo
// de existência". O recovery foi neutralizado (emissão em segundo plano), mas o change-password PRECISA aguardar a
// transação para devolver 200/401: conta INEXISTENTE termina no findUserByEmail (0 transações); conta EXISTENTE abre
// transação + FOR UPDATE + leituras. Status/corpo são iguais; o TRABALHO no banco (logo o TEMPO) distingue os dois.
// =====================================================================================================================
describe('[ataque] enumeração de usuários pelo tempo do change-password', () => {
  // [CORRIGIDO] (era `it.failing` [ACHADO·MEDIUM]): o TRABALHO no banco segue diferente (0 × ≥1 conexão) — o que o atacante mede é o
  // TEMPO, e toda resposta espera o piso PASSWORD_RESET_RESPONSE_FLOOR_MS (auth.service.ts withResponseFloor). Limite conhecido: banco
  // sob carga a ponto de a conta existente passar do piso.
  it('[CORRIGIDO·MEDIUM] conta existente e inexistente levam o MESMO tempo no change-password (piso de resposta esconde o trabalho)', async () => {
    setPasswordResetResponseFloor(PASSWORD_RESET_RESPONSE_FLOOR_MS)
    try {
      const time = async (email: string) => { const t = Date.now(); await change(email, '123456'); return Date.now() - t }
      const missing = await time('ninguem-mesmo@x.com')   // inexistente: curto-circuito no findUserByEmail
      const existing = await time('b12@x.com')            // existente: transação + FOR UPDATE + leituras + COMMIT
      expect(Math.min(missing, existing)).toBeGreaterThanOrEqual(PASSWORD_RESET_RESPONSE_FLOOR_MS - 5)
      expect(Math.abs(existing - missing)).toBeLessThan(250)
    } finally {
      setPasswordResetResponseFloor(0)
    }
  })
})

// =====================================================================================================================
// PROMESSA 2 — limite por e-mail (carga em memória) além do IP: 429 neutro e canônico que colapsa o que a colação colapsa
// =====================================================================================================================
describe('[ataque] fugir/abusar do limite por e-mail', () => {
  it('[RESISTIU] a 429 do limite por e-mail é a MESMA para e-mail que existe e que não existe', async () => {
    const existing = 'valdo@setes.com.br', missing = 'nao-existe-xyz@x.com'
    let a: any, b: any
    for (let i = 0; i <= RECOVERY_PER_EMAIL.max; i++) {
      a = await request(app).post('/auth/recovery-password').send({ email: existing })
      b = await request(app).post('/auth/recovery-password').send({ email: missing })
    }
    expect([a.status, b.status]).toEqual([429, 429])
    expect(a.body).toEqual(b.body)
  })

  it('[RESISTIU] a forma canônica colapsa no MESMO balde o que a colação iguala (caixa, acento Latin-1, ß=s, ı=i, espaço no fim)', () => {
    const k = normalizeLoginEmail('fulano@gmail.com')
    for (const v of ['FULANO@Gmail.com ', 'fulano@gmaíl.com']) expect(normalizeLoginEmail(v)).toBe(k)
    // as duas dobras da general_ci que o NFKD não faz — CONFIRMADAS ao vivo (ß=s, ı=i) — agora caem no mesmo balde:
    expect(normalizeLoginEmail('straße@x.com')).toBe(normalizeLoginEmail('strase@x.com'))
    expect(normalizeLoginEmail('fulano@gmaıl.com')).toBe(normalizeLoginEmail('fulano@gmail.com'))
  })
})

// =====================================================================================================================
// RE-ATAQUE DO DELTA (depois do verdito 0,82): piso de resposta `withResponseFloor` (400 ms) no recovery e no change
// (depois da checagem de 400), `.catch(alarmNeutral)` na borda do job de fundo, `alarmNeutral` sem o `err` inteiro
// (o `err.sql` do mysql2 levaria o MD5 da senha nova), e lowercase ANTES das dobras na forma canônica (ẞ → ß → s).
// =====================================================================================================================
const FLOOR = PASSWORD_RESET_RESPONSE_FLOOR_MS
async function withFloor<T>(fn: () => Promise<T>): Promise<T> {
  setPasswordResetResponseFloor(FLOOR)
  try { return await fn() } finally { setPasswordResetResponseFloor(0) }
}
const timed = async (p: PromiseLike<any>) => { const t = Date.now(); const r = await p; return { ms: Date.now() - t, r } }

describe('[delta] o piso cobre só o que depende de existência? (429 / 400 / exceção antes do piso)', () => {
  it('[RESISTIU] a 429 do limite por e-mail sai SEM piso — mas é igual (rápida) para conta que existe e que não existe', async () => {
    const existing = 'b3@x.com', missing = 'nao-existe-d1@x.com'
    for (let i = 0; i < 10; i++) { await change(existing, '123456'); await change(missing, '123456') }   // enche os dois baldes (piso 0)
    const [a, b] = await withFloor(async () => [await timed(change(existing, '123456')), await timed(change(missing, '123456'))])
    expect([a.r.status, b.r.status]).toEqual([429, 429])
    expect(a.r.body).toEqual(b.r.body)
    expect(Math.max(a.ms, b.ms)).toBeLessThan(FLOOR - 100)           // nenhuma das duas espera o piso — a 429 não depende de existência
  })

  it('[RESISTIU] os 400 (campo ausente na rota; senha curta no service) saem SEM piso — e nunca tocam a conta (iguais para os dois)', async () => {
    const out = await withFloor(async () => [
      await timed(request(app).post('/auth/change-password').send({ email: 'b4@x.com', newPassword: 'nova-senha' })),
      await timed(request(app).post('/auth/change-password').send({ email: 'nao-existe-d2@x.com', newPassword: 'nova-senha' })),
      await timed(change('b4@x.com', '123456', 'abc')),
      await timed(change('nao-existe-d2@x.com', '123456', 'abc')),
    ])
    expect(out.map(o => o.r.status)).toEqual([400, 400, 400, 400])
    expect(out[0].r.body).toEqual(out[1].r.body)
    expect(out[2].r.body).toEqual(out[3].r.body)
    expect(Math.max(...out.map(o => o.ms))).toBeLessThan(FLOOR - 100)
    expect(getConn).not.toHaveBeenCalled()                    // nenhuma transação: o 400 não diz nada da conta
  })

  it('[RESISTIU] falha da PRÓPRIA busca (findUserByEmail fora do caminho neutro → 500) também espera o piso — o tempo não fala', async () => {
    q.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })))
    const { ms, r } = await withFloor(() => timed(change('nao-existe-d10@x.com', '123456')))
    expect(r.status).toBe(500)                                // o 500 em pane da busca segue (LOW do verdito anterior), mas no piso
    expect(ms).toBeGreaterThanOrEqual(FLOOR - 5)
  })

  // [CORRIGIDO] (era `it.failing` [ACHADO·LOW]): a coerção única `bodyText` (limitador + rotas) — o que não vira texto = campo ausente = 400.
  it('[CORRIGIDO·LOW] corpo com e-mail objeto que não vira texto ({"toString":1}) = 400 nas duas rotas (antes: o limitador lançava e saía 500)', async () => {
    const c = await request(app).post('/auth/change-password').send({ email: { toString: 1 }, code: '123456', newPassword: 'nova-senha' })
    const r = await request(app).post('/auth/recovery-password').send({ email: { toString: 1 } })
    expect([c.status, r.status]).toEqual([400, 400])
  })
})

describe('[delta] contenção acima do piso com a trava da linha do usuário (FOR UPDATE WAIT 5)', () => {
  // A trava serializa as transações da MESMA conta; a conta inexistente não tem trava. Com o orçamento do próprio limite por
  // e-mail (10 change + 5 jobs de recovery em 15 min), o atacante monta uma FILA na linha da vítima: a resposta da última sai em
  // ~N × t_tx. Se N × t_tx > piso, a diferença de tempo volta — o "limite conhecido" (banco sob carga) é INDUZÍVEL pelo atacante.
  const burst = async (email: string, n: number) =>
    Promise.all(Array.from({ length: n }, () => timed(change(email, '123456'))))

  it('[RESISTIU] controle: t_tx = 20 ms → 10 × 20 = 200 ms < piso — rajada na conta existente e na inexistente saem no MESMO tempo', async () => {
    txLatencyMs = 20
    const [ex, mi] = await withFloor(async () => [await burst('b6@x.com', 10), await burst('nao-existe-d4a@x.com', 10)])
    expect([...ex, ...mi].every(o => o.r.status === 401)).toBe(true)
    expect(Math.abs(Math.max(...ex.map(o => o.ms)) - Math.max(...mi.map(o => o.ms)))).toBeLessThan(250)
  })

  it.failing('[ACHADO·LOW] t_tx = 80 ms (banco remoto/carregado) → a fila de 10 na conta existente passa do piso; deveria sair no mesmo tempo da inexistente', async () => {
    txLatencyMs = 80
    const [ex, mi] = await withFloor(async () => [await burst('b5@x.com', 10), await burst('nao-existe-d4b@x.com', 10)])
    expect([...ex, ...mi].every(o => o.r.status === 401)).toBe(true)
    // asserção SEGURA: a mais lenta das duas rajadas tem de sair no mesmo tempo. HOJE: ~800 ms (existe) × ~400 ms (não existe).
    expect(Math.abs(Math.max(...ex.map(o => o.ms)) - Math.max(...mi.map(o => o.ms)))).toBeLessThan(250)
  })
})

describe('[delta] o piso segura recurso? (pool, timers, memória sob rajada)', () => {
  it('[RESISTIU] o piso NÃO segura conexão do pool: a conexão volta antes da espera, a resposta sai no piso', async () => {
    const t0 = Date.now()
    const { r } = await withFloor(() => timed(change('b11@x.com', '123456')))
    const responded = Date.now()
    expect(r.status).toBe(401)
    expect(releaseTimes).toHaveLength(1)
    expect(releaseTimes[0] - t0).toBeLessThan(250)            // conexão devolvida logo depois da transação
    expect(responded - t0).toBeGreaterThanOrEqual(FLOOR - 5)  // a espera do piso é só um timer, sem conexão na mão
  })

  it('[RESISTIU] 300 trocas simultâneas esperam o piso EM PARALELO (não em série) e não deixam timer pendurado', async () => {
    const timersBefore = process.getActiveResourcesInfo().filter(x => x === 'Timeout').length
    const t0 = Date.now()
    const out = await withFloor(() => Promise.allSettled(
      Array.from({ length: 300 }, (_, i) => changePassword(`ninguem-${i}@burst.com`, '123456', 'nova-senha'))))
    const elapsed = Date.now() - t0
    expect(out.every(o => o.status === 'rejected' && (o.reason as any).statusCode === 401)).toBe(true)
    expect(elapsed).toBeLessThan(FLOOR + 1000)                // ~piso, não 300 × piso
    const timersAfter = process.getActiveResourcesInfo().filter(x => x === 'Timeout').length
    expect(timersAfter).toBeLessThanOrEqual(timersBefore + 2) // cada timer morre com a sua resposta
  })
})

describe('[delta] borda do job de fundo e o log do alarme neutro', () => {
  it('[RESISTIU] erro que escapa do job de recovery (mailer quebrado depois do envio) vira alarme — nunca unhandledRejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => { unhandled.push(e) }
    process.on('unhandledRejection', onUnhandled)
    try {
      ;(isMailerConfigured as jest.Mock).mockImplementationOnce(() => { throw new Error('mailer quebrado') })
      await recoveryPassword('b12@x.com')
      await waitForPendingPasswordResets()
      await new Promise(r => setImmediate(r))
      expect(unhandled).toEqual([])
      expect(recordCrash).toHaveBeenCalledTimes(1)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('[RESISTIU] erro do mysql2 com `sql` formatado no UPDATE da senha: o MD5 da senha nova não chega ao log nem à tb_crashlytics', async () => {
    const email = 'b13@x.com', newPassword = 'segredo-novo-123'
    await recover(email)
    const code = lastCode(email)
    failUpdatePasswordWith = (params: any[]) => Object.assign(new Error("Data too long for column 'password' at row 1"), {
      code: 'ER_DATA_TOO_LONG', errno: 1406, sqlMessage: "Data too long for column 'password' at row 1",
      sql: `UPDATE setes_central.tb_user SET password = '${params[0]}', password_set_at = '${params[1]}', activation_key = NULL, updated_at = NOW() WHERE id = ${params[2]}`,
    })
    await expect(changePassword(email, code, newPassword)).rejects.toMatchObject({ statusCode: 401 })
    const md5 = md5Password(newPassword)
    const everything = JSON.stringify([
      (logger.error as jest.Mock).mock.calls, (logger.warn as jest.Mock).mock.calls, (logger.info as jest.Mock).mock.calls,
      (recordCrash as jest.Mock).mock.calls,
    ])
    expect(recordCrash).toHaveBeenCalledTimes(1)               // a pane virou alarme com ref
    expect(everything).not.toContain(md5)
    expect(everything.toLowerCase()).not.toContain(md5.toLowerCase())
    expect(everything).not.toContain(newPassword)
  })
})

describe('[delta] forma canônica: dobras antes das minúsculas (ẞ fica fora, como no banco)', () => {
  it('[RESISTIU] nenhum caractere do BMP deixa marca combinante na forma canônica (lowercase depois do NFKD não reintroduz marca)', () => {
    const bad: number[] = []
    for (let c = 0; c < 0x10000; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue
      if (/\p{M}/u.test(normalizeLoginEmail(String.fromCharCode(c)))) bad.push(c)
    }
    expect(bad).toEqual([])
  })

  // [CORRIGIDO] (era `it.failing` [ACHADO·LOW·INFO]): as dobras voltaram para ANTES das minúsculas — 'ẞ' fica fora, como no banco.
  it('[CORRIGIDO·LOW·INFO] ẞ (U+1E9E): "STRAẞE" e "strase" ficam em baldes DIFERENTES, como no banco (general_ci ao vivo: = → 0)', () => {
    // general_ci, conferido ao vivo 2026-10-18: 'STRAẞE@x.com' = 'strase@x.com' → 0 (e = 'strasse' → 0).
    expect(loginEmailBucket('STRAẞE@x.com')).not.toBe(loginEmailBucket('strase@x.com'))
  })
})
