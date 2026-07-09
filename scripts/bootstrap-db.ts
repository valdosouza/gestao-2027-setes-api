// =====================================================================
// Bootstrap do banco DO ZERO — aplica os scripts canônicos de D:\Gestao2027\sql
// usando a MESMA conexão/.env da API (sem depender do mysql.exe no PATH).
// Uso: npm run db:bootstrap   (depois: npm run dev)
// Ordem: 01 (setes_central DDL) → 02 (seed superusuário) → 05 (tb_sync_api_key)
// Os schemas de cliente são criados pelo boot da API (migrations 001–003).
// =====================================================================
import fs from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
dotenv.config()

const SQL_DIR = process.env.SQL_DIR ?? path.resolve(__dirname, '..', '..', 'sql')

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
    charset: 'utf8mb4',
  })

  try {
    console.log(`[bootstrap] servidor: ${process.env.DB_HOST}:${process.env.DB_PORT} | scripts: ${SQL_DIR}`)

    // 01 — DDL da central (re-executável: IF NOT EXISTS)
    await runFile(conn, '01_setes_central_ddl.sql')

    // 02 — seed (NÃO re-executável): pula se o superusuário já existe
    const [rows] = await conn.query<any[]>(
      "SELECT COUNT(*) AS total FROM setes_central.tb_user"
    )
    if (Number(rows[0].total) > 0) {
      console.log('[bootstrap] 02_setes_central_seed.sql PULADO (tb_user já tem registros)')
    } else {
      await runFile(conn, '02_setes_central_seed.sql')
    }

    // 05 — tb_sync_api_key (re-executável)
    await runFile(conn, '05_sync_api_key.sql')

    // Ajustes incrementais da central (idempotentes): colunas adicionadas ao
    // sql/01 após a base já existir — o CREATE IF NOT EXISTS não altera tabelas.
    await ensureColumn(conn, 'tb_interface', 'i18n_key',
      "ALTER TABLE setes_central.tb_interface ADD COLUMN i18n_key varchar(100) DEFAULT NULL AFTER group_default") // decisão 26 setes-app

    const [dbs] = await conn.query<any[]>(
      "SELECT COUNT(*) AS tabelas FROM information_schema.tables WHERE table_schema = 'setes_central'"
    )
    console.log(`[bootstrap] OK — setes_central com ${dbs[0].tabelas} tabelas.`)
    console.log('[bootstrap] Agora rode: npm run dev (o boot cria os schemas de cliente)')
  } finally {
    await conn.end()
  }
}

async function ensureColumn(conn: mysql.Connection, table: string, column: string, alterSql: string) {
  const [rows] = await conn.query<any[]>(
    `SELECT COUNT(*) AS existe FROM information_schema.columns
     WHERE table_schema = 'setes_central' AND table_name = ? AND column_name = ?`,
    [table, column]
  )
  if (Number(rows[0].existe) > 0) {
    console.log(`[bootstrap] coluna ${table}.${column} já existe — OK`)
    return
  }
  await conn.query(alterSql)
  console.log(`[bootstrap] coluna ${table}.${column} ADICIONADA`)
}

async function runFile(conn: mysql.Connection, file: string) {
  const full = path.join(SQL_DIR, file)
  if (!fs.existsSync(full)) throw new Error(`Arquivo não encontrado: ${full}`)
  const sql = fs.readFileSync(full, 'utf-8')
  console.log(`[bootstrap] aplicando ${file}...`)
  await conn.query(sql)
  console.log(`[bootstrap] ${file} OK`)
}

main().catch(err => {
  console.error('[bootstrap] FALHA:', err.message ?? err)
  process.exit(1)
})
