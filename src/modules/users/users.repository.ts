import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { ListQuery, PagedRows, SearchCriterion, escapeLike } from '@shared/list'
import { USER_KINDS } from './users.dto'
import { updateEntity } from '@shared/entity/entity.repository'
import {
  UserListRow, InstitutionLookupRow, UserRow, UserInput, UserInstitutionGrant, UserInstitutionLink,
  UserInterfacePrivileges, UserPrivilegeGrant,
} from './users.interface'

// Peça centralizada em @shared/db/schema (2026-08-04).
import { assertSchema } from '@shared/db/schema'
import { HttpError } from '@shared/errors/http-error'
import { passwordSetAt } from '@shared/auth/password'
import { ErrorCodes } from '@shared/errors/error-codes'
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
 * PESQUISA AVANÇADA (prompt_pesquisa_avancada.md — Onda 2 §12, D-BA21/D-BA23/D-BA24):
 * lista branca da lista de usuários. `kind` é atributo do VÍNCULO em foco (alias ihu da
 * query base — só servido com foco, service). `institution` = "pertence a X": a expressão
 * devolve o CONJUNTO das instituições do usuário (shape 'set' → `? IN (…)`), escopada em
 * active/deleted do vínculo; só o Super a recebe.
 */
export const USER_INSTITUTION_IDS =
  `(SELECT uih.tb_institution_id FROM setes_central.tb_institution_has_user uih
     WHERE uih.tb_user_id = u.id AND uih.active = 'S' AND uih.deleted = 'N')`

export const USER_SEARCH_CRITERIA: readonly SearchCriterion[] = [
  { key: 'name', kind: 'text', labelKey: 'search.users.name', expr: ['e.nick_trade', 'e.name_company'] },
  { key: 'email', kind: 'text', labelKey: 'search.users.email', expr: 'm.email' },
  { key: 'kind', kind: 'options', labelKey: 'search.users.kind', expr: 'ihu.kind', options: USER_KINDS },
  { key: 'institution', kind: 'lookup', labelKey: 'search.users.institution', shape: 'set',
    expr: USER_INSTITUTION_IDS, lookup: '/api/users/institution-lookup' },
  // D-PV19/D-UC2: "ativo" é do VÍNCULO em foco (alias ihu da query base); sem foco (Super global) cai na credencial
  { key: 'active', kind: 'bool', labelKey: 'search.users.active', expr: "COALESCE(ihu.active, u.active)", boolValues: ['S', 'N'] },
  { key: 'createdAt', kind: 'date', labelKey: 'search.users.createdAt', expr: 'u.created_at', storage: 'datetime' },
]

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
  // Vínculo EM FOCO (parecer do guardião, Onda 2): o escopo entra na query base como
  // LEFT JOIN 1:1 (PK institution × user) — a coluna `kind` da linha e o critério `kind`
  // são a MESMA expressão (ihu.kind), e nenhum subselect correlacionado sobra.
  // institutionId NULL (Super sem foco) = join vazio: kind NULL, todos os usuários.
  const where =
    `FROM setes_central.tb_user u
       INNER JOIN setes_central.tb_entity e ON e.id = u.id
       LEFT JOIN setes_central.tb_entity_has_mailing ehm
         ON ehm.tb_entity_id = u.id
        AND ehm.tb_mailing_group_id = ${LOGIN_GROUP_ID}
        AND ehm.deleted = 'N'
       LEFT JOIN setes_central.tb_mailing m
         ON m.id = ehm.tb_mailing_id AND m.deleted = 'N'
       LEFT JOIN setes_central.tb_institution_has_user ihu
         ON ihu.tb_user_id = u.id AND ihu.tb_institution_id = ?
        AND ihu.deleted = 'N'
     WHERE u.deleted = 'N'
       AND (? = '' OR e.nick_trade LIKE ? OR e.name_company LIKE ? OR m.email LIKE ?)
       AND (? IS NULL OR ihu.tb_user_id IS NOT NULL)${query.criteria.sql}`
  const params = [institutionId, query.filter, like, like, like, institutionId,
                  ...query.criteria.params]

  const [rows] = await pool.query<any[]>(
    `SELECT u.id,
            COALESCE(e.nick_trade, e.name_company) AS name,
            m.email,
            COALESCE(ihu.active, u.active) AS active,
            ihu.kind
     ${where}
     ORDER BY name, u.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows: rows as UserListRow[], total: Number(count[0].total) }
}

/** Instituições para o critério "instituição" (D-BA24 — lookup do PRÓPRIO módulo, só Super). */
export async function listInstitutionLookup(filter: string): Promise<InstitutionLookupRow[]> {
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT i.id, COALESCE(NULLIF(e.nick_trade, ''), e.name_company) AS name
       FROM setes_central.tb_institution i
       INNER JOIN setes_central.tb_entity e ON e.id = i.id
      WHERE i.deleted = 'N'
        AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ?)
      ORDER BY name, i.id
      LIMIT 50`,
    [like, like, like]
  )
  return rows as InstitutionLookupRow[]
}

