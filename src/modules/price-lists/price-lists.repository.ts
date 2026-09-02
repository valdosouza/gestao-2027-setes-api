import pool from '@shared/db/connection'
import { assertSchemaName } from '@shared/field-config'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { PriceListRow, PriceListInput } from './price-lists.interface'

/**
 * Repositório de Tabelas de Preço (tb_price_list no schema do cliente).
 * id MAX+1 POR INSTITUTION em transação (padrão bank-accounts).
 */

const LIST_FIELDS = `l.id, l.description,
            DATE_FORMAT(l.validity, '%Y-%m-%d') AS validity,
            l.modality, l.published`

/** Lista PAGINADA (shared/list): página + COUNT com a MESMA where. */
export async function listPriceLists(
  query: ListQuery, schemaName: string, institutionId: number
): Promise<PagedRows<PriceListRow>> {
  assertSchemaName(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM \`${schemaName}\`.tb_price_list l
     WHERE l.tb_institution_id = ? AND l.deleted = 'N'
       AND (? IS NULL OR l.description LIKE ?)`
  const params = [institutionId, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT ${LIST_FIELDS}
     ${where}
     ORDER BY l.description, l.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

export async function getPriceList(
  id: number, schemaName: string, institutionId: number
): Promise<PriceListRow | null> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT ${LIST_FIELDS}
     FROM \`${schemaName}\`.tb_price_list l
     WHERE l.id = ? AND l.tb_institution_id = ? AND l.deleted = 'N'`,
    [id, institutionId]
  )
  return rows[0] ?? null
}

const INPUT_FIELDS = (input: PriceListInput) => [
  input.description, input.validity ?? null, input.modality ?? null,
  input.published ?? 'S',
]

export async function insertPriceList(
  input: PriceListInput, schemaName: string, institutionId: number
): Promise<number> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [mx] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId
         FROM \`${schemaName}\`.tb_price_list
        WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId]
    )
    const id = Number(mx[0].nextId)

    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_price_list
         (id, tb_institution_id, description, validity, modality, published,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [id, institutionId, ...INPUT_FIELDS(input)]
    )
    await conn.commit()
    return id
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function updatePriceList(
  id: number, input: PriceListInput, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const [result] = await pool.query<any>(
    `UPDATE \`${schemaName}\`.tb_price_list
        SET description = ?, validity = ?, modality = ?, published = ?,
            updated_at = NOW()
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [...INPUT_FIELDS(input), id, institutionId]
  )
  return result.affectedRows > 0
}

/** Soft delete; os preços (tb_price) da tabela ficam — histórico. A grade
 *  do serviço só mostra tabelas vivas, então a linha some das telas. */
export async function softDeletePriceList(
  id: number, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const [result] = await pool.query<any>(
    `UPDATE \`${schemaName}\`.tb_price_list
        SET deleted = 'S', updated_at = NOW()
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [id, institutionId]
  )
  return result.affectedRows > 0
}
