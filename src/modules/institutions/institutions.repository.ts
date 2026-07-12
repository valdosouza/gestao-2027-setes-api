import pool from '@shared/db/connection'
import { saveEntityFiscalChain, getEntityFiscalFull } from '@shared/entity'
import {
  InstitutionInput, InstitutionListRow, InstitutionFull,
} from './institutions.interface'

/**
 * Repositório do CONCRETO Institution — CONSUMIDOR da cadeia de entidade
 * fiscal compartilhada (@shared/entity/entity.repository — skill
 * cadastro-entidade-fiscal.md). Responsabilidades daqui:
 * abrir/fechar a TRANSAÇÃO da cascade, chamar os helpers da cadeia e
 * cuidar da tabela própria (tb_institution) + feature flags do onboarding.
 */

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export async function listInstitutions(filter: string): Promise<InstitutionListRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT i.id,
            e.nick_trade   AS nickTrade,
            e.name_company AS nameCompany,
            i.schema_name  AS schemaName,
            i.active
     FROM setes_central.tb_institution i
     INNER JOIN setes_central.tb_entity e ON e.id = i.id
     WHERE i.deleted = 'N'
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ? OR i.schema_name LIKE ?)
     ORDER BY e.nick_trade
     LIMIT 200`,
    [like, like, like, like]
  )
  return rows
}

/** Objeto COMPLETO: cadeia compartilhada (shared/entity) + tb_institution. */
export async function getInstitution(id: number): Promise<InstitutionFull | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT schema_name AS schemaName, active
     FROM setes_central.tb_institution
     WHERE id = ? AND deleted = 'N'`,
    [id]
  )
  if (!rows[0]) return null

  const chain = await getEntityFiscalFull(id)
  if (!chain) return null

  return { ...chain, schemaName: rows[0].schemaName, active: rows[0].active }
}

/** schema_name é UNIQUE e nunca reaproveitado — verifica INCLUINDO deleted='S'. */
export async function schemaNameExists(schemaName: string): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    'SELECT schema_name FROM setes_central.tb_institution WHERE schema_name = ?',
    [schemaName]
  )
  return rows.length > 0
}

export async function institutionExists(id: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    "SELECT id FROM setes_central.tb_institution WHERE id = ? AND deleted = 'N'",
    [id]
  )
  return rows.length > 0
}

// ---------------------------------------------------------------------
// Cascade (transação única) — a cadeia é do shared; a tb_institution é daqui
// ---------------------------------------------------------------------

/**
 * POST: cadeia inteira em transação única (helpers do shared) + INSERT da
 * tb_institution. A institution nasce active='N' — quem ativa é a migração
 * do schema, DEPOIS do commit (DDL não tem rollback).
 */
export async function insertInstitutionCascade(
  input: InstitutionInput, schemaName: string
): Promise<number> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const id = await saveEntityFiscalChain(conn, null, input)

    await conn.query(
      `INSERT INTO setes_central.tb_institution (id, schema_name, active, created_at, updated_at)
       VALUES (?, ?, 'N', NOW(), NOW())`,
      [id, schemaName]
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

/** PUT: mesma cascade em transação única. schema_name é IMUTÁVEL. */
export async function updateInstitutionCascade(
  id: number, input: InstitutionInput
): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    await saveEntityFiscalChain(conn, id, input)

    if (input.active !== undefined) {
      await conn.query(
        `UPDATE setes_central.tb_institution SET active = ?, updated_at = NOW() WHERE id = ?`,
        [input.active, id]
      )
    }

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function setInstitutionActive(id: number, active: 'S' | 'N'): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_institution SET active = ?, updated_at = NOW() WHERE id = ?`,
    [active, id]
  )
}

/** Soft delete da institution — a cadeia entity permanece. */
export async function deleteInstitution(id: number): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_institution SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}

/**
 * Feature flags padrão do onboarding (gate técnico — decisão 17). Veio do
 * antigo admin.repository quando o cadastro absorveu o onboarding
 * (decisão do Valdo, 2026-07-11).
 */
export async function insertDefaultFlags(institutionId: number): Promise<void> {
  const defaultModules = ['core']
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query<any[]>(
      'SELECT COALESCE(MAX(id), 0) AS maxId FROM setes_central.tb_feature_flag FOR UPDATE'
    )
    let nextId = Number(rows[0].maxId)

    const now    = new Date()
    const values = defaultModules.map(mod => [++nextId, institutionId, mod, true, now, now])

    await conn.query(
      `INSERT INTO setes_central.tb_feature_flag
         (id, tb_institution_id, module_key, enabled, created_at, updated_at)
       VALUES ?`,
      [values]
    )

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}
