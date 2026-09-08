import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import {
  OrderListRow, OrderFull, OpenOrderInput, OrderItemInput,
  OrderProductLookupRow, OrderNegotiation, NegotiationInput, OrderBankLookupRow,
} from './orders.interface'
import {
  listOrders, getOrder, openOrder, addItem, updateItem, removeItem,
  cancelOrder, listProductsLookup, getNegotiation, saveNegotiation, listPaymentTypesLookup,
  listBanksLookup,
} from './orders.repository'
import { EnabledPaymentType } from '@shared/payment-types'

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

/** Negociação (prazo × parcelamento elaborado) — 404 se o pedido não é uma venda viva. */
export async function fetchNegotiation(orderId: number, scope: OrdersScope): Promise<OrderNegotiation> {
  const negotiation = await getNegotiation(orderId, scope.schemaName, scope.institutionId)
  if (!negotiation) throw new HttpError(404, `Pedido ${orderId} não encontrado`, undefined, 'ORDER_NOT_FOUND')
  return negotiation
}

/** Lookup das formas vinculadas/habilitadas — cabeçalho e forma por parcela da negociação. */
export async function fetchPaymentTypesLookup(
  filter: string, scope: OrdersScope
): Promise<EnabledPaymentType[]> {
  return listPaymentTypesLookup(filter, scope.schemaName, scope.institutionId)
}

/** Grava e devolve a negociação já recomposta (preview/base atualizados). */
export async function updateNegotiation(
  orderId: number, input: NegotiationInput, scope: OrdersScope
): Promise<OrderNegotiation> {
  await saveNegotiation(orderId, input, scope.schemaName, scope.institutionId)
  return fetchNegotiation(orderId, scope)
}

/** Lookup de bancos (cheques do faturamento) — o módulo do app só fala com /api/orders. */
export async function fetchBanksLookup(filter: string): Promise<OrderBankLookupRow[]> {
  return listBanksLookup(filter)
}
