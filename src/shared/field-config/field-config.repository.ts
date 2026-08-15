import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { CatalogFieldRow, FieldConfigRow } from './field-config.types'

/**
 * Leitura do framework de campos configuráveis. O catálogo vive em
 * setes_central; a especialização no schema do cliente (FK cross-schema).
 * schemaName vem do JWT e é validado antes de interpolar.
 */

// Peça centralizada em @shared/db/schema (2026-08-04) — import + re-export
// mantém o contrato dos consumidores históricos deste barrel e o uso local.
import { assertSchemaName } from '@shared/db/schema'
export { assertSchemaName }

/** Baseline técnico da interface (catálogo central). */
export async function listCatalogFields(interfaceId: number): Promise<CatalogFieldRow[]> {
  const [rows] = await pool.query<any[]>(
    `SELECT field_name AS fieldName, table_name AS tableName, kind, required
       FROM setes_central.tb_interface_has_field
      WHERE tb_interface_id = ? AND deleted = 'N'
      ORDER BY field_name`,
    [interfaceId]
  )
  return rows as CatalogFieldRow[]
}

/** Especialização do institution para a interface (schema do cliente). */
export async function listFieldConfig(
  schemaName: string, institutionId: number, interfaceId: number
): Promise<FieldConfigRow[]> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT field_name AS fieldName, field_caption AS fieldCaption, required, mask
       FROM \`${schemaName}\`.tb_institution_has_field
      WHERE tb_institution_id = ? AND tb_interface_id = ? AND deleted = 'N'`,
    [institutionId, interfaceId]
  )
  return rows as FieldConfigRow[]
}

/**
 * Interface do módulo pelo i18n_key (= nome do módulo nos dois lados —
 * ARQUITETURA_MODULOS_API.md). null = módulo sem catálogo de campos.
 */
export async function findInterfaceIdByKey(moduleKey: string): Promise<number | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT id FROM setes_central.tb_interface WHERE i18n_key = ? AND deleted = 'N' LIMIT 1`,
    [moduleKey]
  )
  return rows.length > 0 ? Number(rows[0].id) : null
}
