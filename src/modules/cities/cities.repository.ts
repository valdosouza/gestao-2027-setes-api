import pool from '@shared/db/connection'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { CityRow, CityInput, CityCreateInput } from './cities.interface'

// O JOIN em tb_state é relação de BANCO (stateName para exibição no app) —
// não cria acoplamento de código com o módulo states.

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE
 * (D2) — o filtro por estado (stateId) vale para os dois SELECTs por
 * construção. Desempate por c.id (D8) mantém o OFFSET estável.
 */
export async function listCities(
  query: ListQuery, stateId?: number
): Promise<PagedRows<CityRow>> {
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM setes_central.tb_city c
     LEFT JOIN setes_central.tb_state s ON s.id = c.tb_state_id
     WHERE c.deleted = 'N'
       AND (? IS NULL OR c.name LIKE ?)
       AND (? IS NULL OR c.tb_state_id = ?)`
  const params = [like, like, stateId ?? null, stateId ?? null]

  const [rows] = await pool.query<any[]>(
    `SELECT c.id,
            c.tb_state_id  AS tbStateId,
            c.ibge,
            c.name,
            c.aliq_iss     AS aliqIss,
            c.population,
            c.density,
            c.area,
            s.name         AS stateName
     ${where}
     ORDER BY c.name, c.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

export async function getCity(id: number): Promise<CityRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT c.id, c.tb_state_id AS tbStateId, c.ibge, c.name,
            c.aliq_iss AS aliqIss, c.population, c.density, c.area,
            s.name AS stateName
     FROM setes_central.tb_city c
     LEFT JOIN setes_central.tb_state s ON s.id = c.tb_state_id
     WHERE c.id = ? AND c.deleted = 'N'`,
    [id]
  )
  return rows[0] ?? null
}

/**
 * Verifica se já existe cidade com o id — INCLUINDO registros com deleted='S'.
 * O código da cidade é o código IBGE do município (ex.: Curitiba 4004) e
 * nunca é reaproveitado, mesmo após exclusão lógica (decisão do Valdo, 2026-07-11).
 */
export async function cityIdExists(id: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT id FROM setes_central.tb_city WHERE id = ?`,
    [id]
  )
  return rows.length > 0
}

/**
 * Insere cidade com o id INFORMADO (código IBGE do município) — não há geração
 * sequencial para tb_city (decisão do Valdo, 2026-07-11).
 */
export async function insertCity(input: CityCreateInput): Promise<number> {
  await pool.query(
    `INSERT INTO setes_central.tb_city
       (id, tb_state_id, ibge, name, aliq_iss, population, density, area, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      input.id,
      input.tbStateId,
      input.ibge ?? null,
      input.name,
      input.aliqIss  ?? 0,
      input.population ?? 0,
      input.density  ?? 0,
      input.area     ?? 0,
    ]
  )
  return input.id
}

export async function updateCity(id: number, input: CityInput): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_city
     SET tb_state_id = ?, ibge = ?, name = ?,
         aliq_iss = ?, population = ?, density = ?, area = ?,
         updated_at = NOW()
     WHERE id = ?`,
    [
      input.tbStateId,
      input.ibge ?? null,
      input.name,
      input.aliqIss  ?? 0,
      input.population ?? 0,
      input.density  ?? 0,
      input.area     ?? 0,
      id,
    ]
  )
}

export async function deleteCity(id: number): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_city SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}
