import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { lockInstitutionCounters } from '@shared/db/counters'
import { assertServiceProduct, serviceProductIssue } from '@shared/service-product'
import { toCents } from '@shared/money'   // Q-G27: guarda única virou peça
import { isLockWaitTimeout, isDeadlock } from '@shared/db/contention'
import { assertSchemaName } from '@shared/field-config'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { upsertOrderBilling } from '@shared/order-billing'
import { issueInvoice } from '@shared/invoice'
import {
  applyTitleAutomation, localIsoDate, resolveTitleAutomationConfig,
} from '@shared/title-automation'
import { assertPaymentRules } from '@shared/order-installment'
import {
  ORDER_NO_CONTRACT_DUE_DAY_MSG, ORDER_NO_CONTRACT_PAYMENT_TYPE_MSG,
  ORDER_STANDALONE_DUE_DAY_MSG, ORDER_STANDALONE_PAYMENT_TYPE_MSG,
} from './service-orders.messages'
import {
  prorataValue, parcelQuotas, firstDayOfMonth, lastDayOfMonth, contractDaySuggestion,
} from './service-orders.calc'
import {
  ServiceOrderListRow, ServiceOrderFull, OpenOrderInput, OrderItemInput,
  MonthlyRunInput, MonthlyRunReport, InvoiceInput, InvoiceResult,
  ServiceProductLookupRow,
} from './service-orders.interface'

/**
 * Repositório das Ordens de Serviço (backbone tb_order + natureza
 * tb_order_service (tomador) + CICLO tb_service_order — Fases 3 e 6 do
 * 05-ORDEM-SERVICO; migration 047: o ciclo ganhou ramo próprio porque
 * tb_order_service é natureza por PRESENÇA, compartilhada com a venda de
 * serviço e com o sync). Regras estruturais: status vive na tb_order (DP7);
 * open_lock (no CICLO) preenchido/esvaziado pela APLICAÇÃO na MESMA
 * transação (D5 — UNIQUE é a rede da corrida); a identidade da OS é a
 * EXISTÊNCIA do ciclo (venda com serviço nunca entra aqui); itens no
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
    `FROM \`${schemaName}\`.tb_service_order c
     INNER JOIN \`${schemaName}\`.tb_order_service s
        ON s.id = c.id AND s.tb_institution_id = c.tb_institution_id
       AND s.terminal = c.terminal AND s.deleted = 'N'
     INNER JOIN \`${schemaName}\`.tb_order o
        ON o.id = c.id AND o.tb_institution_id = c.tb_institution_id
       AND o.terminal = c.terminal AND o.deleted = 'N'
     INNER JOIN setes_central.tb_entity e ON e.id = s.tb_customer_id
     LEFT JOIN \`${schemaName}\`.tb_order_totalizer t
        ON t.id = c.id AND t.tb_institution_id = c.tb_institution_id
       AND t.terminal = c.terminal AND t.deleted = 'N'
     WHERE c.tb_institution_id = ? AND c.deleted = 'N'
       AND (? IS NULL OR o.status = ?)
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ?)`
  const params = [institutionId, statusFilter, statusFilter, like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT c.id,
            c.number,
            s.tb_customer_id AS customerId,
            COALESCE(e.nick_trade, e.name_company) AS customerName,
            o.status,
            DATE_FORMAT(o.dt_record, '%Y-%m-%d') AS dtRecord,
            (SELECT COUNT(*) FROM \`${schemaName}\`.tb_order_item i
              WHERE i.tb_order_id = s.id AND i.tb_institution_id = s.tb_institution_id
                AND i.terminal = s.terminal AND i.deleted = 'N') AS itemsCount,
            COALESCE(t.total_value, 0) AS totalValue
     ${where}
     ORDER BY o.status, c.number DESC, c.id DESC
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
    `SELECT c.id, c.number,
            s.tb_customer_id AS customerId,
            COALESCE(e.nick_trade, e.name_company) AS customerName,
            o.status,
            DATE_FORMAT(o.dt_record, '%Y-%m-%d') AS dtRecord,
            COALESCE(t.total_value, 0) AS totalValue,
            inv.number AS invoiceNumber,
            DATE_FORMAT(inv.dt_emission, '%Y-%m-%d') AS dtEmission
     FROM \`${schemaName}\`.tb_service_order c
     INNER JOIN \`${schemaName}\`.tb_order_service s
        ON s.id = c.id AND s.tb_institution_id = c.tb_institution_id
       AND s.terminal = c.terminal AND s.deleted = 'N'
     INNER JOIN \`${schemaName}\`.tb_order o
        ON o.id = c.id AND o.tb_institution_id = c.tb_institution_id
       AND o.terminal = c.terminal AND o.deleted = 'N'
     INNER JOIN setes_central.tb_entity e ON e.id = s.tb_customer_id
     LEFT JOIN \`${schemaName}\`.tb_order_totalizer t
        ON t.id = s.id AND t.tb_institution_id = s.tb_institution_id
       AND t.terminal = s.terminal AND t.deleted = 'N'
     LEFT JOIN \`${schemaName}\`.tb_invoice inv
        ON inv.id = s.id AND inv.tb_institution_id = s.tb_institution_id
       AND inv.terminal = s.terminal AND inv.deleted = 'N'
     WHERE c.id = ? AND c.tb_institution_id = ? AND c.deleted = 'N'`,
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

/**
 * Ordem ABERTA travada para escrita (409 quando não está aberta). A
 * identidade da OS é a EXISTÊNCIA do ciclo (tb_service_order): uma venda com
 * item de serviço tem a natureza mas não o ciclo → 404 aqui (antes vazava:
 * DELETE/itens/faturar do módulo de OS pegavam a venda — parecer 2026-09-09).
 */
