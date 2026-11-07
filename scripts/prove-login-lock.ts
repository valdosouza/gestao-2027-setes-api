/**
 * PROVA do limite por conta do login (Ondas 1+2 do endurecer — D-EA1/D-EA2/D-EA3/D-EA14/D-EA15; sql/74 + `judgeLoginAttempt` do auth) em
 * SCHEMA DESCARTÁVEL `setes_loginlock_probe_<pid>`: cópia VAZIA de `setes_central.tb_user` (CREATE TABLE … LIKE — sem dado) + os scripts
 * sql/67 e sql/74 aplicados com o `USE` trocado. Usuários SINTÉTICOS (ids 910001…). O SQL executado é o do CÓDIGO REAL: a conexão entregue
 * às funções do auth troca `setes_central.` pelo schema descartável no texto (nenhuma costura no código de produção). Molde:
 * `scripts/prove-password-reset-lock.ts`. NUNCA escreve em `setes_central` (confere antes/depois); apaga o schema no fim, inclusive em falha.
 * Plano: `Infra-IA/prompts/prompt_endurecer_autenticacao.md` §P.5 (P1–P8 + L13).
 *
 *   P1  DDL aplica e reaplica (re-executável); o reaplicar CONSERTA a tabela criada sem o índice da janela; CHECKs e FKs recusam.
 *   P2  50 erradas em PARALELO na mesma conta = exatamente 10 linhas, seq 1..10 sem buraco, zero deadlock que passe do retry; 1 aviso.
 *   P3  40 contas × 3 erradas em paralelo = zero deadlock (nem resolvido pelo retry) — leitura do filho consistente (regra 13).
 *   P4  rodada MISTA na mesma conta (erradas + certa + pedido e consumo de código da recuperação — as três filhas sob a MESMA trava).
 *   P5  `created_at` recuado 15 min + 1 s → desbloqueia (a certa entra).
 *   P6  aviso: 50 erradas paralelas = 1 linha de aviso; recuada 1 h (e a janela das falhas) → o próximo bloqueio toma seq 2.
 *   P7  com 10 mil falhas ANTIGAS da conta, a leitura que decide usa o índice da janela (EXPLAIN: range, Using index, poucas linhas).
 *   P8  `setes_central` intacta (as tabelas do 74 NÃO nascem lá por esta prova).
 *   L6  o escritor da senha (`updatePassword`, o do script do Super e da recuperação) troca a senha e a conta SEGUE bloqueada.
 *   L13 trava S das FKs: uma transação de negócio insere em tabela com FK para tb_user e segura o COMMIT por 6 s → o login da MESMA
 *       conta recebe 1205 depois de ~5 s (vira a 401 neutra); com 1 s o login espera e passa.
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-login-lock.ts
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
import { md5Password, checkPassword } from '@shared/auth/password'
import { splitStatements } from '../src/migrations/runner'
import { judgeLoginAttempt, issuePasswordResetCode, judgePasswordResetCode, LoginJudgement } from '@modules/auth/auth.service'
import { AuthUser, countLoginFailuresInWindow, updatePassword, LOGIN_MAX_FAILURES } from '@modules/auth/auth.repository'

const PROBE = `setes_loginlock_probe_${process.pid}`
const SQL_DIR = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '..', '..', 'sql'))
const SQL67 = path.join(SQL_DIR, '67_user_password_reset_ddl.sql')
const SQL74 = path.join(SQL_DIR, '74_user_login_failure_ddl.sql')
const results: Array<[string, string]> = []
let deadlocksSeen = 0
const ok = (label: string, cond: boolean, detail: string) => {
  results.push([cond ? 'OK  ' : 'FALHA', `${label} — ${detail}`])
  if (!cond) process.exitCode = 1
}

/** A conexão do código real, com `setes_central.` trocado pelo descartável no TEXTO do SQL. */
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

/** A mesma transação do login (`withDeadlockRetry` 3×), contando cada deadlock. */
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

