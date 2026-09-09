import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { assertSchemaName } from '@shared/field-config'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { lockInstitutionCounters } from '@shared/db/counters'
import { getOrderBilling, upsertOrderBilling, normalizeDeadline } from '@shared/order-billing'
import {
  getSaleOrderInfo, getReturnedQuantityByProduct,
  getOpenReturnQuantityByProduct, QTY_EPSILON,
} from '@shared/order-return'
import {
  OrderReturnListRow, OrderReturnFull, ReturnableProduct,
} from './order-returns.interface'

/**
 * Repositório da Devolução de Mercadoria — backbone tb_order + ramo
 * tb_order_stock_adjust (direction 'E') + ÂNCORA tb_order_stock_adjust_return
 * (nasce na ABERTURA — fato gerador é a decisão de devolver; o billing
 * deriva o pedido original daqui). A LISTA filtra por EXISTÊNCIA da âncora:
 * o módulo irmão futuro de ajuste avulso lista os ajustes SEM âncora —
 * disjuntos por construção (parecer 2026-08-24).
 *
 * Saldo devolvível = DERIVADO por produto: vendido − devolvido consumado
 * (elos) − aberto em OUTRAS devoluções da mesma origem. Devolução aberta
 * não reserva saldo; o gate real é o assertReturnableInTx do faturamento.
 */

const ADJUST_KIND = 'Adjust'

// ---------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------

