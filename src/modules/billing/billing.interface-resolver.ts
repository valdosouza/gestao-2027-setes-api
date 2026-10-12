import { Request } from 'express'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'

export type OrderInterfaceKey = 'service-orders' | 'order-returns' | 'orders'

/**
 * Interface do RAMO de um pedido — Q-G22 (cancel: OS × venda) estendida pela
 * Q-G29 (Valdo 2026-09-10): "qualquer privilégio deve existir na tabela
 * específica, depois referenciado como opção na tela, e o código alinhado com o
 * privilégio atribuído à interface". A devolução tem interface própria
 * (`order-returns`, seed 54: FATURAR); quem só tem FATURAR em `orders` não
 * fatura devolução e vice-versa. CANCELAR em `order-returns` entra com a Onda 2
 * (ramo adjust no cancelamento) — hoje a devolução faturada não cancela.
 *
 * D-F32 (F2a, etapa A2 — prompt_apis_fiscais_isoladas.md §22.9): a regra mora na VIEW de política
 * `vw_order_interface` (migration 065, colação fixa na 068) — a MESMA que a nfse-api lê; uma verdade só (antes:
 * `hasServiceOrderCycle` + `getAnchor(includeDeleted)` aqui e o CASE da view lá, duas cópias). Ciclo de OS vivo →
 * 'service-orders'; âncora de devolução, MESMO soft-deletada (D-A31) → 'order-returns'; senão 'orders'. Pedido sem
 * linha em `tb_order` → 'orders' (o default de quem lê a view).
 */
export async function resolveOrderInterface(
  schemaName: string, institutionId: number, orderId: number
): Promise<OrderInterfaceKey> {
  if (!Number.isInteger(orderId) || orderId <= 0) return 'orders'
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT interface_key AS k FROM \`${s}\`.vw_order_interface
      WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0`,
    [institutionId, orderId]
  )
  const k = rows[0]?.k
  return k === 'service-orders' || k === 'order-returns' ? k : 'orders'
}

/** Resolver das rotas do billing: `orderId` vem no corpo. */
export function resolveFromBody(req: Request): Promise<string> {
  const inst = req.institution!
  return resolveOrderInterface(inst.schemaName, inst.institutionId, Number(req.body?.orderId))
}

/** Resolver das rotas `/fiscal/:orderId/*`: o pedido vem na URL. */
export function resolveFromParam(req: Request): Promise<string> {
  const inst = req.institution!
  return resolveOrderInterface(inst.schemaName, inst.institutionId, Number(req.params?.orderId))
}
