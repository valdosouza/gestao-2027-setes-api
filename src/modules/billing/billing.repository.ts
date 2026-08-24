import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { assertSchema } from '@shared/db/schema'
import { ItemTaxCalcResult } from '@shared/tax-rule'
import { tryAutoSettleCash } from '@shared/financial-settlement'
import { insertCommissions, CommissionEntryInput } from '@shared/commission'
import { persistReturn, assertReturnableInTx, ReturnPlan } from '@shared/order-return'
import logger from '@shared/logger/logger'
import {
  OrderBranch, BillingOrderItem, ItemTaxRuleLink, InvoiceResult,
} from './billing.interface'

/**
 * Repositório do faturamento (W2 Onda 3). Leituras fora de transação; a
 * gravação da nota inteira (impostos por item + invoice + financeiro +
 * status) acontece em UMA transação (persistInvoice — molde generateInvoice
 * do service-orders). As tabelas de imposto por item são as do BASELINE
 * (Rodada 3: primeiras produtoras = este módulo; o sync nunca as toca).
 */

export interface OrderBranchInfo {
  branch: OrderBranch
  recipientEntityId: number
  direction: 'E' | 'S'
}

export async function getOrderStatus(
  schemaName: string, institutionId: number, orderId: number
): Promise<string | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT status FROM \`${s}\`.tb_order
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
    [orderId, institutionId]
  )
  return rows[0] ? String(rows[0].status ?? '') : null
}

/** Identifica o ramo da ordem e o destinatário (venda/compra/ajuste/serviço). */
export async function getOrderBranch(
  schemaName: string, institutionId: number, orderId: number
): Promise<OrderBranchInfo | null> {
  const s = assertSchema(schemaName)
  const key = [orderId, institutionId]

  const [sale] = await pool.query<any[]>(
    `SELECT tb_customer_id AS entityId FROM \`${s}\`.tb_order_sale
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`, key)
  if (sale[0]) return { branch: 'sale', recipientEntityId: Number(sale[0].entityId), direction: 'S' }

  const [purchase] = await pool.query<any[]>(
    `SELECT tb_provider_id AS entityId FROM \`${s}\`.tb_order_purchase
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`, key)
  if (purchase[0]) return { branch: 'purchase', recipientEntityId: Number(purchase[0].entityId), direction: 'E' }

  const [adjust] = await pool.query<any[]>(
    `SELECT tb_entity_id AS entityId, direction FROM \`${s}\`.tb_order_stock_adjust
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`, key)
  if (adjust[0]) {
    const dir = String(adjust[0].direction) === 'E' ? 'E' : 'S'
    return { branch: 'adjust', recipientEntityId: Number(adjust[0].entityId), direction: dir }
  }

  const [service] = await pool.query<any[]>(
    `SELECT tb_customer_id AS entityId FROM \`${s}\`.tb_order_service
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0`, key)
  if (service[0]) return { branch: 'service', recipientEntityId: Number(service[0].entityId), direction: 'S' }

  return null
}

/** Itens vivos com os dados fiscais do produto (NCM/origem/finalidade/CEST). */
export async function listBillingItems(
  schemaName: string, institutionId: number, orderId: number
): Promise<BillingOrderItem[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT i.id, i.kind, i.tb_product_id AS productId,
            i.quantity, i.unit_value AS unitValue,
            COALESCE(i.discount_value, 0) AS discountValue,
            mi.tb_price_list_id AS priceListId,
            p.kind AS productKind,
            m.ncm, m.source AS origin, m.cest,
            m.kind_tributary AS purpose
       FROM \`${s}\`.tb_order_item i
       JOIN \`${s}\`.tb_product p
         ON (p.id = i.tb_product_id AND p.tb_institution_id = i.tb_institution_id)
       LEFT JOIN \`${s}\`.tb_merchandise m
         ON (m.id = i.tb_product_id AND m.tb_institution_id = i.tb_institution_id)
       LEFT JOIN \`${s}\`.tb_order_item_merchandise mi
         ON (mi.id = i.id AND mi.tb_institution_id = i.tb_institution_id
             AND mi.tb_order_id = i.tb_order_id AND mi.terminal = i.terminal
             AND mi.deleted = 'N')
      WHERE i.tb_order_id = ? AND i.tb_institution_id = ? AND i.terminal = 0
        AND i.deleted = 'N'`,
    [orderId, institutionId]
  )
  return rows.map(r => ({
    id: r.id, kind: r.kind, productId: r.productId,
    quantity: Number(r.quantity ?? 0), unitValue: Number(r.unitValue ?? 0),
    discountValue: Number(r.discountValue ?? 0),
    productKind: (r.productKind ?? 'P') as 'P' | 'M' | 'S',
    ncm: r.ncm || null, origin: r.origin || null,
    merchandiseSt: (r.cest ?? '').trim() !== '' ? 'S' : 'N',
    purpose: r.purpose || null,
    priceListId: r.priceListId === null || r.priceListId === undefined
      ? null : Number(r.priceListId),
  }))
}

