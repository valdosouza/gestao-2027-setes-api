import pool from '@shared/db/connection'
import { assertSchemaName } from '@shared/field-config'

/**
 * SQL de escrita dos VALORES de configuração (schema do cliente) —
 * tb_institution_has_config. Leitura/resolução vive em
 * @shared/interface-config (consumida também pelo enforcement da API).
 */

/** Valor gravado (não deletado) de uma linha específica; null = não existe. */
export async function getConfigValue(
  schemaName: string, institutionId: number, interfaceId: number,
  name: string, tbUserId: number
): Promise<string | null> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT content FROM \`${schemaName}\`.tb_institution_has_config
      WHERE tb_institution_id = ? AND tb_interface_id = ? AND name = ?
        AND tb_user_id = ? AND deleted = 'N'`,
    [institutionId, interfaceId, name, tbUserId]
  )
  return rows.length > 0 ? String(rows[0].content) : null
}

/** Upsert do valor (PK quádrupla; ressuscita soft-deleted). */
export async function upsertConfigValue(
  schemaName: string, institutionId: number, interfaceId: number,
  name: string, tbUserId: number, content: string
): Promise<void> {
  assertSchemaName(schemaName)
  await pool.query(
    `INSERT INTO \`${schemaName}\`.tb_institution_has_config
       (tb_institution_id, tb_interface_id, name, tb_user_id,
        content, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE
       content    = VALUES(content),
       deleted    = 'N',
       updated_at = NOW()`,
    [institutionId, interfaceId, name, tbUserId, content]
  )
}

/** Remove (soft) o valor — volta a herdar institution → default. */
export async function deleteConfigValue(
  schemaName: string, institutionId: number, interfaceId: number,
  name: string, tbUserId: number
): Promise<void> {
  assertSchemaName(schemaName)
  await pool.query(
    `UPDATE \`${schemaName}\`.tb_institution_has_config
        SET deleted = 'S', updated_at = NOW()
      WHERE tb_institution_id = ? AND tb_interface_id = ? AND name = ?
        AND tb_user_id = ?`,
    [institutionId, interfaceId, name, tbUserId]
  )
}
