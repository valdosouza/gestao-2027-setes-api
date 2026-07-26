import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { CategoryRow } from './categories.interface'
import { parentIdFromPath } from '@shared/tree-path'

/**
 * Repositório de tb_category (SCHEMA DO CLIENTE — árvore por posit_level
 * materializado; todas as queries filtram pela institution do JWT).
 * Identificadores de schema via ?? (escape do mysql2). A MATEMÁTICA do
 * caminho (segmento/filho/pai/descendente) vive no service — aqui só SQL.
 */

const SELECT_FIELDS = `c.id, c.description, c.posit_level AS positLevel,
            c.kind, c.active`

function toRow(raw: any): CategoryRow {
  return { ...raw, parentId: parentIdFromPath(raw.positLevel) }
}

/** Lista ORDENADA pelo caminho (a ordem já é a da árvore). */
export async function listCategories(
  filter: string, kind: string | null, schemaName: string, institutionId: number
): Promise<CategoryRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT ${SELECT_FIELDS}
     FROM ?? c
     WHERE c.tb_institution_id = ? AND c.deleted = 'N'
       AND (? IS NULL OR c.kind = ?)
       AND (? IS NULL OR c.description LIKE ?)
     ORDER BY c.posit_level`,
    [`${schemaName}.tb_category`, institutionId, kind, kind, like, like]
  )
  return rows.map(toRow)
}

export async function getCategory(
  id: number, schemaName: string, institutionId: number
): Promise<CategoryRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT ${SELECT_FIELDS}
     FROM ?? c
     WHERE c.id = ? AND c.tb_institution_id = ? AND c.deleted = 'N'`,
    [`${schemaName}.tb_category`, id, institutionId]
  )
  return rows[0] ? toRow(rows[0]) : null
}

/** Tem subníveis vivos? (bloqueia a exclusão — decisão do Valdo). */
export async function hasChildren(
  positLevel: string, schemaName: string, institutionId: number
): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM ?? WHERE tb_institution_id = ? AND deleted = 'N'
       AND posit_level LIKE ? LIMIT 1`,
    [`${schemaName}.tb_category`, institutionId, `${positLevel}.%`]
  )
  return rows.length > 0
}

/** Pai validado DENTRO da transação (existe, vivo, mesma árvore/kind). */
async function lockParent(
  conn: PoolConnection, table: string, institutionId: number,
  parentId: number, kind: string
): Promise<string> {
  const [rows] = await conn.query<any[]>(
    `SELECT posit_level AS positLevel, kind FROM ??
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' FOR UPDATE`,
    [table, parentId, institutionId]
  )
  if (!rows[0]) {
    throw new HttpError(400, 'Categoria pai não encontrada',
      [{ field: 'parentId', message: 'Nível superior inexistente' }])
  }
  if (rows[0].kind !== kind) {
    throw new HttpError(400, 'Nível superior de outro tipo',
      [{ field: 'parentId', message: 'Produto e Serviço não se misturam na mesma árvore' }])
  }
  return String(rows[0].positLevel)
}

/**
 * Insere com id MAX+1 POR INSTITUTION e posit_level calculado na criação
 * (caminho do pai + código — Delphi Pc_DefineNivel). Tudo na transação.
 */
export async function insertCategory(
  input: { description: string; kind: string; parentId?: number | null; active?: string },
  buildPath: (parentPath: string | null, id: number) => string,
  schemaName: string, institutionId: number
): Promise<number> {
  const table = `${schemaName}.tb_category`
  const conn  = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const parentPath = input.parentId != null
      ? await lockParent(conn, table, institutionId, input.parentId, input.kind)
      : null

    const [rows] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM ??
        WHERE tb_institution_id = ? FOR UPDATE`,
      [table, institutionId]
    )
    const id = Number(rows[0].nextId)

    await conn.query(
      `INSERT INTO ?? (id, tb_institution_id, description, posit_level,
         kind, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [table, id, institutionId, input.description,
       buildPath(parentPath, id), input.kind, input.active ?? 'S']
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

/**
 * Atualiza descrição/ativo e, se [newParentId] difere do pai atual, MOVE a
 * subárvore inteira: troca o prefixo do posit_level do nó e de todos os
 * descendentes (decisão do Valdo — mover recalcula em transação).
 * As validações de ciclo/kind vêm prontas do service via [computeNewPath].
 */
export async function updateCategoryTree(
  id: number,
  input: { description: string; active?: string },
  newParentId: number | null | undefined,
  computeNewPath: (currentPath: string, parentPath: string | null) => string | null,
  schemaName: string, institutionId: number
): Promise<void> {
  const table = `${schemaName}.tb_category`
  const conn  = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query<any[]>(
      `SELECT posit_level AS positLevel, kind FROM ??
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' FOR UPDATE`,
      [table, id, institutionId]
    )
    if (!rows[0]) throw new HttpError(404, `Categoria ${id} não encontrada`)
    const currentPath = String(rows[0].positLevel)

    // undefined = app não pediu movimento; null = mover para a raiz
    if (newParentId !== undefined) {
      const parentPath = newParentId != null
        ? await lockParent(conn, table, institutionId, newParentId, rows[0].kind)
        : null
      const newPath = computeNewPath(currentPath, parentPath)
      if (newPath !== null) {
        await conn.query(
          `UPDATE ?? SET posit_level =
             CONCAT(?, SUBSTRING(posit_level, ?)), updated_at = NOW()
           WHERE tb_institution_id = ?
             AND (posit_level = ? OR posit_level LIKE ?)`,
          [table, newPath, currentPath.length + 1, institutionId,
           currentPath, `${currentPath}.%`]
        )
      }
    }

    await conn.query(
      `UPDATE ?? SET description = ?, active = ?, updated_at = NOW()
       WHERE id = ? AND tb_institution_id = ?`,
      [table, input.description, input.active ?? 'S', id, institutionId]
    )

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function deleteCategory(
  id: number, schemaName: string, institutionId: number
): Promise<void> {
  await pool.query(
    `UPDATE ?? SET deleted = 'S', updated_at = NOW()
      WHERE id = ? AND tb_institution_id = ?`,
    [`${schemaName}.tb_category`, id, institutionId]
  )
}
