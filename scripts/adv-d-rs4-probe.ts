/**
 * SONDA ADVERSARIAL do D-RS4 em InnoDB REAL (gate de entrega 2026-10-21) — molde de scripts/prove-password-reset-lock.ts.
 * Schema DESCARTÁVEL `setes_advrs4_probe_<pid>` (cópia VAZIA de tb_user + o sql/67 com o USE trocado), usuários SINTÉTICOS 9xxxxx,
 * chave de assinatura DESCARTÁVEL (o HMAC deriva dela), SQL do CÓDIGO REAL com `setes_central.` trocado no texto. `setes_central` só é
 * LIDA (impressão digital antes/depois); o schema é apagado no fim, inclusive em falha.
 *
 * O que ataca:
 *   P1 (d) falha DETERMINÍSTICA do INSERT do aviso (aqui: CHECK extra na tabela irmã — vale por INSERT negado/coluna divergente) → o +1 da
 *       5ª errada é desfeito pelo ROLLBACK? failed_attempts fica em 4 e o código CERTO depois troca a senha?
 *   P2 (b) fronteira da hora com o NOW() do banco: aviso com exatamente 60 min → nova vaga; com 59 min → calado.
 *   P3 (a) tempo REAL da transação: errada comum × 5ª errada (EXISTS + MAX + INSERT a mais) — cabe no piso de 400 ms?
 *   P4 (e) CHECK/PK/FK da irmã: kind 'X', seq 0, PK duplicada, usuário inexistente.
 *   P5 (b) corrida: 2 "5ªs" em paralelo = 1 vaga; 10 pedidos calados em paralelo = ≤ 1 vaga; zero deadlock.
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/adv-d-rs4-probe.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync } from 'crypto'
import mysql from 'mysql2/promise'
import pool from '@shared/db/connection'
import { resetJwtKeyRing } from '@shared/auth/product-token'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { detectLockWaitSupport } from '@shared/db/counters'
import { splitStatements } from '../src/migrations/runner'
import {
  issuePasswordResetCode, judgePasswordResetCode, PASSWORD_RESET_MAX_FAILED_ATTEMPTS, PASSWORD_RESET_MAX_PER_HOUR,
} from '@modules/auth/auth.service'
import { AuthUser } from '@modules/auth/auth.repository'

const PROBE = `setes_advrs4_probe_${process.pid}`
const SQL67 = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '..', '..', 'sql'), '67_user_password_reset_ddl.sql')
const results: Array<[string, string]> = []
let deadlocksSeen = 0
const ok = (label: string, cond: boolean, detail: string) => {
  results.push([cond ? 'OK  ' : 'FALHA', `${label} — ${detail}`])
  if (!cond) process.exitCode = 1
}
/** Achado: a condição SEGURA que o código atual quebra (registrada como ACHADO, não como falha da sonda). */
const found = (label: string, broken: boolean, detail: string) => {
  results.push([broken ? 'ACHADO' : 'RESISTIU', `${label} — ${detail}`])
}