const PASS = (id: number) => `certa-${id}`
async function asUser(id: number): Promise<AuthUser> {
  const [rows] = await pool.query<any[]>(`SELECT password, active FROM \`${PROBE}\`.tb_user WHERE id = ?`, [id])
  return { id, password: rows[0].password, active: rows[0].active, loginEmail: `u${id}@probe.test` }
}
/** O login como o service faz: senha conferida FORA da trava, julgamento sob a trava (o caminho certo também passa por ela). */
async function attempt(id: number, password: string): Promise<LoginJudgement> {
  const who = await asUser(id)
  const pre = await checkPassword(password, who.password)
  return inTx('login', c => judgeLoginAttempt(c, who, password, pre))
}
async function failuresOf(id: number): Promise<Array<{ seq: number }>> {
  const [rows] = await pool.query<any[]>(`SELECT seq FROM \`${PROBE}\`.tb_user_login_failure WHERE tb_user_id = ? ORDER BY seq`, [id])
  return rows
}
async function noticesOf(id: number): Promise<Array<{ seq: number }>> {
  const [rows] = await pool.query<any[]>(`SELECT seq FROM \`${PROBE}\`.tb_user_login_block_notice WHERE tb_user_id = ? ORDER BY seq`, [id])
  return rows
}
async function windowCount(id: number): Promise<number> {
  const conn = await pool.getConnection()
  try { return await countLoginFailuresInWindow(id, probeConn(conn)) } finally { conn.release() }   // o pré-filtro: autocommit
}

async function centralFingerprint(): Promise<string> {
  const [t] = await pool.query<any[]>(
    `SELECT COUNT(*) AS n, SUM(table_name IN ('tb_user_login_failure', 'tb_user_login_block_notice')) AS lock74
       FROM information_schema.tables WHERE table_schema = 'setes_central'`)
  const [u] = await pool.query<any[]>(`SELECT COUNT(*) AS n, COALESCE(SUM(CRC32(CONCAT_WS('|', id, password, active, deleted))), 0) AS crc FROM setes_central.tb_user`)
  return JSON.stringify({ tables: Number(t[0].n), lock74: Number(t[0].lock74 ?? 0), users: Number(u[0].n), crc: String(u[0].crc) })
}

async function applySql(conn: mysql.Connection, file: string): Promise<void> {
  const sql = fs.readFileSync(file, 'utf8').replace(/USE `setes_central`;/, `USE \`${PROBE}\`;`)
  if (!sql.includes(PROBE)) throw new Error(`${path.basename(file)} sem o USE esperado`)
  for (const stmt of splitStatements(sql)) await conn.query(stmt)
}

