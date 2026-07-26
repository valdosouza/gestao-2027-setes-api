import pool from '@shared/db/connection'
import { CfopRow, CfopInput } from './cfop.interface'

/**
 * Repositório de setes_central.tb_cfop (catálogo central — Super).
 * note é BLOB no banco: CAST no SELECT para chegar como texto.
 */

const CFOP_FIELDS = (input: CfopInput) => [
  input.description,
  input.concise ?? null,
  input.register ?? null,
  input.way ?? null,
  input.jurisdiction ?? null,
  input.note ?? null,
  input.active ?? 'S',
]

export async function listCfop(filter: string): Promise<CfopRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT c.id, c.description, c.concise, c.register, c.way,
            c.jurisdiction, CAST(c.note AS CHAR) AS note, c.active
     FROM setes_central.tb_cfop c
     WHERE c.deleted = 'N'
       AND (? IS NULL OR c.id LIKE ? OR c.description LIKE ? OR c.concise LIKE ?)
     ORDER BY c.id
     LIMIT 200`,
    [like, like, like, like]
  )
  return rows
}

export async function getCfop(id: string): Promise<CfopRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT c.id, c.description, c.concise, c.register, c.way,
            c.jurisdiction, CAST(c.note AS CHAR) AS note, c.active
     FROM setes_central.tb_cfop c
     WHERE c.id = ? AND c.deleted = 'N'`,
    [id]
  )
  return rows[0] ?? null
}

/** Código já usado? INCLUI deleted='S' — código externo nunca é
 *  reaproveitado (padrão countries/BACEN). */
export async function cfopCodeExists(id: string): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    'SELECT id FROM setes_central.tb_cfop WHERE id = ?',
    [id]
  )
  return rows.length > 0
}

export async function insertCfop(id: string, input: CfopInput): Promise<void> {
  await pool.query(
    `INSERT INTO setes_central.tb_cfop
       (id, description, concise, register, way, jurisdiction, note,
        active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [id, ...CFOP_FIELDS(input)]
  )
}

/** Atualiza o CFOP — o código (id) nunca muda. */
export async function updateCfop(id: string, input: CfopInput): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_cfop
        SET description = ?, concise = ?, register = ?, way = ?,
            jurisdiction = ?, note = ?, active = ?, updated_at = NOW()
      WHERE id = ?`,
    [...CFOP_FIELDS(input), id]
  )
}

export async function deleteCfop(id: string): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_cfop SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}
