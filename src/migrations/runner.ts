import fs     from 'fs'
import path   from 'path'
import pool   from '@shared/db/connection'
import logger from '@shared/logger/logger'
import { getAppliedMigrations, recordMigration } from './repository'

const SQL_DIR = path.resolve(__dirname, 'sql')

interface MigrationFile {
  version: string
  name:    string
  file:    string
}

function loadMigrationFiles(): MigrationFile[] {
  return fs
    .readdirSync(SQL_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(file => {
      const [version, ...rest] = file.replace('.sql', '').split('_')
      return { version, name: rest.join('_'), file }
    })
}

function splitStatements(sql: string): string[] {
  sql = sql.replace(/--[^\n]*\n/g, '\n')

  const statements: string[] = []
  let current = ''
  let inBlock  = false

  for (const line of sql.split('\n')) {
    const trimmed = line.trim().toUpperCase()

    if (trimmed === 'BEGIN') inBlock = true
    if (trimmed === 'END;')  inBlock = false

    current += line + '\n'

    if (!inBlock && line.trim().endsWith(';')) {
      const stmt = current.trim().replace(/;$/, '').trim()
      if (stmt.length > 0) statements.push(stmt)
      current = ''
    }
  }

  if (current.trim().length > 0) {
    statements.push(current.trim())
  }

  return statements.filter(s => s.length > 0)
}

export async function runMigrationsForSchema(schemaName: string): Promise<void> {
  const conn = await pool.getConnection()

  try {
    await conn.query(`CREATE SCHEMA IF NOT EXISTS \`${schemaName}\``)
    await conn.query(`USE \`${schemaName}\``)

    // Garante que a tabela de controle de migrations existe antes de qualquer coisa
    await conn.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        version    VARCHAR(10)  NOT NULL UNIQUE,
        name       VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `)

    const files   = loadMigrationFiles()
    const applied = await getAppliedMigrations(conn)
    const pending = files.filter(f => !applied.includes(f.version))

    if (pending.length === 0) {
      logger.info('Migrations: nenhuma pendente', { schemaName })
      return
    }

    for (const migration of pending) {
      const sql        = fs.readFileSync(path.join(SQL_DIR, migration.file), 'utf-8')
      const statements = splitStatements(sql)

      for (const statement of statements) {
        if (statement.trim().length === 0) continue
        await conn.query(statement)
      }

      await recordMigration(conn, migration.version, migration.name)
      logger.info(`Migration aplicada: ${migration.version} - ${migration.name}`, { schemaName })
    }

    logger.info('Migrations concluidas', { schemaName, total: pending.length })
  } catch (err) {
    logger.error('Erro na migration', { schemaName, err })
    throw err
  } finally {
    conn.release()
  }
}

export async function runMigrationsForAllTenants(): Promise<void> {
  const [tenants] = await pool.query<any[]>(
    'SELECT schema_name FROM setes_central.tenants WHERE active = TRUE'
  )

  logger.info(`Iniciando migrations para ${tenants.length} tenant(s)`)

  for (const tenant of tenants) {
    await runMigrationsForSchema(tenant.schema_name)
  }

  logger.info('Migrations finalizadas para todos os tenants')
}
