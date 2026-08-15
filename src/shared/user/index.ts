import pool from '@shared/db/connection'
import { PoolConnection } from 'mysql2/promise'
import { nextEntityId, insertEntity } from '@shared/entity/entity.repository'

/**
 * Peça `user` — nascimento de uma CREDENCIAL (entity + tb_user + e-mail de
 * login + vínculo com a institution), em transação única.
 *
 * Promovida de `modules/users/users.repository` em 2026-08-15, quando o
 * onboarding do Estabelecimento passou a criar o primeiro admin do cliente
 * (A2): dois módulos precisam da MESMA cascata e módulo não importa módulo
 * (ARQUITETURA_MODULOS_API.md). Consumidores: `users` (cadastro) e
 * `institutions` (onboarding).
 *
 * Garantias exigidas pelo módulo auth (análise 2026-07-12): e-mail de login
 * ÚNICO no grupo 2, id = MAX+1 da tb_entity, senha JÁ hasheada pelo chamador
 * (@shared/auth/password — nunca na query).
 */

/** tb_mailing_group 'sistema' — o grupo que o login consulta. */
export const LOGIN_GROUP_ID = 2

export interface UserCascadeInput {
  nameCompany: string
  nickTrade:   string
  email:       string
  active:      'S' | 'N'
}

/** Vínculo criado na MESMA transação; `kind` vira o role do JWT. */
export interface UserInstitutionLink {
  institutionId: number
  kind:          string
}

/**
 * Entity que usa o email como LOGIN (grupo 2) — duplicidade: dois usuários
 * com o mesmo email quebrariam o findUserByEmail do auth (LIMIT 1).
 */
export async function findLoginEmailOwner(email: string): Promise<number | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT ehm.tb_entity_id AS id
     FROM setes_central.tb_entity_has_mailing ehm
       INNER JOIN setes_central.tb_mailing m ON m.id = ehm.tb_mailing_id
     WHERE m.email = ?
       AND ehm.tb_mailing_group_id = ${LOGIN_GROUP_ID}
       AND ehm.deleted = 'N' AND m.deleted = 'N'
     LIMIT 1`,
    [email]
  )
  return rows.length > 0 ? Number(rows[0].id) : null
}

/**
 * E-mail de login do entity (diff): garante tb_mailing (reusa pelo UNIQUE,
 * ressuscita soft-deleted, senão MAX+1) + vínculo grupo 2; soft delete dos
 * vínculos de login com OUTRO email.
 */
export async function syncLoginEmail(
  conn: PoolConnection, entityId: number, email: string
): Promise<void> {
  const [found] = await conn.query<any[]>(
    `SELECT id, deleted FROM setes_central.tb_mailing WHERE email = ? FOR UPDATE`,
    [email]
  )
  let mailingId: number
  if (found.length > 0) {
    mailingId = Number(found[0].id)
    if (found[0].deleted === 'S') {
      await conn.query(
        `UPDATE setes_central.tb_mailing SET deleted = 'N', updated_at = NOW() WHERE id = ?`,
        [mailingId]
      )
    }
  } else {
    const [rows] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.tb_mailing FOR UPDATE`
    )
    mailingId = Number(rows[0].nextId)
    await conn.query(
      `INSERT INTO setes_central.tb_mailing (id, email, created_at, updated_at)
       VALUES (?, ?, NOW(), NOW())`,
      [mailingId, email]
    )
  }

  // Login antigo com outro email → soft delete do vínculo (o email fica).
  await conn.query(
    `UPDATE setes_central.tb_entity_has_mailing
     SET deleted = 'S', updated_at = NOW()
     WHERE tb_entity_id = ? AND tb_mailing_group_id = ${LOGIN_GROUP_ID}
       AND tb_mailing_id <> ?`,
    [entityId, mailingId]
  )
  await conn.query(
    `INSERT INTO setes_central.tb_entity_has_mailing
       (tb_entity_id, tb_mailing_id, tb_mailing_group_id, created_at, updated_at, deleted)
     VALUES (?, ?, ${LOGIN_GROUP_ID}, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE deleted = 'N', updated_at = NOW()`,
    [entityId, mailingId]
  )
}

/**
 * entity + user + e-mail de login em transação única. [link] cria o vínculo
 * tb_institution_has_user na MESMA transação (workflow 2026-07-12 — o
 * primeiro admin do cliente nasce já vinculado). Devolve o id.
 */
export async function insertUserCascade(
  input: UserCascadeInput, passwordHash: string,
  link: UserInstitutionLink | null
): Promise<number> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const id = await nextEntityId(conn)
    await insertEntity(conn, id, {
      nameCompany: input.nameCompany, nickTrade: input.nickTrade,
    })
    await conn.query(
      `INSERT INTO setes_central.tb_user (id, password, active, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())`,
      [id, passwordHash, input.active]
    )
    await syncLoginEmail(conn, id, input.email)
    if (link !== null) {
      await conn.query(
        `INSERT INTO setes_central.tb_institution_has_user
           (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted)
         VALUES (?, ?, ?, 'S', NOW(), NOW(), 'N')`,
        [link.institutionId, id, link.kind]
      )
    }
    await conn.commit()
    return id
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}
