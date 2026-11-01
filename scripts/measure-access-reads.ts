/**
 * MEDIÇÃO das leituras do veredito SEM cache (D-AU8 — costura A1 da frente auth-api; pedido do gate socrático: "o custo de ler a view
 * viva em toda requisição") em banco DESCARTÁVEL — `setes_central`/`setes_setes` só são LIDOS (estrutura e o catálogo real copiados).
 *
 * Volume sintético: o catálogo REAL do dev (interfaces, verbos, pares); 1 001 estabelecimentos no central com 10 vínculos cada (10 mil
 * vínculos), o cliente medido com 1 000 usuários (20 admin, 980 regulares), licença de todas as telas e ~60 % dos pares concedidos a cada
 * regular (~100 mil concessões). Pool do tamanho do setes-api (20 conexões).
 *  1. Leitura a leitura (sequencial): a SESSÃO (o SQL da biblioteca, no central descartável), o veredito permitido (1 leitura), o veredito
 *     negado (2 leituras: acesso + alcance) e o MENU (accessRows) — p50/p95/p99/máx em ms.
 *  2. Rajada: N "requisições" (sessão + veredito) com C em paralelo sobre o pool de 20 — vazão e latência.
 *  No fim apaga tudo, mesmo com falha. Só mede — não aprova nem reprova (os números vão para o registro do passo 4).
 *
 *   npx tsx --require tsconfig-paths/register scripts/measure-access-reads.ts [requisições=3000] [paralelas=60]
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import { accessVerdict, accessRows } from 'fiscal-api/access'

const CENTRAL = 'prova_med_central'
const CLIENT = 'setes_zprova_med'
const SQL_DIR = process.env.SQL_DIR ?? path.resolve(__dirname, '../../sql')
const REQUESTS = Number(process.argv[2] ?? 3000)
const PARALLEL = Number(process.argv[3] ?? 60)

const statementsOf = (sql: string): string[] =>
  sql.replace(/--[^\n]*\n/g, '\n').split(';').map(s => s.trim()).filter(s => s.length > 0)
const centralSql = () => fs.readFileSync(path.join(SQL_DIR, '70_user_access_central_views.sql'), 'utf8')
  .replace(/`setes_central`/g, `\`${CENTRAL}\``)
const clientSql = () => fs.readFileSync(path.resolve(__dirname, '../src/migrations/sql/075_user_access_views.sql'), 'utf8')
  .replace(/`setes_central`/g, `\`${CENTRAL}\``)

const SESSION_SQL = `SELECT profile, vendor FROM \`${CENTRAL}\`.vw_user_link
  WHERE tb_user_id = ? AND tb_institution_id = ? AND schema_name = ? AND (password_set_at IS NULL OR password_set_at <= ?) LIMIT 2`

function stats(ms: number[]): string {
  const s = [...ms].sort((a, b) => a - b)
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return `p50 ${at(0.5).toFixed(2)} · p95 ${at(0.95).toFixed(2)} · p99 ${at(0.99).toFixed(2)} · máx ${s[s.length - 1].toFixed(2)} ms (n=${s.length})`
}
async function timed<T>(fn: () => Promise<T>): Promise<number> {
  const t = process.hrtime.bigint()
  await fn()
  return Number(process.hrtime.bigint() - t) / 1e6
}
async function bulk(conn: mysql.PoolConnection, head: string, rows: unknown[][], size = 5000): Promise<void> {
  for (let i = 0; i < rows.length; i += size) await conn.query(`${head} VALUES ?`, [rows.slice(i, i + size)])
}

async function main(): Promise<void> {
  const pool = mysql.createPool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    connectionLimit: 20, timezone: 'Z',
  })
  const conn = await pool.getConnection()
  try {
    await conn.query('SET NAMES utf8mb4')
    await conn.query(`DROP DATABASE IF EXISTS \`${CLIENT}\``)
    await conn.query(`DROP DATABASE IF EXISTS \`${CENTRAL}\``)
    await conn.query(`CREATE DATABASE \`${CENTRAL}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
    await conn.query(`CREATE DATABASE \`${CLIENT}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    for (const t of ['tb_user', 'tb_institution', 'tb_institution_has_user', 'tb_interface', 'tb_privilege', 'tb_interface_has_privilege']) {
      await conn.query(`CREATE TABLE \`${CENTRAL}\`.\`${t}\` LIKE \`setes_central\`.\`${t}\``)
    }
    for (const t of ['tb_institution_has_interface', 'tb_user_has_privilege']) {
      await conn.query(`CREATE TABLE \`${CLIENT}\`.\`${t}\` LIKE \`setes_setes\`.\`${t}\``)
    }
    for (const st of statementsOf(centralSql())) await conn.query(st)
    await conn.query(`USE \`${CLIENT}\``)
    for (const st of statementsOf(clientSql())) await conn.query(st)

    // o catálogo REAL do dev (só leitura do central)
    for (const t of ['tb_interface', 'tb_privilege', 'tb_interface_has_privilege']) {
      await conn.query(`INSERT INTO \`${CENTRAL}\`.\`${t}\` SELECT * FROM \`setes_central\`.\`${t}\``)
    }
    const [ifaces] = await conn.query<any[]>(`SELECT id FROM \`${CENTRAL}\`.tb_interface WHERE deleted = 'N'`)
    const [pairs] = await conn.query<any[]>(`SELECT tb_interface_id i, tb_privilege_id p FROM \`${CENTRAL}\`.tb_interface_has_privilege
      WHERE active = 'S' AND deleted = 'N'`)
    const insts: unknown[][] = [[1, 'setes_zprova_med_s', 'S', 'N'], [2, CLIENT, 'S', 'N']]
    for (let n = 3; n <= 1001; n++) insts.push([n, `setes_zmed_${n}`, 'S', 'N'])
    await bulk(conn, `INSERT INTO \`${CENTRAL}\`.tb_institution (id, schema_name, active, deleted)`, insts)
    const users: unknown[][] = []
    for (let u = 1; u <= 11001; u++) users.push([u, 'HASH', 'S', 'N', new Date()])
    await bulk(conn, `INSERT INTO \`${CENTRAL}\`.tb_user (id, password, active, deleted, created_at)`, users)
    const links: unknown[][] = []
    for (let u = 1; u <= 1000; u++) links.push([2, u, u <= 20 ? 'admin' : 'user', 'S', 'N'])
    links.push([1, 1001, 'super', 'S', 'N'])
    for (let n = 3; n <= 1001; n++) for (let k = 0; k < 10; k++) links.push([n, 1002 + (n - 3) * 10 + k, k === 0 ? 'admin' : 'user', 'S', 'N'])
    await bulk(conn, `INSERT INTO \`${CENTRAL}\`.tb_institution_has_user (tb_institution_id, tb_user_id, kind, active, deleted)`,
      links.filter(l => Number(l[1]) <= 11001))
    await bulk(conn, `INSERT INTO \`${CLIENT}\`.tb_institution_has_interface (tb_institution_id, tb_interface_id, active, deleted)`,
      ifaces.map((r: any) => [2, r.id, 'S', 'N']))
    const grants: unknown[][] = []
    for (let u = 21; u <= 1000; u++) {
      for (const pr of pairs as any[]) if ((u + pr.i * 7 + pr.p * 13) % 5 < 3) grants.push([u, pr.i, pr.p, 'S', 'N'])
    }
    await bulk(conn, `INSERT INTO \`${CLIENT}\`.tb_user_has_privilege (tb_user_id, tb_interface_id, tb_privilege_id, active, deleted)`, grants)
    await conn.query(`ANALYZE TABLE \`${CENTRAL}\`.tb_institution_has_user, \`${CENTRAL}\`.tb_interface_has_privilege,
      \`${CLIENT}\`.tb_user_has_privilege, \`${CLIENT}\`.tb_institution_has_interface`)
    console.log(`Volume: ${ifaces.length} interfaces · ${pairs.length} pares · ${insts.length} estabelecimentos · ${links.length} vínculos · `
      + `${grants.length} concessões no cliente medido`)

    // o par "orders × FATURAR" (permitido a parte dos regulares) e um verbo NÃO registrado em orders (negado: 2 leituras)
    const who = (u: number) => ({ userId: u, institutionId: 2, schemaName: CLIENT })
    const regular = (k: number) => 21 + (k * 37) % 980
    const iat = '2026-11-01 12:00:00'
    const N = 300
    const runs: [string, (k: number) => Promise<unknown>][] = [
      ['sessão (vw_user_link, 1 leitura)', k => pool.query(SESSION_SQL, [regular(k), 2, CLIENT, iat])],
      ['veredito regular (orders × FATURAR)', k => accessVerdict(pool as any, who(regular(k)), ['orders'], 'FATURAR')],
      ['veredito negado (verbo sem par — acesso + alcance)', k => accessVerdict(pool as any, who(regular(k)), ['orders'], 'CATALOGAR')],
      ['veredito admin (orders × CANCELAR)', k => accessVerdict(pool as any, who(1 + (k % 20)), ['orders'], 'CANCELAR')],
      ['menu regular (accessRows)', k => accessRows(pool as any, who(regular(k)))],
      ['menu admin (accessRows)', k => accessRows(pool as any, who(1 + (k % 20)))],
    ]
    console.log('\n── 1. leitura a leitura (sequencial)')
    for (const [label, fn] of runs) {
      for (let k = 0; k < 20; k++) await fn(k)                  // aquece
      const ms: number[] = []
      for (let k = 0; k < N; k++) ms.push(await timed(() => fn(k)))
      console.log(`   ${label.padEnd(52)} ${stats(ms)}`)
    }

    console.log(`\n── 2. rajada: ${REQUESTS} requisições (sessão + veredito), ${PARALLEL} em paralelo, pool de 20`)
    const lat: number[] = []
    let next = 0
    const t0 = process.hrtime.bigint()
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
      while (next < REQUESTS) {
        const k = next++
        lat.push(await timed(async () => {
          await pool.query(SESSION_SQL, [regular(k), 2, CLIENT, iat])
          await accessVerdict(pool as any, who(regular(k)), ['orders'], 'FATURAR')
        }))
      }
    }))
    const secs = Number(process.hrtime.bigint() - t0) / 1e9
    console.log(`   vazão ${(REQUESTS / secs).toFixed(0)} req/s em ${secs.toFixed(2)} s · latência ${stats(lat)}`)
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${CLIENT}\``).catch(() => undefined)
    await conn.query(`DROP DATABASE IF EXISTS \`${CENTRAL}\``).catch(() => undefined)
    conn.release()
    await pool.end()
  }
}

main().catch(err => { console.error('Falha na medição:', err); process.exit(2) })
