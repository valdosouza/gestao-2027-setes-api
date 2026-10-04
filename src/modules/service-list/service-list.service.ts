import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import { ServiceListRow, ServiceListInput } from './service-list.interface'
import {
  listServiceList, getServiceListItem, serviceListCodeExists,
  insertServiceListItem, updateServiceListItem, deleteServiceListItem,
  SERVICE_LIST_SEARCH_CRITERIA,
} from './service-list.repository'

/**
 * Regras do módulo service-list: item informado pelo usuário (padrão de
 * código externo, precedente cfop) — 409 se já existir MESMO com
 * deleted='S'; imutável na edição.
 */

export { SERVICE_LIST_SEARCH_CRITERIA }

/** Critérios da pesquisa avançada servidos ao app (D-BA2) — sem expressão SQL. */
export async function fetchServiceListSearchCriteria(): Promise<PublicSearchCriterion[]> {
  return publicCriteria(SERVICE_LIST_SEARCH_CRITERIA)
}

export async function fetchServiceList(query: ListQuery): Promise<PagedRows<ServiceListRow>> {
  return listServiceList(query)
}

export async function fetchServiceListItem(id: string): Promise<ServiceListRow> {
  const row = await getServiceListItem(id)
  if (!row) throw new HttpError(404, `Item ${id} da lista de serviços não encontrado`)
  return row
}

export async function createServiceListItem(
  id: string, input: ServiceListInput
): Promise<{ id: string }> {
  if (await serviceListCodeExists(id)) {
    throw new HttpError(409, `Item ${id} já cadastrado`,
      [{ field: 'id', message: 'Item já utilizado' }])
  }
  await insertServiceListItem(id, input)
  return { id }
}

export async function editServiceListItem(id: string, input: ServiceListInput): Promise<void> {
  await fetchServiceListItem(id)
  await updateServiceListItem(id, input)
}

export async function removeServiceListItem(id: string): Promise<void> {
  await fetchServiceListItem(id)
  await deleteServiceListItem(id)
}
