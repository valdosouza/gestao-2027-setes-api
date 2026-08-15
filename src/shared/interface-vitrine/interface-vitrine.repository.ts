import pool from '@shared/db/connection'
import { assertSchemaName } from '@shared/field-config'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { InterfaceVitrineRow } from './interface-vitrine.types'

/**
 * SQL da vitrine de interfaces e do contrato comercial — compartilhado pelos
 * painéis interface-fields (Fase 2) e interface-configs (Framework de
 * Configurações). Catálogo em setes_central; contrato no schema do cliente.
 */

/**
 * Vitrine: TODAS as interfaces do produto, marcando as adquiridas e os
 * módulos do cliente que as contêm (filtros por nome/módulo).
 * PAGINADA (shared/list) UMA vez aqui para os DOIS consumidores
 * (interface-fields e interface-configs): página + COUNT com a MESMA
 * cláusula WHERE (D2); desempate por i.id (D8).
 */
export async function listVitrine(
  query: ListQuery, schemaName: string, institutionId: number
): Promise<PagedRows<InterfaceVitrineRow>> {
  assertSchemaName(schemaName)
  const like = `%${escapeLike(query.filter)}%`
  const where =
    `FROM setes_central.tb_interface i
     LEFT JOIN \`${schemaName}\`.tb_institution_has_interface ihi
       ON ihi.tb_interface_id = i.id
      AND ihi.tb_institution_id = ?
      AND ihi.active = 'S' AND ihi.deleted = 'N'
     WHERE i.deleted = 'N'
       AND (? = '' OR i.description LIKE ?)`
  const params = [institutionId, query.filter, like]

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
     ${where}
     ORDER BY i.description, i.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows: rows as InterfaceVitrineRow[], total: Number(count[0].total) }
}

export async function interfaceExists(interfaceId: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM setes_central.tb_interface WHERE id = ? AND deleted = 'N'`,
    [interfaceId]
  )
  return rows.length > 0
}

/** Interface adquirida pelo institution? (contrato comercial). */
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
