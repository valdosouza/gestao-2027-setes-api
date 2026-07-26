// =====================================================================
// errors:gen — deriva setes_central.tb_error_catalog do ARQUIVO
// src/shared/errors/error-codes.ts (fonte da verdade — R8 do Framework de
// Mensagens). Upsert idempotente; códigos removidos do arquivo viram
// deleted='S' (nunca DELETE — trilha p/ crashlytics antigas).
// Uso: npm run errors:gen  (rodar a cada entrega que mexer em erros)
// =====================================================================
import dotenv from 'dotenv'
dotenv.config()
import mysql from 'mysql2/promise'
import { ErrorCatalog } from '../src/shared/errors/error-codes'

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  })
  try {
    const codes = Object.keys(ErrorCatalog)
    for (const code of codes) {
      await conn.query(
        `INSERT INTO setes_central.tb_error_catalog
           (code, description, created_at, updated_at, deleted)
         VALUES (?, ?, NOW(), NOW(), 'N')
         ON DUPLICATE KEY UPDATE
           description = VALUES(description), deleted = 'N', updated_at = NOW()`,
        [code, ErrorCatalog[code as keyof typeof ErrorCatalog]]
      )
    }
    await conn.query(
      `UPDATE setes_central.tb_error_catalog
          SET deleted = 'S', updated_at = NOW()
        WHERE code NOT IN (?) AND deleted = 'N'`,
      [codes]
    )
    console.log(`[errors:gen] catálogo sincronizado — ${codes.length} códigos`)
  } finally {
    await conn.end()
  }
}

main().catch(err => {
  console.error('[errors:gen] FALHA:', err.message ?? err)
  process.exit(1)
})
