import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { assertSchemaName } from '@shared/field-config'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { upsertOrderBilling } from '@shared/order-billing'
import { assertPaymentRules } from '@shared/order-installment'
import {
  prorataValue, parcelQuotas, firstDayOfMonth, lastDayOfMonth,
} from './service-orders.calc'
import {
  ServiceOrderListRow, ServiceOrderFull, OpenOrderInput, OrderItemInput,
  MonthlyRunInput, MonthlyRunReport, InvoiceInput, InvoiceResult,
  ServiceProductLookupRow,
} from './service-orders.interface'

/**
 * Repositório das Ordens de Serviço (backbone tb_order + ramo
 * tb_order_service — Fases 3 e 6 do 05-ORDEM-SERVICO). Regras estruturais:
 * status vive na tb_order (DP7); open_lock preenchido/esvaziado pela
 * APLICAÇÃO na MESMA transação (D5 — UNIQUE é a rede da corrida); itens no
 * detalhe universal kind='Service' (DP6 — sem estoque); totalizer
 * recalculado a cada mudança; faturamento em transação única
 * (billing → invoice 'SE' → financial/bills 'RA' → status 'F').
 */

const SERVICE_KIND = 'Service'

// ---------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE
 * (D2). O subselect itemsCount fica SÓ no SELECT da página (não pesa o
 * COUNT); ORDER BY já tem desempate composto (number DESC, id DESC) —
 * OFFSET estável (D8).
 */
