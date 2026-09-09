import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import {
  ServiceOrderListRow, ServiceOrderFull, OpenOrderInput, OrderItemInput,
  MonthlyRunInput, MonthlyRunReport, InvoiceInput, InvoiceResult,
  ServiceProductLookupRow,
} from './service-orders.interface'
import {
  listOrders, getOrder, openOrder, addItem, updateItem, removeItem,
  cancelOrder, monthlyRun, generateInvoice, listProductsLookup,
} from './service-orders.repository'
import { fifthBusinessDaySuggestion } from './service-orders.calc'

/**
 * Regras do módulo service-orders: escopo SEMPRE da institution do JWT
 * (userId do JWT vai na tb_order); a máquina de estados vive no
 * repositório (lock A/F); a SUGESTÃO de vencimento é serviço puro (DP1 —
 * quem decide é o usuário).
 */

export interface ServiceOrderScope {
  schemaName:    string
  institutionId: number
  userId:        number
}

export async function fetchOrders(
  status: 'A' | 'F' | '', query: ListQuery, scope: ServiceOrderScope
): Promise<PagedRows<ServiceOrderListRow>> {
  return listOrders(status, query, scope.schemaName, scope.institutionId)
}

export async function fetchOrder(
  id: number, scope: ServiceOrderScope
): Promise<ServiceOrderFull> {
  const order = await getOrder(id, scope.schemaName, scope.institutionId)
  if (!order) throw new HttpError(404, `Ordem de serviço ${id} não encontrada`)
  return order
}

export async function createOrder(
  input: OpenOrderInput, scope: ServiceOrderScope
): Promise<number> {
  return openOrder(input, scope.schemaName, scope.institutionId, scope.userId)
}

export async function createItem(
  orderId: number, input: OrderItemInput, scope: ServiceOrderScope
): Promise<number> {
  return addItem(orderId, input, scope.schemaName, scope.institutionId)
}

export async function editItem(
  orderId: number, itemId: number, input: OrderItemInput,
  scope: ServiceOrderScope
): Promise<void> {
  await updateItem(orderId, itemId, input, scope.schemaName, scope.institutionId)
}

export async function deleteItem(
  orderId: number, itemId: number, scope: ServiceOrderScope
): Promise<void> {
  await removeItem(orderId, itemId, scope.schemaName, scope.institutionId)
}

export async function removeOrder(
  orderId: number, scope: ServiceOrderScope
): Promise<void> {
  await cancelOrder(orderId, scope.schemaName, scope.institutionId)
}

export async function runMonthly(
  input: MonthlyRunInput, scope: ServiceOrderScope
): Promise<MonthlyRunReport> {
  return monthlyRun(input, scope.schemaName, scope.institutionId, scope.userId)
}

export async function invoiceOrder(
  orderId: number, input: InvoiceInput, scope: ServiceOrderScope
): Promise<InvoiceResult> {
  return generateInvoice(orderId, input, scope.schemaName, scope.institutionId, scope.userId)
}

export function expirationSuggestion(year: number, month: number): string {
  return fifthBusinessDaySuggestion(year, month)
}

export async function fetchProductsLookup(
  filter: string, scope: ServiceOrderScope
): Promise<ServiceProductLookupRow[]> {
  return listProductsLookup(filter, scope.schemaName, scope.institutionId)
}
