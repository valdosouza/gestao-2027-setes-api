import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import { ModuleRow, ModuleInterfaceLookupRow, MenuScope } from './modules.interface'
import { ModuleBodyDto } from './modules.dto'
import {
  listModules, getModule, listEligibleInterfaces, findIneligibleInterfaceIds,
  insertModuleCascade, updateModuleCascade, deleteModuleCascade,
  MODULE_SEARCH_CRITERIA,
} from './modules.repository'

/**
 * Regra do módulo de Menus (prompt_modulo_menus.md D1–D4): escopo SEMPRE
 * pelo schema do JWT (adminGuard no gateway — o Super atua num cliente
 * trocando de institution). Interface vinculada precisa ser ELEGÍVEL
 * (contratada — contrato do grupo, D-GE22, lido pela chave, D-GE4 — + kind 'T' + fora do Super)
 * → 422 com os ids inválidos.
 */

export { MODULE_SEARCH_CRITERIA }

/** Critérios da pesquisa avançada servidos ao app (D-BA2) — sem expressão SQL. */
export async function fetchModuleSearchCriteria(): Promise<PublicSearchCriterion[]> {
  return publicCriteria(MODULE_SEARCH_CRITERIA)
}

export async function fetchModules(
  schemaName: string, query: ListQuery
): Promise<PagedRows<ModuleRow>> {
  return listModules(schemaName, query)
}

export async function fetchModule(schemaName: string, id: number): Promise<ModuleRow> {
  const row = await getModule(schemaName, id)
  if (!row) throw new HttpError(404, `Módulo de menu ${id} não encontrado`)
  return row
}

export async function fetchEligibleInterfaces(
  scope: MenuScope
): Promise<ModuleInterfaceLookupRow[]> {
  return listEligibleInterfaces(scope.schemaName, scope.institutionId)
}

/**
 * Q5 (decisão do Valdo, 2026-08-15): a elegibilidade barra o que o ADMIN faz,
 * não o que o Super fez pelas costas dele. Id inelegível que JÁ estava vinculado
 * ao módulo (contrato revogado depois do vínculo) é preservado com sua posição —
 * o menu não o expõe (getMenus faz INNER JOIN com o contrato) e a recontratação
 * devolve a tela ao módulo certo sozinha. O 422 fica só para id NOVO no array.
 */
async function assertEligible(
  scope: MenuScope, interfaceIds: number[], alreadyLinked: number[] = []
): Promise<void> {
  const grandfathered = new Set(alreadyLinked)
  const candidates = interfaceIds.filter(id => !grandfathered.has(id))
  const invalid = await findIneligibleInterfaceIds(scope.schemaName, scope.institutionId, candidates)
  if (invalid.length > 0) {
    throw new HttpError(422,
      `Interface(s) não elegível(is) ao menu (não contratada, não-tela ou do grupo Super): ${invalid.join(', ')}`,
      invalid.map(id => ({ field: 'interfaceIds', message: String(id) })),
      ErrorCodes.VALIDATION_FAILED)
  }
}

export async function createModule(
  scope: MenuScope, input: ModuleBodyDto
): Promise<{ id: number }> {
  await assertEligible(scope, input.interfaceIds)
  const id = await insertModuleCascade(scope.schemaName, input)
  return { id }
}

export async function editModule(
  scope: MenuScope, id: number, input: ModuleBodyDto
): Promise<void> {
  const current = await fetchModule(scope.schemaName, id)
  await assertEligible(scope, input.interfaceIds, current.interfaceIds)
  await updateModuleCascade(scope.schemaName, id, input)
}

/**
 * Exclusão graciosa (objetivo 5): sem bloqueio — as telas do módulo VOLTAM
 * ao agrupamento por group_default no menu (getMenus já se comporta assim).
 */
export async function removeModule(schemaName: string, id: number): Promise<void> {
  await fetchModule(schemaName, id)
  await deleteModuleCascade(schemaName, id)
}
