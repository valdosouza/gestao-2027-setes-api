import pool from '@shared/db/connection'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { StateRow, StateInput } from './states.interface'

// O JOIN em tb_country é relação de BANCO (countryName para exibição no
// app) — não cria acoplamento de código com o módulo countries.

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE
 * (D2) — o filtro por país (countryId) vale para os dois SELECTs por
 * construção. Desempate por s.id (D8) mantém o OFFSET estável.
 */
export async function listStates(
  query: ListQuery, countryId?: number
): Promise<PagedRows<StateRow>> {
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM setes_central.tb_state s
     LEFT JOIN setes_central.tb_country c ON c.id = s.tb_country_id
     WHERE s.deleted = 'N'
       AND (? IS NULL OR s.name LIKE ? OR s.abbreviation LIKE ?)
       AND (? IS NULL OR s.tb_country_id = ?)`
  const params = [like, like, like, countryId ?? null, countryId ?? null]

  const [rows] = await pool.query<any[]>(
    `SELECT s.id,
            s.tb_country_id AS tbCountryId,
            s.abbreviation,
            s.name,
            s.aliquota,
            c.name          AS countryName
     ${where}
     ORDER BY s.name, s.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

export async function getState(id: number): Promise<StateRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT s.id, s.tb_country_id AS tbCountryId, s.abbreviation, s.name,
            s.aliquota, c.name AS countryName
     FROM setes_central.tb_state s
     LEFT JOIN setes_central.tb_country c ON c.id = s.tb_country_id
     WHERE s.id = ? AND s.deleted = 'N'`,
    [id]
  )
  return rows[0] ?? null
}

/**
 * Verifica se já existe estado com o id — INCLUINDO registros com deleted='S'.
 * O código do estado é o código IBGE da UF (ex.: Paraná 41, São Paulo 35) e
 * nunca é reaproveitado, mesmo após exclusão lógica (decisão do Valdo, 2026-07-11).
 */
export async function stateIdExists(id: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT id FROM setes_central.tb_state WHERE id = ?`,
    [id]
  )
  return rows.length > 0
}

/**
 * Insere estado com o id INFORMADO (código IBGE da UF) — não há geração
 * sequencial para tb_state (decisão do Valdo, 2026-07-11).
 */
export async function insertState(id: number, input: StateInput): Promise<number> {
  await pool.query(
    `INSERT INTO setes_central.tb_state
       (id, tb_country_id, abbreviation, name, aliquota, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
    [id, input.tbCountryId, input.abbreviation, input.name, input.aliquota ?? null]
  )
  return id
}

export async function updateState(id: number, input: StateInput): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_state
     SET tb_country_id = ?, abbreviation = ?, name = ?, aliquota = ?, updated_at = NOW()
     WHERE id = ?`,
    [input.tbCountryId, input.abbreviation, input.name, input.aliquota ?? null, id]
  )
}

export async function deleteState(id: number): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_state SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}
