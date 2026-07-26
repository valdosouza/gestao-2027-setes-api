import pool from '@shared/db/connection'

export interface FeatureFlag {
  institutionId: number
  moduleKey:     string
  enabled:       boolean
}

export async function getFlagsForInstitution(institutionId: number): Promise<FeatureFlag[]> {
  const [rows] = await pool.query<any[]>(
    `SELECT tb_institution_id AS institutionId, module_key AS moduleKey, enabled
     FROM setes_central.tb_feature_flag
     WHERE tb_institution_id = ? AND deleted = 'N'`,
    [institutionId]
  )
  return rows
}
