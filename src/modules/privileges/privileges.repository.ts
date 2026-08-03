import pool from '@shared/db/connection'
import { ListQuery, PagedRows } from '@shared/list'
import { PrivilegeRow } from './privileges.interface'

// A lista também alimenta os checkboxes da tela de Interfaces
// (tb_interface_has_privilege — labels = description direto do banco).

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE
 * (D2). Ordenação já é pelo id — sem desempate extra (D8).
 */
export async function listPrivileges(query: ListQuery): Promise<PagedRows<PrivilegeRow>> {
  const like = query.filter ? `%${query.filter}%` : null
  const where =
    `FROM setes_central.tb_privilege
     WHERE deleted = 'N'
       AND (? IS NULL OR description LIKE ?)`
  const params = [like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT id, description
     ${where}
     ORDER BY id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

export async function getPrivilege(id: number): Promise<PrivilegeRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT id, description
     FROM setes_central.tb_privilege
     WHERE id = ? AND deleted = 'N'`,
    [id]
  )
  return rows[0] ?? null
}

/**
 * Insere privilégio com id gerado MAX(id)+1 (COALESCE p/ tabela vazia) —
 * tb_privilege NÃO tem auto_increment e não há padrão externo de código
 * (mesma decisão do cadastro de Interfaces — Valdo, 2026-07-11).
 */
export async function insertPrivilege(description: string): Promise<number> {
  const [rows] = await pool.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.tb_privilege`
  )
  const id: number = rows[0].nextId
  await pool.query(
    `INSERT INTO setes_central.tb_privilege (id, description, created_at, updated_at)
     VALUES (?, ?, NOW(), NOW())`,
    [id, description]
  )
  return id
}

/** Atualiza a description — o id nunca muda. */
export async function updatePrivilege(id: number, description: string): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_privilege
     SET description = ?, updated_at = NOW()
     WHERE id = ?`,
    [description, id]
  )
}

export async function deletePrivilege(id: number): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_privilege SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}
