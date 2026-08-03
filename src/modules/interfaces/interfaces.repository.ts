import pool from '@shared/db/connection'
import { ListQuery, PagedRows } from '@shared/list'
import { InterfaceRow, InterfaceInput, InterfaceConfigInput } from './interfaces.interface'

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

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE
 * (D2). Desempate por i.id (D8) mantém o OFFSET estável. Os privilegeIds
 * são agregados só para as linhas da página.
 */
export async function listInterfaces(query: ListQuery): Promise<PagedRows<InterfaceRow>> {
  const like = query.filter ? `%${query.filter}%` : null
  const where =
    `FROM setes_central.tb_interface i
     WHERE i.deleted = 'N'
       AND (? IS NULL OR i.description LIKE ? OR i.i18n_key LIKE ? OR i.group_default LIKE ?)`
  const params = [like, like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT i.id,
            i.group_default AS groupDefault,
            i.i18n_key      AS i18nKey,
            i.description,
            i.kind,
            i.\`position\`
     ${where}
     ORDER BY i.description, i.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  const privileges = await privilegeIdsByInterface(rows.map((r) => r.id))
  return {
    rows:  rows.map((row) => ({ ...row, privilegeIds: privileges.get(row.id) ?? [] })),
    total: Number(count[0].total),
  }
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
      input.kind         ?? 'T',   // coluna NOT NULL (decisão 13)
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
      input.kind         ?? 'T',   // coluna NOT NULL (decisão 13)
      input.position     ?? null,
      id,
    ]
  )
}

/**
 * Upsert de UMA configuração do catálogo (tb_interface_has_config — seção
 * "Configurações" da tela de Interfaces; ressuscita soft-deleted).
 */
export async function upsertInterfaceConfig(
  interfaceId: number, name: string, input: InterfaceConfigInput
): Promise<void> {
  await pool.query(
    `INSERT INTO setes_central.tb_interface_has_config
       (tb_interface_id, name, description, kind, options,
        default_content, scope, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE
       description     = VALUES(description),
       kind            = VALUES(kind),
       options         = VALUES(options),
       default_content = VALUES(default_content),
       scope           = VALUES(scope),
       deleted         = 'N',
       updated_at      = NOW()`,
    [interfaceId, name, input.description, input.kind,
     input.options ?? null, input.defaultContent, input.scope]
  )
}

/** Existe a configuração (não deletada) no catálogo da interface? */
export async function interfaceConfigExists(
  interfaceId: number, name: string
): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM setes_central.tb_interface_has_config
      WHERE tb_interface_id = ? AND name = ? AND deleted = 'N'`,
    [interfaceId, name]
  )
  return rows.length > 0
}

/** Remove (soft) uma configuração do catálogo. */
export async function softDeleteInterfaceConfig(
  interfaceId: number, name: string
): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_interface_has_config
        SET deleted = 'S', updated_at = NOW()
      WHERE tb_interface_id = ? AND name = ?`,
    [interfaceId, name]
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
