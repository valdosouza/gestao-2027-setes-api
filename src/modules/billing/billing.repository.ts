import { todayFor } from '@shared/time-zone'
import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { assertSchema } from '@shared/db/schema'
import { ItemTaxCalcResult } from '@shared/tax-rule'
import {
  applyTitleAutomation, TitleAutomationConfig,
} from '@shared/title-automation'
import { receiveChecksOnBilling, CheckReceiveItem } from '@shared/check'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { insertCommissions, CommissionEntryInput } from '@shared/commission'
import { issueInvoice, InvoiceServiceInput } from '@shared/invoice'
import { IssLiability } from '@shared/entity-tax/entity-tax.types'
import { persistReturn, assertReturnableInTx, ReturnPlan } from '@shared/order-return'
import logger from '@shared/logger/logger'
import { assertOrderOpen } from '@shared/order'
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

/**
 * Q-A8 (3ª rodada adversarial do cancelamento, Valdo 2026-09-09): o VALIDATE
 * acusa a ordem sem condições de cobrança (forma/prazo) como issue — antes
 * devolvia 200 limpo e o INVOICE caía em 422 ORDER_NO_BILLING. Vale para a
 * venda (negociação) e para a devolução (herda da venda — D-A4).
 */
export async function hasOrderBilling(
  schemaName: string, institutionId: number, orderId: number
): Promise<boolean> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM \`${s}\`.tb_order_billing
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N' LIMIT 1`,
    [orderId, institutionId]
  )
  return rows.length > 0
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
            p.kind AS productKind, p.description AS productDescription,
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
    productDescription: r.productDescription ?? null,
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

/** Vínculo por item da regra de SERVIÇO (tb_order_item_service_tax_rule —
 *  irmã da tb_order_item_tax_rule, D14). */
export interface ItemServiceTaxRuleLink {
  orderItemId: number
  kind: string
  serviceTaxRuleId: number
  origin: 'A' | 'M'
}

export async function getItemServiceRuleLinks(
  schemaName: string, institutionId: number, orderId: number
): Promise<ItemServiceTaxRuleLink[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT tb_order_item_id AS orderItemId, kind,
            tb_service_tax_rule_id AS serviceTaxRuleId, origin
       FROM \`${s}\`.tb_order_item_service_tax_rule
      WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0
        AND deleted = 'N'`,
    [orderId, institutionId]
  )
  return rows as ItemServiceTaxRuleLink[]
}

export async function clearAutoServiceRuleLink(
  schemaName: string, institutionId: number, orderId: number,
  itemId: number, itemKind: string
): Promise<void> {
  const s = assertSchema(schemaName)
  await pool.query(
    `UPDATE \`${s}\`.tb_order_item_service_tax_rule
        SET deleted = 'S', updated_at = NOW()
      WHERE tb_order_id = ? AND tb_order_item_id = ? AND tb_institution_id = ?
        AND terminal = 0 AND kind = ? AND origin = 'A' AND deleted = 'N'`,
    [orderId, itemId, institutionId, itemKind]
  )
}

