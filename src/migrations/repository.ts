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

/**
 * Versões aplicadas COM o nome gravado (F2a A2 — gates F2A2-ADV-04): o runner confere que a versão aplicada é a do
 * MESMO arquivo (mesmo nome) — duas frentes que escolham o mesmo número não podem fazer uma delas ser pulada calada.
 */
export async function getAppliedMigrationRows(conn: PoolConnection): Promise<{ version: string; name: string }[]> {
  try {
    const [rows] = await conn.query<any[]>('SELECT version, name FROM _migrations ORDER BY version ASC')
    return rows.map(r => ({ version: String(r.version), name: String(r.name ?? '') }))
  } catch {
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
