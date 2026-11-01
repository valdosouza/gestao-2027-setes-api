/**
 * PROVA do script sql/73 (fase IBS/CBS, D-IB113 — o indicador do grupo IBS/CBS do CST) em SCHEMAS DESCARTÁVEIS, sem tocar o
 * `setes_central`:
 *   A) cópia do `tb_tax_ibscbs` VIVO (CREATE TABLE … LIKE + as linhas — só LEITURA da origem): o boot recusa ANTES do 73 (diz o
 *      script); o 73 aplicado DUAS vezes (re-executável); a coluna nasce NULL em toda linha existente; o CHECK binário recusa
 *      'X', 's' e '' e aceita 'S', 'N' e NULL; o boot (`assertIbscbsCatalogSchema`, a MESMA função do servidor) RECUSA
 *      enquanto um CST de indicador desconhecido ainda tem cClassTrib vivo (D-IB120), só ALERTA se o CST saiu da fonte, e
 *      passa com todo indicador conhecido; sem o CHECK (script interrompido entre os comandos) o boot
 *      recusa e o 73 de novo conserta;
 *   B) ambiente NOVO: o script 61 (com o espelho da coluna) + o 73 por cima — a coluna e o CHECK do 61 iguais aos do 73, e o
 *      bloco do `tb_tax_ibscbs` no canônico 01 idêntico ao do 61.
 * Apaga os schemas descartáveis no fim (inclusive em falha).
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-ibscbs-cst-group.ts [pasta-do-repositorio-sql=../../sql]
 */
import fs from 'fs'
import path from 'path'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'
import { assertIbscbsCatalogSchema, CST_GROUP_CHECK } from '@shared/ibscbs-classification'

const SQL_DIR = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..', 'sql'))
const PROBE_A = `setes_ib113_probe_a_${process.pid}`
const PROBE_B = `setes_ib113_probe_b_${process.pid}`
const SCRIPT_73 = path.join(SQL_DIR, '73_ibscbs_cst_requires_group.sql')
const SCRIPT_61 = path.join(SQL_DIR, '61_ibscbs_reference_ddl.sql')
const SCRIPT_01 = path.join(SQL_DIR, '01_setes_central_ddl.sql')

/** Os comandos do script, sem o `USE setes_central` (quem chama já fez `USE` do schema descartável). */
const statementsOf = (file: string): string[] => splitStatements(fs.readFileSync(file, 'utf8'))
  .filter(st => !/^USE\s/i.test(st.trim()))