function probeConn(conn: mysql.PoolConnection): any {
  return new Proxy(conn, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (sql: string, params?: unknown[]) => {
          if (/setes_central\./.test(sql) && !/tb_user\b|tb_user_password_reset|tb_entity_has_mailing|tb_mailing/.test(sql)) {
            throw new Error(`a sonda só redireciona tabelas do pedido de troca de senha: ${sql.slice(0, 80)}`)
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

const user = (id: number, password: string): AuthUser => ({ id, password, active: 'S', loginEmail: `u${id}@probe.test` })
async function currentPassword(id: number): Promise<string> {
  const [rows] = await pool.query<any[]>(`SELECT password FROM \`${PROBE}\`.tb_user WHERE id = ?`, [id])
  return rows[0].password
}
async function asUser(id: number): Promise<AuthUser> { return user(id, await currentPassword(id)) }
async function failedOf(id: number): Promise<number> {
  const [r] = await pool.query<any[]>(`SELECT failed_attempts FROM \`${PROBE}\`.tb_user_password_reset WHERE tb_user_id = ? ORDER BY seq DESC LIMIT 1`, [id])
  return Number(r[0]?.failed_attempts ?? -1)
}
async function noticesOf(id: number): Promise<string[]> {
  const [r] = await pool.query<any[]>(`SELECT seq, kind FROM \`${PROBE}\`.tb_user_password_reset_notice WHERE tb_user_id = ? ORDER BY seq`, [id])
  return r.map(x => `${x.seq}${x.kind}`)
}
const tally = (xs: string[]) => Object.entries(xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {})).map(([k, v]) => `${k}×${v}`).join(' ')

async function centralFingerprint(): Promise<string> {
  const [t] = await pool.query<any[]>(
    `SELECT COUNT(*) AS n, SUM(table_name LIKE 'tb_user_password_reset%') AS reset FROM information_schema.tables WHERE table_schema = 'setes_central'`)
  const [u] = await pool.query<any[]>(`SELECT COUNT(*) AS n, MD5(GROUP_CONCAT(CONCAT(id, ':', COALESCE(password, ''), ':', COALESCE(updated_at, '')) ORDER BY id)) AS h FROM setes_central.tb_user`)
  return JSON.stringify({ tables: Number(t[0].n), reset: Number(t[0].reset ?? 0), users: `${u[0].n}:${u[0].h}` })
}

async function applySql67(conn: mysql.Connection): Promise<void> {
  const sql = fs.readFileSync(SQL67, 'utf8').replace(/USE `setes_central`;/, `USE \`${PROBE}\`;`)
  if (!sql.includes(PROBE)) throw new Error('sql/67 sem o USE esperado')
  for (const stmt of splitStatements(sql)) await conn.query(stmt)
}

function throwawaySigningKey(): string {
  const file = path.join(os.tmpdir(), `setes-advrs4-probe-${process.pid}.pem`)
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  process.env.JWT_PRIVATE_KEY_PATH = file
  process.env.JWT_KID = 'probe'
  delete process.env.JWT_PUBLIC_KEYS
  resetJwtKeyRing()
  return file
}

async function main() {
  const keyFile = throwawaySigningKey()
  await detectLockWaitSupport()
  const before = await centralFingerprint()
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, timezone: 'Z',
  })
  try {
    await admin.query(`CREATE SCHEMA \`${PROBE}\` DEFAULT CHARACTER SET utf8mb4`)
    await admin.query(`CREATE TABLE \`${PROBE}\`.tb_user LIKE setes_central.tb_user`)
    const users = Array.from({ length: 8 }, (_, i) => 900001 + i)
    await admin.query(`INSERT INTO \`${PROBE}\`.tb_user (id, password, active, activation_key, created_at, updated_at, deleted) VALUES ?`,
      [users.map(id => [id, `HASH${id}`, 'S', null, new Date(), new Date(), 'N'])])
    await applySql67(admin)
    const NOTICE = `\`${PROBE}\`.tb_user_password_reset_notice`

    // ---- P1 (d): o INSERT do aviso falha de forma determinística — o +1 da 5ª errada sobrevive? -------------------------------------
    const u1 = 900001
    await admin.query(`ALTER TABLE ${NOTICE} ADD CONSTRAINT ck_adv_block CHECK (seq < 0)`)   // todo INSERT do aviso falha (4025)
    await inTx('emit1', c => issuePasswordResetCode(c, user(u1, `HASH${u1}`), '313131'))
    const who1 = await asUser(u1)
    const errs1: string[] = []
    for (let i = 0; i < PASSWORD_RESET_MAX_FAILED_ATTEMPTS + 2; i++) {        // 7 erradas: a 5ª, 6ª e 7ª "esgotariam"
      try { await inTx('wrong1', c => judgePasswordResetCode(c, who1, String(700000 + i), 'NOVA')) } catch (e: any) { errs1.push(String(e.errno ?? e.code)) }
    }
    const failed1 = await failedOf(u1)
    let right1 = 'erro'
    try { right1 = (await inTx('right1', c => judgePasswordResetCode(c, who1, '313131', 'TOMADA'))).verdict } catch (e: any) { right1 = `erro:${e.errno}` }
    const pw1 = await currentPassword(u1)
    found('P1 (d) INSERT do aviso falhando: o +1 da 5ª errada é DESFEITO — failed fica abaixo do teto e o código CERTO depois troca a senha',
      failed1 < PASSWORD_RESET_MAX_FAILED_ATTEMPTS || right1 === 'changed',
      `erros na 5ª..7ª = [${errs1.join(',')}]; failed_attempts depois de 7 erradas = ${failed1} (teto ${PASSWORD_RESET_MAX_FAILED_ATTEMPTS}); `
      + `código certo depois = ${right1}; senha ${pw1 === 'TOMADA' ? 'TROCADA' : 'intacta'}; avisos ${(await noticesOf(u1)).join(',') || 'nenhum'}`)
    await admin.query(`ALTER TABLE ${NOTICE} DROP CONSTRAINT ck_adv_block`)

    // ---- P2 (b): fronteira da hora com o relógio do BANCO -----------------------------------------------------------------------
    const u2 = 900002
    for (let i = 0; i <= PASSWORD_RESET_MAX_PER_HOUR; i++) await inTx('emit2', c => issuePasswordResetCode(c, user(u2, `HASH${u2}`), '424242'))
    const n2a = await noticesOf(u2)                                                  // 4º pedido = capped → vaga 1 (C)
    // os recuos saem pelo POOL (sessão em UTC, como o código): a conexão `admin` está no fuso do servidor e um NOW() dela recuaria ~4 h
    await pool.query(`UPDATE ${NOTICE} SET created_at = NOW() - INTERVAL 59 MINUTE WHERE tb_user_id = ?`, [u2])
    const at59 = await inTx('cap59', c => issuePasswordResetCode(c, user(u2, `HASH${u2}`), '424243'))
    await pool.query(`UPDATE ${NOTICE} SET created_at = NOW() - INTERVAL 60 MINUTE WHERE tb_user_id = ?`, [u2])
    const at60 = await inTx('cap60', c => issuePasswordResetCode(c, user(u2, `HASH${u2}`), '424244'))
    const n2b = await noticesOf(u2)
    ok('P2 (b) fronteira: aviso com 59 min = calado; com 60 min exatos = nova vaga (seq 2) — "1/h" é ≥ 60 min, pelo NOW() do banco',
      n2a.length === 1 && at59.verdict === 'capped' && !at59.notice && at60.verdict === 'capped' && at60.notice === 'C' && n2b.join(',') === '1C,2C',
      `depois do 4º pedido: ${n2a.join(',')}; aos 59 min: ${at59.verdict}/${at59.notice ?? 'sem vaga'}; aos 60 min: ${at60.verdict}/${at60.notice ?? 'sem vaga'}; linhas ${n2b.join(',')}`)

    // ---- P3 (a): o tempo REAL da transação — errada comum × a 5ª (vaga) -----------------------------------------------------------
    const u3 = 900003
    await inTx('emit3', c => issuePasswordResetCode(c, user(u3, `HASH${u3}`), '535353'))
    const who3 = await asUser(u3)
    const ms: number[] = []
    for (let i = 0; i < PASSWORD_RESET_MAX_FAILED_ATTEMPTS; i++) {
      const t = process.hrtime.bigint()
      await inTx('wrong3', c => judgePasswordResetCode(c, who3, String(710000 + i), 'NOVA'))
      ms.push(Number(process.hrtime.bigint() - t) / 1e6)
    }
    const plain = ms.slice(1, -1), fifth = ms[ms.length - 1]
    ok('P3 (a) tempo da transação: a 5ª errada (EXISTS + MAX + INSERT) fica muito abaixo do piso de 400 ms — o piso esconde o trabalho a mais',
      fifth < 100 && Math.max(...plain) < 100,
      `erradas comuns = [${plain.map(x => x.toFixed(1)).join(', ')}] ms; a 5ª (vaga) = ${fifth.toFixed(1)} ms; piso 400 ms; avisos ${(await noticesOf(u3)).join(',')}`)

    // ---- P4 (e): CHECK/PK/FK da irmã -------------------------------------------------------------------------------------------------
    const rejected: string[] = []
    for (const [what, sql, vals] of [
      ['kind X', `INSERT INTO ${NOTICE} (tb_user_id, seq, kind, created_at) VALUES (?, 99, 'X', NOW())`, [u3]],
      ['kind minúsculo e', `INSERT INTO ${NOTICE} (tb_user_id, seq, kind, created_at) VALUES (?, 99, 'e', NOW())`, [u3]],
      ['seq 0', `INSERT INTO ${NOTICE} (tb_user_id, seq, kind, created_at) VALUES (?, 0, 'E', NOW())`, [u3]],
      ['PK duplicada (1)', `INSERT INTO ${NOTICE} (tb_user_id, seq, kind, created_at) VALUES (?, 1, 'E', NOW())`, [u3]],
      ['usuário inexistente (FK)', `INSERT INTO ${NOTICE} (tb_user_id, seq, kind, created_at) VALUES (123456789, 1, 'E', NOW())`, []],
      ['created_at NULL', `INSERT INTO ${NOTICE} (tb_user_id, seq, kind, created_at) VALUES (?, 98, 'E', NULL)`, [u3]],
    ] as Array<[string, string, unknown[]]>) {
      try { await admin.query(sql, vals); rejected.push(`${what}:ACEITO`) } catch (e: any) { rejected.push(`${what}:${e.errno}`) }
    }
    // (a colação unicode_ci iguala 'e' a 'E' — o CHECK aceita a minúscula? se aceitar, a linha fica gravada com 'e')
    const [lower] = await admin.query<any[]>(`SELECT COUNT(*) AS n FROM ${NOTICE} WHERE tb_user_id = ? AND seq = 99`, [u3])
    await admin.query(`DELETE FROM ${NOTICE} WHERE seq IN (98, 99)`)                 // descartável — §3.1 não se aplica
    ok('P4 (e) a irmã recusa kind fora de E/C, seq 0, PK duplicada, FK órfã e created_at NULL',
      rejected.filter(r => r.endsWith(':ACEITO')).every(r => r.startsWith('kind minúsculo')) && rejected.filter(r => !r.endsWith(':ACEITO')).length >= 5,
      `${rejected.join(', ')}; linha com kind minúsculo gravada = ${lower[0].n} (o código só escreve 'E'/'C' tipados — nota)`)

    // ---- P5 (b): corrida real — 2 "5ªs" em paralelo; 10 pedidos calados em paralelo ------------------------------------------------
    const deadlocksBefore = deadlocksSeen
    const u5 = 900004
    await inTx('emit5', c => issuePasswordResetCode(c, user(u5, `HASH${u5}`), '646464'))
    const who5 = await asUser(u5)
    for (let i = 0; i < PASSWORD_RESET_MAX_FAILED_ATTEMPTS - 1; i++) await inTx('wrong5', c => judgePasswordResetCode(c, who5, String(720000 + i), 'NOVA'))
    const pair = await Promise.all([0, 1].map(i => inTx('fifth5', c => judgePasswordResetCode(c, who5, String(730000 + i), 'NOVA'))))
    const n5 = await noticesOf(u5)
    const u6 = 900005
    for (let i = 0; i < PASSWORD_RESET_MAX_PER_HOUR; i++) await inTx('emit6', c => issuePasswordResetCode(c, user(u6, `HASH${u6}`), '757575'))
    const capped = await Promise.all(Array.from({ length: 10 }, (_, i) => inTx('cap6', c => issuePasswordResetCode(c, user(u6, `HASH${u6}`), String(760000 + i)))))
    const n6 = await noticesOf(u6)
    ok('P5 (b) corrida InnoDB: 2 "5ªs" em paralelo = 1 vaga E (a outra = exhausted); 10 calados em paralelo = 1 vaga C; failed = 5; zero deadlock',
      pair.filter(p => p.notice === 'E').length === 1 && pair.some(p => p.verdict === 'exhausted') && n5.join(',') === '1E'
        && (await failedOf(u5)) === PASSWORD_RESET_MAX_FAILED_ATTEMPTS
        && capped.every(c => c.verdict === 'capped') && capped.filter(c => c.notice).length === 1 && n6.join(',') === '1C' && deadlocksSeen === deadlocksBefore,
      `par: ${tally(pair.map(p => `${p.verdict}/${p.notice ?? '-'}`))}; linhas ${n5.join(',')}; failed=${await failedOf(u5)}; calados: ${tally(capped.map(c => `${c.verdict}/${c.notice ?? '-'}`))}; linhas ${n6.join(',')}; deadlocks ${deadlocksSeen - deadlocksBefore}`)
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS \`${PROBE}\``).catch(e => console.error('limpeza falhou', e))
    fs.rmSync(keyFile, { force: true })
    await admin.end().catch(() => undefined)
  }
  const after = await centralFingerprint()
  ok('setes_central intacta (tabelas, pedido/aviso ausentes como antes, tb_user igual)', before === after, after)
  const [left] = await pool.query<any[]>(`SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = ?`, [PROBE])
  ok('schema descartável apagado', Number(left[0].n) === 0, PROBE)
  for (const [status, line] of results) console.log(`${status} ${line}`)
}

main()
  .catch(err => { console.error('✗ a sonda falhou', err); process.exitCode = 1 })
  .finally(() => pool.end().catch(() => undefined))