export async function listOrders(
  status: 'A' | 'F' | '', query: ListQuery,
  schemaName: string, institutionId: number
): Promise<PagedRows<ServiceOrderListRow>> {
  assertSchemaName(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const statusFilter = status || null
  const where =
    `FROM \`${schemaName}\`.tb_order_service s
     INNER JOIN \`${schemaName}\`.tb_order o
        ON o.id = s.id AND o.tb_institution_id = s.tb_institution_id
       AND o.terminal = s.terminal AND o.deleted = 'N'
     INNER JOIN setes_central.tb_entity e ON e.id = s.tb_customer_id
     LEFT JOIN \`${schemaName}\`.tb_order_totalizer t
        ON t.id = s.id AND t.tb_institution_id = s.tb_institution_id
       AND t.terminal = s.terminal AND t.deleted = 'N'
     WHERE s.tb_institution_id = ? AND s.deleted = 'N'
       AND (? IS NULL OR o.status = ?)
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ?)`
  const params = [institutionId, statusFilter, statusFilter, like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT s.id,
            s.number,
            s.tb_customer_id AS customerId,
            COALESCE(e.nick_trade, e.name_company) AS customerName,
            o.status,
            DATE_FORMAT(o.dt_record, '%Y-%m-%d') AS dtRecord,
            (SELECT COUNT(*) FROM \`${schemaName}\`.tb_order_item i
              WHERE i.tb_order_id = s.id AND i.tb_institution_id = s.tb_institution_id
                AND i.terminal = s.terminal AND i.deleted = 'N') AS itemsCount,
            COALESCE(t.total_value, 0) AS totalValue
     ${where}
     ORDER BY o.status, s.number DESC, s.id DESC
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

export async function getOrder(
  id: number, schemaName: string, institutionId: number
): Promise<ServiceOrderFull | null> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT s.id, s.number,
            s.tb_customer_id AS customerId,
            COALESCE(e.nick_trade, e.name_company) AS customerName,
            o.status,
            DATE_FORMAT(o.dt_record, '%Y-%m-%d') AS dtRecord,
            COALESCE(t.total_value, 0) AS totalValue,
            inv.number AS invoiceNumber,
            DATE_FORMAT(inv.dt_emission, '%Y-%m-%d') AS dtEmission
     FROM \`${schemaName}\`.tb_order_service s
     INNER JOIN \`${schemaName}\`.tb_order o
        ON o.id = s.id AND o.tb_institution_id = s.tb_institution_id
       AND o.terminal = s.terminal AND o.deleted = 'N'
     INNER JOIN setes_central.tb_entity e ON e.id = s.tb_customer_id
     LEFT JOIN \`${schemaName}\`.tb_order_totalizer t
        ON t.id = s.id AND t.tb_institution_id = s.tb_institution_id
       AND t.terminal = s.terminal AND t.deleted = 'N'
     LEFT JOIN \`${schemaName}\`.tb_invoice inv
        ON inv.id = s.id AND inv.tb_institution_id = s.tb_institution_id
       AND inv.terminal = s.terminal AND inv.deleted = 'N'
     WHERE s.id = ? AND s.tb_institution_id = ? AND s.deleted = 'N'`,
    [id, institutionId]
  )
  if (!rows[0]) return null

  const [items] = await pool.query<any[]>(
    `SELECT i.id,
            i.tb_product_id AS productId,
            p.description   AS productDescription,
            i.quantity,
            i.unit_value      AS unitValue,
            COALESCE(i.discount_value, 0) AS discountValue,
            ROUND(i.quantity * i.unit_value - COALESCE(i.discount_value, 0), 2) AS total
     FROM \`${schemaName}\`.tb_order_item i
     LEFT JOIN \`${schemaName}\`.tb_product p
       ON p.id = i.tb_product_id AND p.tb_institution_id = i.tb_institution_id
     WHERE i.tb_order_id = ? AND i.tb_institution_id = ? AND i.deleted = 'N'
     ORDER BY i.id`,
    [id, institutionId]
  )
  return { ...rows[0], items }
}

export async function listProductsLookup(
  filter: string, schemaName: string, institutionId: number
): Promise<ServiceProductLookupRow[]> {
  assertSchemaName(schemaName)
  const like = filter ? `%${filter}%` : null
  // Ordem de Serviço lista SERVIÇOS (tb_product.kind='S' — D2 do
  // prompt_notas_mercadoria_servico.md); mercadorias entram pela tela de venda.
  const [rows] = await pool.query<any[]>(
    `SELECT p.id, p.description
     FROM \`${schemaName}\`.tb_product p
     WHERE p.tb_institution_id = ? AND p.deleted = 'N' AND p.active = 'S' AND p.kind = 'S'
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

/** Recalcula o tb_order_totalizer da ordem (upsert — PK id/inst/terminal). */
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
     INNER JOIN \`${schemaName}\`.tb_order_service s
        ON s.id = o.id AND s.tb_institution_id = o.tb_institution_id
       AND s.terminal = o.terminal AND s.deleted = 'N'
     WHERE o.id = ? AND o.tb_institution_id = ? AND o.terminal = 0
       AND o.deleted = 'N' FOR UPDATE`,
    [orderId, institutionId]
  )
  if (!rows[0]) throw new HttpError(404, `Ordem de serviço ${orderId} não encontrada`)
  if (rows[0].status !== 'A') {
    throw new HttpError(409, 'Ordem já faturada — alterações só via financeiro',
      undefined, 'ORDER_INVOICED')
  }
}

/** Cria tb_order + tb_order_service ABERTA (D5/DP7) e devolve o id. */
async function createOpenOrder(
  conn: PoolConnection, schemaName: string, institutionId: number,
  customerId: number, userId: number
): Promise<number> {
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${schemaName}\`.tb_order
      WHERE tb_institution_id = ? FOR UPDATE`,
    [institutionId]
  )
  const id = Number(mx[0].nextId)

  const [mxNum] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(number), 0) + 1 AS nextNumber
       FROM \`${schemaName}\`.tb_order_service WHERE tb_institution_id = ?`,
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
    `INSERT INTO \`${schemaName}\`.tb_order_service
       (id, tb_institution_id, terminal, number, tb_customer_id, open_lock,
        created_at, updated_at)
     VALUES (?, ?, 0, ?, ?, CONCAT(?, '-', ?), NOW(), NOW())`,
    [id, institutionId, Number(mxNum[0].nextNumber), customerId,
     institutionId, customerId]
  )
  return id
}

