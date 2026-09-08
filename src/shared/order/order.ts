import { PoolConnection } from 'mysql2/promise'
import { assertSchema } from '@shared/db/schema'
import { HttpError } from '@shared/errors/http-error'

/**
 * Peça mínima do BACKBONE do pedido (prompt_negociacao_pedido.md §6 —
 * parecer setes-conceito 2026-09-06): fatos do PEDIDO que várias frentes
 * consomem (negociação, faturamento, futuro limite de crédito/compra).
 * Agnóstica ao ramo: só conhece tb_order, tb_order_item (+ vínculo
 * set_financial) e tb_order_shipping.
 */

/** Pool ou conexão — só o `.query` importa (leituras fora e dentro de transação). */
export type Queryable = Pick<PoolConnection, 'query'>

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

export interface OrderFinancialBase {
  /** Σ itens com financeiro (unit × qtd − desconto, arredondado por item). */
  itemsValue: number
  /** Frete do PEDIDO (tb_order_shipping). */
  freight: number
  /** itemsValue + freight — a base que a NEGOCIAÇÃO enxerga. */
  base: number
}

/**
 * Base financeira do PEDIDO — espelho de `TControllerPedido.valorFinanceiro`
 * do legado (ControllerPedido.pas:1540): itens `set_financial` ≠ 'N' (link
 * ausente = conta) + frete do pedido, SEM impostos e SEM despesas. É contra
 * ela que o parcelamento elaborado é validado (D4/D7); a base da NOTA (com
 * ST/IPI/despesas) só nasce no faturamento.
 */
export async function getOrderFinancialBase(
  db: Queryable, schemaName: string, institutionId: number, orderId: number
): Promise<OrderFinancialBase> {
  const s = assertSchema(schemaName)
  const [items] = await db.query<any[]>(
    `SELECT i.quantity, i.unit_value AS unitValue,
            COALESCE(i.discount_value, 0) AS discountValue,
            COALESCE(l.set_financial, 'S') AS setFinancial
       FROM \`${s}\`.tb_order_item i
       LEFT JOIN \`${s}\`.tb_order_item_tax_rule l
         ON l.tb_institution_id = i.tb_institution_id AND l.tb_order_id = i.tb_order_id
        AND l.terminal = i.terminal AND l.tb_order_item_id = i.id
        AND l.kind COLLATE utf8mb4_unicode_ci = i.kind COLLATE utf8mb4_unicode_ci
        AND l.deleted = 'N'
      WHERE i.tb_order_id = ? AND i.tb_institution_id = ? AND i.terminal = 0
        AND i.deleted = 'N'`,
    [orderId, institutionId]
  )
  const itemsValue = round2(items
    .filter(r => r.setFinancial !== 'N')
    .reduce((sum, r) => sum + round2(Number(r.unitValue) * Number(r.quantity) - Number(r.discountValue)), 0))
  const [ship] = await db.query<any[]>(
    `SELECT COALESCE(SUM(value), 0) AS freight FROM \`${s}\`.tb_order_shipping
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
    [orderId, institutionId]
  )
  const freight = round2(Number(ship[0]?.freight ?? 0))
  return { itemsValue, freight, base: round2(itemsValue + freight) }
}

/**
 * Trava o pedido (FOR UPDATE) e exige que esteja ABERTO — agnóstico ao ramo
 * (por tb_order.status, sem JOIN em tb_order_sale/purchase). 404 se não
 * existe; 409 ORDER_INVOICED se já faturado.
 */
export async function lockOpenOrder(
  conn: PoolConnection, schemaName: string, institutionId: number, orderId: number
): Promise<{ status: string }> {
  const s = assertSchema(schemaName)
  const [rows] = await conn.query<any[]>(
    `SELECT status FROM \`${s}\`.tb_order
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N' FOR UPDATE`,
    [orderId, institutionId]
  )
  if (!rows[0]) throw new HttpError(404, `Pedido ${orderId} não encontrado`, undefined, 'ORDER_NOT_FOUND')
  if (rows[0].status !== 'A') {
    throw new HttpError(409, 'Pedido já faturado — alterações só via financeiro',
      undefined, 'ORDER_INVOICED')
  }
  return { status: String(rows[0].status) }
}