async function lockOpenOrder(
  conn: PoolConnection, schemaName: string, institutionId: number, orderId: number
): Promise<void> {
  const [rows] = await conn.query<any[]>(
    `SELECT o.status FROM \`${schemaName}\`.tb_order o
     INNER JOIN \`${schemaName}\`.tb_service_order c
        ON c.id = o.id AND c.tb_institution_id = o.tb_institution_id
       AND c.terminal = o.terminal AND c.deleted = 'N'
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

/**
 * Cria tb_order + natureza tb_order_service + CICLO tb_service_order ABERTO
 * (D5/DP7) e devolve o id. PRÉ-CONDIÇÃO: a transação já travou a institution
 * (`lockInstitutionCounters`) — os dois MAX+1 abaixo deadlockam entre
 * concorrentes sem isso (Q-A12).
 */
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

  // nº da OS: MAX+1 sobre o CICLO (UNIQUE (institution, number) = índice do
  // contador — família do Q-G5), travante
  const [mxNum] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(number), 0) + 1 AS nextNumber
       FROM \`${schemaName}\`.tb_service_order WHERE tb_institution_id = ? FOR UPDATE`,
    [institutionId]
  )

  await conn.query(
    `INSERT INTO \`${schemaName}\`.tb_order
       (id, tb_institution_id, terminal, tb_user_id, dt_record, status,
        created_at, updated_at)
     VALUES (?, ?, 0, ?, CURDATE(), 'A', NOW(), NOW())`,
    [id, institutionId, userId]
  )
  // natureza (tomador) — number NULL: nº de origem é só do sync (ramos irmãos)
  await conn.query(
    `INSERT INTO \`${schemaName}\`.tb_order_service
       (id, tb_institution_id, terminal, tb_customer_id, created_at, updated_at)
     VALUES (?, ?, 0, ?, NOW(), NOW())`,
    [id, institutionId, customerId]
  )
  try {
    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_service_order
         (id, tb_institution_id, terminal, number, open_lock, created_at, updated_at)
       VALUES (?, ?, 0, ?, CONCAT(?, '-', ?), NOW(), NOW())`,
      [id, institutionId, Number(mxNum[0].nextNumber), institutionId, customerId]
    )
  } catch (err: any) {
    // Q-A5: a trava D5 (UNIQUE open_lock) ocupada entre a consulta e o INSERT
    // (ex.: cancelamento da nota reabrindo a OS do cliente) é 409, não 500.
    if (err?.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'Cliente já tem ordem de serviço aberta (máx. 1 por cliente — D5)',
        undefined, 'ORDER_OPEN_EXISTS')
    }
    throw err
  }
  return id
}

/**
 * Q-A17b (Valdo 2026-09-09): item de OS sem valor não existe (sem caso real de
 * cortesia) → 422.
 *
 * A conferência é em CENTAVOS (gate adversarial da Onda 1, MEDIUM-3): validar
 * em float deixava `unitValue: 0.001` passar, o DECIMAL(10,2) do total gravava
 * 0,00 e a OS faturava uma nota de valor ZERO — consumindo número de nota, com
 * título de 0,00, sem baixa e sem boleto, em silêncio. Mesma regra do
 * @shared/money adotada na Q-A27: o que valida é o que grava.
 */
function assertItemValue(input: OrderItemInput): void {
  const centavos = toCents(Number(input.unitValue) * Number(input.quantity ?? 1))
  if (!(Number(input.unitValue) > 0) || centavos <= 0) {
    throw new HttpError(422, 'Item da ordem de serviço precisa de valor unitário maior que zero',
      [{ field: 'unitValue', message: 'Informe o valor' }], 'SERVICE_ORDER_ITEM_VALUE_REQUIRED')
  }
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
  // Q-A5 (3ª rodada adversarial do cancelamento, 2026-09-09): os locks da
  // Rodada 2 (trava D5 no plano do cancelamento; MAX(number_seq) na sequência
  // 'SE') deadlockam com este módulo — vítima reexecuta, nunca 500 (mesma peça
  // do billing, bank-slips, checks e settlements).
  return withDeadlockRetry('abertura de OS', { institutionId, customerId: input.customerId }, 3, async () => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      await lockInstitutionCounters(conn, institutionId) // Q-A12: cunha nº do pedido/OS — 1º lock

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
        `SELECT id FROM \`${schemaName}\`.tb_service_order
        WHERE tb_institution_id = ? AND open_lock = CONCAT(?, '-', ?) AND deleted = 'N' FOR UPDATE`,
      [institutionId, institutionId, input.customerId]
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
  })
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

    await assertServiceProduct(conn, schemaName, institutionId, input.productId)
    assertItemValue(input)

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
    await assertServiceProduct(conn, schemaName, institutionId, input.productId)   // Q-A20: PUT = mesma guarda do POST
    assertItemValue(input)   // Q-A17b

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
    // D-A34 (Valdo 2026-09-13, "sim"): LIBERAR A COMPETÊNCIA é consequência de remover o
    // item — o fato gravado é "a rotina faturou o item X do contrato na competência Y
    // gerando ESTE item da OS"; sem o item, o fato perdeu o objeto e o mês volta a ser
    // injetável (antes ficava consumido para sempre e o cliente sem cobrança, com o
    // operador sem saída a não ser cancelar a OS inteira). Não é botão novo: é o mesmo
    // ato que o operador já faz.
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_contract_item_competence
          SET deleted = 'S', updated_at = NOW()
        WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0
          AND tb_order_item_id = ? AND deleted = 'N'`,
      [institutionId, orderId, itemId]
    )
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
      `UPDATE \`${schemaName}\`.tb_service_order
          SET deleted = 'S', open_lock = NULL, updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
      [orderId, institutionId]
    )
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_order_service
          SET deleted = 'S', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
      [orderId, institutionId]
    )
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_order
          SET deleted = 'S', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
      [orderId, institutionId]
    )
    // D-A29: OS cancelada devolve a competência ao contrato (a rotina pode
    // reinjetar); item REMOVIDO à mão da OS viva NÃO devolve — ato do operador.
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_contract_item_competence
          SET deleted = 'S', updated_at = NOW()
        WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0`,
      [institutionId, orderId]
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
  const competence = `${input.year}-${String(input.month).padStart(2, '0')}`   // D-A29

  // contratos VIGENTES na competência, com seus itens
  const [contracts] = await pool.query<any[]>(
    `SELECT c.id AS contractId, c.tb_customer_id AS customerId,
            DATE_FORMAT(c.dt_start, '%Y-%m-%d') AS dtStart,
            DATE_FORMAT(c.dt_end,   '%Y-%m-%d') AS dtEnd,
            c.payment_day AS paymentDay, c.tb_payment_types_id AS paymentTypeId,
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
    report.processed += 1
    try {
      // Q-A5: transação por cliente reexecuta em deadlock (a trava D5 do
      // cancelamento da nota da OS cruza com este SELECT … FOR UPDATE + INSERT);
      // os contadores só entram no relatório DEPOIS do commit — uma tentativa
      // desfeita não conta duas vezes.
      const done = await withDeadlockRetry('rotina mensal', { institutionId, customerId }, 3, async () => {
        const conn = await pool.getConnection()
        const local = { opened: 0, injected: 0, skipped: 0, invalid: [] as { contractId: number; productId: number; reason: string }[] }
        try {
          await conn.beginTransaction()
          // D-A35 (Valdo 2026-09-13, "sim"): a VARREDURA não trava a institution — só o ATO de
          // cunhar trava (regra 7). Estas leituras NÃO são travantes (só decidem se há trabalho);
          // depois do X, cada competência é RE-LIDA travante antes de injetar, então o lock
          // continua sendo o 1º lock EXCLUSIVO da transação e ninguém injeta duas vezes.
          // Antes, a rotina tomava o X por cliente mesmo sem nada a fazer (caso comum depois da
          // D-G33) e empurrava faturamento/baixa concorrentes para 10 s.

          // D-A29 (Q-A29, Valdo 2026-09-13): idempotência pela COMPETÊNCIA gravada no
          // ato (tb_contract_item_competence — migration 051), não por created_at:
          // a reexecução retroativa injetava em dobro. D-G33 (Q-G33): a OS só abre
          // quando há ao menos um item injetável — OS vazia ocupava a trava D5.
          const injectable: { row: any; value: number }[] = []
          for (const row of rows) {
            const [billed] = await conn.query<any[]>(
              `SELECT 1 FROM \`${schemaName}\`.tb_contract_item_competence
                WHERE tb_institution_id = ? AND tb_contract_id = ? AND tb_product_id = ?
                  AND competence = ? AND deleted = 'N'`,
              [institutionId, row.contractId, row.productId, competence]
            )
            if (billed.length > 0) {
              local.skipped += 1
              continue
            }
            // Q-G27 ("ambos", Valdo 2026-09-10): o contrato valida o produto ao gravar,
            // mas ele pode ter sido inativado/trocado depois — a rotina PULA o item e
            // REPORTA (antes injetava e o cinto do faturamento recusava a OS inteira).
            const issue = await serviceProductIssue(conn, schemaName, institutionId, Number(row.productId))
            if (issue) {
              local.skipped += 1
              local.invalid.push({ contractId: Number(row.contractId), productId: Number(row.productId), reason: issue })
              continue
            }
            const value = prorataValue(Number(row.value), row.dtStart, row.dtEnd,
              input.year, input.month)
            if (value <= 0) {
              local.skipped += 1
              continue
            }
            injectable.push({ row, value })
          }
          if (injectable.length === 0) {
            await conn.commit()
            return local
          }

          // há o que injetar: AGORA trava (regra 7 — 1º lock exclusivo) e reconfere as
          // competências de forma TRAVANTE (o snapshot REPEATABLE READ acima pode ter
          // envelhecido entre a varredura e o X)
          await lockInstitutionCounters(conn, institutionId)
          const confirmed: typeof injectable = []
          for (const item of injectable) {
            const [billed] = await conn.query<any[]>(
              `SELECT 1 FROM \`${schemaName}\`.tb_contract_item_competence
                WHERE tb_institution_id = ? AND tb_contract_id = ? AND tb_product_id = ?
                  AND competence = ? AND deleted = 'N' FOR UPDATE`,
              [institutionId, item.row.contractId, item.row.productId, competence]
            )
            if (billed.length > 0) local.skipped += 1
            else confirmed.push(item)
          }
          if (confirmed.length === 0) {
            await conn.commit()
            return local
          }

          // ordem ABERTA do cliente (FOR UPDATE) ou nova
          const [open] = await conn.query<any[]>(
            `SELECT c.id FROM \`${schemaName}\`.tb_service_order c
              WHERE c.tb_institution_id = ? AND c.open_lock = CONCAT(?, '-', ?) AND c.deleted = 'N' FOR UPDATE`,
            [institutionId, institutionId, customerId]
          )
          let orderId: number
          if (open[0]) {
            orderId = Number(open[0].id)
          } else {
            orderId = await createOpenOrder(conn, schemaName, institutionId, customerId, userId)
            local.opened += 1
          }

          for (const { row, value } of confirmed) {
            const itemId = await insertServiceItem(conn, schemaName, institutionId, orderId,
              { productId: Number(row.productId), quantity: 1, unitValue: value })
            // fato do ato: contrato × produto × competência → item da OS (revive se a
            // OS anterior da competência foi cancelada — cancelOrder soft-deleta aqui).
            // D23 (Q-R1, Valdo 2026-09-19): o fato carrega as CONDIÇÕES que o contrato
            // tinha NESTE ato (dia e forma) — o lote lê daqui, e editar/excluir o
            // contrato depois não reescreve a cobrança de um mês já gerado (D-A36). A
            // reinjeção após cancelar a OS é ato NOVO: as condições de então valem.
            await conn.query(
              `INSERT INTO \`${schemaName}\`.tb_contract_item_competence
                 (tb_institution_id, tb_contract_id, tb_product_id, competence,
                  tb_order_id, terminal, tb_order_item_id, payment_day, tb_payment_types_id,
                  created_at, updated_at, deleted)
               VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, NOW(), NOW(), 'N')
               ON DUPLICATE KEY UPDATE tb_order_id = VALUES(tb_order_id),
                 tb_order_item_id = VALUES(tb_order_item_id),
                 payment_day = VALUES(payment_day), tb_payment_types_id = VALUES(tb_payment_types_id),
                 deleted = 'N', updated_at = NOW()`,
              [institutionId, row.contractId, row.productId, competence, orderId, itemId,
               row.paymentDay ?? null, row.paymentTypeId ?? null]
            )
            local.injected += 1
          }
          await recalcTotalizer(conn, schemaName, institutionId, orderId)

          await conn.commit()
          return local
        } catch (err) {
          await conn.rollback()
          throw err
        } finally {
          conn.release()
        }
      })
      report.opened += done.opened
      report.injected += done.injected
      report.skipped += done.skipped
      for (const inv of done.invalid) {
        report.errors.push({
          customerId, contractId: inv.contractId, productId: inv.productId,
          message: `Contrato ${inv.contractId}: ${inv.reason} (produto ${inv.productId}) — item pulado`,
        })
      }
    } catch (err: any) {
      // Adversarial da Rodada 5 (D5, 2026-09-11): contenção (1205 / 1213 com retry
      // esgotado) NÃO é erro de negócio de UM cliente — propaga para a fronteira
      // (409 RESOURCE_BUSY, como em todo módulo), em vez de 200 com o texto cru
      // do driver em errors[] e N × 10 s serializados nos clientes seguintes.
      if (isLockWaitTimeout(err) || isDeadlock(err)) throw err
      report.errors.push({ customerId, message: String(err.message ?? err) })
    }
  }
  return report
}

