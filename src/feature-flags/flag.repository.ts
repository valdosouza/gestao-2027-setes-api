import pool from '@shared/db/connection'

export interface FeatureFlag {
  tenantId: string
  moduleKey: string
  enabled:  boolean
}

export async function getFlagsForTenant(tenantId: string): Promise<FeatureFlag[]> {
  const [rows] = await pool.query<any[]>(
    'SELECT tenant_id as tenantId, module_key as moduleKey, enabled FROM feature_flags WHERE tenant_id = ?',
    [tenantId]
  )
  return rows
}
