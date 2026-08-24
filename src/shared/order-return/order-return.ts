import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { HttpError } from '@shared/errors/http-error'

/**
 * Peça compartilhada da DEVOLUÇÃO por item (Q2/Q3/Q4 da rodada 2026-08-24)
 * — equivalente web do controle TB_ITENS_DEV do legado (UN_Fatura_Ajt):
 * um ajuste Entrada ancorado num pedido de venda original
 * (tb_order_stock_adjust_return) tem cada item ligado ao item vendido de
 * origem (tb_order_item_return). O saldo devolvível é DERIVADO (soma dos
 * itens ligados à origem) — nunca coluna.
 *
 * Vendedor: DERIVADO do tb_order_sale da origem (D3 do Valdo — "do jeito
 * que falei fica ambíguo"; a validação de igualdade do legado morre por
 * construção).
 */

export interface OriginalSaleInfo {
  salesmanId: number
  customerId: number
  /** status da tb_order da origem — devolução exige 'F' (decisão 2026-08-24) */
  status: string
}

export interface OriginalSaleItem {
  id: number
  kind: string
  productId: number
  quantity: number
  unitValue: number
  priceListId: number | null
}

/** Tolerância para comparar quantidades derivadas de fontes distintas
 *  (soma float JS × SUM decimal do MySQL) — quantity é decimal(10,4). */
export const QTY_EPSILON = 1e-6

export interface ReturnLink {
  /** item do AJUSTE (devolvido) */
  itemId: number
  itemKind: string
  /** quantidade devolvida (a do próprio item do ajuste) */
  quantity: number
  /** item da VENDA original */
  itemIdOri: number
  kindOri: string
  /** produto e lista da ORIGEM — fonte da alíquota do estorno de comissão */
  productId: number
  priceListIdOri: number | null
}

export interface ReturnIssue {
  itemId?: number
  field: string
  message: string
}

export interface ReturnPlan {
  orderIdOri: number
  salesmanId: number
  customerId: number
  links: ReturnLink[]
}

/**
 * Âncora da devolução (tb_order_stock_adjust_return) de um ajuste — nasce
 * na ABERTURA da devolução (módulo order-returns, parecer 2026-08-24);
 * o billing DERIVA daqui o pedido original (fonte única — o payload não
 * carrega mais returnedOrderId).
 */
export async function getAnchor(
  schemaName: string, institutionId: number, adjustOrderId: number
): Promise<{ orderIdOri: number } | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT tb_order_id_ori AS orderIdOri
       FROM \`${s}\`.tb_order_stock_adjust_return
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
    [adjustOrderId, institutionId]
  )
  return rows[0] ? { orderIdOri: Number(rows[0].orderIdOri) } : null
}

/**
 * Quantidade em devoluções ABERTAS ancoradas na origem, por produto —
 * devolução aberta não RESERVA saldo (decisão 2026-08-24: derivado, sem
 * coluna), mas a pré-carga/detalhe DESCONTA as irmãs abertas para o
 * usuário enxergar o saldo real; o gate final segue sendo o lock do
 * faturamento.
 */
export async function getOpenReturnQuantityByProduct(
  schemaName: string, institutionId: number, orderIdOri: number,
  excludeOrderId?: number
): Promise<Map<number, number>> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT i.tb_product_id AS productId, SUM(i.quantity) AS qty
       FROM \`${s}\`.tb_order_stock_adjust_return r
       JOIN \`${s}\`.tb_order o
         ON (o.id = r.id AND o.tb_institution_id = r.tb_institution_id
             AND o.terminal = r.terminal AND o.deleted = 'N' AND o.status = 'A')
       JOIN \`${s}\`.tb_order_item i
         ON (i.tb_order_id = r.id AND i.tb_institution_id = r.tb_institution_id
             AND i.terminal = r.terminal AND i.deleted = 'N')
      WHERE r.tb_institution_id = ? AND r.tb_order_id_ori = ? AND r.deleted = 'N'
        AND (? IS NULL OR r.id <> ?)
      GROUP BY i.tb_product_id`,
    [institutionId, orderIdOri, excludeOrderId ?? null, excludeOrderId ?? null]
  )
  const map = new Map<number, number>()
  for (const row of rows) map.set(Number(row.productId), Number(row.qty ?? 0))
  return map
}