// ---------------------------------------------------------------------
// Gerar Faturamento (4.5.6/Fase 6 — transação única)
// ---------------------------------------------------------------------

/**
 * CONDIÇÕES combinadas nos contratos que alimentaram esta ordem (D12/D13/D14,
 * Valdo 2026-09-13): o dia de vencimento, a forma de pagamento e a ÚLTIMA
 * competência injetada. É o contrato dizendo QUANDO e COMO o cliente paga.
 *
 * D23 (Q-R1, Valdo 2026-09-19): a fonte é o FATO da competência
 * (`tb_contract_item_competence.payment_day/tb_payment_types_id`, gravados NO ATO
 * da injeção — migration 054), NÃO o contrato vivo. Editar ou excluir o contrato
 * depois não muda a cobrança do mês que ele já gerou; por isso a consulta nem
 * faz JOIN com tb_contract — o fato basta, e a competência soft-deletada
 * (item removido / OS cancelada) sai sozinha pelo `deleted`.
 *
 * Por que a ÚLTIMA competência: uma OS que não foi faturada em setembro recebe
 * também os itens de outubro — está se cobrando tudo que acumulou, então a
 * referência é o mês mais recente, não o primeiro.
 *
 * Dia e forma são resolvidos INDEPENDENTES: dois contratos do mesmo cliente
 * podem combinar no dia e divergir na forma. Cada um que DIVERGE vira null —
 * não existe "o dia" nem "a forma", e escolher um seria decidir pelo usuário
 * sem ele saber. Quem chama decide: a sugestão da tela cai no genérico; o lote
 * recusa a ordem e diz por quê. Devolve null só quando a ordem não veio de
 * contrato nenhum (OS avulsa).
 */
