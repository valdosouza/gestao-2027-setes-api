import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import { OrderReturnListRow, OrderReturnFull } from './order-returns.interface'
import {
  listReturns, getReturn, openReturn, updateItemQuantity, removeItem,
  cancelReturn,
} from './order-returns.repository'

export interface OrderReturnsScope {
  schemaName:    string
  institutionId: number
  userId:        number
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