async function insertServiceItem(
  conn: PoolConnection, schemaName: string, institutionId: number,
  orderId: number, input: OrderItemInput
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
    [itemId, institutionId, orderId, SERVICE_KIND, input.productId,
     input.quantity, input.unitValue, input.discountValue ?? 0]
  )
  return itemId
}

// ---------------------------------------------------------------------
// Escrita — OS manual (tarefas — 4.4)
// ---------------------------------------------------------------------

export async function openOrder(
  input: OpenOrderInput, schemaName: string, institutionId: number, userId: number
): Promise<number> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [role] = await conn.query<any[]>(
      `SELECT 1 FROM \`${schemaName}\`.tb_customer
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [input.customerId, institutionId]
    )
    if (role.length === 0) {
      throw new HttpError(400, 'Cliente não encontrado nesta institution',
        [{ field: 'customerId', message: 'Cliente inexistente' }],
        'ROLE_MISSING')
    }

    const [open] = await conn.query<any[]>(
      `SELECT id FROM \`${schemaName}\`.tb_order_service
        WHERE tb_institution_id = ? AND tb_customer_id = ?
          AND open_lock IS NOT NULL AND deleted = 'N' FOR UPDATE`,
      [institutionId, input.customerId]
    )
    if (open[0]) {
      throw new HttpError(409,
        `Cliente já tem a ordem ${open[0].id} aberta (máx. 1 por cliente — D5)`,
        undefined, 'ORDER_OPEN_EXISTS')
    }

    const id = await createOpenOrder(conn, schemaName, institutionId,
      input.customerId, userId)

    await conn.commit()
    return id
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function addItem(
  orderId: number, input: OrderItemInput,
  schemaName: string, institutionId: number
): Promise<number> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await lockOpenOrder(conn, schemaName, institutionId, orderId)

    const [prod] = await conn.query<any[]>(
      `SELECT 1 FROM \`${schemaName}\`.tb_product
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [input.productId, institutionId]
    )
    if (prod.length === 0) {
      throw new HttpError(400, 'Produto/serviço inexistente',
        [{ field: 'productId', message: 'Produto não encontrado' }],
        'ROLE_MISSING')
    }

    const itemId = await insertServiceItem(conn, schemaName, institutionId, orderId, input)
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

    const [result] = await conn.query<any>(
      `UPDATE \`${schemaName}\`.tb_order_item
          SET tb_product_id = ?, quantity = ?, unit_value = ?,
              discount_value = ?, updated_at = NOW()
        WHERE id = ? AND tb_order_id = ? AND tb_institution_id = ?
          AND terminal = 0 AND kind = ? AND deleted = 'N'`,
      [input.productId, input.quantity, input.unitValue,
       input.discountValue ?? 0, itemId, orderId, institutionId, SERVICE_KIND]
    )
    if (result.affectedRows === 0) {
      throw new HttpError(404, `Item ${itemId} não encontrado na ordem ${orderId}`)
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
      throw new HttpError(404, `Item ${itemId} não encontrado na ordem ${orderId}`)
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

/** Cancela ordem ABERTA (soft delete — D6; libera a trava D5). */
export async function cancelOrder(
  orderId: number, schemaName: string, institutionId: number
): Promise<void> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await lockOpenOrder(conn, schemaName, institutionId, orderId)

    await conn.query(
      `UPDATE \`${schemaName}\`.tb_order_service
          SET deleted = 'S', open_lock = NULL, updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
      [orderId, institutionId]
    )
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_order
          SET deleted = 'S', updated_at = NOW()
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

// ---------------------------------------------------------------------
// Rotina mensal (4.5 — manual, botão; transação POR CLIENTE)
// ---------------------------------------------------------------------

export async function monthlyRun(
  input: MonthlyRunInput, schemaName: string, institutionId: number, userId: number
): Promise<MonthlyRunReport> {
  assertSchemaName(schemaName)
  const first = firstDayOfMonth(input.year, input.month)
  const last  = lastDayOfMonth(input.year, input.month)

  // contratos VIGENTES na competência, com seus itens
  const [contracts] = await pool.query<any[]>(
    `SELECT c.id AS contractId, c.tb_customer_id AS customerId,
            DATE_FORMAT(c.dt_start, '%Y-%m-%d') AS dtStart,
            DATE_FORMAT(c.dt_end,   '%Y-%m-%d') AS dtEnd,
            i.tb_product_id AS productId, i.value
     FROM \`${schemaName}\`.tb_contract c
     INNER JOIN \`${schemaName}\`.tb_contract_item i
        ON i.tb_contract_id = c.id AND i.tb_institution_id = c.tb_institution_id
       AND i.deleted = 'N'
     WHERE c.tb_institution_id = ? AND c.deleted = 'N' AND c.active = 'S'
       AND c.dt_start <= ? AND (c.dt_end IS NULL OR c.dt_end >= ?)
     ORDER BY c.tb_customer_id, c.id`,
    [institutionId, last, first]
  )

  const byCustomer = new Map<number, any[]>()
  for (const row of contracts) {
    const list = byCustomer.get(Number(row.customerId)) ?? []
    list.push(row)
    byCustomer.set(Number(row.customerId), list)
  }

  const report: MonthlyRunReport = {
    processed: 0, opened: 0, injected: 0, skipped: 0, errors: [],
  }

  for (const [customerId, rows] of byCustomer) {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      report.processed += 1

      // ordem ABERTA do cliente (FOR UPDATE) ou nova
      const [open] = await conn.query<any[]>(
        `SELECT s.id FROM \`${schemaName}\`.tb_order_service s
          WHERE s.tb_institution_id = ? AND s.tb_customer_id = ?
            AND s.open_lock IS NOT NULL AND s.deleted = 'N' FOR UPDATE`,
        [institutionId, customerId]
      )
      let orderId: number
      if (open[0]) {
        orderId = Number(open[0].id)
      } else {
        orderId = await createOpenOrder(conn, schemaName, institutionId, customerId, userId)
        report.opened += 1
      }

      let touched = false
      for (const row of rows) {
        // idempotência (3.4): item do produto do contrato JÁ injetado na
        // competência? (kind Service criado dentro do mês)
        const [exists] = await conn.query<any[]>(
          `SELECT 1 FROM \`${schemaName}\`.tb_order_item
            WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0
              AND kind = ? AND tb_product_id = ? AND deleted = 'N'
              AND DATE(created_at) BETWEEN ? AND ?`,
          [orderId, institutionId, SERVICE_KIND, row.productId, first, last]
        )
        if (exists.length > 0) {
          report.skipped += 1
          continue
        }
        const value = prorataValue(Number(row.value), row.dtStart, row.dtEnd,
          input.year, input.month)
        if (value <= 0) {
          report.skipped += 1
          continue
        }
        await insertServiceItem(conn, schemaName, institutionId, orderId,
          { productId: Number(row.productId), quantity: 1, unitValue: value })
        report.injected += 1
        touched = true
      }
      if (touched) await recalcTotalizer(conn, schemaName, institutionId, orderId)

      await conn.commit()
    } catch (err: any) {
      await conn.rollback()
      report.errors.push({ customerId, message: String(err.message ?? err) })
    } finally {
      conn.release()
    }
  }
  return report
}