export interface ContractBillingReference {
  /** Dia combinado; null quando os contratos divergem. */
  paymentDay: number | null
  /** Forma combinada; null quando divergem ou nenhum contrato a define. */
  paymentTypeId: number | null
  /** 'YYYY-MM' — competência mais recente injetada na ordem. */
  competence: string
}

/** A ordem de serviço existe e está viva? (motivo honesto no lote). */
export async function orderExists(
  orderId: number, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM \`${schemaName}\`.tb_service_order
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
    [orderId, institutionId]
  )
  return rows.length > 0
}

function billingReferenceSql(schemaName: string, forUpdate: boolean): string {
  return `SELECT MAX(comp.competence) AS competence,
            COUNT(DISTINCT comp.payment_day) AS dias,
            MIN(comp.payment_day) AS paymentDay,
            COUNT(DISTINCT comp.tb_payment_types_id) AS formas,
            -- COUNT(*) inclui as linhas com forma NULL, que o COUNT(DISTINCT)
            -- ignora: contrato "informar no faturamento" convivendo com outro
            -- que combinou forma fazia o lote adotar a do irmão e faturar —
            -- com baixa automática e taxa numa forma que ninguém escolheu
            -- (gate adversarial). Sem forma em TODOS, não há forma combinada.
            COUNT(*) AS contratos,
            COUNT(comp.tb_payment_types_id) AS comForma,
            MIN(comp.tb_payment_types_id) AS paymentTypeId
       FROM \`${schemaName}\`.tb_contract_item_competence comp
      WHERE comp.tb_institution_id = ? AND comp.tb_order_id = ? AND comp.terminal = 0
        AND comp.deleted = 'N'${forUpdate ? ' FOR UPDATE' : ''}`
}

