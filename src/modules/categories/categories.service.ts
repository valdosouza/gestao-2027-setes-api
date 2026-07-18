import { HttpError } from '@shared/errors/http-error'
import {
  CategoryRow, CategoryCreateInput, CategoryUpdateInput,
} from './categories.interface'
import { childPath, parentIdFromPath, isSelfOrDescendant } from './categories.path'
import {
  listCategories, getCategory, hasChildren,
  insertCategory, updateCategoryTree, deleteCategory,
} from './categories.repository'

/**
 * Regras da ÁRVORE de categorias (decisões do Valdo 2026-07-18):
 * - Duas árvores independentes por kind ('P' produtos / 'S' serviços;
 *   abas no app) — kind imutável e pai sempre do MESMO kind.
 * - posit_level nasce na criação (caminho do pai + código) e MOVER de pai
 *   recalcula o caminho da subárvore inteira em transação.
 * - Excluir é BLOQUEADO enquanto houver subníveis (só folhas).
 */

/** Escopo do usuário logado — sempre derivado do JWT, nunca do payload. */
export interface CategoryScope {
  schemaName:    string
  institutionId: number
}

export async function fetchCategories(
  filter: string, kind: string | null, scope: CategoryScope
): Promise<CategoryRow[]> {
  return listCategories(filter, kind, scope.schemaName, scope.institutionId)
}

export async function fetchCategory(
  id: number, scope: CategoryScope
): Promise<CategoryRow> {
  const row = await getCategory(id, scope.schemaName, scope.institutionId)
  if (!row) throw new HttpError(404, `Categoria ${id} não encontrada`)
  return row
}

export async function createCategory(
  input: CategoryCreateInput, scope: CategoryScope
): Promise<{ id: number }> {
  const id = await insertCategory(
    input, childPath, scope.schemaName, scope.institutionId)
  return { id }
}

/**
 * Decide o novo caminho do nó ao mover (null = não moveu). Validações de
 * ciclo aqui (função injetada na transação do repository — o pai já chega
 * validado quanto a existência/kind pelo lockParent).
 */
export function resolveMovedPath(
  id: number, newParentId: number | null
): (currentPath: string, parentPath: string | null) => string | null {
  return (currentPath, parentPath) => {
    if (parentIdFromPath(currentPath) === newParentId) return null // já está lá
    if (newParentId === id) {
      throw new HttpError(400, 'Movimento inválido',
        [{ field: 'parentId', message: 'A categoria não pode ser filha dela mesma' }])
    }
    if (parentPath !== null && isSelfOrDescendant(currentPath, parentPath)) {
      throw new HttpError(400, 'Movimento inválido',
        [{ field: 'parentId', message: 'Não é possível mover para um subnível dela mesma' }])
    }
    return childPath(parentPath, id)
  }
}

export async function editCategory(
  id: number, input: CategoryUpdateInput, scope: CategoryScope
): Promise<void> {
  await updateCategoryTree(
    id,
    { description: input.description, active: input.active },
    input.parentId,
    resolveMovedPath(id, input.parentId ?? null),
    scope.schemaName, scope.institutionId
  )
}

export async function removeCategory(
  id: number, scope: CategoryScope
): Promise<void> {
  const row = await fetchCategory(id, scope)
  // Decisão do Valdo: só folhas — o usuário exclui os filhos primeiro.
  if (await hasChildren(row.positLevel, scope.schemaName, scope.institutionId)) {
    throw new HttpError(409,
      'Categoria possui subníveis — exclua os subníveis primeiro')
  }
  await deleteCategory(id, scope.schemaName, scope.institutionId)
}
