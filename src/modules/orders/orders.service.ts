import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import {
  OrderListRow, OrderFull, OpenOrderInput, OrderItemInput,
  OrderProductLookupRow,
} from './orders.interface'
import {
  listOrders, getOrder, openOrder, addItem, updateItem, removeItem,
  cancelOrder, listProductsLookup,
} from './orders.repository'

export interface OrdersScope {
  schemaName:    string
  institutionId: number
  userId:        number
}

export async function fetchOrders(
  status: 'A' | 'F' | '', query: ListQuery, scope: OrdersScope
): Promise<PagedRows<OrderListRow>> {
  return listOrders(status, query, scope.schemaName, scope.institutionId)
}

export async function fetchOrder(id: number, scope: OrdersScope): Promise<OrderFull> {
  const order = await getOrder(id, scope.schemaName, scope.institutionId)
  if (!order) throw new HttpError(404, `Pedido ${id} não encontrado`)
  return order
}

export async function createOrder(input: OpenOrderInput, scope: OrdersScope): Promise<number> {
  return openOrder(input, scope.schemaName, scope.institutionId, scope.userId)
}

export async function createItem(
  orderId: number, input: OrderItemInput, scope: OrdersScope
): Promise<number> {
  return addItem(orderId, input, scope.schemaName, scope.institutionId)
}

export async function editItem(
  orderId: number, itemId: number, input: OrderItemInput, scope: OrdersScope
): Promise<void> {
  await updateItem(orderId, itemId, input, scope.schemaName, scope.institutionId)
}

export async function deleteItem(
  orderId: number, itemId: number, scope: OrdersScope
): Promise<void> {
  await removeItem(orderId, itemId, scope.schemaName, scope.institutionId)
}

export async function removeOrder(orderId: number, scope: OrdersScope): Promise<void> {
  await cancelOrder(orderId, scope.schemaName, scope.institutionId)
}

export async function fetchProductsLookup(
  branch: 'merchandise' | 'service', filter: string, scope: OrdersScope
): Promise<OrderProductLookupRow[]> {
  return listProductsLookup(branch, filter, scope.schemaName, scope.institutionId)
}