export async function getItemRuleLinks(
  schemaName: string, institutionId: number, orderId: number
): Promise<ItemTaxRuleLink[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT tb_order_item_id AS orderItemId, kind,
            tb_tax_rule_id AS taxRuleId, tb_cfop_id AS cfopId,
            set_financial AS setFinancial, origin
       FROM \`${s}\`.tb_order_item_tax_rule
      WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0
        AND deleted = 'N'`,
    [orderId, institutionId]
  )
  return rows as ItemTaxRuleLink[]
}

/** Ids de regra que NÃO estão vivos (soft-deletados ou inexistentes) —
 *  gate do /invoice: link gravado com regra morta exige revalidação. */
export async function findDeadRuleIds(
  schemaName: string, ruleIds: number[]
): Promise<number[]> {
  if (ruleIds.length === 0) return []
  const s = assertSchema(schemaName)
  const unique = [...new Set(ruleIds)]
  const [rows] = await pool.query<any[]>(
    `SELECT id FROM \`${s}\`.tb_tax_rule
      WHERE id IN (?) AND deleted = 'N'`,
    [unique]
  )
  const alive = new Set(rows.map(r => Number(r.id)))
  return unique.filter(id => !alive.has(id))
}

/** Remove o vínculo AUTOMÁTICO quando a validação não acha mais regra —
 *  'A' órfão nunca sobrevive a uma validação que falhou; 'M' é intocável. */
export async function clearAutoRuleLink(
  schemaName: string, institutionId: number, orderId: number,
  itemId: number, itemKind: string
): Promise<void> {
  const s = assertSchema(schemaName)
  await pool.query(
    `UPDATE \`${s}\`.tb_order_item_tax_rule
        SET deleted = 'S', updated_at = NOW()
      WHERE tb_order_id = ? AND tb_order_item_id = ? AND tb_institution_id = ?
        AND terminal = 0 AND kind = ? AND origin = 'A' AND deleted = 'N'`,
    [orderId, itemId, institutionId, itemKind]
  )
}

/**
 * Grava a regra encontrada pela validação (origin 'A'). Linha 'M' existente
 * NUNCA é sobrescrita — o IF no UPDATE preserva a escolha do cliente.
 */
export async function upsertItemRuleAuto(
  schemaName: string, institutionId: number, orderId: number,
  itemId: number, itemKind: string, ruleId: number, cfopId: string | null
): Promise<void> {
  const s = assertSchema(schemaName)
  await pool.query(
    `INSERT INTO \`${s}\`.tb_order_item_tax_rule
       (tb_order_id, tb_order_item_id, tb_institution_id, terminal, kind,
        tb_tax_rule_id, tb_cfop_id, set_financial, origin,
        created_at, updated_at, deleted)
     VALUES (?, ?, ?, 0, ?, ?, ?, 'S', 'A', NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE
       tb_tax_rule_id = IF(origin = 'M', tb_tax_rule_id, VALUES(tb_tax_rule_id)),
       tb_cfop_id     = IF(origin = 'M', tb_cfop_id, VALUES(tb_cfop_id)),
       deleted        = IF(origin = 'M', deleted, 'N'),
       updated_at     = IF(origin = 'M', updated_at, NOW())`,
    [orderId, itemId, institutionId, itemKind, ruleId, cfopId]
  )
}

