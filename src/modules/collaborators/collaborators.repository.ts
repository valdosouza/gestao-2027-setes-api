import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { saveEntityFiscalChain, getEntityFiscalFull } from '@shared/entity'
import {
  CollaboratorInput, CollaboratorListRow, CollaboratorFull,
} from './collaborators.interface'

/**
 * Repositório do CONCRETO Collaborator — CONSUMIDOR da cadeia de entidade
 * fiscal compartilhada (skill cadastro-entidade-fiscal.md). A cadeia vive em
 * setes_central; a tb_collaborator vive no SCHEMA DO CLIENTE (migration 008)
 * com PK composta (id, tb_institution_id) — todas as queries filtram pela
 * institution do JWT. Identificadores de schema entram via ?? (escape de
 * identifier do mysql2).
 */

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export async function listCollaborators(
  filter: string, schemaName: string, institutionId: number
): Promise<CollaboratorListRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT c.id,
            e.nick_trade   AS nickTrade,
            e.name_company AS nameCompany,
            c.active
     FROM ?? c
     INNER JOIN setes_central.tb_entity e ON e.id = c.id
     WHERE c.tb_institution_id = ? AND c.deleted = 'N'
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ?)
     ORDER BY e.nick_trade
     LIMIT 200`,
    [`${schemaName}.tb_collaborator`, institutionId, like, like, like]
  )
  return rows
}

/** Objeto COMPLETO: cadeia compartilhada + tb_collaborator.
 *  DATE_FORMAT nas datas (senão o driver devolve Date com timezone). */
export async function getCollaborator(
  id: number, schemaName: string, institutionId: number
): Promise<CollaboratorFull | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT DATE_FORMAT(c.dt_admission, '%Y-%m-%d')   AS dtAdmission,
            DATE_FORMAT(c.dt_resignation, '%Y-%m-%d') AS dtResignation,
            c.salary,
            c.fathers_name         AS fathersName,
            c.mothers_name         AS mothersName,
            c.vote_number          AS voteNumber,
            c.vote_zone            AS voteZone,
            c.vote_section         AS voteSection,
            c.military_certificate AS militaryCertificate,
            c.pis,
            c.active
     FROM ?? c
     WHERE c.id = ? AND c.tb_institution_id = ? AND c.deleted = 'N'`,
    [`${schemaName}.tb_collaborator`, id, institutionId]
  )
  if (!rows[0]) return null

  const chain = await getEntityFiscalFull(id)
  if (!chain) return null

  return { ...chain, ...rows[0] }
}

export async function collaboratorExists(
  id: number, schemaName: string, institutionId: number
): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM ?? WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [`${schemaName}.tb_collaborator`, id, institutionId]
  )
  return rows.length > 0
}

// ---------------------------------------------------------------------
// Cascade (transação única) — a cadeia é do shared; a tb_collaborator é daqui
// ---------------------------------------------------------------------

const COLLABORATOR_FIELDS = (input: CollaboratorInput) => [
  input.active ?? 'S',
  input.dtAdmission ?? null, input.dtResignation ?? null,
  input.salary ?? null,
  input.fathersName ?? null, input.mothersName ?? null,
  input.voteNumber ?? null, input.voteZone ?? null, input.voteSection ?? null,
  input.militaryCertificate ?? null, input.pis ?? null,
]

/**
 * POST: cadeia em transação única (reuso por documento — decisões 1 e 9 da
 * Fase 3) + tb_collaborator. Papel duplicado NESTA institution: linha viva →
 * 409 com o id no payload (o app oferece abrir em edição); linha deleted='S'
 * → REVIVE com os dados novos (modelo customers.repository).
 */
export async function insertCollaboratorCascade(
  input: CollaboratorInput, schemaName: string, institutionId: number,
  updatedBy: number | null = null
): Promise<{ id: number; reused: boolean }> {
  const table = `${schemaName}.tb_collaborator`
  const conn  = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const { id, reused } = await saveEntityFiscalChain(conn, null, input, updatedBy)

    const [existing] = await conn.query<any[]>(
      `SELECT deleted FROM ?? WHERE id = ? AND tb_institution_id = ? FOR UPDATE`,
      [table, id, institutionId]
    )
    if (existing.length > 0 && existing[0].deleted === 'N') {
      throw new HttpError(409,
        `Esta entidade já está cadastrada como colaborador deste estabelecimento (id ${id})`,
        [{ field: 'id', message: String(id) }])
    }

    if (existing.length > 0) {
      await conn.query(
        `UPDATE ?? SET active = ?, dt_admission = ?, dt_resignation = ?,
           salary = ?, fathers_name = ?, mothers_name = ?, vote_number = ?,
           vote_zone = ?, vote_section = ?, military_certificate = ?, pis = ?,
           deleted = 'N', updated_at = NOW()
         WHERE id = ? AND tb_institution_id = ?`,
        [table, ...COLLABORATOR_FIELDS(input), id, institutionId]
      )
    } else {
      await conn.query(
        `INSERT INTO ?? (id, tb_institution_id, active, dt_admission,
           dt_resignation, salary, fathers_name, mothers_name, vote_number,
           vote_zone, vote_section, military_certificate, pis,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [table, id, institutionId, ...COLLABORATOR_FIELDS(input)]
      )
    }

    await conn.commit()
    return { id, reused }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** PUT: mesma cascade em transação única. */
export async function updateCollaboratorCascade(
  id: number, input: CollaboratorInput, schemaName: string, institutionId: number,
  updatedBy: number | null = null
): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    await saveEntityFiscalChain(conn, id, input, updatedBy)

    await conn.query(
      `UPDATE ?? SET active = ?, dt_admission = ?, dt_resignation = ?,
         salary = ?, fathers_name = ?, mothers_name = ?, vote_number = ?,
         vote_zone = ?, vote_section = ?, military_certificate = ?, pis = ?,
         updated_at = NOW()
       WHERE id = ? AND tb_institution_id = ?`,
      [`${schemaName}.tb_collaborator`, ...COLLABORATOR_FIELDS(input), id, institutionId]
    )

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Soft delete do PAPEL — a cadeia entity permanece (outros papéis/schemas). */
export async function deleteCollaborator(
  id: number, schemaName: string, institutionId: number
): Promise<void> {
  await pool.query(
    `UPDATE ?? SET deleted = 'S', updated_at = NOW() WHERE id = ? AND tb_institution_id = ?`,
    [`${schemaName}.tb_collaborator`, id, institutionId]
  )
}