function mapBillingReference(r: any): ContractBillingReference | null {
  if (!r || r.competence == null) return null
  return {
    competence: String(r.competence),
    paymentDay: Number(r.dias) === 1 ? Number(r.paymentDay) : null,
    // Só existe "a forma combinada" quando TODOS os contratos da ordem
    // combinaram a MESMA: uma forma distinta (`formas`) e nenhuma linha sem
    // forma (`comForma` = `contratos`).
    paymentTypeId: Number(r.formas) === 1
      && Number(r.comForma) === Number(r.contratos)
      && r.paymentTypeId != null
      ? Number(r.paymentTypeId) : null,
  }
}

/**
 * Variante TRANSACIONAL e TRAVANTE (M1 — regra 2 do PADROES §9: leitura que
 * decide trava): usada por `generateInvoice` depois do lock da ordem, para que
 * a condição gravada no título seja a dos fatos que a nota realmente cobre.
 */
export async function contractBillingReferenceTx(
  conn: PoolConnection, schemaName: string, institutionId: number, orderId: number
): Promise<ContractBillingReference | null> {
  const [rows] = await conn.query<any[]>(
    billingReferenceSql(schemaName, true), [institutionId, orderId])
  return mapBillingReference(rows[0])
}

export async function contractBillingReference(
  orderId: number, schemaName: string, institutionId: number
): Promise<ContractBillingReference | null> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT MAX(comp.competence) AS competence,
            COUNT(DISTINCT comp.payment_day) AS dias,
            MIN(comp.payment_day) AS paymentDay,
            COUNT(DISTINCT comp.tb_payment_types_id) AS formas,
            -- COUNT(*) inclui as linhas com forma NULL, que o COUNT(DISTINCT)
            -- ignora: contrato "informar no faturamento" convivendo com outro
            -- que combinou forma fazia o lote adotar a do irmão e faturar —
            -- com baixa automática e taxa numa forma que ninguém escolheu
            -- (gate adversarial). Sem forma em TODOS, não há forma combinada.
            COUNT(*) AS contratos,
            COUNT(comp.tb_payment_types_id) AS comForma,
            MIN(comp.tb_payment_types_id) AS paymentTypeId
       FROM \`${schemaName}\`.tb_contract_item_competence comp
      WHERE comp.tb_institution_id = ? AND comp.tb_order_id = ? AND comp.terminal = 0
        AND comp.deleted = 'N'`,
    [institutionId, orderId]
  )
  return mapBillingReference(rows[0])
}

