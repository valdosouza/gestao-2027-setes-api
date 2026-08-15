import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { updateEntity } from '@shared/entity/entity.repository'
import {
  UserListRow, UserRow, UserInput, UserInstitutionGrant, UserInstitutionLink,
  UserInterfacePrivileges, UserPrivilegeGrant,
} from './users.interface'

// Peça centralizada em @shared/db/schema (2026-08-04).
import { assertSchema } from '@shared/db/schema'
// Nascimento da credencial promovido a @shared/user em 2026-08-15 (A2 — o
// onboarding do Estabelecimento também cria usuário). O módulo REEXPORTA
// para manter estável o contrato do cadastro (service e testes).
import { LOGIN_GROUP_ID, syncLoginEmail, findLoginEmailOwner, insertUserCascade } from '@shared/user'

export { findLoginEmailOwner, insertUserCascade }

/**
 * SQL do cadastro de Usuário — cadeia do LOGIN em setes_central:
 * tb_entity (peça shared, herança por PK) + tb_user + email de login
 * (tb_mailing × tb_entity_has_mailing GRUPO 2 'sistema') +
 * tb_institution_has_user (vínculos). Escrita em transação única.
 */

/**
 * [institutionId] null = todos (super); informado = só os vinculados.
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE
 * (D2) — o escopo por institution vale para os dois SELECTs por construção.
 * Desempate por u.id (D8) mantém o OFFSET estável.
 */
export async function listUsers(
  query: ListQuery, institutionId: number | null
): Promise<PagedRows<UserListRow>> {
  const like = `%${escapeLike(query.filter)}%`
  const where =
    `FROM setes_central.tb_user u
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
               AND ihu.active = 'S' AND ihu.deleted = 'N'))`
  const params = [query.filter, like, like, like, institutionId, institutionId]

  const [rows] = await pool.query<any[]>(
    `SELECT u.id,
            COALESCE(e.nick_trade, e.name_company) AS name,
            m.email,
            u.active,
            (SELECT ihu.kind FROM setes_central.tb_institution_has_user ihu
              WHERE ihu.tb_user_id = u.id AND ihu.tb_institution_id = ?
                AND ihu.active = 'S' AND ihu.deleted = 'N') AS kind
     ${where}
     ORDER BY name, u.id
     LIMIT ? OFFSET ?`,
    [institutionId, ...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows: rows as UserListRow[], total: Number(count[0].total) }
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

/** Schema do institution alvo (super opera cross-schema — decisão 23). */
export async function findInstitutionSchema(institutionId: number): Promise<string | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT schema_name AS schemaName FROM setes_central.tb_institution
     WHERE id = ? AND deleted = 'N'`,
    [institutionId]
  )
  return rows.length > 0 ? String(rows[0].schemaName) : null
}

// ---------------------------------------------------------------------
// Privilégios de acesso (workflow ACL 2026-07-12): interfaces CONTRATADAS
// pelo institution alvo × catálogo de privilégios da interface × concessão
// ao usuário (tb_user_has_privilege no schema do cliente).
// ---------------------------------------------------------------------

export async function listUserPrivileges(
  schemaName: string, institutionId: number, userId: number
): Promise<UserInterfacePrivileges[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT i.id            AS interfaceId,
            i.description,
            i.i18n_key      AS i18nKey,
            i.group_default AS groupDefault,
            (SELECT GROUP_CONCAT(m.description ORDER BY m.description SEPARATOR ', ')
               FROM \`${s}\`.tb_module_has_interface mhi
               JOIN \`${s}\`.tb_module m
                 ON m.id = mhi.tb_module_id AND m.deleted = 'N'
              WHERE mhi.tb_interface_id = i.id
                AND mhi.deleted = 'N' AND mhi.active = 'S') AS moduleNames,
            p.id            AS privilegeId,
            p.description   AS privilegeDescription,
            CASE WHEN uhp.tb_user_id IS NULL THEN 'N' ELSE 'S' END AS granted
       FROM \`${s}\`.tb_institution_has_interface ihi
       INNER JOIN setes_central.tb_interface i
         ON i.id = ihi.tb_interface_id AND i.deleted = 'N'
       INNER JOIN setes_central.tb_interface_has_privilege ihp
         ON ihp.tb_interface_id = i.id AND ihp.active = 'S' AND ihp.deleted = 'N'
       INNER JOIN setes_central.tb_privilege p
         ON p.id = ihp.tb_privilege_id AND p.deleted = 'N'
       LEFT JOIN \`${s}\`.tb_user_has_privilege uhp
         ON uhp.tb_user_id = ?
        AND uhp.tb_interface_id = i.id
        AND uhp.tb_privilege_id = p.id
        AND uhp.active = 'S' AND uhp.deleted = 'N'
      WHERE ihi.tb_institution_id = ? AND ihi.active = 'S' AND ihi.deleted = 'N'
      ORDER BY i.description, p.id`,
    [userId, institutionId]
  )

  const byInterface = new Map<number, UserInterfacePrivileges>()
  for (const row of rows) {
    let entry = byInterface.get(row.interfaceId)
    if (!entry) {
      entry = {
        interfaceId:  Number(row.interfaceId),
        description:  row.description,
        i18nKey:      row.i18nKey,
        groupDefault: row.groupDefault,
        moduleNames:  row.moduleNames,
        privileges:   [],
      }
      byInterface.set(row.interfaceId, entry)
    }
    entry.privileges.push({
      privilegeId: Number(row.privilegeId),
      description: row.privilegeDescription,
      granted:     row.granted as 'S' | 'N',
    } as UserPrivilegeGrant)
  }
  return Array.from(byInterface.values())
}

/** Ids dos privilégios definidos no catálogo para a interface (validação). */
export async function listInterfaceCatalogPrivilegeIds(
  interfaceId: number
): Promise<number[]> {
  const [rows] = await pool.query<any[]>(
    `SELECT tb_privilege_id AS id
     FROM setes_central.tb_interface_has_privilege
     WHERE tb_interface_id = ? AND active = 'S' AND deleted = 'N'`,
    [interfaceId]
  )
  return rows.map(r => Number(r.id))
}

/** Sincroniza a concessão de UMA interface: concede a lista, revoga (soft) o resto. */
export async function setUserPrivileges(
  schemaName: string, userId: number, interfaceId: number, privilegeIds: number[]
): Promise<void> {
  const s = assertSchema(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    if (privilegeIds.length > 0) {
      await conn.query(
        `INSERT INTO \`${s}\`.tb_user_has_privilege
           (tb_user_id, tb_interface_id, tb_privilege_id, active, created_at, updated_at, deleted)
         VALUES ${privilegeIds.map(() => "(?, ?, ?, 'S', NOW(), NOW(), 'N')").join(', ')}
         ON DUPLICATE KEY UPDATE active = 'S', deleted = 'N', updated_at = NOW()`,
        privilegeIds.flatMap(privilegeId => [userId, interfaceId, privilegeId])
      )
      await conn.query(
        `UPDATE \`${s}\`.tb_user_has_privilege
         SET active = 'N', updated_at = NOW()
         WHERE tb_user_id = ? AND tb_interface_id = ? AND tb_privilege_id NOT IN (?)`,
        [userId, interfaceId, privilegeIds]
      )
    } else {
      await conn.query(
        `UPDATE \`${s}\`.tb_user_has_privilege
         SET active = 'N', updated_at = NOW()
         WHERE tb_user_id = ? AND tb_interface_id = ?`,
        [userId, interfaceId]
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
