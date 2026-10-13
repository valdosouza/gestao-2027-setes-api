import fs     from 'fs'
import path   from 'path'
import pool   from '@shared/db/connection'
import logger from '@shared/logger/logger'
import { getAppliedMigrationRows, recordMigration } from './repository'
import { F2A_PASSIVO_NAME, F2A_TOMBSTONE_NAME } from './f2a-names'

const SQL_DIR = path.resolve(__dirname, 'sql')

interface MigrationFile {
  version: string
  name:    string
  file:    string
}

function loadMigrationFiles(): MigrationFile[] {
  const files = fs
    .readdirSync(SQL_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(file => {
      const [version, ...rest] = file.replace('.sql', '').split('_')
      return { version, name: rest.join('_'), file }
    })
  assertUniqueVersions(files)
  return files
}

/**
 * F2a A2 (gates F2A2-ADV-04, 2026-10-12): o runner decide pela VERSÃO (o número) — duas frentes que escolham o MESMO
 * número fariam uma delas ser PULADA para sempre, calada (ou o 2º INSERT em `_migrations` derrubaria o boot depois do
 * DDL). Falha ALTA no boot: dois arquivos com a mesma versão, ou versão aplicada com OUTRO nome que o do arquivo.
 */
export function assertUniqueVersions(files: MigrationFile[]): void {
  const seen = new Map<string, string>()
  for (const f of files) {
    const other = seen.get(f.version)
    if (other) throw new Error(`Migrations com a MESMA versão ${f.version}: ${other} e ${f.file} — renumere uma delas (o runner decide pelo número)`)
    seen.set(f.version, f.file)
  }
}

export function assertAppliedMatchFiles(files: MigrationFile[], applied: { version: string; name: string }[], schemaName: string): void {
  const byVersion = new Map(files.map(f => [f.version, f]))
  // D-F153: o schema teve a F2a ABORTADA antes do ato — o código da F2a não sobe sobre ele por acidente. Pelo NOME, nunca pelo número
  // (gate socrático da Rodada 5, R5-SOC-03): a F2a renumerada num rebase (069 → 071) também recusa; e o número da lápide fica RESERVADO —
  // outra migration com ele nunca rodaria (PADROES §11 regra 14).
  const tomb = applied.find(a => a.name === F2A_TOMBSTONE_NAME)
  if (tomb) {
    const f2a = files.find(f => f.name === F2A_PASSIVO_NAME)
    if (f2a) {
      throw new Error(`${schemaName}: a F2a foi ABORTADA neste schema (lápide "${F2A_TOMBSTONE_NAME}" na versão ${tomb.version} — D-F153`
        + `${f2a.version !== tomb.version ? `; o arquivo da F2a agora é ${f2a.file}` : ''}); o código da F2a NÃO sobe sobre ele. `
        + 'Para voltar à F2a (ato deliberado): '
        + '`npx tsx --require tsconfig-paths/register scripts/f2a-abort-before-cutover.ts <schema> <institutionId> --retirar-lapide --vai`')
    }
    const other = byVersion.get(tomb.version)
    if (other) {
      throw new Error(`${schemaName}: a versão ${tomb.version} está RESERVADA pela lápide da F2a abortada (D-F153 — PADROES §11 regra 14), `
        + `mas o arquivo ${other.file} usa o mesmo número — ele NUNCA rodaria. Renumere o arquivo.`)
    }
  }
  for (const a of applied) {
    if (a.name === F2A_TOMBSTONE_NAME) continue
    const f = byVersion.get(a.version)
    if (f && a.name && f.name !== a.name) {
      throw new Error(`${schemaName}: a versão ${a.version} foi aplicada como "${a.name}", mas o arquivo é ${f.file} — `
        + 'duas migrations com o mesmo número; a do arquivo NUNCA rodaria. Renumere o arquivo.')
    }
  }
}

export function splitStatements(sql: string): string[] {
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
    const appliedRows = await getAppliedMigrationRows(conn)
    assertAppliedMatchFiles(files, appliedRows, schemaName)
    const applied = appliedRows.map(r => r.version)
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

export async function runMigrationsForAllInstitutions(): Promise<void> {
  const [institutions] = await pool.query<any[]>(
    "SELECT schema_name FROM setes_central.tb_institution WHERE active = 'S' AND deleted = 'N'"
  )

  logger.info(`Iniciando migrations para ${institutions.length} institution(s)`)

  for (const institution of institutions) {
    await runMigrationsForSchema(institution.schema_name)
  }

  logger.info('Migrations finalizadas para todas as institutions')
}
