import pool from '@shared/db/connection'
import { assertSchemaName } from '@shared/field-config'
import { CatalogConfigRow, ConfigValueRow } from './interface-config.types'

/**
 * Leitura do Framework de Configurações. O catálogo vive em setes_central;
 * os valores no schema do cliente (FK cross-schema). schemaName vem do JWT
 * e é validado antes de interpolar (mesma defesa do field-config).
 */

/** Catálogo de configurações da interface (setes_central). */
export async function listCatalogConfigs(interfaceId: number): Promise<CatalogConfigRow[]> {
  const [rows] = await pool.query<any[]>(
    `SELECT name, description, kind, options,
            default_content AS defaultContent, scope
       FROM setes_central.tb_interface_has_config
      WHERE tb_interface_id = ? AND deleted = 'N'
      ORDER BY name`,
    [interfaceId]
  )
  return rows as CatalogConfigRow[]
}

/**
 * Valores gravados para a interface no schema do cliente: o da institution
 * (tb_user_id = 0) e os overrides do usuário corrente — só existe linha
 * quando o valor diverge do default (nota de projeto b).
 */
export async function listConfigValues(
  schemaName: string, institutionId: number, interfaceId: number, userId: number
): Promise<ConfigValueRow[]> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT name, tb_user_id AS tbUserId, content
       FROM \`${schemaName}\`.tb_institution_has_config
      WHERE tb_institution_id = ? AND tb_interface_id = ?
        AND tb_user_id IN (0, ?) AND deleted = 'N'`,
    [institutionId, interfaceId, userId]
  )
  return rows as ConfigValueRow[]
}