/**
 * Condições que a nota vai GRAVAR (M1). Sem `termsFromContract` (faturamento
 * avulso, ou lote com override total) são as do corpo. Com ele, a condição que
 * veio do fato é re-resolvida AQUI — sob o lock da ordem, com FOR UPDATE nos
 * fatos — e, se sumiu ou divergiu (item removido, competência nova de outro
 * contrato injetada entre a leitura do lote e o lock), a ordem é RECUSADA com o
 * mesmo código da porta de fora. Nunca se fatura com a condição envelhecida.
 */
async function resolveInvoiceTermsTx(
  conn: PoolConnection, schemaName: string, institutionId: number, orderId: number,
  input: InvoiceInput
): Promise<{ dtExpiration: string; paymentTypeId: number }> {
  const t = input.termsFromContract
  if (!t?.dtExpiration && !t?.paymentTypeId) {
    return { dtExpiration: input.dtExpiration, paymentTypeId: input.paymentTypeId }
  }
  const ref = await contractBillingReferenceTx(conn, schemaName, institutionId, orderId)
  let dtExpiration = input.dtExpiration
  let paymentTypeId = input.paymentTypeId
  if (t.dtExpiration) {
    if (!ref?.paymentDay) {
      throw new HttpError(422, ref ? ORDER_NO_CONTRACT_DUE_DAY_MSG : ORDER_STANDALONE_DUE_DAY_MSG,
        [{ field: 'dtExpiration', message: 'Sem dia de vencimento combinado' }],
        'ORDER_NO_CONTRACT_DUE_DAY')
    }
    const [ano, mes] = ref.competence.split('-').map(Number)
    dtExpiration = contractDaySuggestion(ano, mes, ref.paymentDay)
  }
  if (t.paymentTypeId) {
    if (!ref?.paymentTypeId) {
      throw new HttpError(422, ref ? ORDER_NO_CONTRACT_PAYMENT_TYPE_MSG : ORDER_STANDALONE_PAYMENT_TYPE_MSG,
        [{ field: 'paymentTypeId', message: 'Sem forma de pagamento combinada' }],
        'ORDER_NO_CONTRACT_PAYMENT_TYPE')
    }
    paymentTypeId = ref.paymentTypeId
  }
  return { dtExpiration, paymentTypeId }
}

