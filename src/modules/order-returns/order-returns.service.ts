import { HttpError } from '@shared/errors/http-error'
import { walletSalesmanId } from '@shared/customer-wallet'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import { OrderReturnListRow, OrderReturnFull, OrderReturnLookupRow } from './order-returns.interface'
import {
  listReturns, getReturn, openReturn, updateItemQuantity, removeItem,
  cancelReturn,
  ORDER_RETURN_SEARCH_CRITERIA, listCustomerLookup,
} from './order-returns.repository'

export interface OrderReturnsScope {
  schemaName:    string
  institutionId: number
  userId:        number
  /** quem pergunta — a carteira travada do vendedor vale no lookup de cliente (D-BA34) */
  role?:         string
}

export { ORDER_RETURN_SEARCH_CRITERIA }

/** Critérios da pesquisa avançada servidos ao app (D-BA2) — sem expressão SQL. */
export async function fetchOrderReturnSearchCriteria(): Promise<PublicSearchCriterion[]> {
  return publicCriteria(ORDER_RETURN_SEARCH_CRITERIA)
}

/** D-BA34: a carteira é da PESSOA — vendedor travado só enxerga os seus clientes no lookup. */
export async function fetchCustomerLookup(filter: string, scope: OrderReturnsScope): Promise<OrderReturnLookupRow[]> {
  const salesmanId = await walletSalesmanId({ ...scope, role: scope.role ?? '' })
  return listCustomerLookup(filter, scope.schemaName, scope.institutionId, salesmanId)
}

export async function fetchReturns(
  status: 'A' | 'F' | '', query: ListQuery, scope: OrderReturnsScope
): Promise<PagedRows<OrderReturnListRow>> {
  return listReturns(status, query, scope.schemaName, scope.institutionId)
}

export async function fetchReturn(
  id: number, scope: OrderReturnsScope
): Promise<OrderReturnFull> {
  const ret = await getReturn(id, scope.schemaName, scope.institutionId)
  if (!ret) throw new HttpError(404, `Devolução ${id} não encontrada`)
  return ret
}

export async function createReturn(
  saleOrderId: number, scope: OrderReturnsScope
): Promise<number> {
  return openReturn(saleOrderId, scope.schemaName, scope.institutionId, scope.userId)
}

export async function editItemQuantity(
  orderId: number, itemId: number, quantity: number, scope: OrderReturnsScope
): Promise<void> {
  await updateItemQuantity(orderId, itemId, quantity, scope.schemaName, scope.institutionId)
}

export async function deleteItem(
  orderId: number, itemId: number, scope: OrderReturnsScope
): Promise<void> {
  await removeItem(orderId, itemId, scope.schemaName, scope.institutionId)
}

export async function removeReturn(orderId: number, scope: OrderReturnsScope): Promise<void> {
  await cancelReturn(orderId, scope.schemaName, scope.institutionId)
}
