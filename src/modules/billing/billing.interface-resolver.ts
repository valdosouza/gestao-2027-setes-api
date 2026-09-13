import { Request } from 'express'
import { hasServiceOrderCycle } from '@shared/service-order'
import { getAnchor } from '@shared/order-return'

export type OrderInterfaceKey = 'service-orders' | 'order-returns' | 'orders'

/**
 * Interface do RAMO de um pedido — Q-G22 (cancel: OS × venda) estendida pela
 * Q-G29 (Valdo 2026-09-10): "qualquer privilégio deve existir na tabela
 * específica, depois referenciado como opção na tela, e o código alinhado com o
 * privilégio atribuído à interface". A devolução tem interface própria
 * (`order-returns`, seed 54: FATURAR); quem só tem FATURAR em `orders` não
 * fatura devolução e vice-versa. CANCELAR em `order-returns` entra com a Onda 2
 * (ramo adjust no cancelamento) — hoje a devolução faturada não cancela.
 */
export async function resolveOrderInterface(
  schemaName: string, institutionId: number, orderId: number
): Promise<OrderInterfaceKey> {
  if (!Number.isInteger(orderId) || orderId <= 0) return 'orders'
  if (await hasServiceOrderCycle(schemaName, institutionId, orderId)) return 'service-orders'
  if (await getAnchor(schemaName, institutionId, orderId, { includeDeleted: true })) return 'order-returns'   // D-A31
  return 'orders'
}

/** Resolver das rotas do billing: `orderId` vem no corpo. */
export function resolveFromBody(req: Request): Promise<string> {
  const inst = req.institution!
  return resolveOrderInterface(inst.schemaName, inst.institutionId, Number(req.body?.orderId))
}
