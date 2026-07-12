import pool from '@shared/db/connection'
import { assertSchemaName } from '@shared/field-config'
import { InterfaceVitrineRow, FieldConfigInput } from './interface-fields.interface'

/**
 * SQL do painel de campos configuráveis. Catálogo em setes_central;
 * contrato comercial e especialização no schema do cliente (cross-schema).
 */

/**
 * Vitrine (decisão 6): TODAS as interfaces do produto, marcando as
 * adquiridas e os módulos do cliente que as contêm (filtros por nome/módulo).
 */
export async function listVitrine(
  schemaName: string, institutionId: number, filter: string
): Promise<InterfaceVitrineRow[]> {
  assertSchemaName(schemaName)
  const like = `%${filter}%`
  const [rows] = await pool.query<any[]>(
    `SELECT i.id,
            i.description,
            i.i18n_key AS i18nKey,
            CASE WHEN ihi.tb_interface_id IS NULL THEN 'N' ELSE 'S' END AS acquired,
            (SELECT GROUP_CONCAT(m.description ORDER BY m.description SEPARATOR ', ')
               FROM \`${schemaName}\`.tb_module_has_interface mhi
               JOIN \`${schemaName}\`.tb_module m
                 ON m.id = mhi.tb_module_id AND m.deleted = 'N'
              WHERE mhi.tb_interface_id = i.id
                AND mhi.deleted = 'N' AND mhi.active = 'S') AS moduleNames
       FROM setes_central.tb_interface i
       LEFT JOIN \`${schemaName}\`.tb_institution_has_interface ihi
         ON ihi.tb_interface_id = i.id
        AND ihi.tb_institution_id = ?
        AND ihi.active = 'S' AND ihi.deleted = 'N'
      WHERE i.deleted = 'N'
        AND (? = '' OR i.description LIKE ?)
      ORDER BY i.description`,
    [institutionId, filter, like]
  )
  return rows as InterfaceVitrineRow[]
}

export async function interfaceExists(interfaceId: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM setes_central.tb_interface WHERE id = ? AND deleted = 'N'`,
    [interfaceId]
  )
  return rows.length > 0
}

/** Interface adquirida pelo institution? (contrato comercial — decisão 6). */
export async function isInterfaceAcquired(
  schemaName: string, institutionId: number, interfaceId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM \`${schemaName}\`.tb_institution_has_interface
      WHERE tb_institution_id = ? AND tb_interface_id = ?
        AND active = 'S' AND deleted = 'N'`,
    [institutionId, interfaceId]
  )
  return rows.length > 0
}

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
