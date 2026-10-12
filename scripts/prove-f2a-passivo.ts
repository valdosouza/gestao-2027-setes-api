/**
 * PROVA da migration 069_f2a_fiscal_passivo (F2a, etapa A3 — D-F110; `prompt_apis_fiscais_isoladas.md` §22.11) em banco DESCARTÁVEL.
 *
 * Cria `f2a_probe_passivo_<pid>` com a ESTRUTURA das 4 tabelas do schema real (CREATE TABLE … LIKE — sem FKs) e uma cópia das linhas de
 * tb_establishment_issuer/tentativas/vozes; aplica a 069 com o MESMO divisor de comandos do runner do boot (duas vezes — re-executável)
 * e ataca: escrita nas tabelas congeladas (INSERT/UPDATE/DELETE), habilitação SE (INSERT, revive, ambiente, contador, modelo, DELETE,
 * 'se' minúsculo), o ATO da virada (o UPDATE exato de `nfse-api/scripts/cutover-erp.ts`, N→S), as linhas 55/65 livres, e os COMMENTs.
 * Apaga o banco no fim. Só LÊ o schema real (SHOW CREATE / SELECT).
 *
 *   npx tsx --require tsconfig-paths/register scripts/prove-f2a-passivo.ts [schema=setes_setes]
 * Sai com código 1 em qualquer divergência.
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import { splitStatements } from '../src/migrations/runner'

const SRC = process.argv[2] ?? 'setes_setes'
const P = `f2a_probe_passivo_${process.pid}`
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    multipleStatements: false,
  })
  const refused = async (label: string, sql: string, params: unknown[] = []) => {
    try { await c.query(sql, params); check(label, false, 'o banco ACEITOU') } catch (err: any) {
      check(label, err?.errno === 1644 && /F2a \(D-F110/.test(String(err?.sqlMessage)), `${err?.errno} ${String(err?.sqlMessage ?? '').slice(0, 90)}`)
    }
  }
  const accepted = async (label: string, sql: string, params: unknown[] = []) => {
    try { const [r]: any = await c.query(sql, params); check(label, true, `${r?.affectedRows ?? '?'} linha(s)`) } catch (err: any) {
      check(label, false, `${err?.errno} ${String(err?.sqlMessage ?? '').slice(0, 90)}`)
    }
  }
  try {
    await c.query(`DROP DATABASE IF EXISTS \`${P}\``)
    await c.query(`CREATE DATABASE \`${P}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    for (const t of ['tb_establishment_issuer', 'tb_invoice_service', 'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event']) {
      await c.query(`CREATE TABLE \`${P}\`.\`${t}\` LIKE \`${SRC}\`.\`${t}\``)
    }
    for (const t of ['tb_establishment_issuer', 'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event']) {
      await c.query(`INSERT INTO \`${P}\`.\`${t}\` SELECT * FROM \`${SRC}\`.\`${t}\``)
    }
    await c.query(`INSERT INTO \`${P}\`.tb_invoice_service SELECT * FROM \`${SRC}\`.tb_invoice_service LIMIT 5`)
    await c.query(`USE \`${P}\``)

    const file = path.join(__dirname, '..', 'src', 'migrations', 'sql', '069_f2a_fiscal_passivo.sql')
    const statements = splitStatements(fs.readFileSync(file, 'utf8'))
    check('a 069 divide em 22 comandos pelo divisor do runner (9 DROP + 9 CREATE TRIGGER + 4 ALTER)', statements.length === 22, String(statements.length))
    for (const pass of [1, 2]) {
      try { for (const s of statements) await c.query(s); check(`a 069 aplica (passada ${pass} — re-executável)`, true) } catch (err: any) {
        check(`a 069 aplica (passada ${pass})`, false, `${err?.errno} ${err?.sqlMessage}`)
      }
    }
    const [trg] = await c.query<any[]>(`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY 1`, [P])
    check('9 gatilhos de trava presentes', trg.length === 9, trg.map((t: any) => t.TRIGGER_NAME).join(' '))

    // tentativas e vozes: nada entra, muda ou sai
    const [[tx]] = await c.query<any[]>(`SELECT * FROM tb_invoice_service_transmission LIMIT 1`)
    const [[ev]] = await c.query<any[]>(`SELECT * FROM tb_invoice_service_transmission_event LIMIT 1`)
    if (tx) {
      await refused('tentativa: INSERT recusado', `INSERT INTO tb_invoice_service_transmission SELECT * FROM \`${SRC}\`.tb_invoice_service_transmission LIMIT 1`)
      await refused('tentativa: UPDATE recusado', `UPDATE tb_invoice_service_transmission SET last_queried_at = UTC_TIMESTAMP() LIMIT 1`)
      await refused('tentativa: DELETE recusado', `DELETE FROM tb_invoice_service_transmission LIMIT 1`)
    } else check('há tentativa na cópia para atacar', false, `${SRC} sem tentativas`)
    if (ev) {
      await refused('voz: INSERT recusado', `INSERT INTO tb_invoice_service_transmission_event SELECT * FROM \`${SRC}\`.tb_invoice_service_transmission_event LIMIT 1`)
      await refused('voz: UPDATE recusado', `UPDATE tb_invoice_service_transmission_event SET message = 'x' LIMIT 1`)
      await refused('voz: DELETE recusado', `DELETE FROM tb_invoice_service_transmission_event LIMIT 1`)
    } else check('há voz na cópia para atacar', false, `${SRC} sem vozes`)

    // habilitação SE
    const [[se]] = await c.query<any[]>(`SELECT * FROM tb_establishment_issuer WHERE model = 'SE' LIMIT 1`)
    if (!se) throw new Error(`${SRC} sem linha SE — a prova precisa dela`)
    const inst = se.tb_institution_id
    await refused('SE: mudar o ambiente recusado', `UPDATE tb_establishment_issuer SET environment = IF(environment = 'P', 'H', 'P') WHERE tb_institution_id = ? AND model = 'SE'`, [inst])
    await refused('SE: mudar o contador do nDPS recusado', `UPDATE tb_establishment_issuer SET dps_last_number = dps_last_number + 1 WHERE tb_institution_id = ? AND model = 'SE'`, [inst])
    await refused('SE: trocar o dono (tb_institution_id) recusado — F2A3-ADV-05', `UPDATE tb_establishment_issuer SET tb_institution_id = tb_institution_id + 1000 WHERE tb_institution_id = ? AND model = 'SE'`, [inst])
    await refused('SE: trocar o modelo recusado', `UPDATE tb_establishment_issuer SET model = '65' WHERE tb_institution_id = ? AND model = 'SE'`, [inst])
    await refused('SE: DELETE físico recusado', `DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [inst])
    await refused('SE: INSERT de outra linha SE recusado (outra institution)', `INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, created_at, updated_at, deleted) VALUES (?, 'SE', 'H', '1', 0, UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'N')`, [inst + 1000])
    await refused("SE: 'se' minúsculo também recusado (colação da coluna)", `INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, created_at, updated_at, deleted) VALUES (?, 'se', 'H', '1', 0, UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'N')`, [inst + 1001])
    await accepted('SE: mudar a série é LIVRE (não é a habilitação)', `UPDATE tb_establishment_issuer SET serie = serie, tb_user_id = tb_user_id, updated_at = UTC_TIMESTAMP() WHERE tb_institution_id = ? AND model = 'SE'`, [inst])
    if (se.deleted === 'N') {
      // o ATO da virada — o UPDATE exato de nfse-api/scripts/cutover-erp.ts
      await accepted('o ATO da virada (N→S, D-F44) PASSA', `UPDATE \`${P}\`.tb_establishment_issuer SET deleted = 'S', updated_at = NOW() WHERE tb_institution_id = ? AND model = 'SE' AND deleted = 'N'`, [inst])
      await refused('SE aposentada: revive S→N recusado', `UPDATE tb_establishment_issuer SET deleted = 'N' WHERE tb_institution_id = ? AND model = 'SE'`, [inst])
    } else check('linha SE ainda viva na origem para ensaiar o ato', false, `deleted=${se.deleted}`)
    // linhas 55/65: só a série da nota — livres
    await accepted('55: INSERT livre', `INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, created_at, updated_at, deleted) VALUES (?, '55', 'H', '1', 0, UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'N')`, [inst])
    await accepted('55: UPDATE (série e ambiente) livre', `UPDATE tb_establishment_issuer SET serie = '2', environment = 'P' WHERE tb_institution_id = ? AND model = '55'`, [inst])
    await accepted('55: DELETE livre', `DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = '55'`, [inst])

    // COMMENTs de aposentadoria
    const [tc] = await c.query<any[]>(`SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE 'tb_invoice_service_transmission%'`, [P])
    check('as duas tabelas = ORIGEM CONGELADA no comentário', tc.length === 2 && tc.every((r: any) => /^ORIGEM CONGELADA/.test(r.TABLE_COMMENT)))
    const [cc] = await c.query<any[]>(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND ((TABLE_NAME = 'tb_establishment_issuer' AND COLUMN_NAME IN ('environment', 'dps_last_number')) OR (TABLE_NAME = 'tb_invoice_service' AND COLUMN_NAME = 'dps_number'))`, [P])
    const [orig] = await c.query<any[]>(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND ((TABLE_NAME = 'tb_establishment_issuer' AND COLUMN_NAME IN ('environment', 'dps_last_number')) OR (TABLE_NAME = 'tb_invoice_service' AND COLUMN_NAME = 'dps_number'))`, [SRC])
    const key = (r: any) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`
    const same = cc.length === 3 && cc.every((r: any) => {
      const o = orig.find((x: any) => key(x) === key(r))
      return o && o.COLUMN_TYPE === r.COLUMN_TYPE && o.IS_NULLABLE === r.IS_NULLABLE && String(o.COLUMN_DEFAULT) === String(r.COLUMN_DEFAULT)
    })
    check('3 colunas APOSENTADAS no comentário, com tipo/nulo/padrão IGUAIS aos do schema real', same && cc.every((r: any) => /^APOSENTADA/.test(r.COLUMN_COMMENT)),
      cc.map((r: any) => `${key(r)} ${r.COLUMN_TYPE} ${r.IS_NULLABLE} ${r.COLUMN_DEFAULT}`).join(' · '))
    // leitura segue livre (a re-sincronia final e a história leem a origem congelada)
    const [[n]] = await c.query<any[]>(`SELECT COUNT(*) n FROM tb_invoice_service_transmission`)
    check('a origem congelada continua LEGÍVEL', Number(n.n) > 0, `${n.n} tentativas`)
  } finally {
    await c.query(`DROP DATABASE IF EXISTS \`${P}\``)
    await c.end()
  }
  console.log(`\n${failures ? `${failures} FALHA(S)` : 'f2a_fiscal_passivo provada — o ERP não escreve mais a voz fiscal'}`)
}

main().then(() => process.exit(failures ? 1 : 0)).catch(err => { console.error('ERRO', err); process.exit(1) })
