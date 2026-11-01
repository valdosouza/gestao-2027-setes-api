/**
 * ADV D-IB113 (QA adversarial) — MATRIZ contra o MariaDB real, só em schema DESCARTÁVEL `setes_ib113_adv_mx` (apagado no fim):
 * cópia do catálogo vivo (LIKE + INSERT…SELECT, só leitura da origem) + script 73 + CARGA REAL do IT oficial; depois, para TODO
 * cClassTrib do catálogo × várias datas × estados do indicador (carga real · 000 NULL · 000 'N' · SQL direto em modo não estrito),
 * confere as quatro portas pela peça REAL:
 *   P1 cadastro: lista de apoio (filtro = o código) ⇔ salvar ⇔ selo do GET;
 *   P2 faturamento: grupo congelado ⇒ CST com indicador 'S' (NUNCA congela grupo de CST sem o grupo);
 *   P3 faturamento ⇔ veredito da data do fato.
 */
import fs from 'fs'
import path from 'path'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'
import { readXlsx } from '@shared/xlsx/read-xlsx'
import { applyCatalog, parseItCatalog } from '@shared/ibscbs-catalog'
import {
  MODEL_NFSE, Queryable, assertServiceClassification, classificationAcceptance, classificationVerdictAt, deriveCst,
  evaluateIbscbsDeclaration, listClassificationsLookup,
} from '@shared/ibscbs-classification'
const S = 'setes_ib113_adv_mx'
const TABLES = ['tb_tax_ibscbs', 'tb_tax_ibscbs_classification', 'tb_tax_ibscbs_classification_validity',
  'tb_tax_ibscbs_classification_applicability', 'tb_ibscbs_place_indicator', 'tb_ibscbs_place_indicator_applicability', 'tb_nbs']