export async function listReturns(
  status: 'A' | 'F' | '', query: ListQuery,
  schemaName: string, institutionId: number
): Promise<PagedRows<OrderReturnListRow>> {
  assertSchemaName(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const statusFilter = status || null
  const where =
    `FROM \`${schemaName}\`.tb_order_stock_adjust_return r
     INNER JOIN \`${schemaName}\`.tb_order_stock_adjust a
        ON a.id = r.id AND a.tb_institution_id = r.tb_institution_id
       AND a.terminal = r.terminal AND a.deleted = 'N'
     INNER JOIN \`${schemaName}\`.tb_order o
        ON o.id = r.id AND o.tb_institution_id = r.tb_institution_id
       AND o.terminal = r.terminal AND o.deleted = 'N'
     LEFT JOIN \`${schemaName}\`.tb_order_sale s
        ON s.id = r.tb_order_id_ori AND s.tb_institution_id = r.tb_institution_id
       AND s.terminal = r.terminal_ori AND s.deleted = 'N'
     INNER JOIN setes_central.tb_entity ce ON ce.id = a.tb_entity_id
     LEFT JOIN \`${schemaName}\`.tb_order_totalizer t
        ON t.id = r.id AND t.tb_institution_id = r.tb_institution_id
       AND t.terminal = r.terminal AND t.deleted = 'N'
     WHERE r.tb_institution_id = ? AND r.deleted = 'N'
       AND (? IS NULL OR o.status = ?)
       AND (? IS NULL OR ce.nick_trade LIKE ? OR ce.name_company LIKE ?)`
  const params = [institutionId, statusFilter, statusFilter, like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT r.id, a.number,
            r.tb_order_id_ori AS originOrderId,
            s.number AS originNumber,
            a.tb_entity_id AS customerId,
            COALESCE(ce.nick_trade, ce.name_company) AS customerName,
            o.status,
            DATE_FORMAT(o.dt_record, '%Y-%m-%d') AS dtRecord,
            (SELECT COUNT(*) FROM \`${schemaName}\`.tb_order_item i
              WHERE i.tb_order_id = r.id AND i.tb_institution_id = r.tb_institution_id
                AND i.terminal = r.terminal AND i.deleted = 'N') AS itemsCount,
            COALESCE(t.total_value, 0) AS totalValue
     ${where}
     ORDER BY o.status, r.id DESC
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(`SELECT COUNT(*) AS total ${where}`, params)
  return { rows: rows as OrderReturnListRow[], total: Number(count[0].total) }
}

export async function getReturn(
  id: number, schemaName: string, institutionId: number
): Promise<OrderReturnFull | null> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT r.id, a.number,
            o.status,
            DATE_FORMAT(o.dt_record, '%Y-%m-%d') AS dtRecord,
            r.tb_order_id_ori AS originOrderId,
            s.number AS originNumber,
            a.tb_entity_id AS customerId,
            COALESCE(ce.nick_trade, ce.name_company) AS customerName,
            COALESCE(t.total_value, 0) AS totalValue
     FROM \`${schemaName}\`.tb_order_stock_adjust_return r
     INNER JOIN \`${schemaName}\`.tb_order_stock_adjust a
        ON a.id = r.id AND a.tb_institution_id = r.tb_institution_id
       AND a.terminal = r.terminal AND a.deleted = 'N'
     INNER JOIN \`${schemaName}\`.tb_order o
        ON o.id = r.id AND o.tb_institution_id = r.tb_institution_id
       AND o.terminal = r.terminal AND o.deleted = 'N'
     LEFT JOIN \`${schemaName}\`.tb_order_sale s
        ON s.id = r.tb_order_id_ori AND s.tb_institution_id = r.tb_institution_id
       AND s.terminal = r.terminal_ori AND s.deleted = 'N'
     INNER JOIN setes_central.tb_entity ce ON ce.id = a.tb_entity_id
     LEFT JOIN \`${schemaName}\`.tb_order_totalizer t
        ON t.id = r.id AND t.tb_institution_id = r.tb_institution_id
       AND t.terminal = r.terminal AND t.deleted = 'N'
     WHERE r.id = ? AND r.tb_institution_id = ? AND r.deleted = 'N'`,
    [id, institutionId]
  )
  if (!rows[0]) return null
  const header = rows[0]

  const [items] = await pool.query<any[]>(
    `SELECT i.id, i.tb_product_id AS productId,
            p.description AS productDescription,
            i.quantity, i.unit_value AS unitValue,
            ROUND(i.quantity * i.unit_value, 2) AS total
     FROM \`${schemaName}\`.tb_order_item i
     LEFT JOIN \`${schemaName}\`.tb_product p
       ON p.id = i.tb_product_id AND p.tb_institution_id = i.tb_institution_id
     WHERE i.tb_order_id = ? AND i.tb_institution_id = ? AND i.terminal = 0
       AND i.deleted = 'N'
     ORDER BY i.id`,
    [id, institutionId]
  )

  // teto por produto EXCLUINDO esta devolução — para a tela validar a edição
  const returnable = await getReturnableProducts(
    schemaName, institutionId, Number(header.originOrderId), id)
  const maxByProduct = new Map(returnable.map(rp => [rp.productId, rp.available]))

  return {
    ...header,
    items: items.map(i => ({
      ...i,
      quantity: Number(i.quantity),
      unitValue: Number(i.unitValue),
      total: Number(i.total),
      maxQuantity: maxByProduct.get(Number(i.productId)) ?? 0,
    })),
  } as OrderReturnFull
}

/**
 * Saldo devolvível da origem, POR PRODUTO (grão da decisão 2026-08-24):
 * vendido (itens de mercadoria vivos) − consumado (elos) − aberto em
 * outras devoluções; unit_value e stock list do item MAIS RECENTE do
 * produto (paridade ITF_CODIGO DESC).
 */
export async function getReturnableProducts(
  schemaName: string, institutionId: number, orderIdOri: number,
  excludeOrderId?: number
): Promise<ReturnableProduct[]> {
  assertSchemaName(schemaName)
  // stock/price list vivem na especialização merchandise desde a migration
  // 013 (o baseline mente) — aqui nada disso é necessário: o item de
  // devolução nasce sem especialização, como no módulo orders
  const [originItems] = await pool.query<any[]>(
    `SELECT i.id, i.tb_product_id AS productId, i.quantity,
            i.unit_value AS unitValue
     FROM \`${schemaName}\`.tb_order_item i
     INNER JOIN \`${schemaName}\`.tb_product p
        ON p.id = i.tb_product_id AND p.tb_institution_id = i.tb_institution_id
       AND p.kind IN ('P', 'M')
     WHERE i.tb_order_id = ? AND i.tb_institution_id = ? AND i.terminal = 0
       AND i.deleted = 'N'
     ORDER BY i.id`,
    [orderIdOri, institutionId]
  )
  const returned = await getReturnedQuantityByProduct(schemaName, institutionId, orderIdOri)
  const open = await getOpenReturnQuantityByProduct(
    schemaName, institutionId, orderIdOri, excludeOrderId)

  const byProduct = new Map<number, ReturnableProduct & { sold: number }>()
  for (const item of originItems) {
    const productId = Number(item.productId)
    const prev = byProduct.get(productId)
    const sold = (prev?.sold ?? 0) + Number(item.quantity ?? 0)
    // ORDER BY i.id: o último iterado é o mais recente — vence no snapshot
    byProduct.set(productId, {
      productId, sold, available: 0,
      unitValue: Number(item.unitValue ?? 0),
    })
  }
  const result: ReturnableProduct[] = []
  for (const rp of byProduct.values()) {
    const available = rp.sold - (returned.get(rp.productId) ?? 0) - (open.get(rp.productId) ?? 0)
    if (available > QTY_EPSILON) {
      result.push({ productId: rp.productId, available, unitValue: rp.unitValue })
    }
  }
  return result
}

// ---------------------------------------------------------------------
// Helpers transacionais (molde orders — máquina de estados no repositório)
// ---------------------------------------------------------------------

async function recalcTotalizer(
  conn: PoolConnection, schemaName: string, institutionId: number, orderId: number
): Promise<void> {
  const [sums] = await conn.query<any[]>(
    `SELECT COUNT(*)                                AS itemsQtde,
            COALESCE(SUM(quantity), 0)              AS productQtde,
            COALESCE(SUM(quantity * unit_value), 0) AS productValue
     FROM \`${schemaName}\`.tb_order_item
     WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0
       AND deleted = 'N'`,
    [orderId, institutionId]
  )
  const s = sums[0]
  const total = Math.round(Number(s.productValue) * 100) / 100
  await conn.query(
    `INSERT INTO \`${schemaName}\`.tb_order_totalizer
       (id, tb_institution_id, terminal, items_qtde, product_qtde,
        product_value, discount_value, total_value, created_at, updated_at, deleted)
     VALUES (?, ?, 0, ?, ?, ?, 0, ?, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE
       items_qtde = VALUES(items_qtde), product_qtde = VALUES(product_qtde),
       product_value = VALUES(product_value), discount_value = 0,
       total_value = VALUES(total_value), deleted = 'N', updated_at = NOW()`,
    [orderId, institutionId, s.itemsQtde, s.productQtde, s.productValue, total]
  )
}

/** Devolução ABERTA travada para escrita (404/409 nos demais estados). */
async function lockOpenReturn(
  conn: PoolConnection, schemaName: string, institutionId: number, orderId: number
): Promise<void> {
  const [rows] = await conn.query<any[]>(
    `SELECT o.status FROM \`${schemaName}\`.tb_order o
     INNER JOIN \`${schemaName}\`.tb_order_stock_adjust_return r
        ON r.id = o.id AND r.tb_institution_id = o.tb_institution_id
       AND r.terminal = o.terminal AND r.deleted = 'N'
     WHERE o.id = ? AND o.tb_institution_id = ? AND o.terminal = 0
       AND o.deleted = 'N' FOR UPDATE`,
    [orderId, institutionId]
  )
  if (!rows[0]) throw new HttpError(404, `Devolução ${orderId} não encontrada`)
  if (rows[0].status !== 'A') {
    throw new HttpError(409, 'Devolução já faturada — alterações só via financeiro',
      undefined, 'ORDER_INVOICED')
  }
}

// ---------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------

/**
 * Abre a devolução a partir do pedido de venda FATURADO: backbone + ramo
 * (direction 'E') + âncora + itens pré-carregados (UM por produto, com o
 * saldo devolvível agregado) na MESMA transação.
 */
export async function openReturn(
  saleOrderId: number, schemaName: string, institutionId: number, userId: number
): Promise<number> {
  assertSchemaName(schemaName)

  const sale = await getSaleOrderInfo(schemaName, institutionId, saleOrderId)
  if (!sale) {
    throw new HttpError(404, `Pedido de venda ${saleOrderId} não encontrado`)
  }
  if (sale.status !== 'F') {
    throw new HttpError(422, 'Pedido de venda ainda não foi faturado',
      [{ field: 'saleOrderId', message: 'Devolução exige nota emitida' }],
      'ORIGIN_NOT_INVOICED')
  }
  const returnable = await getReturnableProducts(schemaName, institutionId, saleOrderId)
  if (returnable.length === 0) {
    throw new HttpError(422, 'Pedido sem saldo devolvível',
      [{ field: 'saleOrderId', message: 'Todos os itens já foram devolvidos ou estão em devolução aberta' }],
      'NOTHING_RETURNABLE')
  }

  // N2 (re-score socrático da Rodada 3): abrir devolução cunha MAX(id)+1 e
  // MAX(number)+1 — mesma classe do HIGH 3 (gap locks compatíveis); lock da
  // institution como 1º lock + retry.
  return withDeadlockRetry('abertura de devolução', { institutionId, saleOrderId }, 3, async () => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      await lockInstitutionCounters(conn, institutionId) // N2 (regra 7): cunha nº do pedido e do ajuste — 1º lock

      // Q-A1 (M4 PROVADO no gate adversarial do cancelamento, 2026-09-09): a
      // leitura acima é triagem — a DECISÃO relê a venda SOB LOCK (receita C1):
      // a nota cancelada entre a triagem e o INSERT não pode deixar uma
      // devolução ancorada em venda que voltou a 'A'.
      const [locked] = await conn.query<any[]>(
        `SELECT status FROM \`${schemaName}\`.tb_order
          WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N' FOR UPDATE`,
        [saleOrderId, institutionId]
      )
      if (!locked[0] || String(locked[0].status) !== 'F') {
        throw new HttpError(422, 'Pedido de venda deixou de estar faturado — abra a devolução de novo',
          [{ field: 'saleOrderId', message: 'Devolução exige nota emitida' }],
          'ORIGIN_NOT_INVOICED')
      }

      const [mx] = await conn.query<any[]>(
        `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${schemaName}\`.tb_order
          WHERE tb_institution_id = ? FOR UPDATE`,
        [institutionId]
      )
      const id = Number(mx[0].nextId)
      const [mxNum] = await conn.query<any[]>(
        `SELECT COALESCE(MAX(number), 0) + 1 AS nextNumber
           FROM \`${schemaName}\`.tb_order_stock_adjust
          WHERE tb_institution_id = ? FOR UPDATE`,
        [institutionId]
      )

      await conn.query(
        `INSERT INTO \`${schemaName}\`.tb_order
           (id, tb_institution_id, terminal, tb_user_id, dt_record, status,
            created_at, updated_at)
         VALUES (?, ?, 0, ?, CURDATE(), 'A', NOW(), NOW())`,
        [id, institutionId, userId]
      )
      // tb_entity_id = cliente DERIVADO da origem (a validação "mesmo
      // cliente" do buildReturnPlan vira rede de segurança que nunca
      // dispara pela tela — parecer 2026-08-24)
      await conn.query(
        `INSERT INTO \`${schemaName}\`.tb_order_stock_adjust
           (id, tb_institution_id, terminal, tb_entity_id, number, direction,
            created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, 'E', NOW(), NOW())`,
        [id, institutionId, sale.customerId, Number(mxNum[0].nextNumber)]
      )
      await conn.query(
        `INSERT INTO \`${schemaName}\`.tb_order_stock_adjust_return
           (id, tb_institution_id, terminal, tb_order_id_ori, terminal_ori,
            created_at, updated_at)
         VALUES (?, ?, 0, ?, 0, NOW(), NOW())`,
        [id, institutionId, saleOrderId]
      )

      // Q-A4 (Valdo 2026-09-09: HERDAR): a devolução nasce com as condições de
      // cobrança da VENDA (forma + prazo) — o billing exige tb_order_billing
      // desde a negociação (2026-09-06) e a ordem de ajuste não tem negociação
      // própria: o valor volta pela mesma forma em que entrou. Venda legada sem
      // condições → devolução também sem (o billing avisa ORDER_NO_BILLING).
      // Prazo legado NÃO canônico (D-N4 só tolera se inalterado) não é herdado —
      // a devolução nasce sem condições e o billing avisa (Q-G15, assunção);
      // parcelamento ELABORADO da venda também não é herdado (prazo simples).
      const billing = await getOrderBilling(conn, schemaName, institutionId, saleOrderId)
      const inherited = billing ? normalizeDeadline(billing.deadline) : null
      if (billing && inherited && inherited.valid) {
        await upsertOrderBilling(conn, schemaName, institutionId, id, {
          paymentTypeId: billing.paymentTypeId, deadline: inherited.deadline,
          ...(billing.plots != null ? { plots: billing.plots } : {}),
        })
      }

      let itemId = 0
      for (const rp of returnable) {
        itemId += 1
        await conn.query(
          `INSERT INTO \`${schemaName}\`.tb_order_item
             (id, tb_institution_id, tb_order_id, terminal, kind, tb_product_id,
              quantity, unit_value, discount_aliquot, discount_value,
              created_at, updated_at)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?, NULL, 0, NOW(), NOW())`,
          [itemId, institutionId, id, ADJUST_KIND, rp.productId,
           rp.available, rp.unitValue]
        )
      }
      await recalcTotalizer(conn, schemaName, institutionId, id)

      await conn.commit()
      return id
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
  })
}

/** Edita a QUANTIDADE de um item (teto = saldo devolvível excluindo esta). */
export async function updateItemQuantity(
  orderId: number, itemId: number, quantity: number,
  schemaName: string, institutionId: number
): Promise<void> {
  assertSchemaName(schemaName)

  // cortesia de tela FORA da transação (R2 do gate socrático 2026-08-24:
  // getReturnableProducts pede conexões novas ao pool — com o lock já
  // tomado, N PUTs simultâneos esgotariam o pool em fila). O gate REAL
  // segue no assertReturnableInTx do faturar.
  const [item] = await pool.query<any[]>(
    `SELECT i.tb_product_id AS productId, r.tb_order_id_ori AS orderIdOri
       FROM \`${schemaName}\`.tb_order_item i
       JOIN \`${schemaName}\`.tb_order_stock_adjust_return r
         ON (r.id = i.tb_order_id AND r.tb_institution_id = i.tb_institution_id
             AND r.terminal = i.terminal AND r.deleted = 'N')
      WHERE i.id = ? AND i.tb_order_id = ? AND i.tb_institution_id = ?
        AND i.terminal = 0 AND i.deleted = 'N'`,
    [itemId, orderId, institutionId]
  )
  if (!item[0]) {
    throw new HttpError(404, `Item ${itemId} não encontrado na devolução ${orderId}`)
  }
  const returnable = await getReturnableProducts(
    schemaName, institutionId, Number(item[0].orderIdOri), orderId)
  const max = returnable.find(rp => rp.productId === Number(item[0].productId))?.available ?? 0
  if (quantity > max + QTY_EPSILON) {
    throw new HttpError(422, 'Quantidade maior que o saldo devolvível',
      [{ field: 'quantity', message: `Máximo devolvível: ${max}` }],
      'RETURN_INVALID')
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await lockOpenReturn(conn, schemaName, institutionId, orderId)

    const [result] = await conn.query<any>(
      `UPDATE \`${schemaName}\`.tb_order_item
          SET quantity = ?, updated_at = NOW()
        WHERE id = ? AND tb_order_id = ? AND tb_institution_id = ?
          AND terminal = 0 AND deleted = 'N'`,
      [quantity, itemId, orderId, institutionId]
    )
    if (result.affectedRows === 0) {
      throw new HttpError(404, `Item ${itemId} não encontrado na devolução ${orderId}`)
    }
    await recalcTotalizer(conn, schemaName, institutionId, orderId)

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function removeItem(
  orderId: number, itemId: number, schemaName: string, institutionId: number
): Promise<void> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await lockOpenReturn(conn, schemaName, institutionId, orderId)

    const [result] = await conn.query<any>(
      `UPDATE \`${schemaName}\`.tb_order_item
          SET deleted = 'S', updated_at = NOW()
        WHERE id = ? AND tb_order_id = ? AND tb_institution_id = ?
          AND terminal = 0 AND deleted = 'N'`,
      [itemId, orderId, institutionId]
    )
    if (result.affectedRows === 0) {
      throw new HttpError(404, `Item ${itemId} não encontrado na devolução ${orderId}`)
    }
    await recalcTotalizer(conn, schemaName, institutionId, orderId)

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Cancela devolução ABERTA — ramo + âncora + backbone na mesma transação
 *  (devolução cancelada não tem elos, logo não suja o saldo derivado). */
export async function cancelReturn(
  orderId: number, schemaName: string, institutionId: number
): Promise<void> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await lockOpenReturn(conn, schemaName, institutionId, orderId)

    await conn.query(
      `UPDATE \`${schemaName}\`.tb_order_stock_adjust_return
          SET deleted = 'S', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
      [orderId, institutionId]
    )
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_order_stock_adjust
          SET deleted = 'S', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
      [orderId, institutionId]
    )
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_order SET deleted = 'S', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
      [orderId, institutionId]
    )

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}