function throwawaySigningKey(): string {
  const file = path.join(os.tmpdir(), `setes-loginlock-probe-${process.pid}.pem`)
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
  try {
    await admin.query(`SET time_zone = '+00:00'`)
    await admin.query(`CREATE SCHEMA \`${PROBE}\` DEFAULT CHARACTER SET utf8mb4`)
    await admin.query(`CREATE TABLE \`${PROBE}\`.tb_user LIKE setes_central.tb_user`)
    await admin.query(`ALTER TABLE \`${PROBE}\`.tb_user ADD COLUMN IF NOT EXISTS password_set_at DATETIME NULL DEFAULT NULL AFTER password`)
    const users = Array.from({ length: 120 }, (_, i) => 910001 + i)
    await admin.query(
      `INSERT INTO \`${PROBE}\`.tb_user (id, password, active, created_at, updated_at, deleted) VALUES ?`,
      [users.map(id => [id, md5Password(PASS(id)), 'S', new Date(), new Date(), 'N'])])

    // ---- P1. DDL ---------------------------------------------------------------------------------------------------------
    await applySql(admin, SQL67)
    // a tabela das falhas criada SEM o índice da janela (ensaio à mão / versão anterior) — o reaplicar do 74 tem de consertá-la
    await admin.query(`CREATE TABLE \`${PROBE}\`.tb_user_login_failure (tb_user_id int(11) NOT NULL, seq int(11) NOT NULL,
      created_at datetime NOT NULL, updated_at datetime DEFAULT NULL, deleted char(1) NOT NULL DEFAULT 'N', PRIMARY KEY (tb_user_id, seq))
      ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
    await applySql(admin, SQL74)
    const [idxFixed] = await admin.query<any[]>(`SHOW INDEX FROM \`${PROBE}\`.tb_user_login_failure WHERE Key_name = 'idx_user_login_failure_window'`)
    // a tabela de verdade (com FK e CHECK) para o resto da prova: recriada pelo próprio script
    await admin.query(`DROP TABLE \`${PROBE}\`.tb_user_login_failure`)
    await applySql(admin, SQL74)
    await applySql(admin, SQL74)                                        // re-executável
    const [idx] = await admin.query<any[]>(`SHOW INDEX FROM \`${PROBE}\`.tb_user_login_failure WHERE Key_name = 'idx_user_login_failure_window'`)
    const [fks] = await admin.query<any[]>(
      `SELECT constraint_name AS n FROM information_schema.referential_constraints WHERE constraint_schema = ? ORDER BY 1`, [PROBE])
    const rejected: string[] = []
    for (const [what, sql, vals] of [
      ['falha seq 0', `INSERT INTO \`${PROBE}\`.tb_user_login_failure (tb_user_id, seq, created_at) VALUES (?, 0, NOW())`, [910001]],
      ['aviso seq 0', `INSERT INTO \`${PROBE}\`.tb_user_login_block_notice (tb_user_id, seq, created_at) VALUES (?, 0, NOW())`, [910001]],
      ['falha de usuário inexistente (FK)', `INSERT INTO \`${PROBE}\`.tb_user_login_failure (tb_user_id, seq, created_at) VALUES (?, 1, NOW())`, [1]],
      ['aviso de usuário inexistente (FK)', `INSERT INTO \`${PROBE}\`.tb_user_login_block_notice (tb_user_id, seq, created_at) VALUES (?, 1, NOW())`, [1]],
    ] as Array<[string, string, unknown[]]>) {
      try {
        await admin.query(sql, vals)
        rejected.push(`${what}:ACEITO`)
      } catch (e: any) { rejected.push(`${what}:${e.errno}`) }
    }
    ok('P1 DDL re-executável; o reaplicar põe o índice da janela numa tabela criada sem ele; CHECKs e FKs recusam',
      idxFixed.length === 2 && idx.length === 2 && fks.map(f => f.n).includes('fk_user_login_failure_to_user')
        && fks.map(f => f.n).includes('fk_user_login_block_notice_to_user') && rejected.every(r => !/ACEITO/.test(r)),
      `índice consertado=${idxFixed.length === 2}; índice=${idx.map(i => i.Column_name).join(',')}; FKs ${fks.map(f => f.n).join(',')}; recusas ${rejected.join(' · ')}`)

    // ---- P2. 50 erradas em paralelo na MESMA conta ------------------------------------------------------------------------
    const u2 = 910001
    const d2 = deadlocksSeen
    const v2 = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => attempt(u2, `errada-${i}`)))
    const rows2 = await failuresOf(u2)
    const n2 = await noticesOf(u2)
    const err2 = v2.filter(v => v.status === 'rejected').map(v => (v as PromiseRejectedResult).reason?.code ?? 'erro')
    ok('P2 50 erradas em paralelo na mesma conta = exatamente 10 linhas, seq 1..10, zero erro que passe do retry, 1 aviso',
      rows2.length === LOGIN_MAX_FAILURES && rows2.every((r, i) => Number(r.seq) === i + 1) && err2.length === 0 && n2.length === 1,
      `linhas=${rows2.length}; seqs ${rows2.map(r => r.seq).join(',')}; vereditos ${tally(v2.map(v => v.status === 'fulfilled' ? v.value.verdict : 'erro'))}; `
      + `erros ${err2.join(',') || 'nenhum'}; deadlocks vistos (resolvidos pelo retry) = ${deadlocksSeen - d2}; avisos=${n2.length}`)

    // ---- P3. 40 contas × 3 erradas em paralelo -----------------------------------------------------------------------------
    const d3 = deadlocksSeen
    const accounts3 = users.slice(10, 50)
    const v3 = await Promise.allSettled(accounts3.flatMap(id => [0, 1, 2].map(i => attempt(id, `x-${i}`))))
    const [r3] = await pool.query<any[]>(`SELECT COUNT(*) AS n, MAX(seq) AS maxSeq FROM \`${PROBE}\`.tb_user_login_failure WHERE tb_user_id IN (?)`, [accounts3])
    const err3 = v3.filter(v => v.status === 'rejected').map(v => (v as PromiseRejectedResult).reason?.code ?? 'erro')
    ok('P3 40 contas × 3 erradas em paralelo: 120 linhas, zero deadlock (nem resolvido pelo retry)',
      Number(r3[0].n) === 120 && Number(r3[0].maxSeq) === 3 && err3.length === 0 && deadlocksSeen === d3,
      `linhas=${r3[0].n}; maior seq=${r3[0].maxSeq}; erros ${err3.join(',') || 'nenhum'}; deadlocks vistos = ${deadlocksSeen - d3}`)

    // ---- P4. rodada MISTA (login errado + login certo + pedido de código + consumo errado), 20 contas, tudo em paralelo ---------
    const d4 = deadlocksSeen
    const accounts4 = users.slice(50, 70)
    const who4 = new Map(await Promise.all(accounts4.map(async id => [id, await asUser(id)] as const)))
    const ops4 = accounts4.flatMap(id => [
      attempt(id, 'errada'),
      attempt(id, PASS(id)),
      inTx('mix-issue', c => issuePasswordResetCode(c, who4.get(id)!, '424242')),
      inTx('mix-consume', c => judgePasswordResetCode(c, who4.get(id)!, '111111', md5Password('outra'))),
      attempt(id, 'errada-2'),
    ])
    const v4 = await Promise.allSettled(ops4)
    const err4 = v4.filter(v => v.status === 'rejected').map(v => (v as PromiseRejectedResult).reason?.code ?? 'erro')
    ok('P4 rodada mista na mesma conta (login errado/certo + pedido e consumo de código — três filhas sob a MESMA trava): zero erro e deadlock',
      err4.length === 0 && deadlocksSeen === d4,
      `operações=${ops4.length}; vereditos ${tally(v4.map(v => v.status === 'fulfilled' ? ((v.value as any).verdict ?? v.value) : 'erro'))}; `
      + `erros ${err4.join(',') || 'nenhum'}; deadlocks vistos = ${deadlocksSeen - d4}`)

    // ---- L6. trocar a senha (o escritor do script do Super e da recuperação) NÃO desbloqueia --------------------------------
    await inTx('L6-update', c => updatePassword(c, u2, md5Password('Nova-Do-Super-1')))
    const l6 = await attempt(u2, 'Nova-Do-Super-1')
    const l6pre = await windowCount(u2)
    ok('L6 a senha trocada por updatePassword (com password_set_at) NÃO desbloqueia: a nova senha certa = bloqueada, nada gravado',
      l6.verdict === 'blocked' && l6pre === LOGIN_MAX_FAILURES && (await failuresOf(u2)).length === LOGIN_MAX_FAILURES,
      `veredito=${l6.verdict}; pré-filtro conta ${l6pre}`)

    // ---- P5. a janela desliza ------------------------------------------------------------------------------------------------
    await pool.query(`UPDATE \`${PROBE}\`.tb_user_login_failure SET created_at = created_at - INTERVAL 15 MINUTE - INTERVAL 1 SECOND WHERE tb_user_id = ?`, [u2])
    const p5 = await attempt(u2, 'Nova-Do-Super-1')
    ok('P5 created_at recuado 15 min + 1 s → desbloqueia (a senha certa é admitida, nada gravado)',
      p5.verdict === 'right' && (await windowCount(u2)) === 0 && (await failuresOf(u2)).length === LOGIN_MAX_FAILURES,
      `veredito=${p5.verdict}`)

    // ---- P6. o aviso: dentro da hora nenhum outro; recuada a hora, o próximo bloqueio toma seq 2 ------------------------------
    const v6a = await Promise.all(Array.from({ length: 50 }, (_, i) => attempt(u2, `y-${i}`)))   // a janela está vazia: bloqueia de novo
    const n6a = await noticesOf(u2)
    await pool.query(`UPDATE \`${PROBE}\`.tb_user_login_failure SET created_at = created_at - INTERVAL 16 MINUTE WHERE tb_user_id = ?`, [u2])
    await pool.query(`UPDATE \`${PROBE}\`.tb_user_login_block_notice SET created_at = created_at - INTERVAL 61 MINUTE WHERE tb_user_id = ?`, [u2])
    const v6b = await Promise.all(Array.from({ length: 50 }, (_, i) => attempt(u2, `z-${i}`)))
    const n6b = await noticesOf(u2)
    ok('P6 aviso: novo bloqueio dentro da hora = nenhuma vaga nova; recuada 1 h → o próximo bloqueio toma seq 2 (uma só, sob rajada)',
      n6a.length === 1 && v6a.filter(v => v.notice).length === 0 && v6b.filter(v => v.notice).length === 1
        && n6b.map(n => Number(n.seq)).join(',') === '1,2',
      `vagas na 2ª rajada=${v6a.filter(v => v.notice).length} (linhas ${n6a.length}); na 3ª=${v6b.filter(v => v.notice).length}; seqs ${n6b.map(n => n.seq).join(',')}`)

    // ---- P7. EXPLAIN com 10 mil falhas antigas -----------------------------------------------------------------------------
    const u7 = 910100
    const old = Array.from({ length: 10_000 }, (_, i) => [u7, i + 1, new Date(Date.now() - 2 * 86400_000 - i * 1000), null, 'N'])
    for (let i = 0; i < old.length; i += 2000) {
      await admin.query(`INSERT INTO \`${PROBE}\`.tb_user_login_failure (tb_user_id, seq, created_at, updated_at, deleted) VALUES ?`, [old.slice(i, i + 2000)])
    }
    await admin.query(`ANALYZE TABLE \`${PROBE}\`.tb_user_login_failure`)
    const [ex] = await admin.query<any[]>(
      `EXPLAIN SELECT COUNT(*) AS n FROM \`${PROBE}\`.tb_user_login_failure WHERE tb_user_id = ? AND created_at > NOW() - INTERVAL 15 MINUTE`, [u7])
    const e7 = ex[0]
    const p7 = await attempt(u7, PASS(u7))
    ok('P7 10 mil falhas antigas: a leitura que decide usa o índice da janela (range, Using index, poucas linhas) e a conta entra',
      e7.key === 'idx_user_login_failure_window' && e7.type === 'range' && /Using index/.test(String(e7.Extra)) && Number(e7.rows) <= 20
        && p7.verdict === 'right',
      `EXPLAIN key=${e7.key} type=${e7.type} rows=${e7.rows} Extra=${e7.Extra}; veredito=${p7.verdict}`)

    // ---- L13. trava S das FKs de negócio -----------------------------------------------------------------------------------
    await admin.query(`CREATE TABLE \`${PROBE}\`.tb_probe_order (id int NOT NULL, tb_user_id int(11) NOT NULL, PRIMARY KEY (id),
      CONSTRAINT fk_probe_order_user FOREIGN KEY (tb_user_id) REFERENCES \`${PROBE}\`.tb_user (id)) ENGINE=InnoDB`)
    const u13 = 910110
    const holdBusiness = async (id: number, holdMs: number) => {
      const c = await pool.getConnection()
      await c.beginTransaction()
      await c.query(`INSERT INTO \`${PROBE}\`.tb_probe_order (id, tb_user_id) VALUES (?, ?)`, [id, u13])   // S na linha do usuário (FK)
      return { done: new Promise<void>(r => setTimeout(async () => { await c.commit(); c.release(); r() }, holdMs)) }
    }
    const h6 = await holdBusiness(1, 6_000)
    const t6 = performance.now()
    let l13a: string
    try { l13a = (await attempt(u13, PASS(u13))).verdict } catch (e: any) { l13a = e?.code ?? 'erro' }
    const ms6 = Math.round(performance.now() - t6)
    await h6.done
    const h1 = await holdBusiness(2, 1_000)
    const t1 = performance.now()
    let l13b: string
    try { l13b = (await attempt(u13, PASS(u13))).verdict } catch (e: any) { l13b = e?.code ?? 'erro' }
    const ms1 = Math.round(performance.now() - t1)
    await h1.done
    ok('L13 trava S das FKs (limite aceito na A-EA2): negócio segura 6 s → o login da conta recebe 1205 após o WAIT 5 (medido ~5–6 s — a granularidade da espera do InnoDB; = a 401 neutra); 1 s → espera e passa',
      l13a === 'ER_LOCK_WAIT_TIMEOUT' && ms6 >= 4_500 && ms6 < 7_500 && l13b === 'right' && ms1 >= 800,
      `6 s: ${l13a} em ${ms6} ms · 1 s: ${l13b} em ${ms1} ms`)
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS \`${PROBE}\``).catch(e => console.error('limpeza falhou', e))
    fs.rmSync(keyFile, { force: true })
    await admin.end()
    const after = await centralFingerprint()
    ok('P8 setes_central intacta (tabelas, tb_user e nenhuma tabela do 74 criada lá por esta prova)', before === after, after)
    for (const [s, l] of results) console.log(`${s} ${l}`)
    await pool.end()
  }
}

main().catch(e => { console.error(e); process.exitCode = 1 })
