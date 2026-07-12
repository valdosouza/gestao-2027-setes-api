import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { nextEntityId, insertEntity, updateEntity } from '@shared/entity/entity.repository'
import {
  UserListRow, UserRow, UserInput, UserInstitutionGrant, UserInstitutionLink,
} from './users.interface'

/**
 * SQL do cadastro de Usuário — cadeia do LOGIN em setes_central:
 * tb_entity (peça shared, herança por PK) + tb_user + email de login
 * (tb_mailing × tb_entity_has_mailing GRUPO 2 'sistema') +
 * tb_institution_has_user (vínculos). Escrita em transação única.
 */

const LOGIN_GROUP_ID = 2 // tb_mailing_group 'sistema' (auth.repository)

/** [institutionId] null = todos (super); informado = só os vinculados. */
export async function listUsers(
  filter: string, institutionId: number | null
): Promise<UserListRow[]> {
  const like = `%${filter}%`
  const [rows] = await pool.query<any[]>(
    `SELECT u.id,
            COALESCE(e.nick_trade, e.name_company) AS name,
            m.email,
            u.active
     FROM setes_central.tb_user u
       INNER JOIN setes_central.tb_entity e ON e.id = u.id
       LEFT JOIN setes_central.tb_entity_has_mailing ehm
         ON ehm.tb_entity_id = u.id
        AND ehm.tb_mailing_group_id = ${LOGIN_GROUP_ID}
        AND ehm.deleted = 'N'
       LEFT JOIN setes_central.tb_mailing m
         ON m.id = ehm.tb_mailing_id AND m.deleted = 'N'
     WHERE u.deleted = 'N'
       AND (? = '' OR e.nick_trade LIKE ? OR e.name_company LIKE ? OR m.email LIKE ?)
       AND (? IS NULL OR EXISTS (
             SELECT 1 FROM setes_central.tb_institution_has_user ihu
             WHERE ihu.tb_user_id = u.id AND ihu.tb_institution_id = ?
               AND ihu.active = 'S' AND ihu.deleted = 'N'))
     ORDER BY name`,
    [filter, like, like, like, institutionId, institutionId]
  )
  return rows as UserListRow[]
}

/** Usuário tem vínculo ATIVO com a institution? (escopo do admin) */
export async function userLinkedToInstitution(
  userId: number, institutionId: number
): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM setes_central.tb_institution_has_user
     WHERE tb_user_id = ? AND tb_institution_id = ?
       AND active = 'S' AND deleted = 'N'`,
    [userId, institutionId]
  )
  return rows.length > 0
}

export async function getUser(id: number): Promise<UserRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT u.id,
            e.name_company AS nameCompany,
            e.nick_trade   AS nickTrade,
            m.email,
            u.active
     FROM setes_central.tb_user u
       INNER JOIN setes_central.tb_entity e ON e.id = u.id
       LEFT JOIN setes_central.tb_entity_has_mailing ehm
         ON ehm.tb_entity_id = u.id
        AND ehm.tb_mailing_group_id = ${LOGIN_GROUP_ID}
        AND ehm.deleted = 'N'
       LEFT JOIN setes_central.tb_mailing m
         ON m.id = ehm.tb_mailing_id AND m.deleted = 'N'
     WHERE u.id = ? AND u.deleted = 'N'`,
    [id]
  )
  return (rows[0] as UserRow | undefined) ?? null
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
 * Email de login do entity (diff): garante tb_mailing (reusa pelo UNIQUE,
 * ressuscita soft-deleted, senão MAX+1) + vínculo grupo 2; soft delete dos
 * vínculos de login com OUTRO email.
 */
async function syncLoginEmail(
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
 * POST: entity + user + email de login em transação única. [link] cria o
 * vínculo tb_institution_has_user na MESMA transação (workflow 2026-07-12
 * — o primeiro admin do cliente nasce já vinculado). Devolve o id.
 */
export async function insertUserCascade(
  input: UserInput, passwordHash: string,
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

/** PUT: senha só muda quando [passwordHash] vier (null mantém). */
export async function updateUserCascade(
  id: number, input: UserInput, passwordHash: string | null
): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await updateEntity(conn, id, {
      nameCompany: input.nameCompany, nickTrade: input.nickTrade,
    })
    if (passwordHash !== null) {
      await conn.query(
        `UPDATE setes_central.tb_user
         SET password = ?, active = ?, updated_at = NOW() WHERE id = ?`,
        [passwordHash, input.active, id]
      )
    } else {
      await conn.query(
        `UPDATE setes_central.tb_user SET active = ?, updated_at = NOW() WHERE id = ?`,
        [input.active, id]
      )
    }
    await syncLoginEmail(conn, id, input.email)
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function userExists(id: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM setes_central.tb_user WHERE id = ? AND deleted = 'N'`,
    [id]
  )
  return rows.length > 0
}

/** Soft delete (a entity permanece — padrão da casa). */
export async function deleteUser(id: number): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_user SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}

/** Todas as institutions vivas + situação do vínculo do usuário. */
export async function listInstitutionLinks(
  userId: number
): Promise<UserInstitutionGrant[]> {
  const [rows] = await pool.query<any[]>(
    `SELECT i.id AS institutionId,
            e.nick_trade AS name,
            i.schema_name AS schemaName,
            ihu.kind,
            CASE WHEN ihu.tb_user_id IS NOT NULL THEN 'S' ELSE 'N' END AS granted
     FROM setes_central.tb_institution i
       INNER JOIN setes_central.tb_entity e ON e.id = i.id
       LEFT JOIN setes_central.tb_institution_has_user ihu
         ON ihu.tb_institution_id = i.id
        AND ihu.tb_user_id = ?
        AND ihu.active = 'S' AND ihu.deleted = 'N'
     WHERE i.deleted = 'N'
     ORDER BY name`,
    [userId]
  )
  return rows as UserInstitutionGrant[]
}

/** Sincroniza vínculos: concede a lista (com kind), revoga (soft) as demais. */
export async function setInstitutionLinks(
  userId: number, links: UserInstitutionLink[]
): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    if (links.length > 0) {
      const values = links.map(l => [l.institutionId, userId, l.kind])
      await conn.query(
        `INSERT INTO setes_central.tb_institution_has_user
           (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted)
         VALUES ${links.map(() => "(?, ?, ?, 'S', NOW(), NOW(), 'N')").join(', ')}
         ON DUPLICATE KEY UPDATE
           kind = VALUES(kind), active = 'S', deleted = 'N', updated_at = NOW()`,
        values.flat()
      )
      await conn.query(
        `UPDATE setes_central.tb_institution_has_user
         SET active = 'N', updated_at = NOW()
         WHERE tb_user_id = ? AND tb_institution_id NOT IN (?)`,
        [userId, links.map(l => l.institutionId)]
      )
    } else {
      await conn.query(
        `UPDATE setes_central.tb_institution_has_user
         SET active = 'N', updated_at = NOW() WHERE tb_user_id = ?`,
        [userId]
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