export async function getFreightAndExpenses(
  schemaName: string, institutionId: number, orderId: number
): Promise<{ freight: number; expenses: number }> {
  const s = assertSchema(schemaName)
  const [ship] = await pool.query<any[]>(
    `SELECT COALESCE(SUM(value), 0) AS freight FROM \`${s}\`.tb_order_shipping
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
    [orderId, institutionId]
  )
  const [tot] = await pool.query<any[]>(
    `SELECT COALESCE(expenses_value, 0) AS expenses FROM \`${s}\`.tb_order_totalizer
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
    [orderId, institutionId]
  )
  return {
    freight: Number(ship[0]?.freight ?? 0),
    expenses: Number(tot[0]?.expenses ?? 0),
  }
}

export async function getOrderBillingInfo(
  schemaName: string, institutionId: number, orderId: number
): Promise<{ paymentTypeId: number; deadline: string | null } | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT tb_payment_types_id AS paymentTypeId, deadline
       FROM \`${s}\`.tb_order_billing
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
    [orderId, institutionId]
  )
  return rows[0]
    ? { paymentTypeId: Number(rows[0].paymentTypeId), deadline: rows[0].deadline || null }
    : null
}

/** Parcelamento ELABORADO (decisão 25) — presença = negociação parcela a parcela. */
export async function getInstallments(
  schemaName: string, institutionId: number, orderId: number
): Promise<{ parcel: number; dueDate: string; amount: number; paymentTypeId: number | null }[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT parcel, due_date AS dueDate, amount,
            tb_payment_types_id AS paymentTypeId
       FROM \`${s}\`.tb_order_installment
      WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0
        AND deleted = 'N'
      ORDER BY parcel`,
    [orderId, institutionId]
  )
  return rows.map(r => ({
    parcel: Number(r.parcel),
    dueDate: r.dueDate instanceof Date ? r.dueDate.toISOString().slice(0, 10) : String(r.dueDate),
    amount: Number(r.amount),
    paymentTypeId: r.paymentTypeId === null ? null : Number(r.paymentTypeId),
  }))
}

/** Endereço principal da entity (main='S', senão o 1º vivo). */
export async function getEntityLocation(
  entityId: number
): Promise<{ stateId: number | null; cityId: number | null; cityIssAliq: number } | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT a.tb_state_id AS stateId, a.tb_city_id AS cityId,
            COALESCE(c.aliq_iss, 0) AS cityIssAliq
       FROM setes_central.tb_address a
       LEFT JOIN setes_central.tb_city c ON c.id = a.tb_city_id
      WHERE a.id = ? AND a.deleted = 'N'
      ORDER BY (a.main = 'S') DESC
      LIMIT 1`,
    [entityId]
  )
  return rows[0]
    ? { stateId: rows[0].stateId, cityId: rows[0].cityId, cityIssAliq: Number(rows[0].cityIssAliq) }
    : null
}

// ── Motor de observações fiscais (T6/P11) ───────────────────────────────────

/** `Pc_Obs_Regra_Geral` — observações de contexto NF-e (general='2'), TODAS. */
export async function getGeneralObservations(
  schemaName: string, institutionId: number
): Promise<string[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT note FROM \`${s}\`.tb_observation
      WHERE tb_institution_id = ? AND general = '2' AND deleted = 'N'`,
    [institutionId]
  )
  return rows.map(r => String(r.note ?? '')).filter(t => t.trim() !== '')
}

/** Observação vinculada à regra (`tb_tax_rule.tb_observation_id`), por regra. */
export async function getRuleObservationNotes(
  schemaName: string, ruleIds: number[]
): Promise<Map<number, string | null>> {
  const map = new Map<number, string | null>()
  if (ruleIds.length === 0) return map
  const s = assertSchema(schemaName)
  const unique = [...new Set(ruleIds)]
  const [rows] = await pool.query<any[]>(
    `SELECT r.id AS ruleId, o.note AS note
       FROM \`${s}\`.tb_tax_rule r
       LEFT JOIN \`${s}\`.tb_observation o
         ON (o.id = r.tb_observation_id AND o.deleted = 'N')
      WHERE r.id IN (?)`,
    [unique]
  )
  for (const row of rows) map.set(Number(row.ruleId), row.note ? String(row.note) : null)
  return map
}

/** Catálogo IBPT (`setes_central.tb_ncm`) — imposto aproximado por NCM. */
export async function getNcmApproxRates(
  ncmCodes: string[]
): Promise<Map<string, { aliqNac: number; aliqImp: number; aliqEst: number; aliqMun: number }>> {
  const map = new Map<string, { aliqNac: number; aliqImp: number; aliqEst: number; aliqMun: number }>()
  if (ncmCodes.length === 0) return map
  const unique = [...new Set(ncmCodes)]
  const [rows] = await pool.query<any[]>(
    `SELECT number, aliq_nac AS aliqNac, aliq_imp AS aliqImp,
            aliq_est AS aliqEst, aliq_mun AS aliqMun
       FROM setes_central.tb_ncm WHERE number IN (?) AND deleted = 'N'`,
    [unique]
  )
  for (const row of rows) {
    map.set(String(row.number), {
      aliqNac: Number(row.aliqNac ?? 0), aliqImp: Number(row.aliqImp ?? 0),
      aliqEst: Number(row.aliqEst ?? 0), aliqMun: Number(row.aliqMun ?? 0),
    })
  }
  return map
}

