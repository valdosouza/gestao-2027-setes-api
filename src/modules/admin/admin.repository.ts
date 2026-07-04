import pool from '@shared/db/connection'

export interface CreateInstitutionInput {
  name:       string
  nickTrade?: string
  schemaName: string
}

// IDs gerados pela aplicação (Fase 2, decisão 7) — MAX+1 dentro de transação.
// Cria tb_entity + tb_institution com o mesmo id (herança por PK — decisão 1).
export async function insertInstitution(input: CreateInstitutionInput): Promise<number> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query<any[]>(
      'SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.tb_entity FOR UPDATE'
    )
    const id = Number(rows[0].nextId)

    await conn.query(
      `INSERT INTO setes_central.tb_entity (id, name_company, nick_trade, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())`,
      [id, input.name, input.nickTrade ?? input.name]
    )

    await conn.query(
      `INSERT INTO setes_central.tb_institution (id, schema_name, active, created_at, updated_at)
       VALUES (?, ?, 'S', NOW(), NOW())`,
      [id, input.schemaName]
    )

    await conn.commit()
    return id
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function insertDefaultFlags(institutionId: number): Promise<void> {
  const defaultModules = ['core']
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query<any[]>(
      'SELECT COALESCE(MAX(id), 0) AS maxId FROM setes_central.tb_feature_flag FOR UPDATE'
    )
    let nextId = Number(rows[0].maxId)

    const now    = new Date()
    const values = defaultModules.map(mod => [++nextId, institutionId, mod, true, now, now])

    await conn.query(
      `INSERT INTO setes_central.tb_feature_flag
         (id, tb_institution_id, module_key, enabled, created_at, updated_at)
       VALUES ?`,
      [values]
    )

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function institutionSchemaExists(schemaName: string): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    'SELECT schema_name FROM setes_central.tb_institution WHERE schema_name = ?',
    [schemaName]
  )
  return rows.length > 0
}