// ---------------------------------------------------------------------
// Gerar Faturamento (4.5.6/Fase 6 — transação única)
// ---------------------------------------------------------------------

export async function generateInvoice(
  orderId: number, input: InvoiceInput,
  schemaName: string, institutionId: number
): Promise<InvoiceResult> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await lockOpenOrder(conn, schemaName, institutionId, orderId)

    // forma VINCULADA/habilitada + nº de parcelas ≤ max_parcels do vínculo —
    // a MESMA regra das três portas (Q-N1 da negociação do pedido, 2026-09-07)
    await assertPaymentRules(conn, schemaName, institutionId, {
      headerPaymentTypeId: input.paymentTypeId, parcels: [], nParcels: input.parcels,
      limitField: 'parcels',
    })

    const total = await recalcTotalizer(conn, schemaName, institutionId, orderId)
    const [itemsAlive] = await conn.query<any[]>(
      `SELECT COUNT(*) AS n FROM \`${schemaName}\`.tb_order_item
        WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0
          AND deleted = 'N'`,
      [orderId, institutionId]
    )
    if (Number(itemsAlive[0].n) === 0) {
      throw new HttpError(400, 'Ordem sem itens — nada a faturar',
        [{ field: 'items', message: 'Inclua ao menos um item' }],
        'ORDER_NO_ITEMS')
    }

    const [svc] = await conn.query<any[]>(
      `SELECT tb_customer_id AS customerId FROM \`${schemaName}\`.tb_order_service
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
      [orderId, institutionId]
    )
    const customerId = Number(svc[0].customerId)

    // condições de cobrança (passo 5 da sequência — tb_order_billing) pela
    // peça @shared/order-billing (D2 da negociação): OS informa o nº de
    // parcelas do contrato, sem prazo (deadline NULL = "não se aplica").
    await upsertOrderBilling(conn, schemaName, institutionId, orderId, {
      paymentTypeId: input.paymentTypeId, deadline: null, plots: input.parcels,
    })

    // fatura INTERNA (DP8: model 'SE'; número MAX+1 por institution;
    // emissão OFICIAL da NFS-e = P1 futura)
    const [mxInv] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(CAST(number AS UNSIGNED)), 0) + 1 AS nextNumber
         FROM \`${schemaName}\`.tb_invoice
        WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId]
    )
    const invoiceNumber = String(mxInv[0].nextNumber)
    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_invoice
         (id, tb_institution_id, terminal, issuer, number, serie,
          tb_entity_id, dt_emission, value, model, status,
          created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, '1', ?, CURDATE(), ?, 'SE', 'A', NOW(), NOW())`,
      [orderId, institutionId, institutionId, invoiceNumber, customerId, total]
    )

    // financeiro: 1 tb_financial + 1 bill 'RA' POR PARCELA (P7 — PK natural)
    const quotas = parcelQuotas(total, input.parcels)
    for (let parcel = 1; parcel <= input.parcels; parcel++) {
      await conn.query(
        `INSERT INTO \`${schemaName}\`.tb_financial
           (tb_institution_id, tb_order_id, terminal, parcel, dt_expiration,
            tb_payment_types_id, tag_value, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, ?, NOW(), NOW())`,
        [institutionId, orderId, parcel, input.dtExpiration,
         input.paymentTypeId, quotas[parcel - 1]]
      )
      await conn.query(
        `INSERT INTO \`${schemaName}\`.tb_financial_bills
           (tb_institution_id, tb_order_id, terminal, parcel,
            tb_financial_plans_id, number, kind, situation, operation, stage,
            created_at, updated_at)
         VALUES (?, ?, 0, ?, 0, ?, 'RA', 'N', 'C', 'N', NOW(), NOW())`,
        [institutionId, orderId, parcel,
         `${orderId}/${invoiceNumber}-${parcel}`]
      )
    }

    // A→F no backbone (DP7) + libera a trava D5
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_order
          SET status = 'F', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
      [orderId, institutionId]
    )
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_order_service
          SET open_lock = NULL, updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
      [orderId, institutionId]
    )

    await conn.commit()
    return { invoiceNumber, parcels: input.parcels, totalValue: total }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}
