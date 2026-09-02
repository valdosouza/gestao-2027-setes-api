import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import {
  ServiceListRow, ServiceFull, ServiceInput, ServiceLookupRow,
} from './services.interface'
import {
  listServices, getService, insertService, updateService, softDeleteService,
  listCategoriesLookup, listFinancialPlansLookup,
} from './services.repository'

/**
 * Regras do módulo services: escopo SEMPRE da institution do JWT; kind='S'
 * é invariante do repositório (mercadoria é invisível aqui — D5); FKs
 * validadas na transação (400); 404 sem vazar; soft delete livre (usos
 * históricos ficam pelos JOINs).
 */

export interface ServiceScope {
  schemaName:    string
  institutionId: number
}

export async function fetchServices(
  query: ListQuery, scope: ServiceScope
): Promise<PagedRows<ServiceListRow>> {
  return listServices(query, scope.schemaName, scope.institutionId)
}

export async function fetchService(
  id: number, scope: ServiceScope
): Promise<ServiceFull> {
  const service = await getService(id, scope.schemaName, scope.institutionId)
  if (!service) throw new HttpError(404, `Serviço ${id} não encontrado`)
  return service
}

export async function createService(
  input: ServiceInput, scope: ServiceScope
): Promise<number> {
  return insertService(input, scope.schemaName, scope.institutionId)
}

export async function editService(
  id: number, input: ServiceInput, scope: ServiceScope
): Promise<void> {
  const found = await updateService(id, input, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Serviço ${id} não encontrado`)
}

export async function removeService(
  id: number, scope: ServiceScope
): Promise<void> {
  const found = await softDeleteService(id, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Serviço ${id} não encontrado`)
}

export async function fetchCategoriesLookup(
  filter: string, scope: ServiceScope
): Promise<ServiceLookupRow[]> {
  return listCategoriesLookup(filter, scope.schemaName, scope.institutionId)
}

export async function fetchFinancialPlansLookup(
  filter: string, scope: ServiceScope
): Promise<ServiceLookupRow[]> {
  return listFinancialPlansLookup(filter, scope.schemaName, scope.institutionId)
}