/** Só o dia — atalho da sugestão da tela (D12). */
export async function contractPaymentDay(
  orderId: number, schemaName: string, institutionId: number
): Promise<number | null> {
  const ref = await contractBillingReference(orderId, schemaName, institutionId)
  return ref?.paymentDay ?? null
}

export async function generateInvoice(
  orderId: number, input: InvoiceInput,
  schemaName: string, institutionId: number, userId: number
): Promise<InvoiceResult> {
  assertSchemaName(schemaName)

  // Configuração da automação resolvida ANTES da transação (gate adversarial
  // da Onda 1, achado 1): dentro dela, a leitura pediria uma 2ª conexão do
  // pool com a 1ª presa segurando locks — travamento permanente sob carga.
  const automationConfig = await resolveTitleAutomationConfig(
    schemaName, institutionId, userId)

  // Q-A5 (3ª rodada adversarial do cancelamento, 2026-09-09): os locks da
  // Rodada 2 (trava D5 no plano do cancelamento; MAX(number_seq) na sequência
  // 'SE') deadlockam com este módulo — vítima reexecuta, nunca 500 (mesma peça
  // do billing, bank-slips, checks e settlements).
  return withDeadlockRetry('faturamento da OS', { institutionId, orderId }, 3, async () => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      // Regra 7 do PADROES §9 (Q-A12): esta transação CUNHA número de nota
      // (MAX(number_seq) da série 'SE') e, pela automação, settled_code e
      // nosso número — o lock da institution é o PRIMEIRO lock exclusivo, nunca
      // no meio. Sem ele, os gap locks do MAX são compatíveis entre si e N
      // faturamentos concorrentes deadlockavam além dos 3 retries (o gate
      // adversarial provou 6 de 12 morrendo com 1213).
      await lockInstitutionCounters(conn, institutionId)
      await lockOpenOrder(conn, schemaName, institutionId, orderId)

      // M1 (gate socrático R5): condições vindas do fato da competência são
      // reconferidas AQUI, sob o lock da ordem — o mesmo padrão fixado na
      // negociação do pedido ("resolver DENTRO da transação, após o FOR UPDATE")
      const terms = await resolveInvoiceTermsTx(conn, schemaName, institutionId, orderId, input)

      // forma VINCULADA/habilitada + nº de parcelas ≤ max_parcels do vínculo —
      // a MESMA regra das três portas (Q-N1 da negociação do pedido, 2026-09-07)
      await assertPaymentRules(conn, schemaName, institutionId, {
        headerPaymentTypeId: terms.paymentTypeId, parcels: [], nParcels: input.parcels,
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
      // Q-A20 (cinto): o faturamento revalida os itens — produto vivo, ativo e
      // SERVIÇO (item gravado antes da guarda, ou produto inativado depois)
      const [badItems] = await conn.query<any[]>(
        `SELECT COUNT(*) AS n FROM \`${schemaName}\`.tb_order_item i
           LEFT JOIN \`${schemaName}\`.tb_product p
             ON p.id = i.tb_product_id AND p.tb_institution_id = i.tb_institution_id AND p.deleted = 'N'
          WHERE i.tb_order_id = ? AND i.tb_institution_id = ? AND i.terminal = 0 AND i.deleted = 'N'
            AND (p.id IS NULL OR p.active <> 'S' OR p.kind <> 'S')`,
        [orderId, institutionId]
      )
      if (Number(badItems[0].n) > 0) {
        throw new HttpError(422, 'Ordem tem item que não é serviço ativo — corrija os itens antes de faturar',
          [{ field: 'items', message: 'Item com produto inexistente, inativo ou de mercadoria' }],
          'SERVICE_ORDER_ITEM_NOT_SERVICE')
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
        paymentTypeId: terms.paymentTypeId, deadline: null, plots: input.parcels,
      })

      // fatura INTERNA (DP8: model 'SE', série '1'; emissão OFICIAL da NFS-e =
      // P1 futura) pela MESMA peça da nota de venda — Q-G3 (Valdo 2026-09-09:
      // "a nota da OS deve ser cancelável"): evento E, numeração D4 por
      // modelo/série, cabeçalho REVIVIDO no refaturamento; o cancelamento
      // (POST /billing/cancel) reabre a OS devolvendo a trava D5.
      const { invoiceNumber } = await issueInvoice(conn, schemaName, institutionId, userId, {
        orderId, recipientEntityId: customerId, model: 'SE', serie: '1', totalValue: total,
        noteText: null, merchandise: null, serviceTotal: null,
      })

      // financeiro: 1 tb_financial + 1 bill 'RA' POR PARCELA (P7 — PK natural);
      // ON DUPLICATE KEY = revive da parcela soft-deletada pelo cancelamento
      const quotas = parcelQuotas(total, input.parcels)
      for (let parcel = 1; parcel <= input.parcels; parcel++) {
        await conn.query(
          `INSERT INTO \`${schemaName}\`.tb_financial
             (tb_institution_id, tb_order_id, terminal, parcel, dt_expiration,
              tb_payment_types_id, tag_value, created_at, updated_at, deleted)
           VALUES (?, ?, 0, ?, ?, ?, ?, NOW(), NOW(), 'N')
           ON DUPLICATE KEY UPDATE
             dt_expiration = VALUES(dt_expiration), tb_payment_types_id = VALUES(tb_payment_types_id),
             tag_value = VALUES(tag_value), deleted = 'N', updated_at = NOW()`,
          [institutionId, orderId, parcel, terms.dtExpiration,
           terms.paymentTypeId, quotas[parcel - 1]]
        )
        await conn.query(
          `INSERT INTO \`${schemaName}\`.tb_financial_bills
             (tb_institution_id, tb_order_id, terminal, parcel,
              tb_financial_plans_id, number, kind, situation, operation, stage,
              created_at, updated_at, deleted)
           VALUES (?, ?, 0, ?, 0, ?, 'RA', 'N', 'C', 'N', NOW(), NOW(), 'N')
           ON DUPLICATE KEY UPDATE
             tb_financial_plans_id = 0, number = VALUES(number), kind = 'RA',
             situation = 'N', operation = 'C', stage = 'N', deleted = 'N', updated_at = NOW()`,
          [institutionId, orderId, parcel,
           `${orderId}/${invoiceNumber}-${parcel}`]
        )
      }

      // AUTOMATISMOS do nascimento do título (achado A1 da Onda 0 / D5 da fase
      // Primeiro Cliente, Valdo 2026-09-13): até aqui o faturamento da OS
      // gravava os títulos e parava — a baixa por regra de recebimento e o
      // boleto automático só existiam no billing da VENDA. Como a receita de
      // contrato mensal nasce toda por este caminho, a cobrança da Setes saía
      // sem boleto e sem baixa. Mesma composição, mesma política, dois
      // chamadores (a OS NÃO delega ao módulo billing — D5).
      const automation = await applyTitleAutomation(
        conn, schemaName, institutionId, userId, {
          orderId,
          dtPayment: localIsoDate(),
          parcels: Array.from({ length: input.parcels }, (_, i) => ({
            parcel: i + 1,
            paymentTypeId: terms.paymentTypeId,
            amount: quotas[i],
          })),
        }, automationConfig)

      // A→F no backbone (DP7) + libera a trava D5
      await conn.query(
        `UPDATE \`${schemaName}\`.tb_order
            SET status = 'F', updated_at = NOW()
          WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
        [orderId, institutionId]
      )
      await conn.query(
        `UPDATE \`${schemaName}\`.tb_service_order
          SET open_lock = NULL, updated_at = NOW()
          WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
        [orderId, institutionId]
      )

      await conn.commit()
      // O que a automação FEZ volta no resultado (gate adversarial, achado 5):
      // "faturada" sem dizer se houve baixa ou boleto esconde o pior caso da
      // cobrança mensal — lote 100 % faturado e zero cobrado.
      return {
        invoiceNumber, parcels: input.parcels, totalValue: total,
        dtExpiration: terms.dtExpiration, paymentTypeId: terms.paymentTypeId,
        autoSettled: automation.autoSettled,
        bankSlipsIssued: automation.bankSlipsIssued,
        chargeableParcels: automation.chargeable,
      }
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
  })
}
