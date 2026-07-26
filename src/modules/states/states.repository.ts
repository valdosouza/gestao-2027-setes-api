import pool from '@shared/db/connection'
import { StateRow, StateInput } from './states.interface'

// O JOIN em tb_country é relação de BANCO (countryName para exibição no
// app) — não cria acoplamento de código com o módulo countries.

export async function listStates(filter: string, countryId?: number): Promise<StateRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT s.id,
            s.tb_country_id AS tbCountryId,
            s.abbreviation,
            s.name,
            s.aliquota,
            c.name          AS countryName
     FROM setes_central.tb_state s
     LEFT JOIN setes_central.tb_country c ON c.id = s.tb_country_id
     WHERE s.deleted = 'N'
       AND (? IS NULL OR s.name LIKE ? OR s.abbreviation LIKE ?)
       AND (? IS NULL OR s.tb_country_id = ?)
     ORDER BY s.name
     LIMIT 200`,
    [like, like, like, countryId ?? null, countryId ?? null]
  )
  return rows
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