/** Grava a regra de serviço resolvida (origin 'A'); 'M' nunca é sobrescrita. */
export async function upsertItemServiceRuleAuto(
  schemaName: string, institutionId: number, orderId: number,
  itemId: number, itemKind: string, ruleId: number
): Promise<void> {
  const s = assertSchema(schemaName)
  await pool.query(
    `INSERT INTO \`${s}\`.tb_order_item_service_tax_rule
       (tb_order_id, tb_order_item_id, tb_institution_id, terminal, kind,
        tb_service_tax_rule_id, origin, created_at, updated_at, deleted)
     VALUES (?, ?, ?, 0, ?, ?, 'A', NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE
       tb_service_tax_rule_id = IF(origin = 'M', tb_service_tax_rule_id, VALUES(tb_service_tax_rule_id)),
       deleted    = IF(origin = 'M', deleted, 'N'),
       updated_at = IF(origin = 'M', updated_at, NOW())`,
    [orderId, itemId, institutionId, itemKind, ruleId]
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

// getOrderBillingInfo / getInstallments MIGRARAM para @shared/order-billing e
// @shared/order-installment (composição resolveOrderParcels — 2026-09-06).

/** kind das formas de pagamento (catálogo central) — D9 do cheque decide por parcela. */
export async function getPaymentTypeKinds(
  paymentTypeIds: number[], db: Pick<PoolConnection, 'query'> = pool
): Promise<Map<number, string>> {
  if (paymentTypeIds.length === 0) return new Map()
  const [rows] = await db.query<any[]>(
    `SELECT id, kind FROM setes_central.tb_payment_types WHERE id IN (?) AND deleted = 'N'`,
    [paymentTypeIds]
  )
  return new Map(rows.map(r => [Number(r.id), String(r.kind)]))
}

/** Endereço principal da entity (main='S', senão o 1º vivo). */
export async function getEntityLocation(
  entityId: number
): Promise<{ stateId: number | null; cityId: number | null } | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT a.tb_state_id AS stateId, a.tb_city_id AS cityId
       FROM setes_central.tb_address a
      WHERE a.id = ? AND a.deleted = 'N'
      ORDER BY (a.main = 'S') DESC
      LIMIT 1`,
    [entityId]
  )
  return rows[0]
    ? { stateId: rows[0].stateId, cityId: rows[0].cityId }
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
  /** Serviço: item LC 116 + códigos da regra (D4; Onda 3: nacional, cidade de incidência,
   *  alíquota) → tb_order_item_issqn e o ramo de serviço congelado. */
  issqnExtras: {
    serviceListId: string; municipalCode: string | null
    nationalCode: string | null; cityId: number; aliq: number
  } | null
}

export interface PersistInvoiceParams {
  orderId: number
  recipientEntityId: number
  model: string
  serie: string
  items: ComputedItem[]
  totalValue: number
  /** Resolução das parcelas DENTRO da transação, após o FOR UPDATE em tb_order
   *  (gate socrático 2026-09-06 — TOCTOU): composição @shared/order-installment
   *  + validação dos cheques; o retry em deadlock re-resolve junto. */
  resolveParcels: (conn: PoolConnection) => Promise<{ parcel: number; dueDate: string; amount: number; paymentTypeId: number }[]>
  /** Cheques por parcela (D8/D9 do cheque) — só parcelas de forma kind='Q'
   *  usam isto; a soma por parcela já foi validada em billing.service. */
  checks: { parcel: number; items: CheckReceiveItem[] }[]
  financialKind: string      // 'RA' venda/receber | 'PA' compra/pagar
  financialOperation: string // 'C' crédito | 'D' débito (R5-Q1 — resolveFinancialPolarity)
  noteText: string           // motor de observações (T6/P11) — já concatenado
  approxTaxByItem: Map<string, number> // `${orderItemId}|${kind}` -> % aproximado (Lei 12.741/2012)
  userId: number             // autor da baixa automática (regra de recebimento) e dos boletos
  /** Config `auto_bank_slip` da interface billing (D18 do contrato / D9 do
   *  boleto): com 1 carteira ATIVA emite 1 boleto por parcela em boleto. */
  automationConfig: TitleAutomationConfig
  /** Lançamentos de comissão por item (rodada 2026-08-24 — positivos na
   *  venda, NEGATIVOS na devolução; imutáveis, mesma transação da nota). */
  commissions: CommissionEntryInput[]
  /** D-N20: tribISSQN do ramo de serviço, derivado da exigibilidade do ISS do EMITENTE (billing.service). */
  serviceLiability?: IssLiability
  /** LOW-9: config `dps_description_format` ('I' itens · 'O' observação · 'A' ambos); default 'I'. */
  dpsDescriptionFormat?: 'I' | 'O' | 'A'
  /** Devolução de mercadoria: âncora + elos por item (presença = é devolução). */
  returnPlan: ReturnPlan | null
}

/** Tentativas da transação do faturamento em deadlock (D-G4 — Rodada 4 do contrato). */
const INVOICE_DEADLOCK_ATTEMPTS = 3

/** D-G4 (2026-09-04): ver `@shared/db/deadlock-retry` — reexecuta a transação inteira. */
export async function persistInvoice(
  schemaName: string, institutionId: number, params: PersistInvoiceParams
): Promise<InvoiceResult> {
  return withDeadlockRetry('faturamento', { institutionId, orderId: params.orderId },
    INVOICE_DEADLOCK_ATTEMPTS, () => persistInvoiceOnce(schemaName, institutionId, params))
}

async function persistInvoiceOnce(
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
    // guarda travante — MESMO predicado do service (D3/D4: 'C' nunca refatura)
    assertOrderOpen(String(ord[0].status), params.orderId)

    // parcelas resolvidas SOB o lock do pedido (negociação não pode mudar por baixo)
    const parcels = await params.resolveParcels(conn)

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

    // nota + ramos + evento E pela PEÇA @shared/invoice (cancelamento D3/D4/
    // D5/D17, 2026-09-08): número MAX+1 por modelo+série IGNORA canceladas
    // (deleted='S'), cabeçalho e ramos REVIVEM por upsert no refaturamento,
    // status '0' = pronta, NÃO transmitida (autorização = fase guardada);
    // note = motor de observações (T6/P11), texto já concatenado.
    // natureza da nota = PRESENÇA do ramo (D1–D11 de notas mercadoria ×
    // serviço): cada ramo só nasce se há itens dele; conjugada = os dois.
    const merchItems = params.items.filter(ci => ci.item.productKind !== 'S')
    const serviceItems = params.items.filter(ci => ci.item.productKind === 'S')
    const agg = merchItems.length > 0 ? aggregateForMerchandise(merchItems) : null
    const issued = await issueInvoice(conn, s, institutionId, params.userId, {
      orderId: params.orderId, recipientEntityId: params.recipientEntityId,
      model: params.model, serie: params.serie, totalValue: params.totalValue,
      noteText: params.noteText || null,
      merchandise: agg ? {
        baseIcms: agg.baseIcms, icms: agg.icms, baseIcmsSt: agg.baseIcmsSt, icmsSt: agg.icmsSt,
        ipi: agg.ipi, totalValue: params.totalValue, freight: agg.freight,
        expenses: agg.expenses, discount: agg.discount, quantity: agg.quantity,
      } : null,
      service: serviceItems.length > 0
        ? buildServiceBranch(serviceItems, { liability: params.serviceLiability, descriptionFormat: params.dpsDescriptionFormat, noteText: params.noteText || null })
        : null,
    })
    const invoiceNumber = issued.invoiceNumber

    // financeiro (decisões 25/29 — 3º produtor das MESMAS tabelas)
    for (const p of parcels) {
      await conn.query(
        `INSERT INTO \`${s}\`.tb_financial
           (tb_institution_id, tb_order_id, terminal, parcel, dt_expiration,
            tb_payment_types_id, tag_value, created_at, updated_at, deleted)
         VALUES (?, ?, 0, ?, ?, ?, ?, NOW(), NOW(), 'N')
         ON DUPLICATE KEY UPDATE
           dt_expiration = VALUES(dt_expiration), tb_payment_types_id = VALUES(tb_payment_types_id),
           tag_value = VALUES(tag_value), deleted = 'N', updated_at = NOW()`,
        [institutionId, params.orderId, p.parcel, p.dueDate, p.paymentTypeId, p.amount]
      )
      await conn.query(
        `INSERT INTO \`${s}\`.tb_financial_bills
           (tb_institution_id, tb_order_id, terminal, parcel,
            tb_financial_plans_id, number, kind, situation, operation, stage,
            created_at, updated_at, deleted)
         VALUES (?, ?, 0, ?, 0, ?, ?, 'N', ?, 'N', NOW(), NOW(), 'N')
         ON DUPLICATE KEY UPDATE
           tb_financial_plans_id = 0, number = VALUES(number), kind = VALUES(kind),
           situation = 'N', operation = VALUES(operation), stage = 'N',
           deleted = 'N', updated_at = NOW()`,
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

    // data LOCAL do faturamento — fato gerador dos automatismos e do cheque
    const invoiceDate = await todayFor(schemaName, institutionId, conn)   // Q-TZ1

    // recebimento de CHEQUES (D8/D9 do cheque — Infra-IA/prompts/prompt_
    // cheque_rastreabilidade.md): nasce SÓ aqui, na transação da baixa —
    // diferente do contrato/boleto (mecanismos OPCIONAIS que nunca
    // bloqueiam), aqui o usuário JÁ digitou os dados do cheque; sem caixa
    // aberto a operação é RECUSADA (409), não silenciosamente ignorada —
    // não há outro jeito de o cheque nascer no sistema. Erro propaga e
    // derruba o faturamento (sem SAVEPOINT — decisão deliberada).
    for (const c of params.checks) {
      if (c.items.length === 0) continue
      await receiveChecksOnBilling(conn, schemaName, institutionId, params.userId, {
        orderId: params.orderId, parcel: c.parcel, dtPayment: invoiceDate,
        entityId: params.recipientEntityId, checks: c.items,
      })
    }

    // AUTOMATISMOS do nascimento do título — composição @shared/title-automation
    // (extraída na Onda 1 da fase Primeiro Cliente, 2026-09-13): baixa por
    // regra de recebimento + boleto automático, com a MESMA política nas duas
    // portas que faturam (venda aqui, ordem de serviço no módulo service-orders).
    // Nada aqui bloqueia a nota; a data do fato gerador é a data LOCAL de hoje.
    // Roda DEPOIS do cheque, na ordem canônica de locks da regra 3 do
    // PADROES §9 (título → cheque → baixa → extrato; boleto DEPOIS): as telas
    // de Cheques e de Boletos adquirem nessa ordem, e faturar em sentido
    // contrário abriria cruzamento de locks com elas (gate socrático, M1).
    // O resultado de negócio não muda: as parcelas são disjuntas por kind — a
    // auto-baixa recusa 'Q' e 'B' (KIND_FIXED), o boleto só emite em 'B' e o
    // cheque só nasce em 'Q'.
    const automation = await applyTitleAutomation(
      conn, schemaName, institutionId, params.userId, {
        orderId: params.orderId,
        dtPayment: invoiceDate,
        parcels: parcels.map(p => ({
          parcel: p.parcel, paymentTypeId: p.paymentTypeId, amount: p.amount,
        })),
      }, params.automationConfig)

    await conn.query(
      `UPDATE \`${s}\`.tb_order SET status = 'F', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
      [params.orderId, institutionId]
    )

    await conn.commit()
    return {
      orderId: params.orderId, invoiceNumber, serie: params.serie,
      model: params.model, totalValue: params.totalValue,
      parcels: parcels.length,
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
          base_value, aliq_value, tag_value, listservice, tax_code,
          created_at, updated_at, deleted)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         base_value = VALUES(base_value), aliq_value = VALUES(aliq_value),
         tag_value = VALUES(tag_value), listservice = VALUES(listservice),
         tax_code = VALUES(tax_code), deleted = 'N', updated_at = NOW()`,
      [...key, t.issqn.base, t.issqn.aliq, t.issqn.value,
       ci.issqnExtras?.serviceListId ?? null, ci.issqnExtras?.municipalCode ?? null]
    )
  }
}