const IT = path.resolve(__dirname, '../../../Infra-IA/setes-api/integracoes/nfse-adn/classificacao-ibs-cbs/it-2025-002-v1-70-cclasstrib.xlsx')
const DATES = ['2026-11-01', '2026-12-31', '2027-01-01', '2027-06-30']
async function main() {
  const raw = await pool.getConnection()
  const rewrite = (sql: string) => sql.split('setes_central.').join(`\`${S}\`.`)
  const conn: any = { query: (sql: string, p?: unknown[]) => raw.query(rewrite(sql), p),
    beginTransaction: () => raw.beginTransaction(), commit: () => raw.commit(), rollback: () => raw.rollback() }
  const q: Queryable = conn
  const fails: string[] = []
  try {
    await raw.query(`DROP DATABASE IF EXISTS \`${S}\``)
    await raw.query(`CREATE DATABASE \`${S}\``)
    for (const t of TABLES) {
      await raw.query(`CREATE TABLE \`${S}\`.${t} LIKE setes_central.${t}`)
      await raw.query(`INSERT INTO \`${S}\`.${t} SELECT * FROM setes_central.${t}`)
    }
    await raw.query(`USE \`${S}\``)
    for (const st of splitStatements(fs.readFileSync(path.resolve(__dirname, '../../sql/73_ibscbs_cst_requires_group.sql'), 'utf8')))
      if (!/^USE\s/i.test(st.trim())) await raw.query(st)
    const it = parseItCatalog(readXlsx(fs.readFileSync(IT)))
    await applyCatalog(conn, { it, itVersion: 'IT 2025.002 v1.70', unconfirmed: [], models: ['SE'], apply: true, allowShrink: true })
    const [[nbsRow]] = await raw.query<any[]>(`SELECT code FROM \`${S}\`.tb_nbs WHERE deleted='N' ORDER BY code LIMIT 1`)
    const [[place]] = await raw.query<any[]>(`SELECT p.code FROM \`${S}\`.tb_ibscbs_place_indicator p JOIN \`${S}\`.tb_ibscbs_place_indicator_applicability a ON a.code=p.code AND a.model='SE' AND a.deleted='N' WHERE p.deleted='N' ORDER BY p.code LIMIT 1`)
    const [codesRows] = await raw.query<any[]>(`SELECT code FROM \`${S}\`.tb_tax_ibscbs_classification ORDER BY code`)
    const codes = (codesRows as any[]).map(r => String(r.code))
    console.log(`catálogo: ${codes.length} cClassTrib; NBS ${nbsRow?.code}; cIndOp ${place?.code}`)

    const round = async (label: string) => {
      const [g] = await raw.query<any[]>(`SELECT id, requires_ibscbs_group g FROM \`${S}\`.tb_tax_ibscbs`)
      const groupOf = new Map((g as any[]).map(r => [String(r.id), r.g]))
      let declared = 0, saved = 0
      for (const date of DATES) {
        for (const code of codes) {
          const inLookup = (await listClassificationsLookup(code, date, MODEL_NFSE, q)).some(r => r.code === code)
          const saveOk = await assertServiceClassification(q, { ibscbs: { classificationCode: code, placeIndicatorCode: place.code } }, date)
            .then(() => true, (e: any) => { if (e?.statusCode !== 422) throw e; return false })
          const selo = (await classificationAcceptance(q, code, place.code, date)).classification
          if (!(inLookup === saveOk && saveOk === selo)) fails.push(`[${label}] P1 ${code}@${date}: lista=${inLookup} salvar=${saveOk} selo=${selo}`)
          if (saveOk) saved++
          const ev = await evaluateIbscbsDeclaration(q, [{ productId: 1, description: 's', field: 'product.1', nbs: nbsRow.code, classificationCode: code, placeIndicatorCode: place.code }], date, '2027-01-01')
          const v = await classificationVerdictAt(q, code, MODEL_NFSE, date)
          if (ev.declaration.group) {
            declared++
            if (groupOf.get(deriveCst(code)) !== 'S') fails.push(`[${label}] P2 ${code}@${date}: grupo CONGELADO com CST ${deriveCst(code)} = ${groupOf.get(deriveCst(code))}`)
          }
          if ((ev.declaration.group !== null) !== v.accepted) fails.push(`[${label}] P3 ${code}@${date}: declarado=${!!ev.declaration.group} veredito=${v.accepted}/${v.reason}`)
          if (!v.accepted && v.reason === 'cst-without-group' && ev.obligatory && ev.refusal?.code !== 'INVOICE_SERVICE_IBSCBS_REQUIRED') fails.push(`[${label}] P3b ${code}@${date}: sem recusa depois da obrigação`)
        }
      }
      console.log(`[${label}] salvar aceito ${saved} (código×data), declarado ${declared}; falhas acumuladas ${fails.length}`)
    }
    await round('carga real')
    await raw.query(`UPDATE \`${S}\`.tb_tax_ibscbs SET requires_ibscbs_group = NULL WHERE id = '000'`)
    await round('000 NULL')
    await raw.query(`UPDATE \`${S}\`.tb_tax_ibscbs SET requires_ibscbs_group = 'N' WHERE id = '000'`)
    await round('000 N')
    // SQL direto numa sessão NÃO estrita (o modo do dev): o que o CHECK vê é o valor JÁ truncado
    const [[mode]] = await raw.query<any[]>(`SELECT @@SESSION.sql_mode m`)
    console.log('sql_mode da sessão:', mode.m)
    for (const [cst, val] of [['410', 'Sem grupo'], ['400', 'Sim'], ['620', ' S'], ['800', 'NULL'], ['810', 's']] as const) {
      const r = await raw.query(`UPDATE \`${S}\`.tb_tax_ibscbs SET requires_ibscbs_group = ? WHERE id = ?`, [val, cst]).then(() => 'aceito', (e: any) => `recusado ${e.errno}`)
      const [[row]] = await raw.query<any[]>(`SELECT requires_ibscbs_group g, HEX(requires_ibscbs_group) h FROM \`${S}\`.tb_tax_ibscbs WHERE id = ?`, [cst])
      console.log(`  SQL direto ${cst} := ${JSON.stringify(val)} → ${r}; gravado ${JSON.stringify(row.g)} (hex ${row.h})`)
    }
    await round('SQL direto não estrito')
  } finally {
    await raw.query(`DROP DATABASE IF EXISTS \`${S}\``).catch(() => undefined)
    raw.release()
    await pool.end()
  }
  console.log(`FALHAS: ${fails.length}`)
  fails.slice(0, 60).forEach(f => console.log('  ', f))
}
main().catch(e => { console.error('FALHA', e?.stack ?? e); process.exit(1) })