// ── Persistência do faturamento (UMA transação) ────────────────────────────

export interface ComputedItem {
  item: BillingOrderItem
  link: ItemTaxRuleLink
  taxes: ItemTaxCalcResult
  merchandiseValue: number
  freightShare: number
  expensesShare: number
  ipiCst: string | null
  pisCst: string | null
  cofinsCst: string | null
  icmsExtras: {
    cst: string | null
    origin: string | null
    modBc: string | null
    modBcSt: string | null
    dischargeId: number | null
    baseReduction: number
    aliqReduction: number
    stBaseReduction: number
    mvaPct: number | null
    stAliq: number | null   // alíquota INTERNA do destino usada no value_st
  }
}

export interface PersistInvoiceParams {
  orderId: number
  recipientEntityId: number
  model: string
  serie: string
  items: ComputedItem[]
  totalValue: number
  parcels: { parcel: number; dueDate: string; amount: number; paymentTypeId: number }[]
  financialKind: string      // 'RA' venda/receber | 'PA' compra/pagar
  financialOperation: string // 'C' crédito | 'D' débito (R5-Q1 — resolveFinancialPolarity)
  noteText: string           // motor de observações (T6/P11) — já concatenado
  approxTaxByItem: Map<string, number> // `${orderItemId}|${kind}` -> % aproximado (Lei 12.741/2012)
  userId: number             // autor da baixa automática à vista (W3.2)
  /** Lançamentos de comissão por item (rodada 2026-08-24 — positivos na
   *  venda, NEGATIVOS na devolução; imutáveis, mesma transação da nota). */
  commissions: CommissionEntryInput[]
  /** Devolução de mercadoria: âncora + elos por item (presença = é devolução). */
  returnPlan: ReturnPlan | null
}