/** O bloco CREATE TABLE do tb_tax_ibscbs (comparação do espelho 61 × canônico 01). */
const cstBlock = (file: string): string => {
  const m = /CREATE TABLE IF NOT EXISTS `tb_tax_ibscbs` \([\s\S]*?\) ENGINE=[^;]*;/.exec(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
  if (!m) throw new Error(`bloco do tb_tax_ibscbs não encontrado em ${file}`)
  return m[0]
}

async function main() {
  const conn = await pool.getConnection()
  let ok = true
  const check = (label: string, cond: boolean) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${label}`); ok &&= cond }
  const run = async (statements: string[]) => { for (const st of statements) await conn.query(st) }
  const write = async (schema: string, value: string | null): Promise<string> => {
    try {
      await conn.query(`UPDATE \`${schema}\`.tb_tax_ibscbs SET requires_ibscbs_group = ? WHERE id = '000'`, [value])
      return 'aceito'
    } catch (e: any) {
      const m = String(e?.sqlMessage ?? e?.message)
      return /ck_[a-z_]+/.exec(m)?.[0] ? `recusado:${/ck_[a-z_]+/.exec(m)![0]}` : `erro:${m}`
    }
  }
  const column = async (schema: string) => {
    const [rows] = await conn.query<any[]>(
      `SELECT DATA_TYPE AS t, CHARACTER_MAXIMUM_LENGTH AS len, IS_NULLABLE AS nul, COLUMN_DEFAULT AS def, ORDINAL_POSITION AS pos
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tb_tax_ibscbs' AND COLUMN_NAME = 'requires_ibscbs_group'`,
      [schema])
    return (rows as any[])[0]
  }
  const checkClause = async (schema: string) => {
    const [rows] = await conn.query<any[]>(
      `SELECT CHECK_CLAUSE AS c FROM information_schema.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'tb_tax_ibscbs' AND CONSTRAINT_NAME = ?`, [schema, CST_GROUP_CHECK])
    return (rows as any[]).map(r => String(r.c))
  }
  try {
    // ---------------------------------------------------------------- A) cópia do catálogo vivo
    await conn.query(`CREATE DATABASE \`${PROBE_A}\``)
    await conn.query(`CREATE TABLE \`${PROBE_A}\`.tb_tax_ibscbs LIKE setes_central.tb_tax_ibscbs`)
    await conn.query(`INSERT INTO \`${PROBE_A}\`.tb_tax_ibscbs SELECT * FROM setes_central.tb_tax_ibscbs`)
    // D-IB120: o boot lê também a identidade e a história do cClassTrib (CST desconhecido EM USO) — copiadas com as linhas
    for (const t of ['tb_tax_ibscbs_classification', 'tb_tax_ibscbs_classification_validity']) {
      await conn.query(`CREATE TABLE \`${PROBE_A}\`.${t} LIKE setes_central.${t}`)
      await conn.query(`INSERT INTO \`${PROBE_A}\`.${t} SELECT * FROM setes_central.${t}`)
    }
    const [[{ n: copied }]] = await conn.query<any[]>(`SELECT COUNT(*) AS n FROM \`${PROBE_A}\`.tb_tax_ibscbs`)
    check(`cópia do tb_tax_ibscbs vivo: ${copied} CST`, Number(copied) > 0)
    check('o vivo ainda NÃO tem a coluna (o 73 não foi aplicado no setes_central)', (await column('setes_central')) === undefined)

    const before = await assertIbscbsCatalogSchema(pool as any, PROBE_A).then(() => 'subiu', (e: Error) => e.message)
    check(`boot ANTES do 73 recusa e diz o script: "${before.slice(0, 90)}…"`, /sql\/73_ibscbs_cst_requires_group\.sql/.test(before))

    await conn.query(`USE \`${PROBE_A}\``)
    for (let pass = 1; pass <= 2; pass++) await run(statementsOf(SCRIPT_73))
    check('73 aplicado DUAS vezes sem erro (re-executável)', true)
    const col = await column(PROBE_A)
    check(`coluna char(1) anulável, padrão NULL (${JSON.stringify(col)})`,
      col?.t === 'char' && Number(col?.len) === 1 && col?.nul === 'YES' && (col?.def === null || col?.def === 'NULL'))
    const [[{ n: nulls }]] = await conn.query<any[]>(`SELECT COUNT(*) AS n FROM tb_tax_ibscbs WHERE requires_ibscbs_group IS NULL`)
    check(`toda linha existente nasce com o indicador DESCONHECIDO (${nulls}/${copied} NULL — nenhum padrão inventado)`, Number(nulls) === Number(copied))
    const clause = await checkClause(PROBE_A)
    check(`CHECK ${CST_GROUP_CHECK} presente uma vez, binário: ${clause.join(' | ')}`, clause.length === 1 && /utf8mb4_bin/i.test(clause[0]))

    const refused = await assertIbscbsCatalogSchema(pool as any, PROBE_A).then(() => 'subiu', (e: Error) => e.message)
    check(`D-IB120: 73 aplicado e catálogo NÃO recarregado → o boot RECUSA: "${refused.slice(0, 110)}…"`,
      /DESCONHECIDO no\(s\) CST 000, .*ANTES do deploy.*D-IB120/.test(refused))

    for (const [value, expected] of [['S', 'aceito'], ['N', 'aceito'], [null, 'aceito'], ['s', `recusado:${CST_GROUP_CHECK}`],
      ['n', `recusado:${CST_GROUP_CHECK}`], ['X', `recusado:${CST_GROUP_CHECK}`], ['', `recusado:${CST_GROUP_CHECK}`]] as const) {
      const got = await write(PROBE_A, value)
      check(`requires_ibscbs_group = ${value === null ? 'NULL' : `'${value}'`} → ${got}`, got === expected)
    }
    // ADV-IB113-02: o CHECK é avaliado ANTES do índice — com ele, nem a PK de um CST que já existe colide (a sonda do boot conta com isso)
    const dup = await conn.query(`INSERT INTO tb_tax_ibscbs (id, description, requires_ibscbs_group, source_version) VALUES ('000', 'x', 'X', 'x')`)
      .then(() => 'aceito', (e: any) => /ck_[a-z_]+/.exec(String(e?.sqlMessage))?.[0] ?? `erro ${e?.errno}`)
    check(`CST existente com indicador fora do domínio → ${dup} (o CHECK vem antes da PK, nunca 1062)`, dup === CST_GROUP_CHECK)
    await conn.query(`UPDATE tb_tax_ibscbs SET requires_ibscbs_group = IF(id IN ('400','410','620','800','810','811','820'), 'N', 'S')`)
    check(`boot com todo indicador conhecido: ${await assertIbscbsCatalogSchema(pool as any, PROBE_A)}`,
      (await assertIbscbsCatalogSchema(pool as any, PROBE_A)) === 'ok')
    // D-IB120: CST desconhecido cujos cClassTrib saíram TODOS da fonte (linhas superadas) — a carga não o alcança: só alerta
    await conn.query(`UPDATE tb_tax_ibscbs SET requires_ibscbs_group = NULL WHERE id = '830'`)
    await conn.query(`UPDATE tb_tax_ibscbs_classification_validity v JOIN tb_tax_ibscbs_classification c ON c.code = v.code
                         SET v.absent_since_version = 'IT prova' WHERE c.tb_tax_ibscbs_id = '830'`)
    const gone = await assertIbscbsCatalogSchema(pool as any, PROBE_A)
    check(`D-IB120: CST 830 desconhecido e fora da fonte → sobe com alerta: "${gone}"`, gone.startsWith('ok (1 CST com o indicador desconhecido fora da fonte'))
    await conn.query(`UPDATE tb_tax_ibscbs_classification_validity v JOIN tb_tax_ibscbs_classification c ON c.code = v.code
                         SET v.absent_since_version = NULL WHERE c.tb_tax_ibscbs_id = '830'`)
    const back = await assertIbscbsCatalogSchema(pool as any, PROBE_A).then(() => 'subiu', (e: Error) => e.message)
    check(`D-IB120: o 830 volta à fonte ainda desconhecido → recusa de novo ("${back.slice(0, 70)}…")`, /CST 830, que ainda/.test(back))
    await conn.query(`UPDATE tb_tax_ibscbs SET requires_ibscbs_group = 'S' WHERE id = '830'`)

    // script interrompido entre os dois comandos (coluna sem o CHECK) → o boot recusa; o 73 de novo conserta
    await conn.query(`ALTER TABLE tb_tax_ibscbs DROP CONSTRAINT \`${CST_GROUP_CHECK}\``)
    const open = await assertIbscbsCatalogSchema(pool as any, PROBE_A).then(() => 'subiu', (e: Error) => e.message)
    check(`sem o CHECK o boot recusa: "${open.slice(0, 100)}…"`, /ACEITOU requires_ibscbs_group fora do domínio/.test(open))
    const [[{ n: residue }]] = await conn.query<any[]>(`SELECT COUNT(*) AS n FROM tb_tax_ibscbs WHERE id IN ('998','999')`)
    check('a sonda do boot não deixa linha (transação desfeita)', Number(residue) === 0)
    await run(statementsOf(SCRIPT_73))
    check(`o 73 de novo restaura o CHECK e o boot passa: ${await assertIbscbsCatalogSchema(pool as any, PROBE_A)}`, (await checkClause(PROBE_A)).length === 1)

    // ---------------------------------------------------------------- B) ambiente NOVO: 61 (com o espelho) + 73
    await conn.query(`CREATE DATABASE \`${PROBE_B}\``)
    await conn.query(`USE \`${PROBE_B}\``)
    await run(statementsOf(SCRIPT_61))
    const fresh = await column(PROBE_B)
    check(`61 cria a coluna no ambiente novo (${JSON.stringify(fresh)})`, fresh?.t === 'char' && fresh?.nul === 'YES')
    const freshClause = await checkClause(PROBE_B)
    await run(statementsOf(SCRIPT_73))
    check('73 por cima do 61 sem erro', true)
    const afterClause = await checkClause(PROBE_B)
    check(`CHECK do 61 = CHECK do 73 (${freshClause.join('')})`, freshClause.length === 1 && afterClause.length === 1 && freshClause[0] === afterClause[0])
    check(`boot no ambiente novo (tabela vazia): ${await assertIbscbsCatalogSchema(pool as any, PROBE_B)}`, true)
    check('bloco do tb_tax_ibscbs no canônico 01 idêntico ao do 61', cstBlock(SCRIPT_01) === cstBlock(SCRIPT_61))
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${PROBE_A}\``).catch(() => undefined)
    await conn.query(`DROP DATABASE IF EXISTS \`${PROBE_B}\``).catch(() => undefined)
    conn.release()
    await pool.end()
  }
  console.log(ok ? '\nPROVA OK — schemas descartáveis apagados' : '\nPROVA FALHOU — schemas descartáveis apagados')
  process.exit(ok ? 0 : 1)
}

main().catch(e => { console.error('FALHA', e?.message ?? e); process.exit(1) })
