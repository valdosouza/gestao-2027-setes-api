/**
 * PROVA do catálogo de privilégios DEPOIS da janela do passo 4 (bloco de privilégios + costura A1 — Infra-IA/prompts/
 * prompt_privilegios_interfaces.md §14) em banco DESCARTÁVEL — `setes_central` só é LIDO (estrutura e linhas do catálogo copiadas).
 *
 *  1. Cria `prova_cat_central` com CÓPIA das tabelas do catálogo (interfaces, privilégios, pares, configs, campos, flags).
 *  2. Confere a cópia como está HOJE (a mesma conferência do `check:privileges` — D-PV51) só para mostrar o ponto de partida.
 *  3. Aplica o SQL REAL dos seeds pendentes da janela, na ORDEM do roteiro (65 → 68 → 72), o nome do central trocado pelo descartável,
 *     e DE NOVO (re-executáveis).
 *  4. Confere de novo: a janela só pode seguir com ZERO alarme — o boot gritaria e o `check:privileges` (D-PV16) recusaria.
 *     Também: os 4 pares da D-PV61 retirados por soft delete (nunca apagados — PADROES §3.1).
 *  No fim apaga o banco descartável, mesmo com falha.
 *
 *   npx tsx --require tsconfig-paths/register scripts/prove-privilege-catalog-window.ts
 *   (worktree sem .env: DOTENV_CONFIG_PATH=<caminho do .env> na frente; SQL_DIR=<pasta sql> se não for a irmã ../../sql)
 * Sai com código 1 em qualquer falha.
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import router from '../src/gateway/router'
import { listGatedModules } from '../src/shared/auth/module-privilege-gate'
import {
  CATALOG_PAIRS_SQL, PRIVILEGES_SQL, SCREEN_INTERFACES_SQL, CONFIGURABLE_INTERFACES_SQL, INTERFACE_KEYS_SQL, privilegeCatalogAlarms,
} from '../src/shared/auth/assert-privilege-catalog'
import { consumedPrivileges, privilegeCatalogProblems, RESERVED_PRIVILEGES } from '../src/shared/auth/privilege-catalog'

void router                                                     // montar o gateway registra as guardas (a tabela da D-PV14)

const PROBE = 'prova_cat_central'
const SQL_DIR = process.env.SQL_DIR ?? path.resolve(__dirname, '../../sql')
const TABLES = ['tb_interface', 'tb_privilege', 'tb_interface_has_privilege', 'tb_interface_has_config', 'tb_interface_has_field',
  'tb_feature_flag'] as const
const WINDOW_SEEDS = ['65_institution_interfaces_seed.sql', '68_privilege_configure_consult_seed.sql',
  '72_privilege_unconsumed_retire_seed.sql'] as const
const RETIRED = [['billing', 6], ['billing', 2], ['establishment', 2], ['users', 3]] as const   // D-PV61

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const onProbe = (sql: string): string => sql.replace(/\bsetes_central\./g, `${PROBE}.`)
const seedOnProbe = (file: string): string => fs.readFileSync(path.join(SQL_DIR, file), 'utf8')
  .replace(/`setes_central`/g, `\`${PROBE}\``).replace(/\bsetes_central\./g, `${PROBE}.`)

async function alarmsOf(conn: mysql.Connection): Promise<string[]> {
  const rows = async (sql: string): Promise<any[]> => (await conn.query<any[]>(onProbe(sql)))[0]
  const problems = privilegeCatalogProblems({
    catalog: (await rows(CATALOG_PAIRS_SQL)).map(r => ({ interfaceKey: String(r.interfaceKey), privilegeId: Number(r.privilegeId) })),
    privileges: (await rows(PRIVILEGES_SQL)).map(r => ({ id: Number(r.id), description: r.description == null ? null : String(r.description) })),
    screens: (await rows(SCREEN_INTERFACES_SQL)).map(r => String(r.k)),
    configurable: (await rows(CONFIGURABLE_INTERFACES_SQL)).map(r => String(r.k)),
    interfaceKeys: (await rows(INTERFACE_KEYS_SQL)).map(r => String(r.k)),
  }, consumedPrivileges(), RESERVED_PRIVILEGES)
  return privilegeCatalogAlarms(problems)
}

async function main(): Promise<void> {
  if (listGatedModules().length === 0) { console.error('a tabela da guarda por roteador está vazia — o gateway não montou'); process.exit(2) }
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    multipleStatements: true,                                   // o seed vai INTEIRO (há ';' dentro de literal — o 65 tem '10=10;25=25…')
  })
  try {
    await conn.query(`SET NAMES utf8mb4`)
    await conn.query(`DROP DATABASE IF EXISTS \`${PROBE}\``)
    const [cs] = await conn.query<any[]>(
      `SELECT DEFAULT_CHARACTER_SET_NAME c, DEFAULT_COLLATION_NAME k FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'setes_central'`)
    await conn.query(`CREATE DATABASE \`${PROBE}\` CHARACTER SET ${cs[0].c} COLLATE ${cs[0].k}`)
    for (const t of TABLES) {
      await conn.query(`CREATE TABLE \`${PROBE}\`.\`${t}\` LIKE setes_central.\`${t}\``)
      await conn.query(`INSERT INTO \`${PROBE}\`.\`${t}\` SELECT * FROM setes_central.\`${t}\``)
    }

    const before = await alarmsOf(conn)
    console.log(`\n── HOJE (cópia do dev, sem os seeds da janela): ${before.length} alarme(s)`)
    for (const a of before) console.log(`   ${a}`)

    for (const round of [1, 2]) {
      for (const f of WINDOW_SEEDS) {
        try { await conn.query(seedOnProbe(f)); check(`seed ${f} aplicado (rodada ${round})`, true) }
        catch (e) { check(`seed ${f} aplicado (rodada ${round})`, false, (e as Error).message) }
      }
    }

    const after = await alarmsOf(conn)
    console.log(`\n── DEPOIS dos seeds 65 → 68 → 72: ${after.length} alarme(s)`)
    for (const a of after) console.log(`   ${a}`)
    check('catálogo depois da janela = o que o código opera ∪ regras ∪ reservados (D-PV51) — zero alarme', after.length === 0)

    for (const [k, pid] of RETIRED) {
      const [r] = await conn.query<any[]>(
        `SELECT ihp.active, ihp.deleted FROM \`${PROBE}\`.tb_interface_has_privilege ihp
           JOIN \`${PROBE}\`.tb_interface i ON i.id = ihp.tb_interface_id WHERE i.i18n_key = ? AND ihp.tb_privilege_id = ?`, [k, pid])
      check(`D-PV61: ${k} × ${pid} retirado por soft delete (linha mantida)`,
        r.length === 0 || r.every(x => x.active === 'N' && x.deleted === 'S'), JSON.stringify(r))
    }
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${PROBE}\``).catch(() => undefined)
    await conn.end()
  }
  console.log(failures ? `\nPROVA FALHOU (${failures})` : '\nPROVA OK')
  process.exit(failures ? 1 : 0)
}

main().catch(err => { console.error('Falha na prova:', err); process.exit(2) })
