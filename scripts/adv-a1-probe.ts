/**
 * Sonda do QA ADVERSARIAL do gate da costura A1 (passo 4 do plano 10-21 — bloco de privilégios + auth-api A1).
 * Só escreve em bancos DESCARTÁVEIS (`prova_adv_*` / `setes_zadv_*`) e em usuários DESCARTÁVEIS (`prova_adv_*`) — tudo apagado no fim.
 * O banco real só é LIDO (estrutura copiada com CREATE TABLE … LIKE).
 *
 *   npx tsx --require dotenv/config --require tsconfig-paths/register scripts/adv-a1-probe.ts [grant|views|race|all]
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import mysql from 'mysql2/promise'
import pool from '../src/shared/db/connection'
import { accessVerdict, reachableKeys, grantedKeys, accessRows, iatAsUtcDatetime } from 'fiscal-api/access'

const HOSTS = ['%', 'localhost', '127.0.0.1', '::1']
const G_CENTRAL = 'setes_zadv_central'      // o "setes_central" do experimento de GRANT
const G_CLIENT = 'setes_zadv_cli'          // um "schema de cliente"
const V_CENTRAL = 'prova_adv_central'       // o central do experimento das views
const V_CLIENT = 'setes_zadv_vcli'          // schema de cliente das views
const SQL_DIR = process.env.SQL_DIR ?? path.resolve(__dirname, '../../sql')

let failures = 0
const out: string[] = []
function note(label: string, value: unknown): void {
  const line = `${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
  out.push(line); console.log(line)
}
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  const line = `${ok ? 'OK   ' : 'ACHOU'} ${label}${detail ? ` — ${detail}` : ''}`
  out.push(line); console.log(line)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 1. GRANT (D-AU12): a linha "específica" de setes_central sombreia o curinga `setes\_%`?
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
interface GrantScenario { user: string; wildcard: string; specific: string; label: string }
const SCENARIOS: GrantScenario[] = [
  // produção (ops/grants.sql 1a): curinga ESCAPADO + linha específica SEM escape (como o script grava `setes_central`)
  { user: 'prova_adv_e', wildcard: 'setes\\_zadv\\_%', specific: G_CENTRAL, label: 'PRODUÇÃO (curinga escapado + específica sem escape)' },
  // dev (grants-d-au12-dev-local.sql): curinga SEM escape (`setes_%`) + linha específica sem escape
  { user: 'prova_adv_u', wildcard: 'setes_zadv_%', specific: G_CENTRAL, label: 'DEV (curinga sem escape + específica sem escape)' },
  // correção candidata: curinga escapado + linha específica ESCAPADA (`setes\_central`)
  { user: 'prova_adv_f', wildcard: 'setes\\_zadv\\_%', specific: 'setes\\_zadv\\_central', label: 'CORREÇÃO (específica escapada)' },
  // correção candidata no dev: curinga sem escape + específica escapada
  { user: 'prova_adv_g', wildcard: 'setes_zadv_%', specific: 'setes\\_zadv\\_central', label: 'CORREÇÃO DEV (específica escapada, curinga sem escape)' },
]

async function dropGrant(conn: mysql.PoolConnection): Promise<void> {
  for (const s of SCENARIOS) for (const h of HOSTS) await conn.query('DROP USER IF EXISTS ?@?', [s.user, h])
  await conn.query(`DROP DATABASE IF EXISTS \`${G_CENTRAL}\``)
  await conn.query(`DROP DATABASE IF EXISTS \`${G_CLIENT}\``)
}

async function grantExperiment(conn: mysql.PoolConnection): Promise<void> {
  await dropGrant(conn)
  try {
    await conn.query(`CREATE DATABASE \`${G_CENTRAL}\``)
    await conn.query(`CREATE DATABASE \`${G_CLIENT}\``)
    await conn.query(`CREATE TABLE \`${G_CENTRAL}\`.tb_user (id INT PRIMARY KEY, password VARCHAR(64))`)
    await conn.query(`INSERT INTO \`${G_CENTRAL}\`.tb_user VALUES (1, 'HASH-SECRETO')`)
    await conn.query(`CREATE TABLE \`${G_CENTRAL}\`.tb_institution (id INT PRIMARY KEY)`)
    await conn.query(`INSERT INTO \`${G_CENTRAL}\`.tb_institution VALUES (1)`)
    await conn.query(`CREATE SQL SECURITY DEFINER VIEW \`${G_CENTRAL}\`.vw_user_link AS SELECT id AS tb_user_id FROM \`${G_CENTRAL}\`.tb_user`)
    await conn.query(`CREATE TABLE \`${G_CLIENT}\`.tb_invoice (id INT PRIMARY KEY)`)
    const secret = crypto.randomBytes(18).toString('base64url')
    for (const s of SCENARIOS) {
      for (const h of HOSTS) {
        await conn.query('CREATE USER ?@? IDENTIFIED BY ?', [s.user, h, secret])
        await conn.query(`GRANT SELECT ON \`${s.wildcard}\`.* TO ?@?`, [s.user, h])
        // a seção 1a, na MESMA ordem: linha específica com SELECT+SHOW VIEW → tira o SELECT → SELECT tabela a tabela
        await conn.query(`GRANT SELECT, SHOW VIEW ON \`${s.specific}\`.* TO ?@?`, [s.user, h])
        await conn.query(`REVOKE SELECT ON \`${s.specific}\`.* FROM ?@?`, [s.user, h])
        await conn.query(`GRANT SELECT ON \`${G_CENTRAL}\`.\`tb_institution\` TO ?@?`, [s.user, h])
        await conn.query(`GRANT SELECT ON \`${G_CENTRAL}\`.\`vw_user_link\` TO ?@?`, [s.user, h])
      }
      const c = await mysql.createConnection({
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: s.user, password: secret,
      })
      try {
        const [who] = await c.query<any[]>('SELECT CURRENT_USER() AS cu')
        const grants = (await c.query<any[]>('SHOW GRANTS'))[0].map((r: any) => String(Object.values(r)[0]))
        note(`  [${s.label}] conta`, String(who[0].cu))
        note(`  [${s.label}] SHOW GRANTS`, grants.filter(g => /zadv/.test(g)))
        let leaked: string | null = null
        try { const [r] = await c.query<any[]>(`SELECT password FROM \`${G_CENTRAL}\`.tb_user`); leaked = String(r[0]?.password ?? '') }
        catch (e: any) { note(`  [${s.label}] erro tb_user`, e.code) }
        check(`GRANT ${s.label}: tb_user.password NEGADO`, leaked === null, leaked ? `LEU "${leaked}"` : '')
        let viewOk = false
        try { await c.query(`SELECT * FROM \`${G_CENTRAL}\`.vw_user_link`); viewOk = true } catch (e: any) { note('  erro view', e.code) }
        check(`GRANT ${s.label}: vw_user_link legível`, viewOk)
        let cliOk = false
        try { await c.query(`SELECT * FROM \`${G_CLIENT}\`.tb_invoice`); cliOk = true } catch (e: any) { note('  erro cliente', e.code) }
        check(`GRANT ${s.label}: schema de cliente legível pelo curinga`, cliOk)
      } finally {
        await c.end()
      }
    }
  } finally {
    await dropGrant(conn)
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 2. VIEWS: a pilha real (sql/70 + 075) em banco descartável, atacada pela biblioteca real
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function statementsOf(sql: string): string[] {
  return sql.replace(/--[^\n]*\n/g, '\n').split(';').map(s => s.trim()).filter(s => s.length > 0)
}
const centralSql = () => fs.readFileSync(path.join(SQL_DIR, '70_user_access_central_views.sql'), 'utf8').replace(/`setes_central`/g, `\`${V_CENTRAL}\``)
const clientSql = () => fs.readFileSync(path.resolve(__dirname, '../src/migrations/sql/075_user_access_views.sql'), 'utf8')
  .replace(/`setes_central`/g, `\`${V_CENTRAL}\``)

async function dropViews(conn: mysql.PoolConnection): Promise<void> {
  await conn.query(`DROP DATABASE IF EXISTS \`${V_CLIENT}\``)
  await conn.query(`DROP DATABASE IF EXISTS \`${V_CENTRAL}\``)
}

const IFACE = { orders: 10, customers: 11, 'institution-interfaces': 12 } as const
const PRIV = { VISUALIZAR: 6, ALTERAR: 2, FATURAR: 5 } as const

async function viewsExperiment(conn: mysql.PoolConnection): Promise<void> {
  await dropViews(conn)
  try {
    await conn.query('SET NAMES utf8mb4')
    await conn.query(`CREATE DATABASE \`${V_CENTRAL}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
    await conn.query(`CREATE DATABASE \`${V_CLIENT}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    for (const t of ['tb_user', 'tb_institution', 'tb_institution_has_user', 'tb_interface', 'tb_privilege', 'tb_interface_has_privilege']) {
      await conn.query(`CREATE TABLE \`${V_CENTRAL}\`.\`${t}\` LIKE \`setes_central\`.\`${t}\``)
    }
    for (const t of ['tb_institution_has_interface', 'tb_user_has_privilege']) {
      await conn.query(`CREATE TABLE \`${V_CLIENT}\`.\`${t}\` LIKE \`setes_setes\`.\`${t}\``)
    }
    for (const st of statementsOf(centralSql())) await conn.query(st)
    await conn.query(`USE \`${V_CLIENT}\``)
    for (const st of statementsOf(clientSql())) await conn.query(st)

    const [pk] = await conn.query<any[]>(`SELECT COLUMN_NAME c FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = 'setes_central' AND TABLE_NAME = 'tb_institution_has_user' AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`)
    note('PK real de tb_institution_has_user', pk.map((r: any) => r.c))

    // institutions: 1 Setes, 2 cliente, 4 FILIAL do cliente no MESMO schema (grupo)
    await conn.query(`INSERT INTO \`${V_CENTRAL}\`.tb_institution (id, schema_name, active, deleted) VALUES
      (1, 'setes_zadv_v1', 'S', 'N'), (2, ?, 'S', 'N'), (4, 'setes_zadv_v4', 'S', 'N')`, [V_CLIENT])   // schema_name é UNIQUE hoje: o grupo no mesmo schema ainda não existe
    for (const id of [1, 2, 3, 4, 5, 6, 7]) {
      await conn.query(`INSERT INTO \`${V_CENTRAL}\`.tb_user (id, password, active, deleted, created_at) VALUES (?, 'HASH', 'S', 'N', NOW())`, [id])
    }
    // 1 super; 2 admin no 2; 3 regular no 2 e no 4 (filial); 5 'admin ' (espaço no fim) no 2; 6 'super ' (espaço) na Setes; 7 'ADMIN' no 2
    const links: [number, number, string][] = [[1, 1, 'super'], [2, 2, 'admin'], [3, 2, 'user'], [3, 4, 'user'], [5, 2, 'admin '], [6, 1, 'super '], [7, 2, 'ADMIN']]
    for (const [u, i, k] of links) {
      await conn.query(`INSERT INTO \`${V_CENTRAL}\`.tb_institution_has_user (tb_institution_id, tb_user_id, kind, active, deleted) VALUES (?, ?, ?, 'S', 'N')`, [i, u, k])
    }
    for (const [k, id] of Object.entries(IFACE)) {
      await conn.query(`INSERT INTO \`${V_CENTRAL}\`.tb_interface (id, i18n_key, description, kind, group_default, deleted) VALUES (?, ?, ?, 'T', 'X', 'N')`, [id, k, k])
    }
    for (const [n, id] of Object.entries(PRIV)) {
      await conn.query(`INSERT INTO \`${V_CENTRAL}\`.tb_privilege (id, description, deleted) VALUES (?, ?, 'N')`, [id, n])
    }
    for (const [i, p] of [[10, 6], [10, 2], [10, 5], [11, 6], [12, 6], [12, 2]]) {
      await conn.query(`INSERT INTO \`${V_CENTRAL}\`.tb_interface_has_privilege (tb_interface_id, tb_privilege_id, active, deleted) VALUES (?, ?, 'S', 'N')`, [i, p])
    }
    // licença: cliente 2 orders+customers; filial 4 orders+customers
    for (const [inst, i] of [[2, 10], [2, 11], [4, 10], [4, 11]]) {
      await conn.query(`INSERT INTO \`${V_CLIENT}\`.tb_institution_has_interface (tb_institution_id, tb_interface_id, active, deleted) VALUES (?, ?, 'S', 'N')`, [inst, i])
    }
    // concessão: regular 3 → orders V + FATURAR (dada pelo admin do cliente 2)
    for (const [u, i, p] of [[3, 10, 6], [3, 10, 5]]) {
      await conn.query(`INSERT INTO \`${V_CLIENT}\`.tb_user_has_privilege (tb_user_id, tb_interface_id, tb_privilege_id, active, deleted) VALUES (?, ?, ?, 'S', 'N')`, [u, i, p])
    }
    const who = (u: number, i: number, s = V_CLIENT) => ({ userId: u, institutionId: i, schemaName: s })

    // (a) PAD SPACE na chave
    const vPad = await accessVerdict(pool, who(3, 2), ['orders '], 'FATURAR')
    const rPad = await reachableKeys(pool, who(3, 2), ['orders '])
    const gPad = await grantedKeys(pool, who(3, 2), ['orders '], 'FATURAR')
    note('(a) chave "orders " (espaço no fim): accessVerdict / reachableKeys / grantedKeys', { vPad, rPad, gPad })
    check('(a) chave com espaço no fim é tratada como a MESMA decisão nas 3 leituras (exata)', vPad !== 'ok' && rPad.length === 0 && gPad.length === 0,
      `accessVerdict='${vPad}' (PAD SPACE do utf8mb4_bin casa 'orders'), reachableKeys=${JSON.stringify(rPad)}`)

    // a leitura da SESSÃO da biblioteca usa `setes_central.vw_user_link` fixo — a sonda roda o MESMO texto (extraído do fonte) no central descartável
    const libSrc = fs.readFileSync(path.resolve(__dirname, '../../fiscal-api/src/access/access.ts'), 'utf8')
    const sm = libSrc.match(/`(SELECT profile, vendor FROM setes_central\.vw_user_link[\s\S]*?LIMIT 2)`/)
    if (!sm) throw new Error('SQL da sessão não encontrado no fonte da biblioteca')
    const sessionSql = sm[1].replace('setes_central.', `\`${V_CENTRAL}\`.`)
    const sessionOf = async (w: { userId: number; institutionId: number; schemaName: string }, iat: number) => {
      const [rows] = await pool.query<any[]>(sessionSql, [w.userId, w.institutionId, w.schemaName, iatAsUtcDatetime(iat)])
      return rows.length === 1 ? { profile: String(rows[0].profile) } : null
    }
    // (b) kind com espaço no fim (PAD SPACE): 'admin ' = admin? 'super ' na Setes = super?
    const sAdminSp = await sessionOf(who(5, 2), 2_000_000_000)
    const sSuperSp = await sessionOf(who(6, 1, 'setes_zadv_v1'), 2_000_000_000)
    const sUpper = await sessionOf(who(7, 2), 2_000_000_000)
    note('(b) perfil de kind "admin " / "super " / "ADMIN"', { adminSp: sAdminSp?.profile, superSp: sSuperSp?.profile, upper: sUpper?.profile })
    check("(b) kind 'admin ' (espaço no fim) NÃO vira admin (o JS do resto do sistema compara exato)", sAdminSp?.profile !== 'admin',
      `profile='${sAdminSp?.profile}'`)
    check("(b) kind 'super ' (espaço no fim) NÃO vira super", sSuperSp?.profile !== 'super', `profile='${sSuperSp?.profile}'`)
    check("(b) kind 'ADMIN' (caixa) não vira admin", sUpper?.profile === 'user')

    // (c) GRUPO: o regular 3 recebeu FATURAR no schema (concedido pelo admin do 2) — vale também na filial 4 do MESMO schema? (D-GE3)
    const vFilial = await accessVerdict(pool, who(3, 4), ['orders'], 'FATURAR')
    note('(c) concessão dada no estabelecimento 2 vale na filial 4 (mesmo schema)', vFilial)
    // hoje inalcançável (tb_institution.schema_name UNIQUE + a sessão confere o schema): só registra o comportamento da view (D-GE3 reservada)
    note('(c) [inalcançável hoje] concessão dada no 2 lida no schema dele para a institution 4', vFilial)

    // (d) a biblioteca confia no schema de quem pergunta: o super (inst 1) lido no schema de CLIENTE
    const rowsCross = await accessRows(pool, who(1, 1, V_CLIENT))
    note('(d) accessRows do super (inst 1) lido no schema de cliente', rowsCross.length)
    check('(d) a biblioteca sozinha não confere schema × institution (só a sessão confere) — linhas do super aparecem no schema do cliente',
      rowsCross.length === 0, `${rowsCross.length} linha(s) — defesa SÓ na sessão (todo chamador tem de passar pela sessão viva antes)`)

    // (e) D-EA7 na fronteira do segundo, pela biblioteca (iat inteiro)
    const T = Date.UTC(2026, 9, 31, 12, 0, 0) / 1000
    await conn.query(`UPDATE \`${V_CENTRAL}\`.tb_user SET password_set_at = '2026-10-31 12:00:00' WHERE id = 2`)
    const before = await sessionOf(who(2, 2), T - 1)
    const same = await sessionOf(who(2, 2), T)
    note('(e) D-EA7 iat T-1 / T', { before: before?.profile ?? null, same: same?.profile ?? null })
    check('(e) D-EA7: iat anterior = sem sessão; iat = T vale', before === null && same?.profile === 'admin')
    // iat extremo (forjado só com a chave privada): data fora do DATETIME
    let extreme: string
    try { extreme = String((await sessionOf(who(2, 2), 253402300800))?.profile ?? 'null') } catch (e: any) { extreme = `lança ${e.message}` }
    note('(e) iat no ano 10000', extreme)

    // (g) privilégio com 2º nome PAD-igual: o Super cria 'FATURAR ' (a guarda D-PV15 só compara sem caixa — passa), registra em orders,
    //     o admin o concede ao regular 7 (sem o FATURAR de verdade) — o veredito do FATURAR passa?
    await conn.query(`UPDATE \`${V_CENTRAL}\`.tb_institution_has_user SET kind = 'user' WHERE tb_user_id = 7`)
    await conn.query(`INSERT INTO \`${V_CENTRAL}\`.tb_privilege (id, description, deleted) VALUES (13, 'FATURAR ', 'N')`)
    await conn.query(`INSERT INTO \`${V_CENTRAL}\`.tb_interface_has_privilege (tb_interface_id, tb_privilege_id, active, deleted) VALUES (10, 13, 'S', 'N')`)
    await conn.query(`INSERT INTO \`${V_CLIENT}\`.tb_user_has_privilege (tb_user_id, tb_interface_id, tb_privilege_id, active, deleted) VALUES (7, 10, 13, 'S', 'N')`)
    const vDup = await accessVerdict(pool, who(7, 2), ['orders'], 'FATURAR')
    const menuDup = (await accessRows(pool, who(7, 2))).map(r => `${r.interfaceKey}:${r.privilege}`)
    note("(g) concessão do privilégio 'FATURAR ' (outro id) → veredito FATURAR / menu", { vDup, menuDup })
    check("(g) o privilégio 'FATURAR ' (outro id) NÃO vale como FATURAR", vDup !== 'ok', `veredito='${vDup}', menu sem o botão: ${JSON.stringify(menuDup)}`)

    await conn.query(`UPDATE \`${V_CENTRAL}\`.tb_privilege SET deleted = 'S' WHERE id = 13`)   // isola o (h) do (g)
    // (h) o Super renomeia o FATURAR (id 5, consumido) para 'faturar' — a guarda D-PV15 (sameName sem caixa) deixa; o leitor é BINÁRIO
    const vBefore = await accessVerdict(pool, who(1, 1, V_CLIENT), ['orders'], 'FATURAR')
    const vRegBefore = await accessVerdict(pool, who(3, 2), ['orders'], 'FATURAR')
    await conn.query(`UPDATE \`${V_CENTRAL}\`.tb_privilege SET description = 'faturar' WHERE id = 5`)
    const vSuper = await accessVerdict(pool, who(1, 1, V_CLIENT), ['orders'], 'FATURAR')
    const vAdmin = await accessVerdict(pool, who(2, 2), ['orders'], 'FATURAR')
    const vReg = await accessVerdict(pool, who(3, 2), ['orders'], 'FATURAR')
    note("(h) FATURAR renomeado para 'faturar': super / admin / regular (antes: super, regular)", { vBefore, vRegBefore, vSuper, vAdmin, vReg })
    check("(h) renomear só a CAIXA do verbo consumido não derruba o FATURAR de todos", vSuper === 'ok' && vAdmin === 'ok' && vReg === 'ok',
      `super='${vSuper}' admin='${vAdmin}' regular='${vReg}' — todo faturamento negado (403) em todos os clientes`)
    await conn.query(`UPDATE \`${V_CENTRAL}\`.tb_privilege SET description = 'FATURAR' WHERE id = 5`)

    // (i) a tela do Super DELEGÁVEL por um admin de cliente que TEM a linha no contrato e até uma concessão gravada no próprio schema
    await conn.query(`INSERT INTO \`${V_CLIENT}\`.tb_institution_has_interface (tb_institution_id, tb_interface_id, active, deleted) VALUES (2, 12, 'S', 'N')`)
    await conn.query(`INSERT INTO \`${V_CLIENT}\`.tb_user_has_privilege (tb_user_id, tb_interface_id, tb_privilege_id, active, deleted) VALUES (2, 12, 6, 'S', 'N'), (2, 12, 2, 'S', 'N')`)
    const vDelegV = await accessVerdict(pool, who(2, 2), ['institution-interfaces'], 'VISUALIZAR')
    const vDelegA = await accessVerdict(pool, who(2, 2), ['institution-interfaces'], 'ALTERAR')
    const rDeleg = await reachableKeys(pool, who(2, 2), ['institution-interfaces'])
    const menuDeleg = (await accessRows(pool, who(2, 2))).filter(r => r.interfaceKey === 'institution-interfaces')
    note('(i) admin do cliente × delegável (contrato + concessão no schema dele)', { vDelegV, vDelegA, rDeleg, menuDeleg })
    check('(i) admin de cliente NÃO alcança a tela do Super delegável (nem com contrato e concessão)',
      vDelegV === 'not-contracted' && vDelegA === 'not-contracted' && rDeleg.length === 0 && menuDeleg.length === 0)

    // (f) view ausente: a sessão falha FECHADA (lança, nunca "vale")
    await conn.query(`DROP VIEW \`${V_CENTRAL}\`.vw_user_link`)
    let failClosed = false
    try { await sessionOf(who(2, 2), T + 10) } catch (e: any) { failClosed = e?.code === 'ER_NO_SUCH_TABLE' || /doesn't exist|references invalid/i.test(e.message) }
    check('(f) vw_user_link ausente: sessionOf LANÇA (falha fechada)', failClosed)
    let verdictClosed = false
    try { await accessVerdict(pool, who(3, 2), ['orders'], 'FATURAR') } catch (e: any) { verdictClosed = true; note('(f) veredito com a view central ausente', e.code) }
    check('(f) vw_user_link ausente: o veredito por schema LANÇA (nunca ok)', verdictClosed)
  } finally {
    await dropViews(conn)
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 3. D-PV48: corrida de duas "1ª senha" — o UPDATE condicional REAL (texto do users.repository) em tabela descartável
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function raceExperiment(conn: mysql.PoolConnection): Promise<void> {
  const DB = 'prova_adv_race'
  await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``)
  try {
    await conn.query(`CREATE DATABASE \`${DB}\``)
    await conn.query(`CREATE TABLE \`${DB}\`.tb_user LIKE setes_central.tb_user`)
    await conn.query(`ALTER TABLE \`${DB}\`.tb_user ADD COLUMN IF NOT EXISTS password_set_at DATETIME NULL DEFAULT NULL AFTER password`)
    await conn.query(`INSERT INTO \`${DB}\`.tb_user (id, password, active, deleted, created_at) VALUES (1, NULL, 'N', 'N', NOW())`)
    const src = fs.readFileSync(path.resolve(__dirname, '../src/modules/users/users.repository.ts'), 'utf8')
    const m = src.match(/`(UPDATE setes_central\.tb_user SET password = \?, password_set_at = \?, updated_at = NOW\(\)\s+WHERE id = \? AND \(password IS NULL OR password = ''\))`/)
    if (!m) { check('race: SQL do UPDATE condicional encontrado no código', false); return }
    const sql = m[1].replace('setes_central.', `\`${DB}\`.`)
    const run = async (hash: string, holdMs: number) => {
      const c = await pool.getConnection()
      try {
        await c.beginTransaction()
        const [r] = await c.query<any>(sql, [hash, '2026-10-31 12:00:00', 1])
        await new Promise(res => setTimeout(res, holdMs))
        if (Number(r.affectedRows) !== 1) { await c.rollback(); return 0 }
        await c.commit()
        return 1
      } catch (e) { await c.rollback().catch(() => undefined); throw e } finally { c.release() }
    }
    const results = await Promise.all([run('HASH-A', 300), run('HASH-B', 0), run('HASH-C', 0)])
    const [row] = await conn.query<any[]>(`SELECT password FROM \`${DB}\`.tb_user WHERE id = 1`)
    note('race: vencedores / senha final', { results, final: row[0].password })
    check('race D-PV48: três 1ªs senhas simultâneas — exatamente UMA grava', results.filter(x => x === 1).length === 1)
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``)
  }
}

async function main(): Promise<void> {
  const what = process.argv[2] ?? 'all'
  const conn = await pool.getConnection()
  try {
    if (what === 'grant' || what === 'all') await grantExperiment(conn)
    if (what === 'views' || what === 'all') await viewsExperiment(conn)
    if (what === 'race' || what === 'all') await raceExperiment(conn)
  } catch (e: any) {
    check('execução da sonda', false, `${e.code ?? ''} ${e.message}`)
  } finally {
    conn.release()
    await pool.end()
  }
  console.log(failures ? `\n${failures} ACHADO(S)/FALHA(S)` : '\nSEM ACHADOS')
}
main()
