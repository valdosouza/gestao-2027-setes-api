/**
 * Sonda do QA ADVERSARIAL do RE-GATE da costura A1 (delta do retrabalho: PAD SPACE nas views e na biblioteca, A-PV26, 503, CONFIGURAR
 * no escritor da config, D-PV61 seed 72, D-PV62). Só escreve em bancos DESCARTÁVEIS `prova_adv2_*` / `setes_zadv2_*` — apagados no fim,
 * mesmo com falha. O banco real só é LIDO (estrutura com CREATE TABLE … LIKE; o catálogo copiado com INSERT … SELECT).
 *
 *   npx tsx --require tsconfig-paths/register scripts/adv-a1-delta-probe.ts [views|upsert|seeds|all]
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import pool from '../src/shared/db/connection'
import { accessVerdict, reachableKeys, grantedKeys, accessRows, sessionOf } from 'fiscal-api/access'

const SQL_DIR = process.env.SQL_DIR ?? path.resolve(__dirname, '../../sql')
const V_CENTRAL = 'prova_adv2_central'
const V_CLIENT = 'setes_zadv2_cli'
const UP_DB = 'prova_adv2_up'
const CAT_DB = 'prova_adv2_cat'

let failures = 0
function note(label: string, value: unknown): void { console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`) }
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'OK   ' : 'ACHOU'} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Queryable que troca o central pelo descartável (a biblioteca cita `setes_central.` literal). */
function onCentral(conn: { query: (s: string, v?: unknown) => Promise<any> }, central: string) {
  return { query: (sql: string, values?: unknown) => conn.query(sql.replace(/\bsetes_central\./g, `\`${central}\`.`), values) as Promise<[any, any]> }
}
function statementsOf(sql: string): string[] {
  return sql.replace(/--[^\n]*\n/g, '\n').split(';').map(s => s.trim()).filter(s => s.length > 0)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 1. VIEWS do delta (sql/70 + 075) — bordas de PAD SPACE, Unicode, NULL, D-PV62
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function dropViews(conn: mysql.PoolConnection): Promise<void> {
  await conn.query(`DROP DATABASE IF EXISTS \`${V_CLIENT}\``)
  await conn.query(`DROP DATABASE IF EXISTS \`${V_CENTRAL}\``)
}

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
    const central = fs.readFileSync(path.join(SQL_DIR, '70_user_access_central_views.sql'), 'utf8').replace(/`setes_central`/g, `\`${V_CENTRAL}\``)
    for (const st of statementsOf(central)) await conn.query(st)
    await conn.query(`USE \`${V_CLIENT}\``)
    const client = fs.readFileSync(path.resolve(__dirname, '../src/migrations/sql/075_user_access_views.sql'), 'utf8')
      .replace(/`setes_central`/g, `\`${V_CENTRAL}\``)
    for (const st of statementsOf(client)) await conn.query(st)

    const [kindCol] = await conn.query<any[]>(`SELECT COLUMN_TYPE t, IS_NULLABLE n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = 'setes_central' AND TABLE_NAME = 'tb_institution_has_user' AND COLUMN_NAME = 'kind'`)
    note('tb_institution_has_user.kind', kindCol[0])
    const [keyCol] = await conn.query<any[]>(`SELECT COLUMN_TYPE t, IS_NULLABLE n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = 'setes_central' AND TABLE_NAME = 'tb_interface' AND COLUMN_NAME = 'i18n_key'`)
    note('tb_interface.i18n_key', keyCol[0])

    await conn.query(`INSERT INTO \`${V_CENTRAL}\`.tb_institution (id, schema_name, active, deleted) VALUES
      (1, 'setes_zadv2_v1', 'S', 'N'), (2, ?, 'S', 'N'), (3, 'setes_zadv2_c3', 'S', 'N')`, [V_CLIENT])
    // ── kinds (usuário → [institution, kind, perfil esperado])
    const NBSP = ' ', ZWSP = '​'
    const kinds: [number, number, string | null, string][] = [
      [10, 2, 'admin', 'admin'], [11, 2, 'admin ', 'user'], [12, 2, 'admin\t', 'user'], [13, 2, `admin${NBSP}`, 'user'],
      [14, 2, 'Admin', 'user'], [15, 2, ' admin', 'user'], [16, 2, 'super', 'user'], [17, 1, 'super ', 'user'],
      [18, 1, 'super', 'super'], [19, 1, 'SUPER', 'user'], [20, 2, `admin${ZWSP}`, 'user'], [21, 2, 'admin   ', 'user'],
      [22, 1, `super${NBSP}`, 'user'], [23, 2, null, 'user'], [24, 2, 'admin\n', 'user'], [25, 1, 'admin', 'admin'],
      [30, 2, 'user', 'user'], [31, 3, 'admin', 'admin'], [40, 2, 'user', 'user'], [41, 2, 'user', 'user'],
    ]
    for (const [u] of kinds) {
      await conn.query(`INSERT INTO \`${V_CENTRAL}\`.tb_user (id, password, active, deleted, created_at) VALUES (?, 'HASH', 'S', 'N', NOW())`, [u])
    }
    const skipped: number[] = []
    for (const [u, i, k] of kinds) {
      try {
        await conn.query(`INSERT INTO \`${V_CENTRAL}\`.tb_institution_has_user (tb_institution_id, tb_user_id, kind, active, deleted) VALUES (?, ?, ?, 'S', 'N')`, [i, u, k])
      } catch (e: any) { skipped.push(u); note(`  kind de ${u} recusado pela coluna`, e.code) }
    }
    const q = onCentral(conn, V_CENTRAL)
    const who = (u: number, i: number, s = V_CLIENT) => ({ userId: u, institutionId: i, schemaName: s })
    for (const [u, i, k, expected] of kinds) {
      if (skipped.includes(u)) continue
      const s = await sessionOf(q, who(u, i, i === 1 ? 'setes_zadv2_v1' : i === 3 ? 'setes_zadv2_c3' : V_CLIENT), 2_000_000_000)
      check(`(k) kind ${JSON.stringify(k)} na institution ${i} → perfil '${expected}'`, s?.profile === expected, `perfil='${s?.profile}'`)
    }

    // ── interfaces: 10 orders · 20 'orders ' · 30 'Orders' · 40 NULL · 50 institution-interfaces · 51 'institution-interfaces ' ·
    //    60 customers (SEM par) · 61 products (par V soft-deletado) · 62 cities (par V inativo não deletado) · 63 'orders\t'
    const ifaces: [number, string | null][] = [[10, 'orders'], [20, 'orders '], [30, 'Orders'], [40, null], [50, 'institution-interfaces'],
      [51, 'institution-interfaces '], [60, 'customers'], [61, 'products'], [62, 'cities'], [63, 'orders\t'], [64, `orders${NBSP}`]]
    for (const [id, k] of ifaces) {
      try {
        await conn.query(`INSERT INTO \`${V_CENTRAL}\`.tb_interface (id, i18n_key, description, kind, group_default, deleted) VALUES (?, ?, ?, 'T', 'X', 'N')`, [id, k, String(k)])
      } catch (e: any) { note(`  interface ${id} ${JSON.stringify(k)} recusada`, e.code) }
    }
    const privs: [number, string][] = [[1, 'INSERIR'], [2, 'ALTERAR'], [5, 'FATURAR'], [6, 'VISUALIZAR'], [11, 'CONFIGURAR'],
      [13, 'FATURAR '], [14, 'faturar'], [15, 'FATURAR\t'], [16, `FATURAR${NBSP}`], [17, ' FATURAR'], [18, 'FATURAR'], [19, `FATURAR${ZWSP}`]]
    for (const [id, d] of privs) {
      await conn.query(`INSERT INTO \`${V_CENTRAL}\`.tb_privilege (id, description, deleted) VALUES (?, ?, 'N')`, [id, d])
    }
    const pairs: [number, number, string, string][] = [
      [10, 6, 'S', 'N'], [10, 2, 'S', 'N'], [10, 5, 'S', 'N'], [10, 13, 'S', 'N'], [10, 14, 'S', 'N'], [10, 15, 'S', 'N'], [10, 16, 'S', 'N'],
      [10, 17, 'S', 'N'], [10, 19, 'S', 'N'],
      [20, 6, 'S', 'N'], [20, 5, 'S', 'N'], [30, 6, 'S', 'N'], [30, 5, 'S', 'N'], [40, 6, 'S', 'N'], [40, 5, 'S', 'N'],
      [50, 6, 'S', 'N'], [50, 2, 'S', 'N'], [51, 6, 'S', 'N'], [51, 2, 'S', 'N'],
      [61, 6, 'N', 'S'], [62, 6, 'N', 'N'], [63, 5, 'S', 'N'], [64, 5, 'S', 'N'],
    ]
    for (const [i, p, a, d] of pairs) {
      await conn.query(`INSERT INTO \`${V_CENTRAL}\`.tb_interface_has_privilege (tb_interface_id, tb_privilege_id, active, deleted) VALUES (?, ?, ?, ?)`, [i, p, a, d])
    }
    // licença: institution 2 → orders, customers, products, cities, 40(NULL); institution 3 → SÓ 'orders ', 'Orders', 'orders\t', 'orders NBSP'
    for (const [inst, i] of [[2, 10], [2, 60], [2, 61], [2, 62], [2, 40], [3, 20], [3, 30], [3, 63], [3, 64]]) {
      await conn.query(`INSERT INTO \`${V_CLIENT}\`.tb_institution_has_interface (tb_institution_id, tb_interface_id, active, deleted) VALUES (?, ?, 'S', 'N')`, [inst, i])
    }
    // concessões: 40 (regular) → orders: os verbos "quase FATURAR" (13–17, 19); 41 (regular) → orders: o FATURAR DUPLICADO exato (18 —
    // sem par registrado em orders) e o FATURAR verdadeiro em 'orders ' (20) — nunca em orders
    for (const [u, i, p] of [[40, 10, 13], [40, 10, 14], [40, 10, 15], [40, 10, 16], [40, 10, 17], [40, 10, 19], [40, 10, 6],
      [41, 10, 18], [41, 20, 5], [41, 10, 6]]) {
      await conn.query(`INSERT INTO \`${V_CLIENT}\`.tb_user_has_privilege (tb_user_id, tb_interface_id, tb_privilege_id, active, deleted) VALUES (?, ?, ?, 'S', 'N')`, [u, i, p])
    }

    // (p) o verbo com espaço/Unicode/caixa NÃO vale como FATURAR
    const v40 = await accessVerdict(q, who(40, 2), ['orders'], 'FATURAR')
    const rows40 = (await accessRows(q, who(40, 2))).map(r => `${r.interfaceKey}:${r.privilege}`)
    check("(p) verbos 'FATURAR ', 'faturar', 'FATURAR\\t', 'FATURAR NBSP', ' FATURAR', 'FATURAR ZWSP' concedidos → FATURAR NÃO", v40 === 'no-privilege',
      `veredito='${v40}'`)
    check('(p) o menu (accessRows) do regular 40 só tem o VISUALIZAR', JSON.stringify(rows40) === JSON.stringify(['orders:VISUALIZAR']), JSON.stringify(rows40))
    const [vwPriv] = await conn.query<any[]>(`SELECT tb_privilege_id id, HEX(privilege) h FROM \`${V_CLIENT}\`.vw_user_access WHERE tb_user_id = 40 ORDER BY 1`)
    note('(p) linhas cruas da vw_user_access do regular 40', vwPriv)
    // (p2) FATURAR exato DUPLICADO (outro id) concedido, mas SEM par em orders → a view só lê par registrado
    const v41 = await accessVerdict(q, who(41, 2), ['orders'], 'FATURAR')
    check('(p2) FATURAR exato duplicado (id 18) sem par registrado em orders → não vale', v41 === 'no-privilege', `veredito='${v41}'`)

    // (c) chave: a institution 3 só tem licença das "quase orders" — a 'orders' nunca é alcançada; o admin 31 não fatura 'orders'
    const r31 = await reachableKeys(q, who(31, 3), ['orders'])
    const v31 = await accessVerdict(q, who(31, 3), ['orders'], 'FATURAR')
    const g31 = await grantedKeys(q, who(31, 3), ['orders'], 'FATURAR')
    const rows31 = (await accessRows(q, who(31, 3))).map(r => `${r.interfaceKey}:${r.privilege}`)
    check("(c) licença de 'orders '/'Orders'/'orders\\t'/'orders NBSP' não alcança 'orders'", r31.length === 0 && v31 === 'not-contracted' && g31.length === 0,
      JSON.stringify({ r31, v31, g31 }))
    note("(c) menu do admin 31 (licença só das quase-orders)", rows31)
    check("(c) o menu do admin 31 não traz a chave com espaço à direita ('orders ' fora do catálogo)", !rows31.some(r => r.startsWith('orders :')),
      JSON.stringify(rows31))
    // o regular 41 tem FATURAR concedido em 'orders ' (20) — a institution 2 não tem licença dela; pedir 'orders' não pode valer
    check("(c) FATURAR concedido em 'orders ' não vale em 'orders' (regular 41)", (await accessVerdict(q, who(41, 2), ['orders'], 'FATURAR')) !== 'ok')

    // (n) interface com i18n_key NULL: fora do catálogo (o super não a vê)
    const rowsSuper = await accessRows(q, who(18, 1, V_CLIENT))
    check('(n) i18n_key NULL fora do catálogo (accessRows do super)', !rowsSuper.some(r => r.interfaceId === 40), JSON.stringify(rowsSuper.filter(r => r.interfaceId === 40)))
    check("(n) 'institution-interfaces ' (espaço) fora do catálogo", !rowsSuper.some(r => r.interfaceId === 51))

    // (d) D-PV62: super e admin só passam par REGISTRADO e VIVO
    for (const [label, w] of [['super', who(18, 1, V_CLIENT)], ['admin', who(10, 2)]] as const) {
      const vCust = await accessVerdict(q, w, ['customers'], 'VISUALIZAR')
      const vProd = await accessVerdict(q, w, ['products'], 'VISUALIZAR')
      const vCity = await accessVerdict(q, w, ['cities'], 'VISUALIZAR')
      const vOrdIns = await accessVerdict(q, w, ['orders'], 'INSERIR')
      check(`(d) D-PV62 ${label}: tela sem par / par soft-deletado / par inativo / verbo não registrado → no-privilege`,
        [vCust, vProd, vCity, vOrdIns].every(v => v === 'no-privilege'), JSON.stringify({ vCust, vProd, vCity, vOrdIns }))
      check(`(d) D-PV62 ${label}: par registrado vivo → ok`, (await accessVerdict(q, w, ['orders'], 'FATURAR')) === 'ok')
    }
    // super em chave que não existe no catálogo
    check('(d) super em chave fora do catálogo → not-contracted', (await accessVerdict(q, who(18, 1, V_CLIENT), ['ghost'], 'VISUALIZAR')) === 'not-contracted')

    // (g) delegável: admin da Setes (25) sem concessão → não alcança/não exerce; o super sim
    const vDelegAdmin = await accessVerdict(q, who(25, 1, V_CLIENT), ['institution-interfaces'], 'VISUALIZAR')
    check('(g) admin da Setes na delegável sem concessão → no-privilege (D-PV11 (b))', vDelegAdmin === 'no-privilege', vDelegAdmin)
    await conn.query(`INSERT INTO \`${V_CLIENT}\`.tb_user_has_privilege (tb_user_id, tb_interface_id, tb_privilege_id, active, deleted) VALUES (25, 51, 6, 'S', 'N')`)
    check("(g) concessão na 'institution-interfaces ' (espaço) não vale na delegável",
      (await accessVerdict(q, who(25, 1, V_CLIENT), ['institution-interfaces'], 'VISUALIZAR')) === 'no-privilege')
  } finally {
    await conn.query('USE `setes_central`').catch(() => undefined)
    await dropViews(conn)
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 2. upsertInterfaceConfig REAL (o pool troca `setes_central.` pelo descartável) — revive, ordem do ON DUPLICATE, concorrência
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function upsertExperiment(conn: mysql.PoolConnection): Promise<void> {
  await conn.query(`DROP DATABASE IF EXISTS \`${UP_DB}\``)
  const origGet = pool.getConnection.bind(pool)
  try {
    await conn.query(`CREATE DATABASE \`${UP_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
    for (const t of ['tb_interface', 'tb_privilege', 'tb_interface_has_privilege', 'tb_interface_has_config']) {
      await conn.query(`CREATE TABLE \`${UP_DB}\`.\`${t}\` LIKE setes_central.\`${t}\``)
    }
    // as FKs reais (o LIKE não copia)
    await conn.query(`ALTER TABLE \`${UP_DB}\`.tb_interface_has_config ADD CONSTRAINT fk_ihc_interface FOREIGN KEY (tb_interface_id) REFERENCES \`${UP_DB}\`.tb_interface (id)`)
    await conn.query(`ALTER TABLE \`${UP_DB}\`.tb_interface_has_privilege ADD CONSTRAINT fk_ihp_i FOREIGN KEY (tb_interface_id) REFERENCES \`${UP_DB}\`.tb_interface (id),
      ADD CONSTRAINT fk_ihp_p FOREIGN KEY (tb_privilege_id) REFERENCES \`${UP_DB}\`.tb_privilege (id)`)
    for (const id of [1, 2, 3, 4, 5, 6, 7]) {
      await conn.query(`INSERT INTO \`${UP_DB}\`.tb_interface (id, i18n_key, description, kind, group_default, deleted) VALUES (?, ?, 'x', 'T', 'X', 'N')`, [id, `iface-${id}`])
    }
    await conn.query(`INSERT INTO \`${UP_DB}\`.tb_privilege (id, description, deleted) VALUES (6, 'VISUALIZAR', 'N'), (11, 'CONFIGURAR', 'N')`)
    // estados de partida: 1 sem par · 2 par soft-deletado antigo · 3 par vivo antigo · 4 par inativo não deletado · 5/6 concorrência
    await conn.query(`INSERT INTO \`${UP_DB}\`.tb_interface_has_privilege (tb_interface_id, tb_privilege_id, active, created_at, updated_at, deleted) VALUES
      (2, 11, 'N', '2020-01-01 00:00:00', '2020-01-01 00:00:00', 'S'),
      (3, 11, 'S', '2020-01-01 00:00:00', '2020-01-01 00:00:00', 'N'),
      (4, 11, 'N', '2020-01-01 00:00:00', '2020-01-01 00:00:00', 'N'),
      (6, 11, 'N', '2020-01-01 00:00:00', '2020-01-01 00:00:00', 'S')`)

    ;(pool as any).getConnection = async () => {
      const c = await origGet()
      const rawQuery = c.query.bind(c)
      ;(c as any).query = (sql: any, values?: any) => rawQuery(typeof sql === 'string' ? sql.replace(/\bsetes_central\./g, `\`${UP_DB}\`.`) : sql, values)
      return c
    }
    const { upsertInterfaceConfig } = await import('../src/modules/interfaces/interfaces.repository')
    const INPUT = { description: 'Itens por página', kind: 'Options', options: '10=10;25=25', defaultContent: '25', scope: 'U' } as any
    const pairOf = async (i: number) => (await conn.query<any[]>(
      `SELECT active, deleted, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') u, DATE_FORMAT(created_at, '%Y') c FROM \`${UP_DB}\`.tb_interface_has_privilege WHERE tb_interface_id = ? AND tb_privilege_id = 11`, [i]))[0]

    await upsertInterfaceConfig(1, 'page_size', INPUT)
    const p1 = await pairOf(1)
    check('(u1) par ausente → nasce vivo', p1.length === 1 && p1[0].active === 'S' && p1[0].deleted === 'N', JSON.stringify(p1))
    await upsertInterfaceConfig(2, 'page_size', INPUT)
    const p2 = await pairOf(2)
    check('(u2) par soft-deletado → revive com updated_at novo e created_at mantido', p2[0].active === 'S' && p2[0].deleted === 'N' && p2[0].u !== '2020-01-01 00:00:00' && p2[0].c === '2020',
      JSON.stringify(p2))
    await upsertInterfaceConfig(3, 'page_size', INPUT)
    const p3 = await pairOf(3)
    check('(u3) par vivo → updated_at intacto (a ordem das atribuições do ON DUPLICATE KEY UPDATE)', p3[0].u === '2020-01-01 00:00:00', JSON.stringify(p3))
    await upsertInterfaceConfig(4, 'page_size', INPUT)
    const p4 = await pairOf(4)
    check('(u4) par inativo (N/N) → ativado com updated_at novo', p4[0].active === 'S' && p4[0].u !== '2020-01-01 00:00:00', JSON.stringify(p4))

    // (u5) interface inexistente: FK recusa, NADA fica (nem config nem par)
    let fk = ''
    try { await upsertInterfaceConfig(999, 'page_size', INPUT) } catch (e: any) { fk = e.code }
    const [orphan] = await conn.query<any[]>(`SELECT (SELECT COUNT(*) FROM \`${UP_DB}\`.tb_interface_has_config WHERE tb_interface_id = 999) c,
      (SELECT COUNT(*) FROM \`${UP_DB}\`.tb_interface_has_privilege WHERE tb_interface_id = 999) p`)
    check('(u5) interface inexistente → erro de FK e nenhum resíduo', fk === 'ER_NO_REFERENCED_ROW_2' && orphan[0].c === 0 && orphan[0].p === 0, JSON.stringify({ fk, ...orphan[0] }))

    // (u6) concorrência: N salvamentos simultâneos de configs DIFERENTES na mesma interface (par ausente / par soft-deletado), várias rodadas
    for (const [iface, label] of [[5, 'par ausente'], [6, 'par soft-deletado']] as const) {
      const errs: string[] = []
      for (let round = 0; round < 8; round++) {
        if (round > 0) {
          if (iface === 5) await conn.query(`DELETE FROM \`${UP_DB}\`.tb_interface_has_privilege WHERE tb_interface_id = 5`)
          else await conn.query(`UPDATE \`${UP_DB}\`.tb_interface_has_privilege SET active = 'N', deleted = 'S' WHERE tb_interface_id = 6`)
        }
        const res = await Promise.allSettled(Array.from({ length: 6 }, (_, k) => upsertInterfaceConfig(iface, `cfg_${round}_${k}`, INPUT)))
        for (const r of res) if (r.status === 'rejected') errs.push(String((r.reason as any)?.code ?? (r.reason as any)?.message))
      }
      const pr = await pairOf(iface)
      check(`(u6) 6 salvamentos simultâneos × 8 rodadas (${label}) → sem erro e um par vivo`, errs.length === 0 && pr.length === 1 && pr[0].active === 'S' && pr[0].deleted === 'N',
        `erros=${JSON.stringify(errs)} par=${JSON.stringify(pr)}`)
    }

    // (u7) o verbo de id 11 que NÃO é o CONFIGURAR (o Super criou outro privilégio no id 11 antes do seed 68 — INSERT IGNORE do 68 calado)
    await conn.query(`UPDATE \`${UP_DB}\`.tb_privilege SET description = 'APROVAR' WHERE id = 11`)
    await upsertInterfaceConfig(7, 'page_size', INPUT)
    const p7 = await pairOf(7)
    note('(u7) id 11 = APROVAR (não CONFIGURAR): o escritor registra o par (iface × APROVAR)?', p7)
  } finally {
    ;(pool as any).getConnection = origGet
    await conn.query(`DROP DATABASE IF EXISTS \`${UP_DB}\``)
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 3. SEEDS 64/65/68/72 em ordens diferentes na CÓPIA do catálogo — alarmes da D-PV51 depois de cada ordem
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function seedsExperiment(): Promise<void> {
  const router = (await import('../src/gateway/router')).default
  void router
  const { listGatedModules } = await import('../src/shared/auth/module-privilege-gate')
  const A = await import('../src/shared/auth/assert-privilege-catalog')
  const C = await import('../src/shared/auth/privilege-catalog')
  if (listGatedModules().length === 0) throw new Error('gateway não montou')
  const TABLES = ['tb_interface', 'tb_privilege', 'tb_interface_has_privilege', 'tb_interface_has_config', 'tb_interface_has_field', 'tb_feature_flag']
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    multipleStatements: true,
  })
  const onProbe = (sql: string) => sql.replace(/\bsetes_central\./g, `${CAT_DB}.`)
  const seed = (f: string) => fs.readFileSync(path.join(SQL_DIR, f), 'utf8').replace(/`setes_central`/g, `\`${CAT_DB}\``).replace(/\bsetes_central\./g, `${CAT_DB}.`)
  const alarms = async () => {
    const rows = async (sql: string): Promise<any[]> => (await c.query<any[]>(onProbe(sql)))[0]
    const problems = C.privilegeCatalogProblems({
      catalog: (await rows(A.CATALOG_PAIRS_SQL)).map(r => ({ interfaceKey: String(r.interfaceKey), privilegeId: Number(r.privilegeId) })),
      privileges: (await rows(A.PRIVILEGES_SQL)).map(r => ({ id: Number(r.id), description: r.description == null ? null : String(r.description) })),
      screens: (await rows(A.SCREEN_INTERFACES_SQL)).map(r => String(r.k)),
      configurable: (await rows(A.CONFIGURABLE_INTERFACES_SQL)).map(r => String(r.k)),
      interfaceKeys: (await rows(A.INTERFACE_KEYS_SQL)).map(r => String(r.k)),
    }, C.consumedPrivileges(), C.RESERVED_PRIVILEGES)
    return A.privilegeCatalogAlarms(problems)
  }
  const S64 = '64_privileges_backfill_seed.sql', S65 = '65_institution_interfaces_seed.sql', S68 = '68_privilege_configure_consult_seed.sql',
    S72 = '72_privilege_unconsumed_retire_seed.sql'
  const orders: string[][] = [
    [S65, S68, S72], [S72, S68, S65], [S68, S72, S65], [S68, S65, S72], [S72, S65, S68], [S65, S72, S68], [S65, S68, S72, S64, S68, S72],
  ]
  try {
    await c.query('SET NAMES utf8mb4')
    for (const order of orders) {
      await c.query(`DROP DATABASE IF EXISTS \`${CAT_DB}\``)
      await c.query(`CREATE DATABASE \`${CAT_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
      for (const t of TABLES) {
        await c.query(`CREATE TABLE \`${CAT_DB}\`.\`${t}\` LIKE setes_central.\`${t}\``)
        await c.query(`INSERT INTO \`${CAT_DB}\`.\`${t}\` SELECT * FROM setes_central.\`${t}\``)
      }
      const errs: string[] = []
      for (const f of order) {
        try { await c.query(seed(f)) } catch (e: any) { errs.push(`${f.slice(0, 2)}: ${e.message}`) }
      }
      const a = await alarms()
      const [retired] = await c.query<any[]>(`SELECT i.i18n_key k, ihp.tb_privilege_id p, ihp.active, ihp.deleted FROM \`${CAT_DB}\`.tb_interface_has_privilege ihp
        JOIN \`${CAT_DB}\`.tb_interface i ON i.id = ihp.tb_interface_id
        WHERE (i.i18n_key, ihp.tb_privilege_id) IN (('billing', 6), ('billing', 2), ('establishment', 2), ('users', 3))`)
      const label = order.map(f => f.slice(0, 2)).join('→')
      check(`(s) ordem ${label}: seeds sem erro e ZERO alarme da D-PV51`, errs.length === 0 && a.length === 0,
        `erros=${JSON.stringify(errs)} alarmes=${JSON.stringify(a)}`)
      check(`(s) ordem ${label}: os 4 pares da D-PV61 retirados`, retired.every((r: any) => r.active === 'N' && r.deleted === 'S'), JSON.stringify(retired))
    }
  } finally {
    await c.query(`DROP DATABASE IF EXISTS \`${CAT_DB}\``).catch(() => undefined)
    await c.end()
  }
}

async function main(): Promise<void> {
  const what = process.argv[2] ?? 'all'
  const conn = await pool.getConnection()
  try {
    if (what === 'views' || what === 'all') await viewsExperiment(conn)
    if (what === 'upsert' || what === 'all') await upsertExperiment(conn)
    if (what === 'seeds' || what === 'all') await seedsExperiment()
  } catch (e: any) {
    check('execução da sonda', false, `${e.code ?? ''} ${e.message}\n${e.stack}`)
  } finally {
    for (const db of [V_CLIENT, V_CENTRAL, UP_DB, CAT_DB]) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => undefined)
    conn.release()
    await pool.end()
  }
  console.log(failures ? `\n${failures} ACHADO(S)/FALHA(S)` : '\nSEM ACHADOS')
  process.exit(0)
}
main()
