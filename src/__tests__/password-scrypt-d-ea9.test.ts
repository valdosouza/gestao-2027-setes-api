/// <reference types="jest" />
// Onda 4 do endurecer — o HASH DA SENHA em scrypt (D-EA9), com o peso PROVISÓRIO da D-EA18 e a migração TRANSPARENTE do MD5 no login.
// Plano de testes: `Infra-IA/prompts/prompt_endurecer_autenticacao.md` §P.5 "Item 3 — Onda 4" (H1–H10; o código no título de cada teste).
// H5 e a troca pelo código (H6) estão no `auth-password-reset-q-pv38.test.ts`; H8 (medição) é `scripts/measure-scrypt.ts` e H9 (prova em
// schema descartável, logins paralelos nos dois formatos) é `scripts/prove-scrypt-migration.ts`.
// Banco DUBLADO pelo texto do SQL (molde reduzido do `auth-login-lock-d-ea1.test.ts`); a trava da linha é emulada por ordem de eventos.
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/mailer/mailer', () => ({
  __esModule: true, ...jest.requireActual('../shared/mailer/mailer'),
  sendMail: jest.fn().mockResolvedValue(undefined), isMailerConfigured: jest.fn(() => true), isProduction: jest.fn(() => false),
}))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFSCRYPT'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../shared/session-context/session-context.repository', () => ({
  __esModule: true, existsSalesman: jest.fn().mockResolvedValue(false),
}))

import pool from '../shared/db/connection'
import { recordCrash } from '../shared/errors/crash.repository'
import { setLockWaitSupported } from '../shared/db/counters'
import * as piece from '../shared/auth/password'
import {
  hashPassword, checkPassword, md5Password, storedPasswordForm, SCRYPT_CURRENT, SCRYPT_SALT_BYTES, SCRYPT_KEY_BYTES, scryptMaxmem,
  setCurrentScryptParamsForTests, currentScryptParams, ScryptParams,
} from '../shared/auth/password'
import { login, setLoginRefusalFloor, LOGIN_REFUSED_MESSAGE } from '../modules/auth/auth.service'
import { rehashPassword } from '../modules/auth/auth.repository'
import { resetLoginWatch } from '../modules/auth/login-watch'

const q = (pool as any).query as jest.Mock
const getConn = (pool as any).getConnection as jest.Mock
const SRC = path.resolve(__dirname, '..')
const ROOT = path.resolve(SRC, '..')
const TEST_WEIGHT: ScryptParams = { ...currentScryptParams() }      // o peso leve da suíte (test-setup/scrypt-weight.ts)

// ---- o mundo do dublê -----------------------------------------------------------------------------------------------------
interface User { id: number; password: string | null; active: string; email: string; passwordSetAt: string }
let users: Map<number, User>
let events: string[]
let beforeLock: ((userId: number) => void) | null
const PASS = 'certa-kq7#mv2x'
const SET_AT = '2026-10-01 10:00:00'
const LINK = { institutionId: 1, schemaName: 'setes_setes', name: 'SETES', profile: 'admin' }

function run(sql: string, params: any[], inTx: boolean): any {
  if (/FROM setes_central\.tb_user u\s/.test(sql) && /tb_mailing_group_id = 2/.test(sql)) {
    const u = [...users.values()].find(x => x.email.toLowerCase() === String(params[0]).toLowerCase())
    return [u ? [{ id: u.id, password: u.password, active: u.active, loginEmail: u.email }] : []]
  }
  if (/FROM setes_central\.vw_user_link l/.test(sql)) return [[LINK]]
  if (/SELECT COUNT\(\*\) AS n FROM setes_central\.tb_user_login_failure/.test(sql)) return [[{ n: 0 }]]
  if (/FOR UPDATE/.test(sql) && /FROM setes_central\.tb_user WHERE id = \?/.test(sql)) {
    if (!inTx) throw new Error('trava fora de transação')
    const id = Number(params[0])
    if (beforeLock) { const h = beforeLock; beforeLock = null; h(id) }
    events.push('lock')
    const u = users.get(id)
    return [u ? [{ id: u.id, active: u.active, password: u.password }] : []]
  }
  if (/AS nextSeq/.test(sql)) return [[{ nextSeq: 1 }]]
  if (/INSERT INTO setes_central\.tb_user_login_failure/.test(sql)) { events.push('failure'); return [{ affectedRows: 1 }] }
  if (/UPDATE setes_central\.tb_user SET password = \? WHERE id = \? AND BINARY password = \?/.test(sql)) {
    if (!inTx) throw new Error('regravação fora de transação')
    const [hash, id, from] = params
    const u = users.get(Number(id))
    events.push('rehash')
    if (!u || u.password !== from) return [{ affectedRows: 0 }]
    u.password = hash                                                    // password_set_at NÃO muda (exceção nomeada da D-EA7)
    return [{ affectedRows: 1 }]
  }
  if (/UPDATE setes_central\.tb_user SET password = \?/.test(sql)) throw new Error('o login nunca DEFINE senha: ' + sql)
  return [[]]
}

