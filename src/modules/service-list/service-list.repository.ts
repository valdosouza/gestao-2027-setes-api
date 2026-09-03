import pool from '@shared/db/connection'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { ServiceListRow, ServiceListInput } from './service-list.interface'

/** Repositório de setes_central.tb_service_list (catálogo central — Super). */

const FIELDS = `s.id, s.description, s.local_incidence AS localIncidence,
            COALESCE(s.active, 'S') AS active`

/** Lista PAGINADA (shared/list): página + COUNT com a MESMA where. Ordem
 *  numérica pelo item (1.01 … 40.01), não alfabética. */
export async function listServiceList(query: ListQuery): Promise<PagedRows<ServiceListRow>> {
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM setes_central.tb_service_list s
     WHERE s.deleted = 'N'
       AND (? IS NULL OR s.id LIKE ? OR s.description LIKE ?)`
  const params = [like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT ${FIELDS} ${where}
     ORDER BY CAST(SUBSTRING_INDEX(s.id, '.', 1) AS UNSIGNED), s.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

export async function getServiceListItem(id: string): Promise<ServiceListRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT ${FIELDS} FROM setes_central.tb_service_list s
     WHERE s.id = ? AND s.deleted = 'N'`,
    [id]
  )
  return rows[0] ?? null
}

/** Item já usado? INCLUI deleted='S' — código externo nunca é reaproveitado. */
export async function serviceListCodeExists(id: string): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    'SELECT id FROM setes_central.tb_service_list WHERE id = ?', [id]
  )
  return rows.length > 0
}

const INPUT = (input: ServiceListInput) => [
  input.description, input.localIncidence ?? 'P', input.active ?? 'S',
]

export async function insertServiceListItem(id: string, input: ServiceListInput): Promise<void> {
  await pool.query(
    `INSERT INTO setes_central.tb_service_list
       (id, description, local_incidence, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, NOW(), NOW())`,
    [id, ...INPUT(input)]
  )
}

/** Atualiza o item — o código (id) nunca muda. */
export async function updateServiceListItem(id: string, input: ServiceListInput): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_service_list
        SET description = ?, local_incidence = ?, active = ?, updated_at = NOW()
      WHERE id = ?`,
    [...INPUT(input), id]
  )
}

export async function deleteServiceListItem(id: string): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_service_list SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}
