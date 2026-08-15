import pool from '@shared/db/connection'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { CountryRow } from './countries.interface'

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE
 * (D2). Desempate por id (D8) mantém o OFFSET estável.
 */
export async function listCountries(query: ListQuery): Promise<PagedRows<CountryRow>> {
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM setes_central.tb_country
     WHERE deleted = 'N'
       AND (? IS NULL OR name LIKE ?)`
  const params = [like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT id, name
     ${where}
     ORDER BY name, id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

export async function getCountry(id: number): Promise<CountryRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT id, name FROM setes_central.tb_country WHERE id = ? AND deleted = 'N'`,
    [id]
  )
  return rows[0] ?? null
}

/**
 * Verifica se já existe país com o id — INCLUINDO registros com deleted='S'.
 * O código de país é padrão mundial (BACEN, ex.: Brasil 1058) e nunca é
 * reaproveitado, mesmo após exclusão lógica (decisão do Valdo, 2026-07-10).
 */
export async function countryIdExists(id: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT id FROM setes_central.tb_country WHERE id = ?`,
    [id]
  )
  return rows.length > 0
}

/**
 * Insere país com o id INFORMADO (código BACEN) — não há geração sequencial
 * para tb_country (decisão do Valdo, 2026-07-10).
 */
export async function insertCountry(id: number, name: string): Promise<number> {
  await pool.query(
    `INSERT INTO setes_central.tb_country (id, name, created_at, updated_at)
     VALUES (?, ?, NOW(), NOW())`,
    [id, name]
  )
  return id
}

export async function updateCountry(id: number, name: string): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_country SET name = ?, updated_at = NOW() WHERE id = ?`,
    [name, id]
  )
}

export async function deleteCountry(id: number): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_country SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}
