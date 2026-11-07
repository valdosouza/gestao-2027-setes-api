/**
 * PROVA da migração do hash da senha no login (Onda 4 do endurecer — D-EA9/D-EA18; §P.5 H9, com H3/H4/H10 ao vivo) em SCHEMA DESCARTÁVEL
 * `setes_scrypt_probe_<pid>`: cópia VAZIA de `setes_central.tb_user` (CREATE TABLE … LIKE — sem dado) + os scripts sql/67 e sql/74 com o
 * `USE` trocado. Usuários SINTÉTICOS (ids 920001…). O SQL é o do CÓDIGO REAL (`judgeLoginAttempt`, `rehashPassword`, `updatePassword`): a
 * conexão entregue às funções troca `setes_central.` pelo descartável no texto. Molde: `scripts/prove-login-lock.ts`. NUNCA escreve em
 * `setes_central` (confere antes/depois); apaga o schema no fim, inclusive em falha. Peso: o VIGENTE da peça (`SCRYPT_CURRENT`).
 *
 *   S1  10 contas MD5 + 10 scrypt no peso vigente + 5 scrypt em peso ANTIGO, 3 logins CERTOS em paralelo por conta + 1 errado, tudo junto:
 *       todos os certos admitidos; as MD5 e as de peso antigo migram para o peso vigente; as vigentes não são regravadas; zero deadlock
 *       que passe do retry; `password_set_at` INTACTO em todas; a senha nova confere.
 *       O hash TROCADO por outro login entre a conferência e a trava = 'stale': solta a trava e confere de novo FORA dela (nunca scrypt sob
 *       a trava — a 1ª versão reconferia ali e 10 de 100 logins certos estouravam a espera de 5 s).
 *   S2  (H4) troca de senha em paralelo com o login certo de conta MD5 (10 contas): a senha trocada NUNCA é sobrescrita pela migração.
 *   S3  `setes_central` intacta.
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-scrypt-migration.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { performance } from 'perf_hooks'
import { generateKeyPairSync } from 'crypto'
import mysql from 'mysql2/promise'
import pool from '@shared/db/connection'
import { resetJwtKeyRing } from '@shared/auth/product-token'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { detectLockWaitSupport } from '@shared/db/counters'
import {
  md5Password, checkPassword, hashPassword, storedPasswordForm, SCRYPT_CURRENT, setCurrentScryptParamsForTests,
} from '@shared/auth/password'
import { splitStatements } from '../src/migrations/runner'
import { judgeLoginAttempt, LOGIN_STALE_ROUNDS } from '@modules/auth/auth.service'
import { AuthUser, rehashPassword, updatePassword } from '@modules/auth/auth.repository'

const PROBE = `setes_scrypt_probe_${process.pid}`
const SQL_DIR = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '..', '..', 'sql'))
const SQL67 = path.join(SQL_DIR, '67_user_password_reset_ddl.sql')
const SQL74 = path.join(SQL_DIR, '74_user_login_failure_ddl.sql')
const SET_AT = '2026-10-01 10:00:00'
const results: Array<[string, string]> = []
let deadlocksSeen = 0
const ok = (label: string, cond: boolean, detail: string) => {
  results.push([cond ? 'OK  ' : 'FALHA', `${label} — ${detail}`])
  if (!cond) process.exitCode = 1
}

function probeConn(conn: mysql.PoolConnection): any {
  return new Proxy(conn, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (sql: string, params?: unknown[]) => {
          if (/setes_central\./.test(sql) && !/tb_user\b|tb_user_password_reset|tb_user_login_/.test(sql)) {
            throw new Error(`a prova só redireciona as tabelas da credencial: ${sql.slice(0, 80)}`)
          }
          return target.query(sql.replace(/setes_central\./g, `\`${PROBE}\`.`), params as any)
        }
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

async function inTx<T>(label: string, fn: (c: any) => Promise<T>): Promise<T> {
  return withDeadlockRetry(label, {}, 3, async () => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const r = await fn(probeConn(conn))
      await conn.commit()
      return r
    } catch (e: any) {
      if (e?.code === 'ER_LOCK_DEADLOCK') deadlocksSeen++
      await conn.rollback().catch(() => undefined)
      throw e
    } finally {
      conn.release()
    }
  })
}

const PASS = (id: number) => `certa-${id}-kq7`
async function asUser(id: number): Promise<AuthUser> {
  const [rows] = await pool.query<any[]>(`SELECT password, active FROM \`${PROBE}\`.tb_user WHERE id = ?`, [id])
  return { id, password: rows[0].password, active: rows[0].active, loginEmail: `u${id}@probe.test` }
}
async function row(id: number): Promise<{ password: string; setAt: string | null }> {
  const [rows] = await pool.query<any[]>(
    `SELECT password, DATE_FORMAT(password_set_at, '%Y-%m-%d %H:%i:%s') AS setAt FROM \`${PROBE}\`.tb_user WHERE id = ?`, [id])
  return { password: rows[0].password, setAt: rows[0].setAt }
}

/**
 * O login como o service faz (`loginOrRefuse`, passos 3–4): conferência e hash novo FORA da trava; julgamento sob a trava; admitido com
 * `rehash` → `rehashPassword` na mesma transação (a prova não tem vínculos: "admitido" = veredito certo e ativo).
 */
