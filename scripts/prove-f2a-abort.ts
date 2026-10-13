/**
 * PROVA do ABORTO antes do ato da virada (D-F134; `scripts/f2a-abort-before-cutover.ts`) em bancos DESCARTÁVEIS — `f2a_probe_abort_<pid>`
 * (a forma das tabelas do ERP, CREATE TABLE … LIKE, com cópia das linhas) e `f2a_probe_abortf_<pid>` (a habilitação do fiscal_api, só as
 * colunas que o aborto lê). Aplica a 069 pelo divisor do runner + a linha do `_migrations`, e prova:
 *   - ensaio (sem --vai): relata os 9 gatilhos e a linha; NADA muda (a escrita segue barrada);
 *   - --vai: os 9 gatilhos somem, a linha sai, a escrita na voz/SE volta a passar (o código antigo funciona de novo);
 *   - depois da virada (cutover_at no fiscal_api) → RECUSA e nada cai; SE do ERP aposentada pelo ato → RECUSA.
 * Apaga os dois bancos no fim. Só LÊ o schema real.
 *
 *   npx tsx --require tsconfig-paths/register scripts/prove-f2a-abort.ts [schema=setes_setes]
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import { splitStatements } from '../src/migrations/runner'
import { abortF2aPassivo } from './f2a-abort-before-cutover'

const SRC = process.argv[2] ?? 'setes_setes'
const E = `f2a_probe_abort_${process.pid}`
const F = `f2a_probe_abortf_${process.pid}`
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  })
  const triggers = async () => Number(((await c.query<any[]>(`SELECT COUNT(*) n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`, [E]))[0] as any[])[0].n)
  const row = async () => Number(((await c.query<any[]>(`SELECT COUNT(*) n FROM \`${E}\`._migrations WHERE name = 'f2a_fiscal_passivo'`))[0] as any[])[0].n)
  const writeErrno = async (sql: string, p: unknown[] = []) => { try { await c.query(sql, p); return 0 } catch (e: any) { return Number(e?.errno ?? -1) } }
  const apply069 = async () => {
    const file = path.join(__dirname, '..', 'src', 'migrations', 'sql', '069_f2a_fiscal_passivo.sql')
    await c.query(`USE \`${E}\``)
    for (const s of splitStatements(fs.readFileSync(file, 'utf8'))) await c.query(s)
    await c.query(`INSERT INTO \`${E}\`._migrations (version, name) VALUES ('069', 'f2a_fiscal_passivo') ON DUPLICATE KEY UPDATE name = VALUES(name)`)
  }
  try {
    for (const db of [E, F]) {
      await c.query(`DROP DATABASE IF EXISTS \`${db}\``)
      await c.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    }
    for (const t of ['tb_establishment_issuer', 'tb_invoice_service', 'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event']) {
      await c.query(`CREATE TABLE \`${E}\`.\`${t}\` LIKE \`${SRC}\`.\`${t}\``)
    }
    for (const t of ['tb_establishment_issuer', 'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event']) {
      await c.query(`INSERT INTO \`${E}\`.\`${t}\` SELECT * FROM \`${SRC}\`.\`${t}\``)
    }
    await c.query(`CREATE TABLE \`${E}\`._migrations (id INT AUTO_INCREMENT PRIMARY KEY, version VARCHAR(10) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`)
    await c.query(`CREATE TABLE \`${F}\`.tb_establishment_issuer (tb_institution_id INT NOT NULL, model VARCHAR(2) NOT NULL, cutover_at DATETIME NULL, PRIMARY KEY (tb_institution_id, model))`)
    const [[se]] = await c.query<any[]>(`SELECT tb_institution_id AS i FROM \`${E}\`.tb_establishment_issuer WHERE model = 'SE' LIMIT 1`)
    if (!se) throw new Error(`${SRC} sem habilitação SE para a prova`)
    const inst = Number(se.i)
    await c.query(`INSERT INTO \`${F}\`.tb_establishment_issuer VALUES (?, 'SE', NULL)`, [inst])
    await apply069()
    check('a 069 aplicada + linha no _migrations (o estado do passo 4 da janela)', (await triggers()) === 9 && (await row()) === 1)

    // ensaio: relata, nada muda
    const dry = await abortF2aPassivo(c, E, inst, { vai: false, fiscalDb: F })
    check('ensaio relata os 9 gatilhos e a linha', dry.dryRun && dry.triggers.length === 9 && dry.migrationRow, JSON.stringify({ n: dry.triggers.length, row: dry.migrationRow }))
    check('ensaio NÃO muda nada (gatilhos e linha seguem; a escrita na voz segue barrada)',
      (await triggers()) === 9 && (await row()) === 1
      && (await writeErrno(`UPDATE \`${E}\`.tb_invoice_service_transmission_event SET message = message LIMIT 1`)) === 1644)

    // depois da virada (fiscal_api) → recusa e nada cai
    await c.query(`UPDATE \`${F}\`.tb_establishment_issuer SET cutover_at = UTC_TIMESTAMP() WHERE tb_institution_id = ?`, [inst])
    let refused = ''
    try { await abortF2aPassivo(c, E, inst, { vai: true, fiscalDb: F }) } catch (e: any) { refused = String(e?.message) }
    check('cutover_at no fiscal_api → RECUSA (D-F50) e nada cai', /já VIROU/.test(refused) && (await triggers()) === 9 && (await row()) === 1, refused.slice(0, 90))
    await c.query(`UPDATE \`${F}\`.tb_establishment_issuer SET cutover_at = NULL WHERE tb_institution_id = ?`, [inst])

    // fiscal_api ilegível (banco inexistente) → recusa (falha fechada)
    refused = ''
    try { await abortF2aPassivo(c, E, inst, { vai: true, fiscalDb: `${F}_nao_existe` }) } catch (e: any) { refused = String(e?.message) }
    check('fiscal_api ilegível → RECUSA (falha fechada) e nada cai', refused.length > 0 && (await triggers()) === 9, refused.slice(0, 90))

    // --vai: tudo cai, a escrita volta
    const done = await abortF2aPassivo(c, E, inst, { vai: true, fiscalDb: F })
    check('--vai: os 9 gatilhos SOMEM e a linha SAI do _migrations', !done.dryRun && (await triggers()) === 0 && (await row()) === 0)
    check('--vai: a escrita volta a passar (voz e ambiente da SE — o código antigo funciona de novo)',
      (await writeErrno(`UPDATE \`${E}\`.tb_invoice_service_transmission_event SET message = message LIMIT 1`)) === 0
      && (await writeErrno(`UPDATE \`${E}\`.tb_establishment_issuer SET environment = environment WHERE tb_institution_id = ? AND model = 'SE'`, [inst])) === 0)

    // SE do ERP aposentada pelo ATO → recusa (o lado do ERP do --vai)
    await apply069()
    await c.query(`UPDATE \`${E}\`.tb_establishment_issuer SET deleted = 'S', updated_at = NOW() WHERE tb_institution_id = ? AND model = ? AND deleted = 'N'`, [inst, 'SE'])
    refused = ''
    try { await abortF2aPassivo(c, E, inst, { vai: true, fiscalDb: F }) } catch (e: any) { refused = String(e?.message) }
    check('SE do ERP aposentada pelo ATO → RECUSA (D-F50) e nada cai', /APOSENTADA/.test(refused) && (await triggers()) === 9 && (await row()) === 1, refused.slice(0, 90))
  } finally {
    for (const db of [E, F]) await c.query(`DROP DATABASE IF EXISTS \`${db}\``)
    await c.end()
  }
  console.log(`\n${failures ? `${failures} FALHA(S)` : 'aborto da F2a provado — só antes do --vai, falha fechada depois'}`)
}

main().then(() => process.exit(failures ? 1 : 0)).catch(err => { console.error('ERRO', err); process.exit(1) })
