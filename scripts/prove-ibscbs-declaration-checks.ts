/**
 * PROVA da migration 070 (fase IBS/CBS, IB-2 — D-IB62/D-IB71/D-IB73) em SCHEMA DESCARTÁVEL: cria
 * `setes_ib2_probe_<pid>` com uma cópia VAZIA de `tb_invoice_service` (CREATE TABLE … LIKE — mesma forma e os CHECKs da
 * 066), aplica a 070 DUAS vezes (re-executável), confere que os CHECKs recusam o grupo incompleto e o grupo sem NBS e
 * aceitam o trio, a NBS sozinha e a nota sem declaração; confere que toda linha VIVA de `tb_invoice_service` do schema de
 * origem passaria nos CHECKs (leitura). Apaga o schema descartável no fim (inclusive em falha). NUNCA escreve no schema
 * de origem.
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-ibscbs-declaration-checks.ts [schema-origem=setes_setes]
 */
import fs from 'fs'
import path from 'path'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'

const SOURCE = process.argv[2] ?? 'setes_setes'
const PROBE = `setes_ib2_probe_${process.pid}`
const MIGRATION = path.join(__dirname, '..', 'src', 'migrations', 'sql', '070_ibscbs_declaration_checks.sql')

async function main() {
  if (!/^setes_[a-z0-9_]+$/.test(SOURCE)) throw new Error(`schema de origem inválido: ${SOURCE}`)
  const conn = await pool.getConnection()
  let ok = true
  const check = (label: string, cond: boolean) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${label}`); ok &&= cond }
  try {
    await conn.query(`CREATE DATABASE \`${PROBE}\``)
    await conn.query(`CREATE TABLE \`${PROBE}\`.tb_invoice_service LIKE \`${SOURCE}\`.tb_invoice_service`)
    await conn.query(`USE \`${PROBE}\``)
    const statements = splitStatements(fs.readFileSync(MIGRATION, 'utf8'))
    for (let run = 1; run <= 2; run++) for (const st of statements) await conn.query(st)
    check('070 aplicada DUAS vezes sem erro (re-executável)', true)

    const [cks] = await conn.query<any[]>(
      `SELECT CONSTRAINT_NAME AS n FROM information_schema.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'tb_invoice_service' ORDER BY 1`, [PROBE])
    const names = (cks as any[]).map(r => r.n)
    check(`CHECKs presentes: ${names.join(', ')}`,
      names.includes('ck_invoice_service_ibscbs_pair') && names.includes('ck_invoice_service_ibscbs_requires_nbs')
      && names.includes('ck_invoice_service_classification_code'))

    let id = 1
    const insert = async (cls: string | null, place: string | null, nbs: string | null) => {
      try {
        await conn.query(
          `INSERT INTO tb_invoice_service (id, tb_institution_id, terminal, classification_code, place_indicator_code, nbs)
           VALUES (?, 1, 0, ?, ?, ?)`, [id++, cls, place, nbs])
        return 'aceito'
      } catch (e: any) {
        const m = String(e?.sqlMessage ?? e?.message)
        const ck = /ck_[a-z_]+/.exec(m)?.[0]
        return ck ? `recusado:${ck}` : `erro:${m}`
      }
    }
    check('trio completo aceito', await insert('000001', '100301', '115021000') === 'aceito')
    check('sem declaração (as 3 NULL) aceito', await insert(null, null, null) === 'aceito')
    check('NBS sozinha (cNBS sem o grupo — D-IB62) aceita', await insert(null, null, '115021000') === 'aceito')
    check('cClassTrib sem cIndOp recusado pelo par', await insert('000001', null, '115021000') === 'recusado:ck_invoice_service_ibscbs_pair')
    check('cIndOp sem cClassTrib recusado pelo par', await insert(null, '100301', null) === 'recusado:ck_invoice_service_ibscbs_pair')
    check('grupo sem NBS recusado (E0322)', await insert('000001', '100301', null) === 'recusado:ck_invoice_service_ibscbs_requires_nbs')

    const [bad] = await conn.query<any[]>(
      `SELECT COUNT(*) AS n FROM \`${SOURCE}\`.tb_invoice_service
        WHERE NOT ((classification_code IS NULL) = (place_indicator_code IS NULL))
           OR NOT (classification_code IS NULL OR nbs IS NOT NULL)`)
    check(`${SOURCE}: nenhuma linha existente viola os CHECKs novos (${(bad as any[])[0].n} violações)`, Number((bad as any[])[0].n) === 0)
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${PROBE}\``).catch(() => undefined)
    conn.release()
    await pool.end()
  }
  console.log(ok ? '\nPROVA OK — schema descartável apagado' : '\nPROVA FALHOU — schema descartável apagado')
  process.exit(ok ? 0 : 1)
}

main().catch(e => { console.error('FALHA', e?.message ?? e); process.exit(1) })