function newConn() {
  let open = false
  return {
    beginTransaction: jest.fn(async () => { open = true }),
    commit:   jest.fn(async () => { open = false; events.push('commit') }),
    rollback: jest.fn(async () => { open = false; events.push('rollback') }),
    release:  jest.fn(),
    query:    jest.fn(async (sql: string, params: any[] = []) => run(sql, params, open)),
  }
}

async function seedUser(id: number, password: string | null, email = `u${id}@x.com`): Promise<User> {
  const u = { id, password, active: 'S', email, passwordSetAt: SET_AT }
  users.set(id, u)
  return u
}
async function refused(p: Promise<unknown>): Promise<any> {
  try { await p } catch (e) { return e }
  throw new Error('esperava recusa')
}

beforeAll(() => setLockWaitSupported(true))
beforeEach(() => {
  users = new Map()
  events = []
  beforeLock = null
  q.mockReset().mockImplementation(async (sql: string, params: any[] = []) => run(sql, params, false))
  getConn.mockReset().mockImplementation(async () => newConn())
  ;(recordCrash as jest.Mock).mockClear()
  setLoginRefusalFloor(0)
  resetLoginWatch()
  setCurrentScryptParamsForTests(TEST_WEIGHT)
})
// só os ESPIÕES deste arquivo voltam ao original — `jest.restoreAllMocks()` apagaria também as implementações dos dublês globais
// (jest.mock acima e o `test-setup/access-session.mock.ts`)
const spies: jest.SpyInstance[] = []
function spyOn<T extends object>(obj: T, name: any): jest.SpyInstance {
  const sp = jest.spyOn(obj, name)
  spies.push(sp)
  return sp
}
afterEach(() => { spies.splice(0).forEach(sp => sp.mockRestore()); setCurrentScryptParamsForTests(TEST_WEIGHT) })

