import pool from '@shared/db/connection'

export interface CreateTenantInput {
  id:         string
  name:       string
  schemaName: string
}

export async function insertTenant(input: CreateTenantInput): Promise<void> {
  await pool.query(
    'INSERT INTO setes_central.tenants (id, name, schema_name) VALUES (?, ?, ?)',
    [input.id, input.name, input.schemaName]
  )
}

export async function insertDefaultFlags(tenantId: string): Promise<void> {
  const defaultModules = ['core']

  const values = defaultModules.map(mod => [tenantId, mod, true])

  await pool.query(
    'INSERT INTO setes_central.feature_flags (tenant_id, module_key, enabled) VALUES ?',
    [values]
  )
}

export async function tenantSchemaExists(schemaName: string): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    'SELECT schema_name FROM setes_central.tenants WHERE schema_name = ?',
    [schemaName]
  )
  return rows.length > 0
}
