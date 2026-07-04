import { PoolConnection } from 'mysql2/promise'

export async function getAppliedMigrations(conn: PoolConnection): Promise<string[]> {
  try {
    const [rows] = await conn.query<any[]>(
      'SELECT version FROM _migrations ORDER BY version ASC'
    )
    return rows.map(r => r.version)
  } catch {
    // Tabela ainda não existe — será criada pela migration 001
    return []
  }
}

export async function recordMigration(
  conn: PoolConnection,
  version: string,
  name: string
): Promise<void> {
  await conn.query(
    'INSERT INTO _migrations (version, name) VALUES (?, ?)',
    [version, name]
  )
}
