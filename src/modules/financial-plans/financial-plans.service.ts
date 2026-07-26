import { HttpError } from '@shared/errors/http-error'
import { childPath, parentIdFromPath, isSelfOrDescendant } from '@shared/tree-path'
import {
  FinancialPlanRow, FinancialPlanCreateInput, FinancialPlanUpdateInput,
} from './financial-plans.interface'
import {
  listFinancialPlans, getFinancialPlan, hasChildren,
  insertFinancialPlan, updateFinancialPlanTree, deleteFinancialPlan,
} from './financial-plans.repository'

/**
 * Regras do PLANO DE CONTAS em árvore (padrão do tipo árvore — decisões do
 * Valdo 2026-07-18 no molde categories): posit_level nasce na criação;
 * MOVER de pai recalcula a subárvore em transação (ciclo proibido);
 * excluir BLOQUEADO com subníveis. Árvore única — Natureza/Tipo/Nível são
 * atributos livres por conta (como no Delphi).
 */

/** Escopo do usuário logado — sempre derivado do JWT, nunca do payload. */
export interface FinancialPlanScope {
  schemaName:    string
  institutionId: number
}

export async function fetchFinancialPlans(
  filter: string, scope: FinancialPlanScope
): Promise<FinancialPlanRow[]> {
  return listFinancialPlans(filter, scope.schemaName, scope.institutionId)
}

export async function fetchFinancialPlan(
  id: number, scope: FinancialPlanScope
): Promise<FinancialPlanRow> {
  const row = await getFinancialPlan(id, scope.schemaName, scope.institutionId)
  if (!row) throw new HttpError(404, `Conta ${id} não encontrada`)
  return row
}

export async function createFinancialPlan(
  input: FinancialPlanCreateInput, scope: FinancialPlanScope
): Promise<{ id: number }> {
  const id = await insertFinancialPlan(
    input, childPath, scope.schemaName, scope.institutionId)
  return { id }
}

/** Novo caminho ao mover (null = não moveu) — mesmas regras do categories. */
export function resolveMovedPath(
  id: number, newParentId: number | null
): (currentPath: string, parentPath: string | null) => string | null {
  return (currentPath, parentPath) => {
    if (parentIdFromPath(currentPath) === newParentId) return null // já está lá
    if (newParentId === id) {
      throw new HttpError(400, 'Movimento inválido',
        [{ field: 'parentId', message: 'A conta não pode ser filha dela mesma' }])
    }
    if (parentPath !== null && isSelfOrDescendant(currentPath, parentPath)) {
      throw new HttpError(400, 'Movimento inválido',
        [{ field: 'parentId', message: 'Não é possível mover para um subnível dela mesma' }])
    }
    return childPath(parentPath, id)
  }
}

export async function editFinancialPlan(
  id: number, input: FinancialPlanUpdateInput, scope: FinancialPlanScope
): Promise<void> {
  await updateFinancialPlanTree(
    id, input, input.parentId,
    resolveMovedPath(id, input.parentId ?? null),
    scope.schemaName, scope.institutionId
  )
}

export async function removeFinancialPlan(
  id: number, scope: FinancialPlanScope
): Promise<void> {
  const row = await fetchFinancialPlan(id, scope)
  // Padrão do tipo árvore: só folhas — exclui os filhos primeiro.
  if (await hasChildren(row.positLevel, scope.schemaName, scope.institutionId)) {
    throw new HttpError(409,
      'Conta possui subníveis — exclua os subníveis primeiro')
  }
  await deleteFinancialPlan(id, scope.schemaName, scope.institutionId)
}