// ---- H1 — formato e peso ----------------------------------------------------------------------------------------------------
describe('H1 — formato scrypt$<params>$<sal>$<hash>, peso VIGENTE de produção e maxmem explícito', () => {
  it('H1 o peso de produção é o da D-EA9 (N=2^15, r=8, p=3) e o valor gravado cabe na coluna (≤ 100)', async () => {
    expect(SCRYPT_CURRENT).toEqual({ N: 32768, r: 8, p: 3 })
    setCurrentScryptParamsForTests(SCRYPT_CURRENT)
    const h = await hashPassword(PASS)
    expect(h).toMatch(/^scrypt\$N=32768,r=8,p=3\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/)
    expect(h.length).toBeLessThanOrEqual(100)
    const [, , salt, key] = h.split('$')
    expect(Buffer.from(salt, 'base64')).toHaveLength(SCRYPT_SALT_BYTES)
    expect(Buffer.from(key, 'base64')).toHaveLength(SCRYPT_KEY_BYTES)
    expect(await checkPassword(PASS, h)).toEqual({ ok: true, needsRehash: false, form: 'scrypt' })
    expect((await checkPassword('outra-kq7#mv2x', h)).ok).toBe(false)
    // o maior peso aceito também cabe (N=2^17 tem 6 dígitos)
    const big = `scrypt$N=131072,r=8,p=4$${salt}$${key}`
    expect(big.length).toBeLessThanOrEqual(100)
    expect(storedPasswordForm(big)).toBe('scrypt')
  }, 30000)

  it('H1 sal aleatório: a MESMA senha gera valores diferentes, e os dois conferem', async () => {
    const a = await hashPassword(PASS), b = await hashPassword(PASS)
    expect(a).not.toBe(b)
    expect((await checkPassword(PASS, a)).ok && (await checkPassword(PASS, b)).ok).toBe(true)
  })

  it('H1 maxmem: sem ele o Node RECUSA o peso de produção (128·N·r = 32 MiB = o padrão) — por isso a peça passa o teto explícito', () => {
    // EM OUTRO PROCESSO (conhecimento negativo, achado nesta onda): a recusa deixa um erro PRESO na fila do OpenSSL da thread principal e a
    // PRÓXIMA leitura de chave PEM do processo falha com `ERR_OSSL_EVP_MEMORY_LIMIT_EXCEEDED` — no setes-api, a chave do JWT: o login
    // seguinte cairia em "falha interna". A peça nunca provoca a recusa (peso validado contra a lista + `maxmem` = o dobro do necessário).
    // (a recusa é SÍNCRONA — exceção na chamada, nunca no callback)
    const probe = `
      const c = require('crypto')
      let refused = null
      try { c.scrypt('x', Buffer.alloc(16), 32, { N: 2 ** 15, r: 8, p: 3 }, () => {}) } catch (e) { refused = e.code }
      const pem = c.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
      let poisoned = false, again = false
      try { c.createPrivateKey(pem) } catch (err) { poisoned = err.code || String(err) }
      try { c.createPrivateKey(pem) } catch (err) { again = err.code || String(err) }
      console.log(JSON.stringify({ refused, poisoned, again }))`
    const out = require('child_process').spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' })
    const r = JSON.parse(String(out.stdout).trim())
    expect(r.refused).toBe('ERR_CRYPTO_INVALID_SCRYPT_PARAMS')
    // Node v21.7.3 (o do dev): a 1ª leitura de chave depois da recusa falha; a 2ª passa. Se uma versão nova do Node limpar a fila, este
    // teste avisa — o conhecimento negativo deixa de valer, a guarda da peça segue certa
    expect([r.poisoned, r.again]).toEqual(['ERR_OSSL_EVP_MEMORY_LIMIT_EXCEEDED', false])
    expect(scryptMaxmem(SCRYPT_CURRENT)).toBe(2 * 128 * 2 ** 15 * 8)
  })

  it('H1 todo peso da lista aceita calcula com o teto da peça (nenhum cai na recusa do Node)', async () => {
    for (const N of [2 ** 14, 2 ** 15, 2 ** 16, 2 ** 17]) {
      setCurrentScryptParamsForTests({ N, r: 8, p: 1 })
      expect(storedPasswordForm(await hashPassword(PASS))).toBe('scrypt')
    }
    setCurrentScryptParamsForTests({ N: 2 ** 14, r: 8, p: 4 })
    expect(storedPasswordForm(await hashPassword(PASS))).toBe('scrypt')
  }, 30000)
})