/** Ordem de VENDA viva (ramo sale) — devolve vendedor/cliente da origem. */
export async function getSaleOrderInfo(
  schemaName: string, institutionId: number, orderId: number
): Promise<OriginalSaleInfo | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT os.tb_salesman_id AS salesmanId, os.tb_customer_id AS customerId,
            o.status
       FROM \`${s}\`.tb_order o
       JOIN \`${s}\`.tb_order_sale os
         ON (os.id = o.id AND os.tb_institution_id = o.tb_institution_id
             AND os.terminal = o.terminal AND os.deleted = 'N')
      WHERE o.id = ? AND o.tb_institution_id = ? AND o.terminal = 0
        AND o.deleted = 'N'`,
    [orderId, institutionId]
  )
  if (!rows[0]) return null
  return {
    salesmanId: Number(rows[0].salesmanId),
    customerId: Number(rows[0].customerId),
    status: String(rows[0].status ?? ''),
  }
}

export async function listOriginalSaleItems(
  schemaName: string, institutionId: number, orderId: number
): Promise<OriginalSaleItem[]> {
  const s = assertSchema(schemaName)
  // tb_price_list_id vive na especialização merchandise desde a migration
  // 013 (achado CRITICAL do gate adversarial 2026-08-24 — o baseline mente)
  const [rows] = await pool.query<any[]>(
    `SELECT i.id, i.kind, i.tb_product_id AS productId, i.quantity,
            i.unit_value AS unitValue, mi.tb_price_list_id AS priceListId
       FROM \`${s}\`.tb_order_item i
       LEFT JOIN \`${s}\`.tb_order_item_merchandise mi
         ON (mi.id = i.id AND mi.tb_institution_id = i.tb_institution_id
             AND mi.tb_order_id = i.tb_order_id AND mi.terminal = i.terminal
             AND mi.deleted = 'N')
      WHERE i.tb_order_id = ? AND i.tb_institution_id = ? AND i.terminal = 0
        AND i.deleted = 'N'`,
    [orderId, institutionId]
  )
  return rows.map(r => ({
    id: Number(r.id), kind: String(r.kind), productId: Number(r.productId),
    quantity: Number(r.quantity ?? 0), unitValue: Number(r.unitValue ?? 0),
    priceListId: r.priceListId === null ? null : Number(r.priceListId),
  }))
}

/** Quantidade JÁ devolvida contra a origem, agregada por PRODUTO (soma da
 *  quantity dos itens de devolução vivos ligados àquele pedido). */
export async function getReturnedQuantityByProduct(
  schemaName: string, institutionId: number, orderIdOri: number
): Promise<Map<number, number>> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT i.tb_product_id AS productId, SUM(i.quantity) AS returned
       FROM \`${s}\`.tb_order_item_return r
       JOIN \`${s}\`.tb_order_item i
         ON (i.id = r.id AND i.tb_institution_id = r.tb_institution_id
             AND i.tb_order_id = r.tb_order_id AND i.terminal = r.terminal
             AND i.kind = r.kind AND i.deleted = 'N')
      WHERE r.tb_institution_id = ? AND r.tb_order_id_ori = ? AND r.deleted = 'N'
      GROUP BY i.tb_product_id`,
    [institutionId, orderIdOri]
  )
  const map = new Map<number, number>()
  for (const row of rows) map.set(Number(row.productId), Number(row.returned ?? 0))
  return map
}

export interface ReturnItemToCheck {
  id: number
  kind: string
  productId: number
  quantity: number
  unitValue: number
}

/**
 * Validação completa da devolução (mesmas regras do Fc_VerificaItemDevolvido
 * do legado, por item): origem existe e é VENDA; mesmo cliente; cada
 * produto do ajuste consta na origem; quantidade ≤ vendida MENOS a já
 * devolvida (acumulado — VerificaExistenciaDevolvido); valor unitário ≤ o
 * da origem. Devolve issues (vazia = ok) + o plano de gravação dos elos
 * (item de origem = o MAIS RECENTE do produto, paridade com o
 * ORDER BY ITF_CODIGO DESC do legado).
 */
