import pool from '@shared/db/connection'

export async function getTenantInfo(schemaName: string) {
  const conn = await pool.getConnection()
  try {
    const [rows] = await conn.query<any[]>(
      'SELECT id, name, active FROM setes_central.tenants WHERE schema_name = ?',
      [schemaName]
    )
    return rows[0] ?? null
  } finally {
    conn.release()
  }
}
