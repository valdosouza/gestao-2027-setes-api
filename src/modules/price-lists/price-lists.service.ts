import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import { PriceListRow, PriceListInput } from './price-lists.interface'
import {
  listPriceLists, getPriceList, insertPriceList, updatePriceList,
  softDeletePriceList,
} from './price-lists.repository'

/**
 * Regras do módulo price-lists: escopo SEMPRE da institution do JWT;
 * 404 sem vazar existência de outros escopos; soft delete livre (os
 * preços gravados são histórico — a grade só lê tabelas vivas).
 */

export interface PriceListScope {
  schemaName:    string
  institutionId: number
}

export async function fetchPriceLists(
  query: ListQuery, scope: PriceListScope
): Promise<PagedRows<PriceListRow>> {
  return listPriceLists(query, scope.schemaName, scope.institutionId)
}

export async function fetchPriceList(
  id: number, scope: PriceListScope
): Promise<PriceListRow> {
  const row = await getPriceList(id, scope.schemaName, scope.institutionId)
  if (!row) throw new HttpError(404, `Tabela de preço ${id} não encontrada`)
  return row
}

export async function createPriceList(
  input: PriceListInput, scope: PriceListScope
): Promise<number> {
  return insertPriceList(input, scope.schemaName, scope.institutionId)
}

export async function editPriceList(
  id: number, input: PriceListInput, scope: PriceListScope
): Promise<void> {
  const found = await updatePriceList(id, input, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Tabela de preço ${id} não encontrada`)
}

export async function removePriceList(
  id: number, scope: PriceListScope
): Promise<void> {
  const found = await softDeletePriceList(id, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Tabela de preço ${id} não encontrada`)
}