/**
 * TODOS os vínculos do usuário, vivos ou adormecidos (estabelecimento + perfil + se está vivo) — o login é GLOBAL
 * (`setes_central.tb_user`). Re-prova do gate adversarial da D-PV11: contar só os vivos deixava o admin de um cliente trocar a senha
 * de quem tinha um vínculo SUPER revogado — e o Super, ao reativá-lo, entregava a conta (o `setInstitutionLinks` revive a linha).
 */
export async function listActiveUserLinks(userId: number): Promise<Array<{ institutionId: number; kind: string; alive: boolean; deleted: boolean }>> {
  const [rows] = await pool.query<any[]>(
    `SELECT tb_institution_id AS institutionId, kind, (active = 'S' AND deleted = 'N') AS alive, (deleted = 'S') AS deleted
       FROM setes_central.tb_institution_has_user
      WHERE tb_user_id = ?`,
    [userId]
  )
  return rows.map(r => ({ institutionId: Number(r.institutionId), kind: String(r.kind ?? ''), alive: Boolean(Number(r.alive)), deleted: Boolean(Number(r.deleted ?? 0)) }))
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

/**
 * Usuário completo. D-PV19/D-UC2: `active` é o do VÍNCULO com `institutionId` (null = sem foco → `active` null; o vínculo
 * soft-deletado também conta como inativo — a linha deleted='S' não é "vivo").
 */
export async function getUser(id: number, institutionId: number | null = null): Promise<UserRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT u.id,
            e.name_company AS nameCompany,
            e.nick_trade   AS nickTrade,
            m.email,
            (u.password IS NOT NULL AND u.password <> '') AS hasCredential,
            CASE WHEN ? IS NULL THEN NULL
                 WHEN ihu.tb_user_id IS NULL THEN 'N'
                 WHEN ihu.active = 'S' AND ihu.deleted = 'N' THEN 'S' ELSE 'N' END AS active
     FROM setes_central.tb_user u
       INNER JOIN setes_central.tb_entity e ON e.id = u.id
       LEFT JOIN setes_central.tb_entity_has_mailing ehm
         ON ehm.tb_entity_id = u.id
        AND ehm.tb_mailing_group_id = ${LOGIN_GROUP_ID}
        AND ehm.deleted = 'N'
       LEFT JOIN setes_central.tb_mailing m
         ON m.id = ehm.tb_mailing_id AND m.deleted = 'N'
       LEFT JOIN setes_central.tb_institution_has_user ihu
         ON ihu.tb_user_id = u.id AND ihu.tb_institution_id = ?
     WHERE u.id = ? AND u.deleted = 'N'`,
    [institutionId, institutionId, id]
  )
  const row = rows[0]
  return row ? ({ ...row, hasCredential: Boolean(Number(row.hasCredential)) } as UserRow) : null
}


/**
 * PUT: [passwordHash] = a 1ª senha de uma conta SEM credencial (A-PV23 — usuário vindo do setes-sync); null mantém. D-PV48: a gravação é
 * CONDICIONAL (`password IS NULL`) — duas edições simultâneas não definem duas vezes; quem chega depois recebe 409 e a transação volta. D-PV19 (D-UC1/D-UC2): o e-mail de login NÃO se regrava (o
 * service já recusou qualquer troca — a credencial é do titular) e "ativo" é o VÍNCULO com [linkInstitutionId] (null = não mexe);
 * `tb_user.active` (a credencial) fica como está. Inativar o vínculo vale NA HORA (D-UC9 — o veredito lê a view viva, sem cache: D-AU8).
 */
export async function updateUserCascade(
  id: number, input: UserInput, passwordHash: string | null, linkInstitutionId: number | null = null
): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await updateEntity(conn, id, {
      nameCompany: input.nameCompany, nickTrade: input.nickTrade,
    })
    if (passwordHash !== null) {
      const [res] = await conn.query<any>(
        `UPDATE setes_central.tb_user SET password = ?, password_set_at = ?, updated_at = NOW()
          WHERE id = ? AND (password IS NULL OR password = '')`,
        [passwordHash, passwordSetAt(), id]
      )
      if (Number(res?.affectedRows ?? 0) !== 1) {
        throw new HttpError(409, 'A credencial deste usuário já existe — só o titular troca a senha, pela recuperação',
          [{ field: 'password', message: 'Senha definida só na criação da credencial (D-PV48)' }], ErrorCodes.PASSWORD_OWNER_ONLY)
      }
    } else {
      await conn.query(`UPDATE setes_central.tb_user SET updated_at = NOW() WHERE id = ?`, [id])
    }
    if (input.active !== undefined && linkInstitutionId !== null) {
      await conn.query(
        `UPDATE setes_central.tb_institution_has_user
            SET active = ?, updated_at = NOW()
          WHERE tb_user_id = ? AND tb_institution_id = ? AND deleted = 'N'`,
        [input.active, id, linkInstitutionId]
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

export async function userExists(id: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM setes_central.tb_user WHERE id = ? AND deleted = 'N'`,
    [id]
  )
  return rows.length > 0
}

