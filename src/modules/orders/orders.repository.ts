import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { assertSchemaName } from '@shared/field-config'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import {
  OrderListRow, OrderFull, OpenOrderInput, OrderItemInput,
  OrderProductLookupRow,
} from './orders.interface'

/**
 * Repositório do Pedido de Venda/Conjugado. Backbone tb_order + ramo
 * tb_order_sale SEMPRE presente; tb_order_service nasce por PRESENÇA
 * (1º item de serviço adicionado) — open_lock SEMPRE NULL aqui (não é o
 * "1 OS aberta por cliente" do módulo service-orders; backbones distintos
 * que só compartilham a tabela tb_order_service por natureza do ramo).
 */

const SALE_KIND = 'Sale'
const SERVICE_KIND = 'Service'

// ---------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------

export async function listOrders(
  status: 'A' | 'F' | '', query: ListQuery,
  schemaName: string, institutionId: number
): Promise<PagedRows<OrderListRow>> {
  assertSchemaName(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const statusFilter = status || null
  const where =
    `FROM \`${schemaName}\`.tb_order_sale s
     INNER JOIN \`${schemaName}\`.tb_order o
        ON o.id = s.id AND o.tb_institution_id = s.tb_institution_id
       AND o.terminal = s.terminal AND o.deleted = 'N'
     INNER JOIN setes_central.tb_entity ce ON ce.id = s.tb_customer_id
     INNER JOIN setes_central.tb_entity se ON se.id = s.tb_salesman_id
     LEFT JOIN \`${schemaName}\`.tb_order_totalizer t
        ON t.id = s.id AND t.tb_institution_id = s.tb_institution_id
       AND t.terminal = s.terminal AND t.deleted = 'N'
     WHERE s.tb_institution_id = ? AND s.deleted = 'N'
       AND (? IS NULL OR o.status = ?)
       AND (? IS NULL OR ce.nick_trade LIKE ? OR ce.name_company LIKE ?)`
  const params = [institutionId, statusFilter, statusFilter, like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT s.id, s.number,
            s.tb_customer_id AS customerId,
            COALESCE(ce.nick_trade, ce.name_company) AS customerName,
            s.tb_salesman_id AS salesmanId,
            COALESCE(se.nick_trade, se.name_company) AS salesmanName,
            o.status,
            DATE_FORMAT(o.dt_record, '%Y-%m-%d') AS dtRecord,
            EXISTS(SELECT 1 FROM \`${schemaName}\`.tb_order_service os
                    WHERE os.id = s.id AND os.tb_institution_id = s.tb_institution_id
                      AND os.terminal = s.terminal AND os.deleted = 'N') AS hasService,
            (SELECT COUNT(*) FROM \`${schemaName}\`.tb_order_item i
              WHERE i.tb_order_id = s.id AND i.tb_institution_id = s.tb_institution_id
                AND i.terminal = s.terminal AND i.deleted = 'N') AS itemsCount,
            COALESCE(t.total_value, 0) AS totalValue
     ${where}
     ORDER BY o.status, s.number DESC, s.id DESC
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(`SELECT COUNT(*) AS total ${where}`, params)
  return {
    rows: rows.map(r => ({ ...r, hasService: !!r.hasService })),
    total: Number(count[0].total),
  }
}

export async function getOrder(
  id: number, schemaName: string, institutionId: number
): Promise<OrderFull | null> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT s.id, s.number,
            s.tb_customer_id AS customerId,
            COALESCE(ce.nick_trade, ce.name_company) AS customerName,
            s.tb_salesman_id AS salesmanId,
            COALESCE(se.nick_trade, se.name_company) AS salesmanName,
            o.status,
            DATE_FORMAT(o.dt_record, '%Y-%m-%d') AS dtRecord,
            COALESCE(t.total_value, 0) AS totalValue
     FROM \`${schemaName}\`.tb_order_sale s
     INNER JOIN \`${schemaName}\`.tb_order o
        ON o.id = s.id AND o.tb_institution_id = s.tb_institution_id
       AND o.terminal = s.terminal AND o.deleted = 'N'
     INNER JOIN setes_central.tb_entity ce ON ce.id = s.tb_customer_id
     INNER JOIN setes_central.tb_entity se ON se.id = s.tb_salesman_id
     LEFT JOIN \`${schemaName}\`.tb_order_totalizer t
        ON t.id = s.id AND t.tb_institution_id = s.tb_institution_id
       AND t.terminal = s.terminal AND t.deleted = 'N'
     WHERE s.id = ? AND s.tb_institution_id = ? AND s.deleted = 'N'`,
    [id, institutionId]
  )
  if (!rows[0]) return null

  const [items] = await pool.query<any[]>(
    `SELECT i.id, i.kind,
            i.tb_product_id AS productId,
            p.description   AS productDescription,
            COALESCE(p.kind, 'P') AS productKind,
            i.quantity,
            i.unit_value AS unitValue,
            COALESCE(i.discount_value, 0) AS discountValue,
            ROUND(i.quantity * i.unit_value - COALESCE(i.discount_value, 0), 2) AS total
     FROM \`${schemaName}\`.tb_order_item i
     LEFT JOIN \`${schemaName}\`.tb_product p
       ON p.id = i.tb_product_id AND p.tb_institution_id = i.tb_institution_id
     WHERE i.tb_order_id = ? AND i.tb_institution_id = ? AND i.terminal = 0
       AND i.deleted = 'N'
     ORDER BY i.id`,
    [id, institutionId]
  )
  return { ...rows[0], items }
}

/** Lookup de itens ativos e publicados — mercadoria (P/M) ou serviço (S). */
export async function listProductsLookup(
  branch: 'merchandise' | 'service', filter: string,
  schemaName: string, institutionId: number
): Promise<OrderProductLookupRow[]> {
  assertSchemaName(schemaName)
  const like = filter ? `%${escapeLike(filter)}%` : null
  const kindFilter = branch === 'service' ? `p.kind = 'S'` : `p.kind IN ('P', 'M')`
  const [rows] = await pool.query<any[]>(
    `SELECT p.id, p.description, p.kind
     FROM \`${schemaName}\`.tb_product p
     WHERE p.tb_institution_id = ? AND p.deleted = 'N' AND p.active = 'S'
       AND ${kindFilter}
       AND (? IS NULL OR p.description LIKE ?)
     ORDER BY p.description
     LIMIT 100`,
    [institutionId, like, like]
  )
  return rows
}

// ---------------------------------------------------------------------
// Helpers transacionais
// ---------------------------------------------------------------------

async function recalcTotalizer(
  conn: PoolConnection, schemaName: string, institutionId: number, orderId: number
): Promise<number> {
  const [sums] = await conn.query<any[]>(
    `SELECT COUNT(*)                                   AS itemsQtde,
            COALESCE(SUM(quantity), 0)                 AS productQtde,
            COALESCE(SUM(quantity * unit_value), 0)    AS productValue,
            COALESCE(SUM(COALESCE(discount_value,0)), 0) AS discountValue
     FROM \`${schemaName}\`.tb_order_item
     WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0
       AND deleted = 'N'`,
    [orderId, institutionId]
  )
  const s = sums[0]
  const total = Math.round((Number(s.productValue) - Number(s.discountValue)) * 100) / 100
  await conn.query(
    `INSERT INTO \`${schemaName}\`.tb_order_totalizer
       (id, tb_institution_id, terminal, items_qtde, product_qtde,
        product_value, discount_value, total_value, created_at, updated_at, deleted)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE
       items_qtde = VALUES(items_qtde), product_qtde = VALUES(product_qtde),
       product_value = VALUES(product_value), discount_value = VALUES(discount_value),
       total_value = VALUES(total_value), deleted = 'N', updated_at = NOW()`,
    [orderId, institutionId, s.itemsQtde, s.productQtde, s.productValue,
     s.discountValue, total]
  )
  return total
}

/** Ordem ABERTA travada para escrita (409 quando não está aberta). */
async function lockOpenOrder(
  conn: PoolConnection, schemaName: string, institutionId: number, orderId: number
): Promise<void> {
  const [rows] = await conn.query<any[]>(
    `SELECT o.status FROM \`${schemaName}\`.tb_order o
     INNER JOIN \`${schemaName}\`.tb_order_sale s
        ON s.id = o.id AND s.tb_institution_id = o.tb_institution_id
       AND s.terminal = o.terminal AND s.deleted = 'N'
     WHERE o.id = ? AND o.tb_institution_id = ? AND o.terminal = 0
       AND o.deleted = 'N' FOR UPDATE`,
    [orderId, institutionId]
  )
  if (!rows[0]) throw new HttpError(404, `Pedido ${orderId} não encontrado`)
  if (rows[0].status !== 'A') {
    throw new HttpError(409, 'Pedido já faturado — alterações só via financeiro',
      undefined, 'ORDER_INVOICED')
  }
}

/** Garante o ramo tb_order_service (lazy, PRESENÇA — open_lock SEMPRE NULL aqui). */
async function ensureServiceBranch(
  conn: PoolConnection, schemaName: string, institutionId: number,
  orderId: number, customerId: number
): Promise<void> {
  const [exists] = await conn.query<any[]>(
    `SELECT 1 FROM \`${schemaName}\`.tb_order_service
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
    [orderId, institutionId]
  )
  if (exists[0]) return

  const [mxNum] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(number), 0) + 1 AS nextNumber
       FROM \`${schemaName}\`.tb_order_service WHERE tb_institution_id = ? FOR UPDATE`,
    [institutionId]
  )
  await conn.query(
    `INSERT INTO \`${schemaName}\`.tb_order_service
       (id, tb_institution_id, terminal, number, tb_customer_id, open_lock,
        created_at, updated_at)
     VALUES (?, ?, 0, ?, ?, NULL, NOW(), NOW())`,
    [orderId, institutionId, Number(mxNum[0].nextNumber), customerId]
  )
}

async function insertItem(
  conn: PoolConnection, schemaName: string, institutionId: number,
  orderId: number, kind: string, input: OrderItemInput
): Promise<number> {
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${schemaName}\`.tb_order_item
      WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0 FOR UPDATE`,
    [orderId, institutionId]
  )
  const itemId = Number(mx[0].nextId)
  await conn.query(
    `INSERT INTO \`${schemaName}\`.tb_order_item
       (id, tb_institution_id, tb_order_id, terminal, kind, tb_product_id,
        quantity, unit_value, discount_aliquot, discount_value,
        created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, NULL, ?, NOW(), NOW())`,
    [itemId, institutionId, orderId, kind, input.productId,
     input.quantity, input.unitValue, input.discountValue ?? 0]
  )
  return itemId
}

// ---------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------

/** Abre o pedido — vendedor explícito ou default da carteira do cliente (Q-Orders). */
export async function openOrder(
  input: OpenOrderInput, schemaName: string, institutionId: number, userId: number
): Promise<number> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [cust] = await conn.query<any[]>(
      `SELECT tb_salesman_id AS salesmanId FROM \`${schemaName}\`.tb_customer
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [input.customerId, institutionId]
    )
    if (cust.length === 0) {
      throw new HttpError(400, 'Cliente não encontrado nesta institution',
        [{ field: 'customerId', message: 'Cliente inexistente' }], 'ROLE_MISSING')
    }
    const salesmanId = input.salesmanId ?? cust[0].salesmanId
    if (!salesmanId) {
      throw new HttpError(400,
        'Vendedor não informado e o cliente não tem vendedor padrão na carteira',
        [{ field: 'salesmanId', message: 'Informe o vendedor' }], 'SALESMAN_REQUIRED')
    }

    const [mx] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${schemaName}\`.tb_order
        WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId]
    )
    const id = Number(mx[0].nextId)
    const [mxNum] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(number), 0) + 1 AS nextNumber
         FROM \`${schemaName}\`.tb_order_sale WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId]
    )

    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_order
         (id, tb_institution_id, terminal, tb_user_id, dt_record, status,
          created_at, updated_at)
       VALUES (?, ?, 0, ?, CURDATE(), 'A', NOW(), NOW())`,
      [id, institutionId, userId]
    )
    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_order_sale
         (id, tb_institution_id, terminal, tb_salesman_id, number, tb_customer_id,
          created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, NOW(), NOW())`,
      [id, institutionId, salesmanId, Number(mxNum[0].nextNumber), input.customerId]
    )

    await conn.commit()
    return id
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Adiciona item — a NATUREZA do produto decide o ramo (D-Orders-1: presença). */
export async function addItem(
  orderId: number, input: OrderItemInput,
  schemaName: string, institutionId: number
): Promise<number> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await lockOpenOrder(conn, schemaName, institutionId, orderId)

    // active='S' (achado QA adversarial 2026-08-22): sem isso, um produto
    // desativado (some dos lookups) ainda podia ser incluído por ID direto.
    const [prod] = await conn.query<any[]>(
      `SELECT COALESCE(kind, 'P') AS kind FROM \`${schemaName}\`.tb_product
        WHERE id = ? AND tb_institution_id = ? AND active = 'S' AND deleted = 'N'`,
      [input.productId, institutionId]
    )
    if (prod.length === 0) {
      throw new HttpError(400, 'Produto/serviço inexistente ou inativo',
        [{ field: 'productId', message: 'Produto não encontrado' }], 'ROLE_MISSING')
    }

    const isService = prod[0].kind === 'S'
    if (isService) {
      const [sale] = await conn.query<any[]>(
        `SELECT tb_customer_id AS customerId FROM \`${schemaName}\`.tb_order_sale
          WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
        [orderId, institutionId]
      )
      await ensureServiceBranch(conn, schemaName, institutionId, orderId,
        Number(sale[0].customerId))
    }

    const itemId = await insertItem(conn, schemaName, institutionId, orderId,
      isService ? SERVICE_KIND : SALE_KIND, input)
    await recalcTotalizer(conn, schemaName, institutionId, orderId)

    await conn.commit()
    return itemId
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function updateItem(
  orderId: number, itemId: number, input: OrderItemInput,
  schemaName: string, institutionId: number
): Promise<void> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await lockOpenOrder(conn, schemaName, institutionId, orderId)

    // troca de produto NÃO muda o ramo do item (kind fixo desde a criação —
    // trocar mercadoria<->serviço é excluir e incluir de novo, decisão simples)
    const [result] = await conn.query<any>(
      `UPDATE \`${schemaName}\`.tb_order_item
          SET tb_product_id = ?, quantity = ?, unit_value = ?,
              discount_value = ?, updated_at = NOW()
        WHERE id = ? AND tb_order_id = ? AND tb_institution_id = ?
          AND terminal = 0 AND deleted = 'N'`,
      [input.productId, input.quantity, input.unitValue,
       input.discountValue ?? 0, itemId, orderId, institutionId]
    )
    if (result.affectedRows === 0) {
      throw new HttpError(404, `Item ${itemId} não encontrado no pedido ${orderId}`)
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
    await lockOpenOrder(conn, schemaName, institutionId, orderId)

    const [result] = await conn.query<any>(
      `UPDATE \`${schemaName}\`.tb_order_item
          SET deleted = 'S', updated_at = NOW()
        WHERE id = ? AND tb_order_id = ? AND tb_institution_id = ?
          AND terminal = 0 AND deleted = 'N'`,
      [itemId, orderId, institutionId]
    )
    if (result.affectedRows === 0) {
      throw new HttpError(404, `Item ${itemId} não encontrado no pedido ${orderId}`)
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

/** Cancela pedido ABERTO (soft delete). */
export async function cancelOrder(
  orderId: number, schemaName: string, institutionId: number
): Promise<void> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await lockOpenOrder(conn, schemaName, institutionId, orderId)

    await conn.query(
      `UPDATE \`${schemaName}\`.tb_order_sale SET deleted = 'S', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
      [orderId, institutionId]
    )
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_order_service SET deleted = 'S', updated_at = NOW()
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