/**
 * Ramo de SERVIÇO congelado (Onda 3 — migration 058): um DPS declara UM serviço
 * (D-N2), então os itens de serviço da nota têm que partilhar o MESMO código
 * nacional (e, por construção, a mesma regra: subitem/cidade/alíquota/municipal).
 * Divergência = 422 INVOICE_SERVICE_MULTI_CODE — fature em ordens separadas.
 * Retenção: qualquer item com ISS retido marca o ramo (fonte = tomador, D-N8).
 */
export interface ServiceBranchOptions {
  /** D-N20: tribISSQN pela exigibilidade do EMITENTE; ausente = '1' tributável. */
  liability?: IssLiability
  /** LOW-9: 'I' itens (qtd x nome) · 'O' observação da nota · 'A' ambos. */
  descriptionFormat?: 'I' | 'O' | 'A'
  noteText?: string | null
}

/** xDescServ conforme a config (LOW-9); observação vazia cai nos itens para o DPS nunca sair sem descrição. */
export function serviceDescription(items: string, noteText: string | null | undefined, format: 'I' | 'O' | 'A' = 'I'): string | null {
  const note = (noteText ?? '').trim()
  const text = format === 'O' ? (note || items) : format === 'A' ? [items, note].filter(Boolean).join('\n') : items
  return text.slice(0, 2000) || null
}