// ---- H2 — os dois formatos e a recusa neutra ---------------------------------------------------------------------------------
describe('H2 — certo/errado nos dois formatos; forma desconhecida = recusa neutra, nunca cálculo', () => {
  it('H2 MD5 legado (maiúsculo e minúsculo) confere e pede regravação; errado não', async () => {
    const md5 = md5Password(PASS)
    expect(await checkPassword(PASS, md5)).toEqual({ ok: true, needsRehash: true, form: 'md5' })
    expect(await checkPassword(PASS, md5.toLowerCase())).toEqual({ ok: true, needsRehash: true, form: 'md5' })
    expect(await checkPassword('errada', md5)).toEqual({ ok: false, needsRehash: false, form: 'md5' })
  })

  it('H2 os dois formatos comparam em tempo constante (timingSafeEqual)', async () => {
    const spy = spyOn(crypto, 'timingSafeEqual')
    await checkPassword('errada', md5Password(PASS))
    await checkPassword('errada', await hashPassword(PASS))
    expect(spy).toHaveBeenCalledTimes(2)
  })

  const salt = 'A'.repeat(22) + '==', key = 'A'.repeat(43) + '='
  it.each([
    ['texto puro', 'minha-senha'],
    ['vazio', ''],
    ['nulo', null],
    ['prefixo sem partes', 'scrypt$'],
    ['partes faltando', `scrypt$N=32768,r=8,p=3$${salt}`],
    ['N fora da lista (2^20 — estouraria a memória)', `scrypt$N=1048576,r=8,p=3$${salt}$${key}`],
    ['N que não é potência aceita', `scrypt$N=30000,r=8,p=3$${salt}$${key}`],
    ['r diferente de 8', `scrypt$N=32768,r=16,p=3$${salt}$${key}`],
    ['p acima do teto', `scrypt$N=32768,r=8,p=5$${salt}$${key}`],
    ['p zero', `scrypt$N=32768,r=8,p=0$${salt}$${key}`],
    ['base64 não canônico (bits sobrando)', `scrypt$N=32768,r=8,p=3$${'A'.repeat(21)}B==$${key}`],
    ['base64 com caractere inválido', `scrypt$N=32768,r=8,p=3$${'A'.repeat(21)}*==$${key}`],
    ['caixa trocada no prefixo', `SCRYPT$N=32768,r=8,p=3$${salt}$${key}`],
    ['MD5 com 31 hex', md5Password(PASS).slice(1)],
    ['bcrypt alheio', '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'],
  ])('H2 %s → invalid, não confere e NÃO calcula', async (_name, stored) => {
    const spy = spyOn(crypto, 'scrypt')
    expect(storedPasswordForm(stored)).toBe('invalid')
    expect(await checkPassword(PASS, stored)).toEqual({ ok: false, needsRehash: false, form: 'invalid' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('H2 no login: hash gravado fora das formas = a MESMA 401 + alarme com ref (nunca 500); nada gravado', async () => {
    await seedUser(1, 'senha-em-claro')
    const e = await refused(login('u1@x.com', 'senha-em-claro'))
    expect([e.statusCode, e.message]).toEqual([401, LOGIN_REFUSED_MESSAGE])
    expect(recordCrash).toHaveBeenCalledWith(expect.objectContaining({ ref: 'REFSCRYPT', userId: 1 }))
    expect(JSON.stringify((recordCrash as jest.Mock).mock.calls)).not.toContain('senha-em-claro')   // o valor gravado nunca vai ao alarme
    expect(events).toEqual(['lock', 'failure', 'commit'])                  // conta como senha ERRADA (texto puro nunca confere)
    expect(users.get(1)!.password).toBe('senha-em-claro')
  })
})

// ---- H3/H4/H7 — a migração no login ----------------------------------------------------------------------------------------
describe('H3/H4/H7 — o login certo regrava o MD5 em scrypt, sob a trava, por compare-and-set, sem tocar password_set_at', () => {
  it('H3 MD5 confere → 200 e o valor vira scrypt na MESMA transação (antes do COMMIT); o 2º login compara scrypt sem escrever', async () => {
    const u = await seedUser(1, md5Password(PASS))
    const r = await login('u1@x.com', PASS)
    expect(r.status).toBe('ok')
    expect(events).toEqual(['lock', 'rehash', 'commit'])
    expect(storedPasswordForm(u.password)).toBe('scrypt')
    expect(u.password).toMatch(new RegExp(`^scrypt\\$N=${TEST_WEIGHT.N},r=8,p=${TEST_WEIGHT.p}\\$`))
    expect(u.passwordSetAt).toBe(SET_AT)                                     // não é senha nova: a sessão aberta NÃO cai (D-EA7)
    events = []
    const spy = spyOn(piece, 'checkPassword')
    expect((await login('u1@x.com', PASS)).status).toBe('ok')
    expect(events).toEqual(['lock', 'commit'])                             // zero escrita no login comum
    expect(await spy.mock.results[0].value).toMatchObject({ ok: true, form: 'scrypt', needsRehash: false })
  })

  it('H3 senha ERRADA contra MD5 nunca regrava (e nem calcula o hash novo)', async () => {
    const u = await seedUser(1, md5Password(PASS))
    const spy = spyOn(piece, 'hashPassword')
    await refused(login('u1@x.com', 'errada-kq7#mv2x'))
    expect(events).toEqual(['lock', 'failure', 'commit'])
    expect(u.password).toBe(md5Password(PASS))
    expect(spy).not.toHaveBeenCalled()
  })

  it('H3 inativo e sem vínculo com a senha certa NÃO regravam (não admitidos — D-EA6)', async () => {
    const u = await seedUser(1, md5Password(PASS))
    u.active = 'N'
    await refused(login('u1@x.com', PASS))
    expect(u.password).toBe(md5Password(PASS))
    expect(events).not.toContain('rehash')
  })

  it('H4 a senha trocada em paralelo (entre a conferência e a trava) NUNCA é sobrescrita pela migração', async () => {
    const u = await seedUser(1, md5Password(PASS))
    const nova = await hashPassword('nova-pelo-codigo-1')
    beforeLock = () => { u.password = nova }                                // a troca pelo código chegou antes da trava
    const e = await refused(login('u1@x.com', PASS))                         // reconfere contra o travado: a senha antiga não vale mais
    expect(e.statusCode).toBe(401)
    expect(u.password).toBe(nova)
    expect(events).not.toContain('rehash')
  })

  it('H7/H9 OUTRO login certo regravou o MD5 entre a conferência e a trava: solta a trava e confere FORA dela (nunca scrypt sob a trava)', async () => {
    const u = await seedUser(1, md5Password(PASS))
    const migrated = await hashPassword(PASS)                              // o que o login paralelo gravou
    beforeLock = () => { u.password = migrated }
    const order: string[] = []
    const realCheck = piece.checkPassword
    spyOn(piece, 'checkPassword').mockImplementation(async (p: string, st: any) => { order.push(`check:${storedPasswordForm(st)}`); return realCheck(p, st) })
    q.mockImplementation(async (sql: string, params: any[] = []) => run(sql, params, false))
    getConn.mockImplementation(async () => { order.push('conexão'); return newConn() })
    expect((await login('u1@x.com', PASS)).status).toBe('ok')
    expect(order).toEqual(['check:md5', 'conexão', 'check:scrypt', 'conexão'])   // a 2ª conferência entre as duas transações
    expect(events).toEqual(['lock', 'commit', 'lock', 'commit'])           // a 1ª não grava nada; nenhuma regravação (já está no peso)
    expect(u.password).toBe(migrated)
  })

  it('H4 o compare-and-set do repositório: valor conferido já não é o gravado = 0 linhas, nada muda', async () => {
    const u = await seedUser(1, 'scrypt-atual-qualquer')
    const conn = newConn()
    await conn.beginTransaction()
    expect(await rehashPassword(conn as any, 1, md5Password(PASS), 'novo')).toBe(false)
    expect(u.password).toBe('scrypt-atual-qualquer')
    expect(String(conn.query.mock.calls[0][0])).toMatch(/AND BINARY password = \?/)
    expect(String(conn.query.mock.calls[0][0])).not.toMatch(/password_set_at|updated_at/)
  })

  it('H7 o scrypt roda FORA da trava: conferência e hash novo antes do FOR UPDATE; sob a trava, só contar, decidir e gravar', async () => {
    await seedUser(1, md5Password(PASS))
    const order: string[] = []
    const realCheck = piece.checkPassword, realHash = piece.hashPassword
    spyOn(piece, 'checkPassword').mockImplementation(async (p: string, st: any) => { const r = await realCheck(p, st); order.push('check'); return r })
    spyOn(piece, 'hashPassword').mockImplementation(async (p: string) => { const r = await realHash(p); order.push('hash'); return r })
    q.mockImplementation(async (sql: string, params: any[] = []) => run(sql, params, false))
    getConn.mockImplementation(async () => { order.push('conexão'); return newConn() })
    await login('u1@x.com', PASS)
    expect(order).toEqual(['check', 'hash', 'conexão'])                     // nenhum cálculo com conexão do pool presa
  })

  it('H7 conta inexistente e conta bloqueada NÃO calculam hash (o piso esconde a diferença — Q-EA43)', async () => {
    const spy = spyOn(piece, 'checkPassword'), spyH = spyOn(piece, 'hashPassword')
    await refused(login('ninguem@x.com', PASS))
    await seedUser(2, md5Password(PASS))
    q.mockImplementation(async (sql: string, params: any[] = []) =>
      /COUNT\(\*\) AS n FROM setes_central\.tb_user_login_failure/.test(sql) ? [[{ n: 10 }]] : run(sql, params, false))
    await refused(login('u2@x.com', PASS))
    expect(spy).not.toHaveBeenCalled()
    expect(spyH).not.toHaveBeenCalled()
  })
})

// ---- H10 — troca de PESO (D-EA18) --------------------------------------------------------------------------------------------
describe('H10 — troca de peso: o valor antigo confere e é RECALCULADO no próximo login certo', () => {
  const OLD: ScryptParams = { N: 2 ** 14, r: 8, p: 1 }
  const NEW: ScryptParams = { N: 2 ** 14, r: 8, p: 2 }

  it('H10 peso antigo confere (o peso vem do valor gravado) e pede recálculo; no peso vigente não pede', async () => {
    setCurrentScryptParamsForTests(OLD)
    const old = await hashPassword(PASS)
    setCurrentScryptParamsForTests(NEW)
    expect(await checkPassword(PASS, old)).toEqual({ ok: true, needsRehash: true, form: 'scrypt' })
    expect(await checkPassword('errada', old)).toEqual({ ok: false, needsRehash: false, form: 'scrypt' })
    expect(await checkPassword(PASS, await hashPassword(PASS))).toEqual({ ok: true, needsRehash: false, form: 'scrypt' })
  })

  it('H10 no login certo o valor vai para o peso novo, na mesma transação, sem tocar password_set_at; o errado nunca recalcula', async () => {
    setCurrentScryptParamsForTests(OLD)
    const u = await seedUser(1, await hashPassword(PASS))
    const before = u.password
    setCurrentScryptParamsForTests(NEW)
    await refused(login('u1@x.com', 'errada-kq7#mv2x'))
    expect(u.password).toBe(before)
    events = []
    expect((await login('u1@x.com', PASS)).status).toBe('ok')
    expect(events).toEqual(['lock', 'rehash', 'commit'])
    expect(u.password).toMatch(/^scrypt\$N=16384,r=8,p=2\$/)
    expect(u.passwordSetAt).toBe(SET_AT)
  })

  it('H10 o peso só aceita valores da lista (o setter recusa um N fora dela)', () => {
    expect(() => setCurrentScryptParamsForTests({ N: 2 ** 20, r: 8, p: 1 })).toThrow(/fora da lista/)
  })
})

// ---- H6/H10 — cercas por varredura -------------------------------------------------------------------------------------------
function prodFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) return d.name === '__tests__' || d.name === 'test-setup' ? [] : prodFiles(p)
    return /\.ts$/.test(d.name) ? [p] : []
  })
}
const PIECE = path.join(SRC, 'shared', 'auth', 'password.ts')