async function attempt(id: number, password: string): Promise<{ verdict: string; rehashed: boolean; rounds: number }> {
  let who = await asUser(id)
  for (let round = 1; round <= LOGIN_STALE_ROUNDS; round++) {
    const pre = await checkPassword(password, who.password)
    const rehashTo = pre.ok && pre.needsRehash ? await hashPassword(password) : null
    const r = await inTx('login', async c => {
      const j = await judgeLoginAttempt(c, who, password, pre, rehashTo, { staleIsRetry: true })
      let rehashed = false
      if (j.verdict === 'right' && j.active === 'S' && j.rehash) rehashed = await rehashPassword(c, id, j.rehash.from, j.rehash.to)
      return { verdict: j.verdict, rehashed, lockedHash: j.lockedHash }
    })
    if (r.verdict !== 'stale') return { verdict: r.verdict, rehashed: r.rehashed, rounds: round }
    staleRounds++
    who = { ...who, password: r.lockedHash ?? null }                       // solta a trava e confere de novo FORA dela
  }
  return { verdict: 'contenção (rodadas esgotadas)', rehashed: false, rounds: LOGIN_STALE_ROUNDS }
}
let staleRounds = 0

async function centralFingerprint(): Promise<string> {
  const [t] = await pool.query<any[]>(`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'setes_central'`)
  const [u] = await pool.query<any[]>(`SELECT COUNT(*) AS n, COALESCE(SUM(CRC32(CONCAT_WS('|', id, password, active, deleted))), 0) AS crc FROM setes_central.tb_user`)
  return JSON.stringify({ tables: Number(t[0].n), users: Number(u[0].n), crc: String(u[0].crc) })
}

async function applySql(conn: mysql.Connection, file: string): Promise<void> {
  const sql = fs.readFileSync(file, 'utf8').replace(/USE `setes_central`;/, `USE \`${PROBE}\`;`)
  if (!sql.includes(PROBE)) throw new Error(`${path.basename(file)} sem o USE esperado`)
  for (const stmt of splitStatements(sql)) await conn.query(stmt)
}

function throwawaySigningKey(): string {
  const file = path.join(os.tmpdir(), `setes-scrypt-probe-${process.pid}.pem`)
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  process.env.JWT_PRIVATE_KEY_PATH = file
  process.env.JWT_KID = 'probe'
  delete process.env.JWT_PUBLIC_KEYS
  resetJwtKeyRing()
  return file
}

function tally(xs: unknown[]): string {
  const m = new Map<string, number>()
  for (const x of xs) m.set(String(x), (m.get(String(x)) ?? 0) + 1)
  return [...m.entries()].map(([k, v]) => `${k}×${v}`).join(' ')
}

