import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import {
  ServiceTaxRuleRow, ServiceTaxRuleInput, ServiceTaxRuleLookupRow,
} from './service-tax-rules.interface'
import {
  listServiceTaxRules, getServiceTaxRule, insertServiceTaxRule,
  updateServiceTaxRule, softDeleteServiceTaxRule, listServiceListLookup,
} from './service-tax-rules.repository'

/**
 * Regras do módulo service-tax-rules: escopo SEMPRE da institution do JWT;
 * validações de FK/fato único dentro da transação (400/409); 404 sem vazar;
 * DELETE 409 quando um serviço aponta a regra (D1/D6).
 */

export interface ServiceTaxRuleScope {
  schemaName:    string
  institutionId: number
}

export async function fetchServiceTaxRules(
  query: ListQuery, scope: ServiceTaxRuleScope
): Promise<PagedRows<ServiceTaxRuleRow>> {
  return listServiceTaxRules(query, scope.schemaName, scope.institutionId)
}

export async function fetchServiceTaxRule(
  id: number, scope: ServiceTaxRuleScope
): Promise<ServiceTaxRuleRow> {
  const row = await getServiceTaxRule(id, scope.schemaName, scope.institutionId)
  if (!row) throw new HttpError(404, `Regra de tributação de serviço ${id} não encontrada`)
  return row
}

export async function createServiceTaxRule(
  input: ServiceTaxRuleInput, scope: ServiceTaxRuleScope
): Promise<number> {
  return insertServiceTaxRule(input, scope.schemaName, scope.institutionId)
}

export async function editServiceTaxRule(
  id: number, input: ServiceTaxRuleInput, scope: ServiceTaxRuleScope
): Promise<void> {
  const found = await updateServiceTaxRule(id, input, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Regra de tributação de serviço ${id} não encontrada`)
}

export async function removeServiceTaxRule(
  id: number, scope: ServiceTaxRuleScope
): Promise<void> {
  const found = await softDeleteServiceTaxRule(id, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Regra de tributação de serviço ${id} não encontrada`)
}

export async function fetchServiceListLookup(filter: string): Promise<ServiceTaxRuleLookupRow[]> {
  return listServiceListLookup(filter)
}
