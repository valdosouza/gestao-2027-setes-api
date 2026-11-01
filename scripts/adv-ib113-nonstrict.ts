/** ADV D-IB113: só em schema descartável `setes_ib113_adv_ns` — SQL direto no indicador numa sessão NÃO estrita (modo do servidor do dev). */
import fs from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
dotenv.config()
import { splitStatements } from '../src/migrations/runner'
const S = 'setes_ib113_adv_ns'
async function main() {
  const c = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD })
  try {
    await c.query(`DROP DATABASE IF EXISTS \`${S}\``)
    await c.query(`CREATE DATABASE \`${S}\``)
    await c.query(`CREATE TABLE \`${S}\`.tb_tax_ibscbs LIKE setes_central.tb_tax_ibscbs`)
    await c.query(`INSERT INTO \`${S}\`.tb_tax_ibscbs SELECT * FROM setes_central.tb_tax_ibscbs`)
    await c.query(`USE \`${S}\``)
    for (const st of splitStatements(fs.readFileSync(path.resolve(__dirname, '../../sql/73_ibscbs_cst_requires_group.sql'), 'utf8')))
      if (!/^USE\s/i.test(st.trim())) await c.query(st)
    const [[m]] = await c.query<any[]>(`SELECT @@SESSION.sql_mode m`)
    console.log('sql_mode:', m.m)
    for (const [cst, val] of [['410', 'Sem grupo'], ['400', 'Sim'], ['620', ' S'], ['800', 'NULL'], ['810', 's'], ['811', 'S '], ['820', 'Não']] as const) {
      const r = await c.query(`UPDATE \`${S}\`.tb_tax_ibscbs SET requires_ibscbs_group = ? WHERE id = ?`, [val, cst]).then(() => 'aceito', (e: any) => `recusado ${e.errno}`)
      const [[row]] = await c.query<any[]>(`SELECT requires_ibscbs_group g FROM \`${S}\`.tb_tax_ibscbs WHERE id = ?`, [cst])
      console.log(`  ${cst} := ${JSON.stringify(val)} → ${r}; gravado ${JSON.stringify(row.g)}`)
    }
  } finally {
    await c.query(`DROP DATABASE IF EXISTS \`${S}\``).catch(() => undefined)
    await c.end()
  }
}
main().catch(e => { console.error(e); process.exit(1) })
