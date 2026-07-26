// =====================================================================
// Aplica um seed canônico de D:\Gestao2027\sql na conexão do .env
// (mesmo estilo do bootstrap-db.ts — sem depender do mysql.exe no PATH).
// Uso: npx tsx scripts/apply-seed.ts 16_software_house_seed.sql
//      (nome do arquivo relativo à pasta sql/, ou caminho absoluto)
// =====================================================================
import fs from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
dotenv.config()

const SQL_DIR = process.env.SQL_DIR ?? path.resolve(__dirname, '..', '..', 'sql')

async function main() {
  const arg = process.argv[2]
  if (!arg) throw new Error('uso: npx tsx scripts/apply-seed.ts <arquivo.sql>')
  const file = path.isAbsolute(arg) ? arg : path.join(SQL_DIR, arg)
  if (!fs.existsSync(file)) throw new Error(`Arquivo não encontrado: ${file}`)

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
    charset: 'utf8mb4',
  })
  try {
    console.log(`[apply-seed] aplicando ${file}...`)
    await conn.query(fs.readFileSync(file, 'utf-8'))
    console.log('[apply-seed] OK')
  } finally {
    await conn.end()
  }
}

main().catch(err => {
  console.error('[apply-seed] FALHA:', err.message ?? err)
  process.exit(1)
})