async function main() {
  const keyFile = throwawaySigningKey()
  await detectLockWaitSupport()
  const before = await centralFingerprint()
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    timezone: 'Z', multipleStatements: false,
  })
  const current = `N=${SCRYPT_CURRENT.N},r=${SCRYPT_CURRENT.r},p=${SCRYPT_CURRENT.p}`
  try {
    await admin.query(`SET time_zone = '+00:00'`)
    await admin.query(`CREATE SCHEMA \`${PROBE}\` DEFAULT CHARACTER SET utf8mb4`)
    await admin.query(`CREATE TABLE \`${PROBE}\`.tb_user LIKE setes_central.tb_user`)
    await admin.query(`ALTER TABLE \`${PROBE}\`.tb_user ADD COLUMN IF NOT EXISTS password_set_at DATETIME NULL DEFAULT NULL AFTER password`)
    await applySql(admin, SQL67)
    await applySql(admin, SQL74)

    const md5Ids = Array.from({ length: 10 }, (_, i) => 920001 + i)
    const curIds = Array.from({ length: 10 }, (_, i) => 920101 + i)
    const oldIds = Array.from({ length: 5 }, (_, i) => 920201 + i)
    const raceIds = Array.from({ length: 10 }, (_, i) => 920301 + i)
    const seed: Array<[number, string]> = []
    for (const id of [...md5Ids, ...raceIds]) seed.push([id, md5Password(PASS(id))])
    setCurrentScryptParamsForTests({ N: 2 ** 14, r: 8, p: 1 })               // o peso ANTIGO (D-EA18): gravado antes da "troca de peso"
    for (const id of oldIds) seed.push([id, await hashPassword(PASS(id))])
    setCurrentScryptParamsForTests(SCRYPT_CURRENT)                           // o vigente de produção daqui em diante
    for (const id of curIds) seed.push([id, await hashPassword(PASS(id))])
    await admin.query(
      `INSERT INTO \`${PROBE}\`.tb_user (id, password, password_set_at, active, created_at, updated_at, deleted) VALUES ?`,
      [seed.map(([id, h]) => [id, h, SET_AT, 'S', new Date(), new Date(), 'N'])])

    // ---- S1. os dois formatos (e o peso antigo) em logins paralelos ---------------------------------------------------------
    const t1 = performance.now()
    const all = [...md5Ids, ...curIds, ...oldIds]
    const jobs = all.flatMap(id => [
      attempt(id, PASS(id)).then(r => ({ id, kind: 'certa', ...r })),
      attempt(id, PASS(id)).then(r => ({ id, kind: 'certa', ...r })),
      attempt(id, PASS(id)).then(r => ({ id, kind: 'certa', ...r })),
      attempt(id, `errada-${id}`).then(r => ({ id, kind: 'errada', ...r })),
    ])
    const v1 = await Promise.allSettled(jobs)
    const wall1 = performance.now() - t1
    const fulfilled = v1.filter(v => v.status === 'fulfilled').map(v => (v as PromiseFulfilledResult<any>).value)
    const errors = v1.filter(v => v.status === 'rejected').map(v => (v as PromiseRejectedResult).reason?.code ?? String((v as any).reason))
    const rightOk = fulfilled.filter(f => f.kind === 'certa').every(f => f.verdict === 'right')
    const wrongOk = fulfilled.filter(f => f.kind === 'errada').every(f => f.verdict === 'wrong')
    const after = new Map<number, { password: string; setAt: string | null }>()
    for (const id of all) after.set(id, await row(id))
    const migrated = [...md5Ids, ...oldIds].every(id => after.get(id)!.password.startsWith(`scrypt$${current}$`))
    const untouched = curIds.every(id => after.get(id)!.password === seed.find(s => s[0] === id)![1])
    const setAtIntact = all.every(id => after.get(id)!.setAt === SET_AT)
    const rehashCount = fulfilled.filter(f => f.rehashed).length
    let verify = true
    for (const id of all) verify = verify && (await checkPassword(PASS(id), after.get(id)!.password)).ok
    ok('S1 (H9) 10 MD5 + 10 scrypt vigente + 5 scrypt de peso antigo, 3 certos + 1 errado por conta em paralelo',
      errors.length === 0 && rightOk && wrongOk && migrated && untouched && setAtIntact && verify && rehashCount === md5Ids.length + oldIds.length,
      `${jobs.length} logins em ${(wall1 / 1000).toFixed(1)} s; vereditos ${tally(fulfilled.map(f => `${f.kind}:${f.verdict}`))}; `
        + `erros ${errors.length ? tally(errors) : '0'}; deadlocks resolvidos pelo retry ${deadlocksSeen}; regravações ${rehashCount} `
        + `(esperado ${md5Ids.length + oldIds.length} — UMA por conta); rodadas repetidas fora da trava (hash já trocado por outro login) ${staleRounds}; migradas=${migrated}; `
        + `vigentes intocadas=${untouched}; password_set_at intacto=${setAtIntact}; todas conferem=${verify}`)
    ok('S1 (H9) zero deadlock', deadlocksSeen === 0, `deadlocks vistos ${deadlocksSeen}`)

    // ---- S2. (H4) troca de senha × migração em paralelo ---------------------------------------------------------------------
    const d2 = deadlocksSeen
    const newHashes = new Map<number, string>()
    for (const id of raceIds) newHashes.set(id, await hashPassword(`nova-${id}-kq7`))
    const v2 = await Promise.allSettled(raceIds.flatMap(id => [
      attempt(id, PASS(id)),
      inTx('troca', c => updatePassword(c, id, newHashes.get(id)!)),
    ]))
    const final2 = await Promise.all(raceIds.map(async id => ({ id, ...(await row(id)) })))
    const kept = final2.every(r => r.password === newHashes.get(r.id))
    ok('S2 (H4) troca de senha em paralelo com o login certo de conta MD5: a senha trocada nunca é sobrescrita',
      kept && v2.every(v => v.status === 'fulfilled'),
      `senhas novas preservadas ${final2.filter(r => r.password === newHashes.get(r.id)).length}/${raceIds.length}; `
        + `formas ${tally(final2.map(r => storedPasswordForm(r.password)))}; erros ${v2.filter(v => v.status === 'rejected').length}; `
        + `deadlocks ${deadlocksSeen - d2}`)
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS \`${PROBE}\``).catch(() => undefined)
    await admin.end().catch(() => undefined)
    fs.rmSync(keyFile, { force: true })
  }
  const afterCentral = await centralFingerprint()
  ok('S3 setes_central intacta', before === afterCentral, `antes ${before} · depois ${afterCentral}`)
  await pool.end()
  for (const [s, l] of results) console.log(`${s} ${l}`)
}

main().catch(async err => {
  console.error(err)
  process.exitCode = 1
  await pool.end().catch(() => undefined)
})