describe('H6/H10 — cercas: todo escritor pela peça; o peso num lugar só; nunca scryptSync', () => {
  const files = [...prodFiles(SRC), path.join(ROOT, 'scripts', 'reset-super-password.ts')]
  const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, '/')

  it('H6 nenhum MD5 de senha fora da peça (createHash(\'md5\') nem md5Password em produção)', () => {
    const bad = files.filter(f => f !== PIECE).filter(f => /createHash\(\s*['"]md5['"]|md5Password/.test(fs.readFileSync(f, 'utf8')))
    expect(bad.map(rel)).toEqual([])
  })

  it('H6 os escritores chamam hashPassword: cadastro (POST/PUT), admin do onboarding, troca pelo código, script do Super', () => {
    const uses = (f: string) => /\bhashPassword\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))
    for (const f of ['src/modules/users/users.service.ts', 'src/modules/institutions/institutions.service.ts',
      'src/modules/auth/auth.service.ts', 'src/modules/auth/super-password-reset.ts']) expect([f, uses(f)]).toEqual([f, true])
    const sup = fs.readFileSync(path.join(SRC, 'modules', 'auth', 'super-password-reset.ts'), 'utf8')
    expect(sup).not.toMatch(/\[0-9A-F\]\{32\}/)                             // o script do Super deixou de exigir "32 hex"
  })

  it('H7/H10 nunca scryptSync; o crypto.scrypt e o peso (N/r/p) só dentro da peça', () => {
    for (const f of files) {
      const code = fs.readFileSync(f, 'utf8')
      expect([rel(f), /\bscryptSync\s*\(|import\s*\{[^}]*\bscryptSync\b/.test(code)]).toEqual([rel(f), false])   // a chamada/import (comentário pode citar)
      if (f === PIECE) continue
      expect([rel(f), /import\s*\{[^}]*\bscrypt\b[^}]*\}\s*from\s*'crypto'|\bcrypto\.scrypt\b|require\(\s*'crypto'\s*\)\.scrypt\b/.test(code)]).toEqual([rel(f), false])
      expect([rel(f), /\bN\s*:\s*2\s*\*\*\s*1\d|\bN\s*:\s*(16384|32768|65536|131072)\b|N=\d+,r=\d|scrypt\$N=/.test(code)]).toEqual([rel(f), false])
    }
  })

  it('H10 só testes trocam o peso (setCurrentScryptParamsForTests fora de __tests__/test-setup = proibido)', () => {
    const bad = files.filter(f => f !== PIECE).filter(f => /setCurrentScryptParamsForTests/.test(fs.readFileSync(f, 'utf8')))
    expect(bad.map(rel)).toEqual([])
  })
})
