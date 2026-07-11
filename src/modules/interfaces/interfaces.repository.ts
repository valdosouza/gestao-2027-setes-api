import pool from '@shared/db/connection'
import { InterfaceRow, InterfaceInput } from './interfaces.interface'

// =====================================================================
// tb_interface + tb_interface_has_privilege
// ATENÇÃO: GET /api/core/menus também lê tb_interface — este repositório
// só ATENDE o CRUD do Super, sem tocar naquele endpoint.
// =====================================================================

/**
 * Busca os privilégios ativos (deleted='N' e active='S') das interfaces
 * informadas, agregados por interface — alimenta o campo privilegeIds.
 */
async function privilegeIdsByInterface(interfaceIds: number[]): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>()
  if (interfaceIds.length === 0) return map
  const [rows] = await pool.query<any[]>(
    `SELECT tb_interface_id AS interfaceId, tb_privilege_id AS privilegeId
     FROM setes_central.tb_interface_has_privilege
     WHERE deleted = 'N' AND active = 'S' AND tb_interface_id IN (?)
     ORDER BY tb_privilege_id`,
    [interfaceIds]
  )
  for (const row of rows) {
    const list = map.get(row.interfaceId) ?? []
    list.push(row.privilegeId)
    map.set(row.interfaceId, list)
  }
  return map
}

export async function listInterfaces(filter: string): Promise<InterfaceRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT i.id,
            i.group_default AS groupDefault,
            i.i18n_key      AS i18nKey,
            i.description,
            i.kind,
            i.\`position\`
     FROM setes_central.tb_interface i
     WHERE i.deleted = 'N'
       AND (? IS NULL OR i.description LIKE ? OR i.i18n_key LIKE ? OR i.group_default LIKE ?)
     ORDER BY i.description
     LIMIT 200`,
    [like, like, like, like]
  )
  const privileges = await privilegeIdsByInterface(rows.map((r) => r.id))
  return rows.map((row) => ({ ...row, privilegeIds: privileges.get(row.id) ?? [] }))
}

export async function getInterface(id: number): Promise<InterfaceRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT i.id,
            i.group_default AS groupDefault,
            i.i18n_key      AS i18nKey,
            i.description,
            i.kind,
            i.\`position\`
     FROM setes_central.tb_interface i
     WHERE i.id = ? AND i.deleted = 'N'`,
    [id]
  )
  const row = rows[0]
  if (!row) return null
  const privileges = await privilegeIdsByInterface([id])
  return { ...row, privilegeIds: privileges.get(id) ?? [] }
}

/**
 * Insere interface com id gerado MAX(id)+1 (COALESCE p/ tabela vazia) —
 * tb_interface NÃO tem auto_increment e não há padrão externo de código
 * (decisão do Valdo, 2026-07-11).
 */
export async function insertInterface(input: InterfaceInput): Promise<number> {
  const [rows] = await pool.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.tb_interface`
  )
  const id: number = rows[0].nextId
  await pool.query(
    `INSERT INTO setes_central.tb_interface
       (id, group_default, i18n_key, description, kind, \`position\`, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      id,
      input.groupDefault ?? null,
      input.i18nKey      ?? null,
      input.description,
      input.kind         ?? null,
      input.position     ?? null,
    ]
  )
  return id
}

/** Atualiza a interface — o id nunca muda. */
export async function updateInterface(id: number, input: InterfaceInput): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_interface
     SET group_default = ?, i18n_key = ?, description = ?, kind = ?, \`position\` = ?,
         updated_at = NOW()
     WHERE id = ?`,
    [
      input.groupDefault ?? null,
      input.i18nKey      ?? null,
      input.description,
      input.kind         ?? null,
      input.position     ?? null,
      id,
    ]
  )
}

export async function deleteInterface(id: number): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_interface SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}

/**
 * Sincroniza tb_interface_has_privilege com os ids selecionados na tela:
 * selecionados → INSERT ... ON DUPLICATE KEY UPDATE active='S', deleted='N'
 * (reativa vínculo excluído logicamente); não selecionados → deleted='S'.
 */
export async function syncInterfacePrivileges(
  interfaceId: number,
  privilegeIds: number[]
): Promise<void> {
  if (privilegeIds.length > 0) {
    const values = privilegeIds.map(() => `(?, ?, 'S', NOW(), NOW(), 'N')`).join(', ')
    const params = privilegeIds.flatMap((privilegeId) => [interfaceId, privilegeId])
    await pool.query(
      `INSERT INTO setes_central.tb_interface_has_privilege
         (tb_interface_id, tb_privilege_id, active, created_at, updated_at, deleted)
       VALUES ${values}
       ON DUPLICATE KEY UPDATE active = 'S', deleted = 'N', updated_at = NOW()`,
      params
    )
    await pool.query(
      `UPDATE setes_central.tb_interface_has_privilege
       SET deleted = 'S', updated_at = NOW()
       WHERE tb_interface_id = ? AND deleted = 'N' AND tb_privilege_id NOT IN (?)`,
      [interfaceId, privilegeIds]
    )
  } else {
    await pool.query(
      `UPDATE setes_central.tb_interface_has_privilege
       SET deleted = 'S', updated_at = NOW()
       WHERE tb_interface_id = ? AND deleted = 'N'`,
      [interfaceId]
    )
  }
}
