// =====================================================================
// Aplica as migrations pendentes em TODOS os schemas de cliente ativos
// (mesma engine do boot da API — runMigrationsForSchema/_migrations).
// Uso: npx tsx --require tsconfig-paths/register scripts/run-migrations.ts
// =====================================================================
import dotenv from 'dotenv'
dotenv.config()

import { runMigrationsForAllInstitutions } from '../src/migrations/runner'
import pool from '@shared/db/connection'

async function main() {
  await runMigrationsForAllInstitutions()
  await pool.end()
}

main().catch(err => {
  console.error('[run-migrations] FALHA:', err.message ?? err)
  process.exit(1)
})
