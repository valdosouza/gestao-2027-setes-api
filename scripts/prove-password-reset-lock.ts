/**
 * PROVA do pedido de troca de senha (Q-PV38 / D-PV13 — sql/67 + `createPasswordResetCode`/`consumePasswordResetCode` do auth) em
 * SCHEMA DESCARTÁVEL `setes_pwreset_probe_<pid>`: cópia VAZIA de `setes_central.tb_user` (CREATE TABLE … LIKE — sem FK, sem dado) +
 * o script sql/67 aplicado com o `USE` trocado. Usuários SINTÉTICOS (ids 900001…). O SQL executado é o do CÓDIGO REAL: a conexão
 * entregue às funções do auth troca `setes_central.` pelo schema descartável no texto (nenhuma costura no código de produção).
 * NUNCA escreve em `setes_central` (confere antes/depois); apaga o schema no fim, inclusive em falha.
 *
 * O que prova (InnoDB de verdade, REPEATABLE READ como o pool):
 *   1. DDL: aplica, reaplica (re-executável), CHECKs recusam HMAC fora da forma/seq 0/tentativas negativas; a tb_user não sofre ALTER
 *      (coluna activation_key idêntica) e o código antigo em texto puro é limpo.
 *   2. 25 tentativas ERRADAS em paralelo contra o mesmo código → `failed_attempts` = teto, nenhuma a mais; o certo depois = esgotado.
 *   3. 10 emissões em paralelo para a MESMA conta → no máximo o teto por hora, `seq` 1..n sem buraco, zero erro.
 *   4. Emissões em paralelo para 40 CONTAS diferentes → todas emitem com seq 1 e NENHUM deadlock, nem os que o retry resolveria
 *      (1ª rodada, com as leituras do filho travantes: 1 deadlock de 12 contas passou de 5 retentativas — PADROES §9 regra 13).
 *   7. Rodada MISTA (para cada conta: tentativa errada + código novo + tentativa) em paralelo → zero erro, zero deadlock.
 *   5. Troca de senha pelo "admin" (UPDATE direto da senha) no meio → o código aberto não casa mais (HMAC amarrado à senha).
 *   6. Vencido (created_at recuado) → recusado; usado → recusado na 2ª vez.
 *   8. D-RS4 (2026-10-21): o AVISO AO DONO — 25 erradas em paralelo esgotam o código e tomam a vaga da hora UMA só vez (1 linha,
 *      kind E); 10 pedidos calados em paralelo (teto) na mesma hora NÃO tomam outra; passada a hora (created_at recuado), o teto
 *      calado toma a vaga de novo (seq 2, kind C); o CHECK recusa kind fora de E/C; zero deadlock (tabela irmã sob a MESMA trava).
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-password-reset-lock.ts
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
  createPasswordResetCode, consumePasswordResetCode, issuePasswordResetCode, judgePasswordResetCode,
  PASSWORD_RESET_MAX_FAILED_ATTEMPTS, PASSWORD_RESET_MAX_PER_HOUR,
} from '@modules/auth/auth.service'
import { AuthUser } from '@modules/auth/auth.repository'

const PROBE = `setes_pwreset_probe_${process.pid}`
const SQL67 = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '..', '..', 'sql'), '67_user_password_reset_ddl.sql')
const results: Array<[string, string]> = []
/** Deadlocks vistos (inclusive os que o retry resolveu) — o protocolo de trava promete ZERO. */
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
          if (/setes_central\./.test(sql) && !/tb_user\b|tb_user_password_reset|tb_entity_has_mailing|tb_mailing/.test(sql)) {
            throw new Error(`a prova só redireciona tabelas do pedido de troca de senha: ${sql.slice(0, 80)}`)
          }
          return target.query(sql.replace(/setes_central\./g, `\`${PROBE}\`.`), params as any)
        }
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

/** A mesma transação do service (`inPasswordResetTx`: 3 tentativas no deadlock), contando cada deadlock. */
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