export async function buildReturnPlan(
  schemaName: string, institutionId: number, orderIdOri: number,
  adjustEntityId: number, adjustItems: ReturnItemToCheck[]
): Promise<{ issues: ReturnIssue[]; plan: ReturnPlan | null }> {
  const issues: ReturnIssue[] = []

  const sale = await getSaleOrderInfo(schemaName, institutionId, orderIdOri)
  if (!sale) {
    return {
      issues: [{ field: 'returnedOrderId',
        message: `Pedido de venda ${orderIdOri} não encontrado` }],
      plan: null,
    }
  }
  // decisão 2026-08-24 (Q-C/R3): devolução só contra venda FATURADA —
  // sem nota não houve comissão nem financeiro para estornar (o legado
  // validava contra itens de NOTA, não de pedido)
  if (sale.status !== 'F') {
    issues.push({ field: 'returnedOrderId',
      message: `Pedido ${orderIdOri} ainda não foi faturado — devolução exige nota emitida` })
  }
  if (sale.customerId !== adjustEntityId) {
    issues.push({ field: 'returnedOrderId',
      message: `O cliente do ajuste não é o mesmo do pedido ${orderIdOri}` })
  }

  const originals = await listOriginalSaleItems(schemaName, institutionId, orderIdOri)
  const returned = await getReturnedQuantityByProduct(schemaName, institutionId, orderIdOri)

  const links: ReturnLink[] = []
  // R1 do gate socrático 2026-08-24: o saldo lido do banco é congelado —
  // itens IRMÃOS do mesmo plano precisam se acumular, senão 2 itens do
  // mesmo produto passam cada um contra o saldo cheio.
  const plannedByProduct = new Map<number, number>()
  for (const item of adjustItems) {
    const candidates = originals.filter(o => o.productId === item.productId)
    if (candidates.length === 0) {
      issues.push({ itemId: item.id, field: 'product',
        message: `Produto ${item.productId} não consta no pedido original ${orderIdOri}` })
      continue
    }
    const soldQty = candidates.reduce((sum, o) => sum + o.quantity, 0)
    const planned = plannedByProduct.get(item.productId) ?? 0
    const available = soldQty - (returned.get(item.productId) ?? 0) - planned
    if (item.quantity > available + QTY_EPSILON) {
      issues.push({ itemId: item.id, field: 'quantity',
        message: `Quantidade a devolver (${item.quantity}) maior que o saldo devolvível ` +
          `(${available}) do produto ${item.productId} no pedido ${orderIdOri}` })
    }
    plannedByProduct.set(item.productId, planned + item.quantity)
    // item de origem de referência = o mais recente (legado: ITF_CODIGO DESC)
    const origin = candidates.reduce((a, b) => (b.id > a.id ? b : a))
    if (item.unitValue > origin.unitValue) {
      issues.push({ itemId: item.id, field: 'unitValue',
        message: `Valor unitário (${item.unitValue}) maior que o do pedido original ` +
          `(${origin.unitValue}) para o produto ${item.productId}` })
    }
    links.push({
      itemId: item.id, itemKind: item.kind, quantity: item.quantity,
      itemIdOri: origin.id, kindOri: origin.kind,
      productId: item.productId, priceListIdOri: origin.priceListId,
    })
  }

  return {
    issues,
    plan: issues.length === 0
      ? { orderIdOri, salesmanId: sale.salesmanId, customerId: sale.customerId, links }
      : null,
  }
}

/**
 * Revalidação do saldo devolvível DENTRO da transação, sob lock do pedido
 * ORIGINAL (R2 do gate socrático + HIGH do adversarial, 2026-08-24): o
 * buildReturnPlan roda fora da transação e o FOR UPDATE do persistInvoice
 * tranca só o ajuste — sem este lock, duas devoluções concorrentes contra
 * a mesma venda leriam o mesmo saldo e estourariam o vendido. Saldo
 * derivado que serve de GATE é recomputado onde é consumido.
 */
