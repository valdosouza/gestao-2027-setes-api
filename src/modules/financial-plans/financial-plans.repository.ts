import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { parentIdFromPath } from '@shared/tree-path'
import {
  FinancialPlanRow, FinancialPlanCreateInput, FinancialPlanUpdateInput,
} from './financial-plans.interface'

/**
 * Repositório de tb_financial_plans (SCHEMA DO CLIENTE — árvore ÚNICA por
 * posit_level materializado; molde categories.repository). A MATEMÁTICA do
 * caminho vive em @shared/tree-path (service injeta) — aqui só SQL.
 * `source_` mantém o nome legado no banco; no JSON vira `source`.
 */

const SELECT_FIELDS = `p.id, p.description, p.posit_level AS positLevel,
            p.source_ AS source, p.kind, p.cluster, p.active`

function toRow(raw: any): FinancialPlanRow {
  return { ...raw, parentId: parentIdFromPath(raw.positLevel) }
}

/** Defaults do Delphi (radios em ItemIndex 0): Credora/Custo/Sintética. */
const PLAN_FIELDS = (input: FinancialPlanCreateInput) => [
  input.description,
  input.source ?? 'C',
  input.kind ?? 'C',
  input.cluster ?? 'S',
  input.active ?? 'S',
]

/** Lista ORDENADA pelo caminho (a ordem já é a da árvore). */
export async function listFinancialPlans(
  filter: string, schemaName: string, institutionId: number
): Promise<FinancialPlanRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT ${SELECT_FIELDS}
     FROM ?? p
     WHERE p.tb_institution_id = ? AND p.deleted = 'N'
       AND (? IS NULL OR p.description LIKE ?)
     ORDER BY p.posit_level`,
    [`${schemaName}.tb_financial_plans`, institutionId, like, like]
  )
  return rows.map(toRow)
}

export async function getFinancialPlan(
  id: number, schemaName: string, institutionId: number
): Promise<FinancialPlanRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT ${SELECT_FIELDS}
     FROM ?? p
     WHERE p.id = ? AND p.tb_institution_id = ? AND p.deleted = 'N'`,
    [`${schemaName}.tb_financial_plans`, id, institutionId]
  )
  return rows[0] ? toRow(rows[0]) : null
}

/** Tem subníveis vivos? (bloqueia a exclusão — padrão do tipo árvore). */
export async function hasChildren(
  positLevel: string, schemaName: string, institutionId: number
): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM ?? WHERE tb_institution_id = ? AND deleted = 'N'
       AND posit_level LIKE ? LIMIT 1`,
    [`${schemaName}.tb_financial_plans`, institutionId, `${positLevel}.%`]
  )
  return rows.length > 0
}

/** Pai validado DENTRO da transação (existe e está vivo — árvore única,
 *  sem checagem de domínio). */
async function lockParent(
  conn: PoolConnection, table: string, institutionId: number, parentId: number
): Promise<string> {
  const [rows] = await conn.query<any[]>(
    `SELECT posit_level AS positLevel FROM ??
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' FOR UPDATE`,
    [table, parentId, institutionId]
  )
  if (!rows[0]) {
    throw new HttpError(400, 'Conta pai não encontrada',
      [{ field: 'parentId', message: 'Nível superior inexistente' }])
  }
  return String(rows[0].positLevel)
}

/**
 * Insere com id MAX+1 POR INSTITUTION e posit_level calculado na criação
 * (caminho do pai + código — Delphi Pc_DefineNivel). Tudo na transação.
 */
export async function insertFinancialPlan(
  input: FinancialPlanCreateInput,
  buildPath: (parentPath: string | null, id: number) => string,
  schemaName: string, institutionId: number
): Promise<number> {
  const table = `${schemaName}.tb_financial_plans`
  const conn  = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const parentPath = input.parentId != null
      ? await lockParent(conn, table, institutionId, input.parentId)
      : null

    const [rows] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM ??
        WHERE tb_institution_id = ? FOR UPDATE`,
      [table, institutionId]
    )
    const id = Number(rows[0].nextId)

    await conn.query(
      `INSERT INTO ?? (id, tb_institution_id, description, posit_level,
         source_, kind, cluster, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [table, id, institutionId,
       input.description, buildPath(parentPath, id),
       input.source ?? 'C', input.kind ?? 'C', input.cluster ?? 'S',
       input.active ?? 'S']
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
 * Atualiza os atributos e, se [newParentId] difere do pai atual, MOVE a
 * subárvore inteira (troca do prefixo do posit_level em transação —
 * padrão do tipo árvore; validações de ciclo via [computeNewPath]).
 */
export async function updateFinancialPlanTree(
  id: number,
  input: FinancialPlanUpdateInput,
  newParentId: number | null | undefined,
  computeNewPath: (currentPath: string, parentPath: string | null) => string | null,
  schemaName: string, institutionId: number
): Promise<void> {
  const table = `${schemaName}.tb_financial_plans`
  const conn  = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query<any[]>(
      `SELECT posit_level AS positLevel FROM ??
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' FOR UPDATE`,
      [table, id, institutionId]
    )
    if (!rows[0]) throw new HttpError(404, `Conta ${id} não encontrada`)
    const currentPath = String(rows[0].positLevel)

    // undefined = app não pediu movimento; null = mover para a raiz
    if (newParentId !== undefined) {
      const parentPath = newParentId != null
        ? await lockParent(conn, table, institutionId, newParentId)
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
      `UPDATE ?? SET description = ?, source_ = ?, kind = ?, cluster = ?,
         active = ?, updated_at = NOW()
       WHERE id = ? AND tb_institution_id = ?`,
      [table, ...PLAN_FIELDS(input), id, institutionId]
    )

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function deleteFinancialPlan(
  id: number, schemaName: string, institutionId: number
): Promise<void> {
  await pool.query(
    `UPDATE ?? SET deleted = 'S', updated_at = NOW()
      WHERE id = ? AND tb_institution_id = ?`,
    [`${schemaName}.tb_financial_plans`, id, institutionId]
  )
}