export function buildServiceBranch(serviceItems: ComputedItem[], opts: ServiceBranchOptions = {}): InvoiceServiceInput {
  const r2 = (n: number) => Math.round(n * 100) / 100
  const codes = new Set(serviceItems.map(ci => ci.issqnExtras?.nationalCode ?? ''))
  if (codes.size > 1) {
    throw new HttpError(422, 'Nota de serviço com mais de um código de tributação nacional — um DPS declara UM serviço; fature em ordens separadas',
      serviceItems.map(ci => ({ field: `item.${ci.item.id}`, message: `Código nacional ${ci.issqnExtras?.nationalCode ?? '—'}` })),
      'INVOICE_SERVICE_MULTI_CODE')
  }
  const first = serviceItems[0].issqnExtras
  if (!first || !first.nationalCode) {
    throw new HttpError(422, 'Regra de ISS sem código de tributação nacional — escolha o desdobro do Anexo B na regra',
      [{ field: `item.${serviceItems[0].item.id}`, message: 'Regra sem código nacional' }], 'SERVICE_RULE_NATIONAL_CODE_REQUIRED')
  }
  const baseIss = r2(serviceItems.reduce((sum, ci) => sum + (ci.taxes.issqn?.base ?? 0), 0))
  const issValue = r2(serviceItems.reduce((sum, ci) => sum + (ci.taxes.issqn?.value ?? 0), 0))
  const withheld = serviceItems.some(ci => (ci.taxes.issqn?.withheldValue ?? 0) > 0)
  const itemsText = serviceItems
    .map(ci => `${ci.item.quantity > 1 ? ci.item.quantity + ' x ' : ''}${(ci.item.productDescription ?? `Serviço ${ci.item.productId}`).trim()}`)
    .join('; ')
  const description = serviceDescription(itemsText, opts.noteText, opts.descriptionFormat ?? 'I')
  return {
    totalValue: r2(serviceItems.reduce((sum, ci) => sum + ci.merchandiseValue, 0)),
    serviceListId: first.serviceListId, nationalCode: first.nationalCode,
    municipalCode: first.municipalCode, cityId: first.cityId,
    baseIss, aliqIss: first.aliq, issValue, issWithheld: withheld ? 'S' : 'N', liability: opts.liability ?? '1',
    description,
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
