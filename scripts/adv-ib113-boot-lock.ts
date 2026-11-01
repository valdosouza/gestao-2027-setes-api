/**
 * ADV D-IB113 (QA adversarial) — SÓ em schema descartável `setes_ib113_adv_lock` (apagado no fim):
 * a sonda do boot (`assertIbscbsCatalogSchema`) espera a trava da CARGA do catálogo (`SELECT id FROM tb_tax_ibscbs FOR UPDATE`
 * numa transação aberta)? Mede com e sem o CHECK, com innodb_lock_wait_timeout = 3 s na sessão da sonda.
 */
import fs from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
dotenv.config()
import { splitStatements } from '../src/migrations/runner'
import { assertIbscbsCatalogSchema } from '@shared/ibscbs-classification'
const S = 'setes_ib113_adv_lock'
const TABLES = ['tb_tax_ibscbs', 'tb_tax_ibscbs_classification', 'tb_tax_ibscbs_classification_validity']
const cfg = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD }
async function main() {
  const admin = await mysql.createConnection(cfg)
  const holder = await mysql.createConnection(cfg)
  const probePool = mysql.createPool({ ...cfg, connectionLimit: 2 })
  probePool.on('connection', (c: any) => { c.query('SET SESSION innodb_lock_wait_timeout = 3'); c.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ') })
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${S}\``)
    await admin.query(`CREATE DATABASE \`${S}\``)
    for (const t of TABLES) await admin.query(`CREATE TABLE \`${S}\`.${t} LIKE setes_central.${t}`)
    await admin.query(`INSERT INTO \`${S}\`.tb_tax_ibscbs SELECT * FROM setes_central.tb_tax_ibscbs`)
    await admin.query(`USE \`${S}\``)
    const sql73 = fs.readFileSync(path.resolve(__dirname, '../../sql/73_ibscbs_cst_requires_group.sql'), 'utf8')
    for (const st of splitStatements(sql73)) if (!/^USE\s/i.test(st.trim())) await admin.query(st)
    await admin.query(`UPDATE \`${S}\`.tb_tax_ibscbs SET requires_ibscbs_group = IF(id IN ('400','410','620','800','810','811','820'),'N','S')`)
    const timed = async (label: string) => {
      const t0 = Date.now()
      const r = await assertIbscbsCatalogSchema(probePool as any, S).then(v => `OK ${v}`, (e: any) => `ERRO errno=${e?.errno} ${String(e?.message).slice(0, 140)}`)
      console.log(`${label}: ${Date.now() - t0} ms → ${r}`)
    }
    await timed('sem trava, com CHECK')
    // a CARGA do catálogo: a 1ª instrução da transação dela (apply.ts:257)
    await holder.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await holder.beginTransaction()
    await holder.query(`SELECT id FROM \`${S}\`.tb_tax_ibscbs FOR UPDATE`)
    await timed('carga em andamento, com CHECK')
    await holder.rollback()
    await admin.query(`ALTER TABLE \`${S}\`.tb_tax_ibscbs DROP CONSTRAINT ck_tax_ibscbs_requires_group`)
    await holder.beginTransaction()
    await holder.query(`SELECT id FROM \`${S}\`.tb_tax_ibscbs FOR UPDATE`)
    await timed('carga em andamento, SEM CHECK')
    await holder.rollback()
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS \`${S}\``).catch(() => undefined)
    await admin.end(); await holder.end(); await probePool.end()
  }
}
main().catch(e => { console.error('FALHA', e); process.exit(1) })