async function centralFingerprint(): Promise<string> {
  const [t] = await pool.query<any[]>(
    `SELECT COUNT(*) AS n, SUM(table_name = 'tb_user_password_reset') AS reset FROM information_schema.tables WHERE table_schema = 'setes_central'`)
  const [c] = await pool.query<any[]>(
    `SELECT column_type, collation_name, is_nullable, column_default, column_comment FROM information_schema.columns
      WHERE table_schema = 'setes_central' AND table_name = 'tb_user' AND column_name = 'activation_key'`)
  return JSON.stringify({ tables: Number(t[0].n), reset: Number(t[0].reset ?? 0), activationKey: c[0] })
}

async function applySql67(conn: mysql.Connection): Promise<void> {
  const sql = fs.readFileSync(SQL67, 'utf8').replace(/USE `setes_central`;/, `USE \`${PROBE}\`;`)
  if (!sql.includes(PROBE)) throw new Error('sql/67 sem o USE esperado')
  for (const stmt of splitStatements(sql)) await conn.query(stmt)
}

/** O HMAC deriva da chave de assinatura: a prova usa um par DESCARTÁVEL (nunca a chave do .env). */
function throwawaySigningKey(): string {
  const file = path.join(os.tmpdir(), `setes-pwreset-probe-${process.pid}.pem`)
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
  await detectLockWaitSupport()                                         // a trava do usuário com FOR UPDATE WAIT n, como no boot
  const before = await centralFingerprint()
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    timezone: 'Z',
  })
  try {
    await admin.query(`CREATE SCHEMA \`${PROBE}\` DEFAULT CHARACTER SET utf8mb4`)
    await admin.query(`CREATE TABLE \`${PROBE}\`.tb_user LIKE setes_central.tb_user`)
    const users = Array.from({ length: 44 }, (_, i) => 900001 + i)
    await admin.query(
      `INSERT INTO \`${PROBE}\`.tb_user (id, password, active, activation_key, created_at, updated_at, deleted) VALUES ?`,
      [users.map(id => [id, `HASH${id}`, 'S', id === 900001 ? '654321' : null, new Date(), new Date(), 'N'])])   // 1 código antigo

    // ---- 1. DDL --------------------------------------------------------------------------------------------------------
    const [colBefore] = await admin.query<any[]>(`SHOW FULL COLUMNS FROM \`${PROBE}\`.tb_user LIKE 'activation_key'`)
    await applySql67(admin)
    await applySql67(admin)                                             // re-executável
    const [colAfter] = await admin.query<any[]>(`SHOW FULL COLUMNS FROM \`${PROBE}\`.tb_user LIKE 'activation_key'`)
    const same = ['Type', 'Collation', 'Null', 'Default', 'Comment'].every(k => colBefore[0][k] === colAfter[0][k])
    const [left] = await admin.query<any[]>(`SELECT COUNT(*) AS n FROM \`${PROBE}\`.tb_user WHERE activation_key IS NOT NULL`)
    ok('1a DDL re-executável; tb_user sem ALTER (coluna idêntica) e o código antigo em texto puro LIMPO',
      same && Number(left[0].n) === 0,
      `activation_key preenchidas depois = ${left[0].n}; coluna antes ${JSON.stringify({ ...colBefore[0], Privileges: undefined })} · depois ${JSON.stringify({ ...colAfter[0], Privileges: undefined })}`)
    const rejected: string[] = []
    for (const [what, vals] of [
      ['HMAC maiúsculo', [900001, 1, 'A'.repeat(64), 0]],
      ['HMAC curto', [900001, 1, 'a'.repeat(63), 0]],
      ['código puro', [900001, 1, '123456', 0]],
      ['seq 0', [900001, 0, 'a'.repeat(64), 0]],
      ['tentativas negativas', [900001, 1, 'a'.repeat(64), -1]],
    ] as Array<[string, unknown[]]>) {
      try {
        await admin.query(`INSERT INTO \`${PROBE}\`.tb_user_password_reset (tb_user_id, seq, code_hmac, failed_attempts, created_at) VALUES (?, ?, ?, ?, NOW())`, vals)
        await admin.query(`DELETE FROM \`${PROBE}\`.tb_user_password_reset`)   // schema descartável — §3.1 não se aplica
      } catch (e: any) { rejected.push(`${what}:${e.errno}`) }
    }
    ok('1b CHECKs recusam forma inválida', rejected.length === 5, rejected.join(', '))

    // ---- 2. rajada paralela de tentativas erradas ----------------------------------------------------------------------
    const u2 = 900001
    await inTx('emit', c => createPasswordResetCode(c, user(u2, `HASH${u2}`), '424242'))
    // o usuário é resolvido FORA da transação (como o service): ler pelo pool dentro dela esgotaria o pool sob a rajada
    const who2 = await asUser(u2)
    const verdicts = await Promise.all(Array.from({ length: 25 }, (_, i) =>
      inTx('wrong', c => consumePasswordResetCode(c, who2, String(500000 + i), 'NOVA'))))
    const [r2] = await pool.query<any[]>(`SELECT failed_attempts FROM \`${PROBE}\`.tb_user_password_reset WHERE tb_user_id = ?`, [u2])
    const right = await inTx('right', c => consumePasswordResetCode(c, who2, '424242', 'NOVA'))
    ok('2 25 erradas em paralelo param no teto e o certo depois é recusado',
      Number(r2[0].failed_attempts) === PASSWORD_RESET_MAX_FAILED_ATTEMPTS && right === 'exhausted' && (await currentPassword(u2)) === `HASH${u2}`,
      `failed_attempts=${r2[0].failed_attempts} (teto ${PASSWORD_RESET_MAX_FAILED_ATTEMPTS}); vereditos ${tally(verdicts)}; certo depois = ${right}`)

    // ---- 3. emissões paralelas para a MESMA conta ----------------------------------------------------------------------
    const u3 = 900002
    const emits = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
      inTx('emit-same', c => createPasswordResetCode(c, user(u3, `HASH${u3}`), String(600000 + i)))))
    const [r3] = await pool.query<any[]>(`SELECT seq FROM \`${PROBE}\`.tb_user_password_reset WHERE tb_user_id = ? ORDER BY seq`, [u3])
    const errs3 = emits.filter(e => e.status === 'rejected').map(e => (e as PromiseRejectedResult).reason?.code)
    ok('3 10 emissões paralelas da mesma conta respeitam o teto por hora, seq sem buraco, zero erro',
      r3.length === PASSWORD_RESET_MAX_PER_HOUR && r3.every((r, i) => Number(r.seq) === i + 1) && errs3.length === 0,
      `linhas=${r3.length} (teto ${PASSWORD_RESET_MAX_PER_HOUR}); seqs ${r3.map(r => r.seq).join(',')}; vereditos ${tally(emits.map(e => e.status === 'fulfilled' ? e.value : 'erro'))}; erros ${errs3.join(',') || 'nenhum'}`)

    // ---- 4. emissões paralelas para contas DIFERENTES ------------------------------------------------------------------
    const deadlocksBefore4 = deadlocksSeen
    const others = users.slice(2, 42)
    const emits4 = await Promise.allSettled(others.map(id =>
      inTx('emit-other', c => createPasswordResetCode(c, user(id, `HASH${id}`), '111111'))))
    const [r4] = await pool.query<any[]>(
      `SELECT COUNT(*) AS n, SUM(seq = 1) AS first FROM \`${PROBE}\`.tb_user_password_reset WHERE tb_user_id IN (?)`, [others])
    const failed4 = emits4.filter(e => e.status === 'rejected').map(e => (e as PromiseRejectedResult).reason?.code ?? 'erro')
    ok('4 40 contas em paralelo: todas emitem com seq 1, nenhum deadlock (nem resolvido pelo retry)',
      failed4.length === 0 && Number(r4[0].n) === 40 && Number(r4[0].first) === 40 && deadlocksSeen === deadlocksBefore4,
      `emitidas=${r4[0].n}; seq 1 = ${r4[0].first}; falhas ${failed4.join(',') || 'nenhuma'}; deadlocks vistos = ${deadlocksSeen - deadlocksBefore4}`)

    // ---- 5. senha trocada por outro caminho no meio ---------------------------------------------------------------------
    const u5 = 900003
    // (a 900003 já tem o código '111111' do passo 4)
    await pool.query(`UPDATE \`${PROBE}\`.tb_user SET password = 'HASH-DO-ADMIN', updated_at = NOW() WHERE id = ?`, [u5])
    const v5 = await asUser(u5).then(who => inTx('after-admin', c => consumePasswordResetCode(c, who, '111111', 'NOVA')))
    ok('5 o PUT do admin no meio invalida o código aberto (HMAC amarrado à senha)', v5 === 'wrong' && (await currentPassword(u5)) === 'HASH-DO-ADMIN',
      `veredito com o código certo = ${v5}`)

    // ---- 6. vencido e usado ---------------------------------------------------------------------------------------------
    const u6 = 900004, u7 = 900005
    await pool.query(`UPDATE \`${PROBE}\`.tb_user_password_reset SET created_at = NOW() - INTERVAL 16 MINUTE WHERE tb_user_id = ?`, [u6])
    const v6 = await asUser(u6).then(who => inTx('expired', c => consumePasswordResetCode(c, who, '111111', 'NOVA')))
    const v7a = await asUser(u7).then(who => inTx('use', c => consumePasswordResetCode(c, who, '111111', 'NOVA-7')))
    const v7b = await asUser(u7).then(who => inTx('reuse', c => consumePasswordResetCode(c, who, '111111', 'OUTRA')))
    const [r7] = await pool.query<any[]>(`SELECT used_at IS NOT NULL AS used FROM \`${PROBE}\`.tb_user_password_reset WHERE tb_user_id = ?`, [u7])
    ok('6 vencido recusado; usado troca uma vez e recusa a 2ª', v6 === 'expired' && v7a === 'changed' && v7b === 'used'
      && (await currentPassword(u7)) === 'NOVA-7' && Number(r7[0].used) === 1, `vencido=${v6}; 1º uso=${v7a}; 2º uso=${v7b}`)

    // ---- 7. rodada MISTA em paralelo -----------------------------------------------------------------------------------
    const deadlocksBefore7 = deadlocksSeen
    const mixed = users.slice(10, 42)
    const who7 = new Map(await Promise.all(mixed.map(async id => [id, await asUser(id)] as const)))
    const ops = mixed.flatMap(id => [
      inTx('mix-wrong', c => consumePasswordResetCode(c, who7.get(id)!, '999999', 'NOVA')),
      inTx('mix-emit',  c => createPasswordResetCode(c, who7.get(id)!, '222222')),
      inTx('mix-right', c => consumePasswordResetCode(c, who7.get(id)!, '222222', `NOVA-${id}`)),
    ])
    const settled7 = await Promise.allSettled(ops)
    const failed7 = settled7.filter(e => e.status === 'rejected').map(e => (e as PromiseRejectedResult).reason?.code ?? 'erro')
    const [r7m] = await pool.query<any[]>(
      `SELECT MAX(failed_attempts) AS maxFailed FROM \`${PROBE}\`.tb_user_password_reset WHERE tb_user_id IN (?)`, [mixed])
    ok('7 rodada mista em paralelo (errada + código novo + tentativa, 32 contas): zero erro, zero deadlock, teto respeitado',
      failed7.length === 0 && deadlocksSeen === deadlocksBefore7 && Number(r7m[0].maxFailed) <= PASSWORD_RESET_MAX_FAILED_ATTEMPTS,
      `operações=${ops.length}; vereditos ${tally(settled7.map(e => e.status === 'fulfilled' ? e.value : 'erro'))}; falhas ${failed7.join(',') || 'nenhuma'}; deadlocks vistos = ${deadlocksSeen - deadlocksBefore7}`)

    // ---- 8. D-RS4: o aviso ao dono — vaga da hora tomada UMA vez sob rajada; teto calado não repete na hora; outra hora, outra vaga --
    const deadlocksBefore8 = deadlocksSeen
    const u8 = 900043
    await inTx('emit8', c => issuePasswordResetCode(c, user(u8, `HASH${u8}`), '313131'))
    const who8 = await asUser(u8)
    const wrong8 = await Promise.all(Array.from({ length: 25 }, (_, i) =>
      inTx('wrong8', c => judgePasswordResetCode(c, who8, String(700000 + i), 'NOVA'))))
    const claimedE = wrong8.filter(o => o.notice === 'E').length
    const [n8a] = await pool.query<any[]>(`SELECT seq, kind FROM \`${PROBE}\`.tb_user_password_reset_notice WHERE tb_user_id = ? ORDER BY seq`, [u8])
    // o teto: já há 1 código na hora; mais 2 emitem, os seguintes são calados — a hora JÁ tem aviso (E) → nenhuma vaga nova
    const capped8 = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      inTx('cap8', c => issuePasswordResetCode(c, who8, String(800000 + i)))))
    const [n8b] = await pool.query<any[]>(`SELECT COUNT(*) AS n FROM \`${PROBE}\`.tb_user_password_reset_notice WHERE tb_user_id = ?`, [u8])
    // passada a hora: o aviso anterior envelhece, os códigos continuam na janela do teto (recuo só do aviso) → o calado toma a vaga C
    await pool.query(`UPDATE \`${PROBE}\`.tb_user_password_reset_notice SET created_at = NOW() - INTERVAL 61 MINUTE WHERE tb_user_id = ?`, [u8])
    const late8 = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      inTx('cap8b', c => issuePasswordResetCode(c, who8, String(810000 + i)))))
    const [n8c] = await pool.query<any[]>(`SELECT seq, kind FROM \`${PROBE}\`.tb_user_password_reset_notice WHERE tb_user_id = ? ORDER BY seq`, [u8])
    // o CHECK do kind é BINÁRIO (gate adversarial: sob unicode_ci 'e' passava): 'X' e 'e' recusados
    const badKinds: string[] = []
    for (const k of ['X', 'e']) {
      try {
        await pool.query(`INSERT INTO \`${PROBE}\`.tb_user_password_reset_notice (tb_user_id, seq, kind, created_at) VALUES (?, 99, ?, NOW())`, [u8, k])
        await pool.query(`DELETE FROM \`${PROBE}\`.tb_user_password_reset_notice WHERE tb_user_id = ? AND seq = 99`, [u8])   // descartável — §3.1 não se aplica
        badKinds.push(`${k}:ACEITO`)
      } catch (e: any) { badKinds.push(`${k}:recusado:${e.errno}`) }
    }
    const badKind = badKinds.every(b => /recusado/.test(b)) ? `recusado (${badKinds.join(' ')})` : `ACEITO (${badKinds.join(' ')})`
    ok('8 aviso ao dono (D-RS4): 25 erradas paralelas = 1 vaga (E); 10 calados na mesma hora = nenhuma; hora seguinte = vaga C (seq 2); CHECK do kind; zero deadlock',
      claimedE === 1 && n8a.length === 1 && n8a[0].kind === 'E'
        && capped8.every(o => o.verdict === 'capped' || o.verdict === 'issued') && capped8.every(o => !o.notice) && Number(n8b[0].n) === 1
        && late8.every(o => o.verdict === 'capped') && late8.filter(o => o.notice === 'C').length === 1 && n8c.length === 2 && n8c[1].kind === 'C'
        && badKind.startsWith('recusado') && deadlocksSeen === deadlocksBefore8,
      `vagas E tomadas na rajada=${claimedE}; linhas depois=${n8a.map(r => `${r.seq}${r.kind}`).join(',')}; calados na hora: ${tally(capped8.map(o => o.verdict))} `
      + `vagas=${capped8.filter(o => o.notice).length} (linhas ${n8b[0].n}); hora seguinte: ${tally(late8.map(o => o.verdict))} vagas C=${late8.filter(o => o.notice === 'C').length} `
      + `(linhas ${n8c.map(r => `${r.seq}${r.kind}`).join(',')}); kind X ${badKind || 'ACEITO'}; deadlocks vistos = ${deadlocksSeen - deadlocksBefore8}`)
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS \`${PROBE}\``).catch(e => console.error('limpeza falhou', e))
    fs.rmSync(keyFile, { force: true })
    await admin.end()
    const after = await centralFingerprint()
    ok('setes_central intacta (tabelas e a coluna activation_key iguais antes/depois)', before === after, after)
    for (const [s, l] of results) console.log(`${s} ${l}`)
    await pool.end()
  }
}

function tally(xs: unknown[]): string {
  const m = new Map<string, number>()
  for (const x of xs) m.set(String(x), (m.get(String(x)) ?? 0) + 1)
  return [...m.entries()].map(([k, v]) => `${k}×${v}`).join(' ')
}

main().catch(e => { console.error(e); process.exitCode = 1 })
