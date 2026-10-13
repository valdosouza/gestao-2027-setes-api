/**
 * PROVA do ABORTO antes do ato da virada (D-F134; `scripts/f2a-abort-before-cutover.ts`) em bancos DESCARTÁVEIS — `f2a_probe_abort_<pid>`
 * (a forma das tabelas do ERP, CREATE TABLE … LIKE, com cópia das linhas) e `f2a_probe_abortf_<pid>` (a habilitação do fiscal_api, só as
 * colunas que o aborto lê) e `f2a_probe_abortc_<pid>` (o central: as DONAS do schema — gate do delta da Rodada 4, F2AR4-SOC-02/ADV-01).
 * Aplica a 069 pelo divisor do runner + a linha do `_migrations`, e prova:
 *   - ensaio (sem --vai): relata os 9 gatilhos e a linha; NADA muda (a escrita segue barrada);
 *   - --vai: os 9 gatilhos somem, a linha sai, a escrita na voz/SE volta a passar (o código antigo funciona de novo);
 *   - depois da virada (cutover_at no fiscal_api) → RECUSA e nada cai; SE do ERP aposentada pelo ato → RECUSA;
 *   - o ESCOPO é o schema: id que não é dono → RECUSA; OUTRA dona do mesmo schema virada → RECUSA (mesmo digitando a que não virou);
 *   - estado incoerente (linha no _migrations sem gatilho visível) → RECUSA sem tirar a linha (F2AR4-ADV-06);
 *   - D-F153: o --vai deixa a LÁPIDE (mesma versão, outro nome) — o runner do código NOVO recusa subir sobre ela; --retirar-lapide a tira;
 *   - D-F152: "reaplicar a trava do schema X" — gatilho derrubado volta pela ferramenta; com a lápide ela RECUSA.
 * Apaga os dois bancos no fim. Só LÊ o schema real.
 *
 *   npx tsx --require tsconfig-paths/register scripts/prove-f2a-abort.ts [schema=setes_setes]
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import { splitStatements, assertAppliedMatchFiles } from '../src/migrations/runner'
import { f2aFreezeTriggersMissingIn, f2aPassivoVersion, F2A_TOMBSTONE_NAME } from '../src/migrations/f2a-freeze-triggers'
import { abortF2aPassivo, removeF2aTombstone } from './f2a-abort-before-cutover'
import { reapplyF2aFreeze } from './f2a-reapply-freeze'

const SRC = process.argv[2] ?? 'setes_setes'
const E = `f2a_probe_abort_${process.pid}`
const F = `f2a_probe_abortf_${process.pid}`
const C = `f2a_probe_abortc_${process.pid}`
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  })
  const triggers = async () => Number(((await c.query<any[]>(`SELECT COUNT(*) n FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ?`, [E]))[0] as any[])[0].n)
  const row = async () => Number(((await c.query<any[]>(`SELECT COUNT(*) n FROM \`${E}\`._migrations WHERE name = 'f2a_fiscal_passivo'`))[0] as any[])[0].n)
  const tomb = async () => Number(((await c.query<any[]>(`SELECT COUNT(*) n FROM \`${E}\`._migrations WHERE name = ?`, [F2A_TOMBSTONE_NAME]))[0] as any[])[0].n)
  const writeErrno = async (sql: string, p: unknown[] = []) => { try { await c.query(sql, p); return 0 } catch (e: any) { return Number(e?.errno ?? -1) } }
  const apply069 = async () => {
    const file = path.join(__dirname, '..', 'src', 'migrations', 'sql', '069_f2a_fiscal_passivo.sql')
    await c.query(`USE \`${E}\``)
    for (const s of splitStatements(fs.readFileSync(file, 'utf8'))) await c.query(s)
    await c.query(`INSERT INTO \`${E}\`._migrations (version, name) VALUES ('069', 'f2a_fiscal_passivo') ON DUPLICATE KEY UPDATE name = VALUES(name)`)
  }
  try {
    for (const db of [E, F, C]) {
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
    // o central: a institution da SE + uma 2ª dona do MESMO schema (filial) — o aborto confere as duas
    const other = inst + 1000
    await c.query(`CREATE TABLE \`${C}\`.tb_institution (id INT PRIMARY KEY, schema_name VARCHAR(64) NOT NULL)`)
    await c.query(`INSERT INTO \`${C}\`.tb_institution VALUES (?, ?), (?, ?), (?, 'setes_outro')`, [inst, E, other, E, inst + 2000])
    await c.query(`INSERT INTO \`${F}\`.tb_establishment_issuer VALUES (?, 'SE', NULL)`, [other])
    await apply069()
    check('a 069 aplicada + linha no _migrations (o estado do passo 4 da janela)', (await triggers()) === 9 && (await row()) === 1)

    // ensaio: relata, nada muda
    const dry = await abortF2aPassivo(c, E, inst, { vai: false, fiscalDb: F, centralDb: C })
    check('ensaio relata os 9 gatilhos e a linha', dry.dryRun && dry.triggers.length === 9 && dry.migrationRow, JSON.stringify({ n: dry.triggers.length, row: dry.migrationRow }))
    check('ensaio NÃO muda nada (gatilhos e linha seguem; a escrita na voz segue barrada)',
      (await triggers()) === 9 && (await row()) === 1
      && (await writeErrno(`UPDATE \`${E}\`.tb_invoice_service_transmission_event SET message = message LIMIT 1`)) === 1644)

    // depois da virada (fiscal_api) → recusa e nada cai
    await c.query(`UPDATE \`${F}\`.tb_establishment_issuer SET cutover_at = UTC_TIMESTAMP() WHERE tb_institution_id = ?`, [inst])
    let refused = ''
    try { await abortF2aPassivo(c, E, inst, { vai: true, fiscalDb: F, centralDb: C }) } catch (e: any) { refused = String(e?.message) }
    check('cutover_at no fiscal_api → RECUSA (D-F50) e nada cai', /já VIROU/.test(refused) && (await triggers()) === 9 && (await row()) === 1, refused.slice(0, 90))
    await c.query(`UPDATE \`${F}\`.tb_establishment_issuer SET cutover_at = NULL WHERE tb_institution_id = ?`, [inst])

    // fiscal_api ilegível (banco inexistente) → recusa (falha fechada)
    refused = ''
    try { await abortF2aPassivo(c, E, inst, { vai: true, fiscalDb: `${F}_nao_existe`, centralDb: C }) } catch (e: any) { refused = String(e?.message) }
    check('fiscal_api ilegível → RECUSA (falha fechada) e nada cai', refused.length > 0 && (await triggers()) === 9, refused.slice(0, 90))

    // o ESCOPO é o schema (F2AR4-SOC-02/ADV-01): id que não é dono → recusa; a OUTRA dona virada → recusa, mesmo digitando a que não virou
    refused = ''
    try { await abortF2aPassivo(c, E, inst + 2000, { vai: true, fiscalDb: F, centralDb: C }) } catch (e: any) { refused = String(e?.message) }
    check('id que não é dono do schema → RECUSA e nada cai', /não é dona/.test(refused) && (await triggers()) === 9 && (await row()) === 1, refused.slice(0, 90))
    await c.query(`UPDATE \`${F}\`.tb_establishment_issuer SET cutover_at = UTC_TIMESTAMP() WHERE tb_institution_id = ?`, [other])
    refused = ''
    try { await abortF2aPassivo(c, E, inst, { vai: true, fiscalDb: F, centralDb: C }) } catch (e: any) { refused = String(e?.message) }
    check('a OUTRA dona do schema já virou → RECUSA (os gatilhos são do schema) e nada cai',
      new RegExp(`institution ${other} já VIROU`).test(refused) && (await triggers()) === 9 && (await row()) === 1, refused.slice(0, 90))
    await c.query(`UPDATE \`${F}\`.tb_establishment_issuer SET cutover_at = NULL WHERE tb_institution_id = ?`, [other])

    // estado incoerente: a linha está no _migrations e nenhum gatilho é visível → recusa SEM tirar a linha (F2AR4-ADV-06)
    const names = ((await c.query<any[]>(`SELECT TRIGGER_NAME n FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ?`, [E]))[0] as any[]).map(r => String(r.n))
    for (const n of names) await c.query(`DROP TRIGGER \`${E}\`.\`${n}\``)
    refused = ''
    try { await abortF2aPassivo(c, E, inst, { vai: true, fiscalDb: F, centralDb: C }) } catch (e: any) { refused = String(e?.message) }
    check('linha no _migrations sem gatilho visível → RECUSA e a linha FICA', /NENHUM gatilho/.test(refused) && (await row()) === 1, refused.slice(0, 90))
    await apply069()

    // --vai: tudo cai, a escrita volta
    const done = await abortF2aPassivo(c, E, inst, { vai: true, fiscalDb: F, centralDb: C })
    check('--vai: os 9 gatilhos SOMEM e a linha VIRA a LÁPIDE (D-F153 — mesma versão, outro nome)',
      !done.dryRun && done.tombstone && (await triggers()) === 0 && (await row()) === 0 && (await tomb()) === 1)
    const applied = ((await c.query<any[]>(`SELECT version, name FROM \`${E}\`._migrations`))[0] as any[]).map(r => ({ version: String(r.version), name: String(r.name) }))
    const version = f2aPassivoVersion()!
    let runner = ''
    try { assertAppliedMatchFiles([{ version, name: 'f2a_fiscal_passivo', file: `${version}_f2a_fiscal_passivo.sql` }], applied, E) } catch (e: any) { runner = String(e?.message) }
    check('o runner do código NOVO RECUSA subir sobre a lápide (nunca re-congela calado); o código antigo (sem o arquivo) não a vê',
      /ABORTADA[\s\S]*D-F153/.test(runner) && (() => { try { assertAppliedMatchFiles([], applied, E); return true } catch { return false } })(), runner.slice(0, 90))
    refused = ''
    try { await reapplyF2aFreeze(c, E, { vai: true }) } catch (e: any) { refused = String(e?.message) }
    check('D-F152: reaplicar a trava num schema com a lápide → RECUSA (voltar à F2a é o --retirar-lapide)', /ABORTADA/.test(refused) && (await triggers()) === 0, refused.slice(0, 90))
    check('--vai: a escrita volta a passar (voz e ambiente da SE — o código antigo funciona de novo)',
      (await writeErrno(`UPDATE \`${E}\`.tb_invoice_service_transmission_event SET message = message LIMIT 1`)) === 0
      && (await writeErrno(`UPDATE \`${E}\`.tb_establishment_issuer SET environment = environment WHERE tb_institution_id = ? AND model = 'SE'`, [inst])) === 0)

    // D-F153: voltar à F2a = tirar a lápide (ato deliberado)
    const back = await removeF2aTombstone(c, E, inst, { vai: true, fiscalDb: F, centralDb: C })
    check('--retirar-lapide --vai: a lápide SAI (o próximo boot do código da F2a aplica a migration de novo)', !back.dryRun && (await tomb()) === 0)

    // D-F152: a trava some (DROP à mão) → a ferramenta a REAPLICA e a conferência do boot volta a passar
    await apply069()
    await c.query(`DROP TRIGGER \`${E}\`.\`tg_f2a_freeze_issuer_se_bu\``)
    const dryRe = await reapplyF2aFreeze(c, E, { vai: false })
    check('reaplicar (ensaio) relata o que falta e nada muda', dryRe.dryRun && dryRe.missing.length === 1 && (await triggers()) === 8, JSON.stringify(dryRe.missing))
    const re = await reapplyF2aFreeze(c, E, { vai: true })
    check('reaplicar --vai: os 9 gatilhos de volta, iguais aos da migration (a conferência do boot passa)',
      re.executed === 18 && (await triggers()) === 9 && (await f2aFreezeTriggersMissingIn(c, E)).length === 0
      && (await writeErrno(`UPDATE \`${E}\`.tb_establishment_issuer SET dps_last_number = dps_last_number + 1 WHERE tb_institution_id = ? AND model = 'SE'`, [inst])) === 1644)

    // SE do ERP aposentada pelo ATO → recusa (o lado do ERP do --vai)
    await apply069()
    await c.query(`UPDATE \`${E}\`.tb_establishment_issuer SET deleted = 'S', updated_at = NOW() WHERE tb_institution_id = ? AND model = ? AND deleted = 'N'`, [inst, 'SE'])
    refused = ''
    try { await abortF2aPassivo(c, E, inst, { vai: true, fiscalDb: F, centralDb: C }) } catch (e: any) { refused = String(e?.message) }
    check('SE do ERP aposentada pelo ATO → RECUSA (D-F50) e nada cai', /APOSENTADA/.test(refused) && (await triggers()) === 9 && (await row()) === 1, refused.slice(0, 90))
  } finally {
    for (const db of [E, F, C]) await c.query(`DROP DATABASE IF EXISTS \`${db}\``)
    await c.end()
  }
  console.log(`\n${failures ? `${failures} FALHA(S)` : 'aborto da F2a provado — só antes do --vai, falha fechada depois'}`)
}

main().then(() => process.exit(failures ? 1 : 0)).catch(err => { console.error('ERRO', err); process.exit(1) })
