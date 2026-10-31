import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import { privilegeCatalogViolations, assertNoCatalogViolation } from '@shared/auth/privilege-catalog'
import { PrivilegeRow } from './privileges.interface'
import {
  listPrivileges, getPrivilege, insertPrivilege, updatePrivilege, deletePrivilege,
  PRIVILEGE_SEARCH_CRITERIA,
} from './privileges.repository'

export { PRIVILEGE_SEARCH_CRITERIA }

/** Critérios da pesquisa avançada servidos ao app (D-BA2) — sem expressão SQL. */
export async function fetchPrivilegeSearchCriteria(): Promise<PublicSearchCriterion[]> {
  return publicCriteria(PRIVILEGE_SEARCH_CRITERIA)
}

export async function fetchPrivileges(query: ListQuery): Promise<PagedRows<PrivilegeRow>> {
  return listPrivileges(query)
}

export async function fetchPrivilege(id: number): Promise<PrivilegeRow> {
  const row = await getPrivilege(id)
  if (!row) throw new HttpError(404, `Privilégio ${id} não encontrado`)
  return row
}

/**
 * Cria privilégio com id gerado automaticamente (MAX+1 — sem padrão externo
 * tipo BACEN/IBGE, mesma decisão do cadastro de Interfaces — Valdo, 2026-07-11).
 */
export async function createPrivilege(description: string): Promise<{ id: number }> {
  assertNoCatalogViolation(privilegeCatalogViolations(null, description))   // D-PV15: nome consumido não se repete
  const id = await insertPrivilege(description)
  return { id }
}

/** Atualiza a description (o id nunca muda). */
export async function editPrivilege(id: number, description: string): Promise<void> {
  await fetchPrivilege(id) // garante existência
  // D-PV15 (= Q-PV17 (a)): o app compara o privilégio pelo NOME — renomear um consumido esconde o botão de todos
  assertNoCatalogViolation(privilegeCatalogViolations(id, description))
  await updatePrivilege(id, description)
}

export async function removePrivilege(id: number): Promise<void> {
  await fetchPrivilege(id)
  assertNoCatalogViolation(privilegeCatalogViolations(id, null))   // D-PV15: privilégio consumido não sai
  await deletePrivilege(id)
}
