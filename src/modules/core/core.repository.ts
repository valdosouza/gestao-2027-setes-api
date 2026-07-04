import pool from '@shared/db/connection'

export async function getInstitutionInfo(schemaName: string) {
  const conn = await pool.getConnection()
  try {
    const [rows] = await conn.query<any[]>(
      `SELECT i.id, e.nick_trade AS name, e.name_company AS companyName, i.active
       FROM setes_central.tb_institution i
       INNER JOIN setes_central.tb_entity e ON (e.id = i.id)
       WHERE i.schema_name = ? AND i.deleted = 'N'`,
      [schemaName]
    )
    return rows[0] ?? null
  } finally {
    conn.release()
  }
}