export async function assertReturnableInTx(
  conn: PoolConnection, schemaName: string, institutionId: number,
  adjustOrderId: number, plan: ReturnPlan
): Promise<void> {
  const s = assertSchema(schemaName)
  const [lock] = await conn.query<any[]>(
    `SELECT id, status FROM \`${s}\`.tb_order
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'
      FOR UPDATE`,
    [plan.orderIdOri, institutionId]
  )
  if (!lock[0]) {
    throw new HttpError(422, 'Pedido original não existe mais',
      [{ field: 'returnedOrderId', message: `Pedido ${plan.orderIdOri} não encontrado` }],
      'RETURN_INVALID')
  }
  if (String(lock[0].status ?? '') !== 'F') {
    throw new HttpError(422, 'Pedido original não está faturado',
      [{ field: 'returnedOrderId', message: `Pedido ${plan.orderIdOri} sem nota emitida` }],
      'RETURN_INVALID')
  }

  // R1 do gate socrático 2026-08-24: o PLANO foi montado de um snapshot
  // pré-lock — um PUT/DELETE commitado no meio geraria nota com totais de
  // uma quantidade e item vivo com outra. Sob o lock, os itens VIVOS de
  // mercadoria da devolução precisam bater 1:1 com o plano.
  const [live] = await conn.query<any[]>(
    `SELECT i.id, i.kind, i.quantity
       FROM \`${s}\`.tb_order_item i
       JOIN \`${s}\`.tb_product p
         ON (p.id = i.tb_product_id AND p.tb_institution_id = i.tb_institution_id
             AND p.kind IN ('P', 'M'))
      WHERE i.tb_order_id = ? AND i.tb_institution_id = ? AND i.terminal = 0
        AND i.deleted = 'N'`,
    [adjustOrderId, institutionId]
  )
  const liveByItem = new Map(live.map(r => [`${r.id}|${r.kind}`, Number(r.quantity ?? 0)]))
  const staleness = new HttpError(422,
    'Itens da devolução alterados durante o faturamento — execute a validação novamente',
    [{ field: 'items', message: 'Quantidades mudaram entre a validação e o faturamento' }],
    'REQUIRES_VALIDATION')
  if (liveByItem.size !== plan.links.length) throw staleness
  for (const link of plan.links) {
    const liveQty = liveByItem.get(`${link.itemId}|${link.itemKind}`)
    if (liveQty === undefined || Math.abs(liveQty - link.quantity) > QTY_EPSILON) {
      throw staleness
    }
  }

  const [sold] = await conn.query<any[]>(
    `SELECT tb_product_id AS productId, SUM(quantity) AS qty
       FROM \`${s}\`.tb_order_item
      WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0
        AND deleted = 'N'
      GROUP BY tb_product_id`,
    [plan.orderIdOri, institutionId]
  )
  const [ret] = await conn.query<any[]>(
    `SELECT i.tb_product_id AS productId, SUM(i.quantity) AS returned
       FROM \`${s}\`.tb_order_item_return r
       JOIN \`${s}\`.tb_order_item i
         ON (i.id = r.id AND i.tb_institution_id = r.tb_institution_id
             AND i.tb_order_id = r.tb_order_id AND i.terminal = r.terminal
             AND i.kind = r.kind AND i.deleted = 'N')
      WHERE r.tb_institution_id = ? AND r.tb_order_id_ori = ? AND r.deleted = 'N'
      GROUP BY i.tb_product_id`,
    [institutionId, plan.orderIdOri]
  )
  const soldBy = new Map<number, number>(sold.map(r => [Number(r.productId), Number(r.qty ?? 0)]))
  const retBy = new Map<number, number>(ret.map(r => [Number(r.productId), Number(r.returned ?? 0)]))

  const planBy = new Map<number, number>()
  for (const link of plan.links) {
    planBy.set(link.productId, (planBy.get(link.productId) ?? 0) + link.quantity)
  }
  for (const [productId, qty] of planBy) {
    const available = (soldBy.get(productId) ?? 0) - (retBy.get(productId) ?? 0)
    if (qty > available + QTY_EPSILON) {
      throw new HttpError(422, 'Saldo devolvível excedido — devolução concorrente ou pedido alterado',
        [{ field: 'quantity',
          message: `Produto ${productId}: devolver ${qty} excede o saldo ${available} do pedido ${plan.orderIdOri}` }],
        'RETURN_INVALID')
    }
  }
}

/**
 * Grava os ELOS por item da devolução consumada (transaction-aware).
 * A ÂNCORA já nasceu na ABERTURA (parecer 2026-08-24 — fato gerador é a
 * decisão de devolver, não o faturamento): aqui ela é só VALIDADA — não
 * existe caminho "insere se ausente" (seria reintroduzir um segundo
 * momento de nascimento; um produtor futuro, como o sync, cria a SUA
 * âncora na inserção dele).
 */
export async function persistReturn(
  conn: PoolConnection, schemaName: string, institutionId: number,
  adjustOrderId: number, plan: ReturnPlan
): Promise<void> {
  const s = assertSchema(schemaName)
  const [anchor] = await conn.query<any[]>(
    `SELECT tb_order_id_ori AS orderIdOri
       FROM \`${s}\`.tb_order_stock_adjust_return
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
    [adjustOrderId, institutionId]
  )
  if (!anchor[0] || Number(anchor[0].orderIdOri) !== plan.orderIdOri) {
    throw new HttpError(422, 'Devolução sem âncora no pedido original',
      [{ field: 'orderId', message: `Ajuste ${adjustOrderId} não está ancorado no pedido ${plan.orderIdOri}` }],
      'RETURN_INVALID')
  }
  for (const link of plan.links) {
    await conn.query(
      `INSERT INTO \`${s}\`.tb_order_item_return
         (id, tb_institution_id, tb_order_id, terminal, kind,
          tb_order_id_ori, tb_order_item_id_ori, terminal_ori, kind_ori,
          created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, 0, ?, NOW(), NOW())`,
      [link.itemId, institutionId, adjustOrderId, link.itemKind,
       plan.orderIdOri, link.itemIdOri, link.kindOri]
    )
  }
}