// D-PV19/D-UC1 (2026-10-20): a credencial NUNCA é excluída (nem soft delete) — `deleteUser` saiu; inativa-se o vínculo.

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

/** `excludedKeys` (D-PV5): interfaces que o cadastro de privilégios não oferece — a lista é do service. */
export async function listUserPrivileges(
  schemaName: string, institutionId: number, userId: number, excludedKeys: readonly string[]
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
        AND i.i18n_key NOT IN (?)
      ORDER BY i.description, p.id`,
    [userId, institutionId, excludedKeys.length > 0 ? excludedKeys : ['']]
  )

  return groupByInterface(rows)
}

/** Linhas (interface × privilégio × concedido) → uma entrada por interface, na ordem da consulta. */
function groupByInterface(rows: any[]): UserInterfacePrivileges[] {
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

/**
 * D-PV11 (Valdo 2026-10-18): telas do grupo Super DELEGÁVEIS (fora do contrato — tela do Super não é vendida), com o catálogo
 * de privilégios delas e o que o usuário já tem. Só o SUPER vê e marca (o service decide quem chama).
 */
export async function listDelegableSuperPrivileges(
  schemaName: string, userId: number, keys: readonly string[]
): Promise<UserInterfacePrivileges[]> {
  if (keys.length === 0) return []
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT i.id            AS interfaceId,
            i.description,
            i.i18n_key      AS i18nKey,
            i.group_default AS groupDefault,
            NULL            AS moduleNames,
            p.id            AS privilegeId,
            p.description   AS privilegeDescription,
            CASE WHEN uhp.tb_user_id IS NULL THEN 'N' ELSE 'S' END AS granted
       FROM setes_central.tb_interface i
       INNER JOIN setes_central.tb_interface_has_privilege ihp
         ON ihp.tb_interface_id = i.id AND ihp.active = 'S' AND ihp.deleted = 'N'
       INNER JOIN setes_central.tb_privilege p
         ON p.id = ihp.tb_privilege_id AND p.deleted = 'N'
       LEFT JOIN \`${s}\`.tb_user_has_privilege uhp
         ON uhp.tb_user_id = ? AND uhp.tb_interface_id = i.id AND uhp.tb_privilege_id = p.id
        AND uhp.active = 'S' AND uhp.deleted = 'N'
      WHERE i.deleted = 'N' AND i.i18n_key IN (?)
      ORDER BY i.description, p.id`,
    [userId, keys]
  )
  return groupByInterface(rows)
}

/**
 * Interface do catálogo central PELO ID, viva ou excluída (null = o id não existe). Gate socrático da D-PV11: com o filtro
 * `deleted = 'N'` aqui, soft-deletar a tela delegável (o gesto natural do Super para "desligar a delegação") fazia a trava do
 * service ser pulada — o service decide com a chave E o estado.
 */
export async function findInterfaceKey(interfaceId: number): Promise<{ key: string | null; deleted: boolean } | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT i18n_key AS i18nKey, deleted FROM setes_central.tb_interface WHERE id = ? LIMIT 1`,
    [interfaceId]
  )
  return rows[0] ? { key: rows[0].i18nKey ?? null, deleted: rows[0].deleted === 'S' } : null
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
