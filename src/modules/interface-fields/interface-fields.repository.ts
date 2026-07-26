import pool from '@shared/db/connection'
import { assertSchemaName } from '@shared/field-config'
import { FieldConfigInput } from './interface-fields.interface'

/**
 * SQL do painel de campos configuráveis. Catálogo em setes_central;
 * especialização no schema do cliente (cross-schema). A vitrine e o check
 * de contrato foram PROMOVIDOS para @shared/interface-vitrine quando o
 * painel de configurações virou o 2º consumidor.
 */

/** Baseline técnico de UM campo do catálogo (null = campo não existe). */
export async function getCatalogFieldRequired(
  interfaceId: number, fieldName: string
): Promise<'S' | 'N' | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT required FROM setes_central.tb_interface_has_field
      WHERE tb_interface_id = ? AND field_name = ? AND deleted = 'N'`,
    [interfaceId, fieldName]
  )
  return rows.length > 0 ? (rows[0].required as 'S' | 'N') : null
}

/** Upsert da especialização (PK tripla; ressuscita soft-deleted). */
export async function upsertFieldConfig(
  schemaName: string, institutionId: number, interfaceId: number,
  fieldName: string, input: FieldConfigInput
): Promise<void> {
  assertSchemaName(schemaName)
  await pool.query(
    `INSERT INTO \`${schemaName}\`.tb_institution_has_field
       (tb_institution_id, tb_interface_id, field_name,
        field_caption, required, mask, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE
       field_caption = VALUES(field_caption),
       required      = VALUES(required),
       mask          = VALUES(mask),
       deleted       = 'N',
       updated_at    = NOW()`,
    [institutionId, interfaceId, fieldName,
     input.fieldCaption ?? null, input.required ?? null, input.mask ?? null]
  )
}