export async function persistInvoice(
  schemaName: string, institutionId: number, params: PersistInvoiceParams
): Promise<InvoiceResult> {
  const s = assertSchema(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [ord] = await conn.query<any[]>(
      `SELECT status FROM \`${s}\`.tb_order
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'
        FOR UPDATE`,
      [params.orderId, institutionId]
    )
    if (!ord[0]) throw new HttpError(404, `Ordem ${params.orderId} não encontrada`)
    if (String(ord[0].status) === 'F') {
      throw new HttpError(409, 'Ordem já faturada', undefined, 'ORDER_INVOICED')
    }

    for (const ci of params.items) {
      await persistItemTaxes(conn, s, institutionId, params.orderId, ci)

      // Imposto aproximado (Lei 12.741/2012) — persistido POR ITEM sempre
      // (T6/P11; port do ITF_IMP_APROX, independente da config da nota).
      const approxAliq = params.approxTaxByItem.get(`${ci.item.id}|${ci.item.kind}`)
      if (approxAliq !== undefined) {
        await conn.query(
          `UPDATE \`${s}\`.tb_order_item_tax_rule SET approx_tax_aliq = ?, updated_at = NOW()
            WHERE tb_order_id = ? AND tb_order_item_id = ? AND tb_institution_id = ?
              AND terminal = 0 AND kind = ?`,
          [approxAliq, params.orderId, ci.item.id, institutionId, ci.item.kind]
        )
      }
    }

    // nota: número MAX+1 por MODELO+SÉRIE (decisão R4-Q3)
    const [mx] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(CAST(number AS UNSIGNED)), 0) + 1 AS nextNumber
         FROM \`${s}\`.tb_invoice
        WHERE tb_institution_id = ? AND model = ? AND serie = ? FOR UPDATE`,
      [institutionId, params.model, params.serie]
    )
    const invoiceNumber = String(mx[0].nextNumber)

    // status '0' = pronta, NÃO transmitida (autorização = fase guardada);
    // note = motor de observações (T6/P11), texto já concatenado
    await conn.query(
      `INSERT INTO \`${s}\`.tb_invoice
         (id, tb_institution_id, terminal, issuer, number, serie,
          tb_entity_id, dt_emission, value, model, status, note, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, CURDATE(), ?, ?, '0', ?, NOW(), NOW())`,
      [params.orderId, institutionId, institutionId, invoiceNumber, params.serie,
       params.recipientEntityId, params.totalValue, params.model, params.noteText || null]
    )

    // natureza da nota = PRESENÇA do ramo (D1–D11 de notas mercadoria ×
    // serviço): cada ramo só nasce se há itens dele; conjugada = os dois.
    const merchItems = params.items.filter(ci => ci.item.productKind !== 'S')
    const serviceItems = params.items.filter(ci => ci.item.productKind === 'S')

    if (merchItems.length > 0) {
      const agg = aggregateForMerchandise(merchItems)
      await conn.query(
        `INSERT INTO \`${s}\`.tb_invoice_merchandise
           (id, tb_institution_id, terminal, base_icms_value, icms_value,
            base_icms_st_value, icms_st_value, ipi_value, total_value,
            freight_value, insurance_value, expenses_value, discount_value,
            total_qtty, indPres, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, NOW(), NOW())`,
        [params.orderId, institutionId, agg.baseIcms, agg.icms, agg.baseIcmsSt,
         agg.icmsSt, agg.ipi, params.totalValue, agg.freight, agg.expenses,
         agg.discount, agg.quantity]
      )
    }
    if (serviceItems.length > 0) {
      const serviceTotal = Math.round(serviceItems.reduce(
        (sum, ci) => sum + ci.merchandiseValue, 0) * 100) / 100
      await conn.query(
        `INSERT INTO \`${s}\`.tb_invoice_service
           (id, tb_institution_id, terminal, total_value, created_at, updated_at)
         VALUES (?, ?, 0, ?, NOW(), NOW())`,
        [params.orderId, institutionId, serviceTotal]
      )
    }

    // financeiro (decisões 25/29 — 3º produtor das MESMAS tabelas)
    for (const p of params.parcels) {
      await conn.query(
        `INSERT INTO \`${s}\`.tb_financial
           (tb_institution_id, tb_order_id, terminal, parcel, dt_expiration,
            tb_payment_types_id, tag_value, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, ?, NOW(), NOW())`,
        [institutionId, params.orderId, p.parcel, p.dueDate, p.paymentTypeId, p.amount]
      )
      await conn.query(
        `INSERT INTO \`${s}\`.tb_financial_bills
           (tb_institution_id, tb_order_id, terminal, parcel,
            tb_financial_plans_id, number, kind, situation, operation, stage,
            created_at, updated_at)
         VALUES (?, ?, 0, ?, 0, ?, ?, 'N', ?, 'N', NOW(), NOW())`,
        [institutionId, params.orderId, p.parcel,
         `${params.orderId}/${invoiceNumber}-${p.parcel}`, params.financialKind,
         params.financialOperation]
      )
    }

    // devolução de mercadoria (Q3/Q4): o saldo devolvível é REVALIDADO
    // aqui dentro, sob lock do pedido ORIGINAL (o plano foi montado fora
    // da transação — R2/HIGH dos gates), e só então âncora + elos entram.
    // INVARIANTE (gate adversarial 2026-08-24): as SUMs do recomputo
    // precisam ser as PRIMEIRAS leituras NÃO-locking desta transação —
    // um SELECT simples adicionado antes deste ponto congelaria o
    // snapshot REPEATABLE READ antes do lock e reabriria a corrida.
    if (params.returnPlan) {
      await assertReturnableInTx(
        conn, schemaName, institutionId, params.orderId, params.returnPlan)
      await persistReturn(conn, schemaName, institutionId, params.orderId, params.returnPlan)
    }

    // comissão por item (Q1/Q2): lançamentos imutáveis na MESMA transação —
    // positivos (venda) ou negativos (devolução); id reservado UMA vez
    await insertCommissions(conn, schemaName, institutionId, params.commissions)

    // baixa automática à vista em espécie (W3.2) — NÃO bloqueia o
    // faturamento (decisão do Valdo: "faturar sem baixar"). O contrato
    // gracioso de tryAutoSettleCash cobre só os 3 motivos de negócio
    // (NOT_CASH/BANK_PREFERRED/NO_OPEN_CASHIER) — qualquer falha TÉCNICA
    // inesperada (bug, deadlock, conexão) é isolada com SAVEPOINT: desfaz
    // só a baixa parcial, a nota segue vigente (achado do gate socrático,
    // rodada 2026-08-22 — sem isso um bug isolado na baixa vetava a nota
    // inteira, contradizendo a decisão).
    let autoSettled = 0
    for (const p of params.parcels) {
      await conn.query('SAVEPOINT auto_settle')
      try {
        const result = await tryAutoSettleCash(conn, schemaName, institutionId, params.userId, {
          orderId: params.orderId, parcel: p.parcel, paidValue: p.amount,
          dtPayment: p.dueDate, paymentTypeId: p.paymentTypeId,
        })
        if (result.settled) autoSettled += 1
      } catch (err) {
        await conn.query('ROLLBACK TO SAVEPOINT auto_settle')
        logger.error('Baixa automática à vista falhou — título fica aberto p/ baixa manual', {
          institutionId, orderId: params.orderId, parcel: p.parcel, err,
        })
      }
    }

    await conn.query(
      `UPDATE \`${s}\`.tb_order SET status = 'F', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
      [params.orderId, institutionId]
    )

    await conn.commit()
    return {
      orderId: params.orderId, invoiceNumber, serie: params.serie,
      model: params.model, totalValue: params.totalValue,
      parcels: params.parcels.length, autoSettled,
    }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Grava o resultado do cálculo nas tabelas de imposto por item do baseline. */
async function persistItemTaxes(
  conn: PoolConnection, s: string, institutionId: number,
  orderId: number, ci: ComputedItem
): Promise<void> {
  const key = [orderId, ci.item.id, institutionId]
  const t = ci.taxes

  if (t.icms || ci.icmsExtras.cst) {
    await conn.query(
      `INSERT INTO \`${s}\`.tb_order_item_icms
         (tb_order_id, tb_order_item_id, tb_institution_id, terminal,
          cst, origem, determ_base, determ_base_st, discharge,
          aliq_rd_base, base_value, aliq, aliq_rd, value,
          aliq_rd_base_st, base_value_st, aliq_st, value_st, mva,
          cred_calc_aliq, cred_expl_value,
          freight_value, insurance_Value, expenses_value, tb_cfop_id,
          created_at, updated_at, deleted)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         cst = VALUES(cst), origem = VALUES(origem),
         determ_base = VALUES(determ_base), determ_base_st = VALUES(determ_base_st),
         discharge = VALUES(discharge), aliq_rd_base = VALUES(aliq_rd_base),
         base_value = VALUES(base_value), aliq = VALUES(aliq),
         aliq_rd = VALUES(aliq_rd), value = VALUES(value),
         aliq_rd_base_st = VALUES(aliq_rd_base_st), base_value_st = VALUES(base_value_st),
         aliq_st = VALUES(aliq_st), value_st = VALUES(value_st), mva = VALUES(mva),
         cred_calc_aliq = VALUES(cred_calc_aliq), cred_expl_value = VALUES(cred_expl_value),
         freight_value = VALUES(freight_value), expenses_value = VALUES(expenses_value),
         tb_cfop_id = VALUES(tb_cfop_id), deleted = 'N', updated_at = NOW()`,
      [...key,
       ci.icmsExtras.cst, ci.icmsExtras.origin,
       ci.icmsExtras.modBc, ci.icmsExtras.modBcSt, ci.icmsExtras.dischargeId,
       ci.icmsExtras.baseReduction,
       t.icms?.base ?? 0, t.icms?.aliq ?? 0, ci.icmsExtras.aliqReduction,
       t.icms?.value ?? 0,
       ci.icmsExtras.stBaseReduction, t.icms?.baseSt ?? null,
       t.icms?.baseSt !== undefined ? ci.icmsExtras.stAliq : null,
       t.icms?.valueSt ?? null, ci.icmsExtras.mvaPct,
       t.icms?.creditAliq ?? null, t.icms?.creditValue ?? null,
       ci.freightShare, ci.expensesShare, ci.link.cfopId]
    )
  }

  if (t.fcp || t.fcpSt) {
    // tabela sem PK (baseline) — limpa antes para o refaturamento não duplicar
    await conn.query(
      `DELETE FROM \`${s}\`.tb_order_item_icms_fcp
        WHERE tb_order_id = ? AND tb_order_item_id = ? AND tb_institution_id = ?
          AND terminal = 0`,
      key
    )
    await conn.query(
      `INSERT INTO \`${s}\`.tb_order_item_icms_fcp
         (tb_order_id, tb_order_item_id, tb_institution_id, terminal,
          vbcfcp, pfcp, vfcp, vbcfcpst, pfcpst, vfcpst,
          created_at, updated_at, deleted)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
      [...key,
       t.fcp?.base ?? null, t.fcp ? percentOf(t.fcp.value, t.fcp.base) : null, t.fcp?.value ?? null,
       t.fcpSt?.base ?? null, t.fcpSt ? percentOf(t.fcpSt.value, t.fcpSt.base) : null, t.fcpSt?.value ?? null]
    )
  }

  if (t.ipi) {
    await conn.query(
      `INSERT INTO \`${s}\`.tb_order_item_ipi
         (tb_order_id, tb_order_item_id, tb_institution_id, terminal,
          cst, class_frame_code, base_value, aliq_value,
          created_at, updated_at, deleted)
       VALUES (?, ?, ?, 0, ?, '999', ?, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         cst = VALUES(cst), base_value = VALUES(base_value),
         aliq_value = VALUES(aliq_value), deleted = 'N', updated_at = NOW()`,
      [...key, ci.ipiCst, t.ipi.base, t.ipi.aliq]
    )
  }

  if (t.ii) {
    await conn.query(
      `INSERT INTO \`${s}\`.tb_order_item_ii
         (tb_institution_id, tb_order_id, terminal, tb_order_item_id,
          base_value, customs_expense, tag_value, iof_value,
          created_at, updated_at, deleted)
       VALUES (?, ?, 0, ?, ?, 0, ?, 0, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         base_value = VALUES(base_value), tag_value = VALUES(tag_value),
         deleted = 'N', updated_at = NOW()`,
      [institutionId, orderId, ci.item.id, t.ii.base, t.ii.iiValue]
    )
  }

  for (const pc of t.pisCofins ?? []) {
    const table = pc.kind === 'P' ? 'tb_order_item_pis' : 'tb_order_item_cofins'
    await conn.query(
      `INSERT INTO \`${s}\`.${table}
         (tb_order_id, tb_order_item_id, tb_institution_id, terminal,
          cst, base_value, aliq_value, tag_value,
          created_at, updated_at, deleted)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         cst = VALUES(cst), base_value = VALUES(base_value),
         aliq_value = VALUES(aliq_value), tag_value = VALUES(tag_value),
         deleted = 'N', updated_at = NOW()`,
      [...key, pc.kind === 'P' ? ci.pisCst : ci.cofinsCst, pc.base, pc.aliq, pc.value]
    )
  }

  if (t.issqn) {
    await conn.query(
      `INSERT INTO \`${s}\`.tb_order_item_issqn
         (tb_order_id, tb_order_item_id, tb_institution_id, terminal,
          base_value, aliq_value, tag_value,
          created_at, updated_at, deleted)
       VALUES (?, ?, ?, 0, ?, ?, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         base_value = VALUES(base_value), aliq_value = VALUES(aliq_value),
         tag_value = VALUES(tag_value), deleted = 'N', updated_at = NOW()`,
      [...key, t.issqn.base, t.issqn.aliq, t.issqn.value]
    )
  }
}

function percentOf(value: number, base: number): number {
  if (base === 0) return 0
  return Math.round((value / base) * 1000000) / 10000
}

function aggregateForMerchandise(items: ComputedItem[]) {
  const agg = {
    baseIcms: 0, icms: 0, baseIcmsSt: 0, icmsSt: 0, ipi: 0,
    freight: 0, expenses: 0, discount: 0, quantity: 0,
  }
  for (const ci of items) {
    agg.baseIcms += ci.taxes.icms?.base ?? 0
    agg.icms += ci.taxes.icms?.value ?? 0
    agg.baseIcmsSt += ci.taxes.icms?.baseSt ?? 0
    agg.icmsSt += ci.taxes.icms?.valueSt ?? 0
    agg.ipi += ci.taxes.ipi?.value ?? 0
    agg.freight += ci.freightShare
    agg.expenses += ci.expensesShare
    agg.discount += ci.item.discountValue
    agg.quantity += ci.item.quantity
  }
  for (const k of Object.keys(agg) as (keyof typeof agg)[]) {
    agg[k] = Math.round(agg[k] * 100) / 100
  }
  return agg
}
