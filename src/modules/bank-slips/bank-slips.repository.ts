import pool from '@shared/db/connection'
import { assertSchemaName } from '@shared/field-config'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import {
  LAST_EVENT_KIND_SQL, stateFromLastEvent, BankSlipState,
  issueBankSlip, settleBankSlip, cancelBankSlip, reverseBankSlipSettlement,
  IssueBankSlipInput, IssueBankSlipResult, SettleBankSlipInput, SettleBankSlipResult,
} from '@shared/bank-slip'
import {
  BankSlipListRow, BankSlipFull, BankSlipTitleRow, BankSlipEventRow,
  AgreementLookupRow, OpenTitleRow,
} from './bank-slips.interface'

/**
 * Repositório do módulo bank-slips: LEITURAS (lista por estado derivado,
 * detalhe com títulos + eventos, lookups) e wrappers TRANSACIONAIS sobre a
 * peça @shared/bank-slip (emitir / liquidar / cancelar / estornar).
 */

const ACCOUNT_LABEL = `CASE WHEN a.id IS NULL THEN NULL
       ELSE CONCAT(COALESCE(b.description, ''), ' — ', COALESCE(a.agency, ''), '/', COALESCE(a.number, '')) END`

/** Nome do cliente pelo 1º título do boleto (cadeia da ordem: venda/serviço/financeiro). */
const CUSTOMER_NAME_SQL = (s: string) => `
  (SELECT COALESCE(e.nick_trade, e.name_company)
     FROM \`${s}\`.tb_bank_slip_title t
     LEFT JOIN \`${s}\`.tb_order_sale osl
       ON osl.id = t.tb_order_id AND osl.tb_institution_id = t.tb_institution_id AND osl.terminal = t.terminal
     LEFT JOIN \`${s}\`.tb_order_service osv
       ON osv.id = t.tb_order_id AND osv.tb_institution_id = t.tb_institution_id AND osv.terminal = t.terminal
     LEFT JOIN \`${s}\`.tb_order_financial ofn
       ON ofn.id = t.tb_order_id AND ofn.tb_institution_id = t.tb_institution_id AND ofn.terminal = t.terminal
     LEFT JOIN setes_central.tb_entity e
       ON e.id = COALESCE(osl.tb_customer_id, osv.tb_customer_id, ofn.tb_entity_id)
    WHERE t.tb_institution_id = bs.tb_institution_id AND t.tb_bank_slip_id = bs.id AND t.deleted = 'N'
    ORDER BY t.tb_order_id, t.parcel LIMIT 1)`

const STATE_SQL = (s: string) =>
  `CASE ${LAST_EVENT_KIND_SQL(s)} WHEN 'L' THEN 'settled' WHEN 'C' THEN 'cancelled' ELSE 'open' END`

/**
 * Lista PAGINADA por estado derivado (HAVING sobre alias — COUNT via
 * subquery, molde settlements.listBills). ORDER BY estável (D8).
 */
export async function listBankSlips(
  status: BankSlipState | '', query: ListQuery, schemaName: string, institutionId: number
): Promise<PagedRows<BankSlipListRow>> {
  assertSchemaName(schemaName)
  const s = schemaName
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const having = status ? 'HAVING state = ?' : ''
  const where =
    `FROM \`${s}\`.tb_bank_slip bs
     LEFT JOIN \`${s}\`.tb_bank_account a
            ON a.id = bs.tb_bank_account_id AND a.tb_institution_id = bs.tb_institution_id
     LEFT JOIN setes_central.tb_bank b ON b.id = a.tb_bank_id
     WHERE bs.tb_institution_id = ? AND bs.deleted = 'N'
       AND (? IS NULL OR bs.our_number LIKE ? OR bs.document_number LIKE ?)`
  const params: any[] = [institutionId, like, like, like]
  const havingParams = status ? [status] : []

  const [rows] = await pool.query<any[]>(
    `SELECT bs.id, bs.our_number AS ourNumber, bs.document_number AS documentNumber,
            DATE_FORMAT(bs.dt_emission, '%Y-%m-%d') AS dtEmission,
            DATE_FORMAT(bs.dt_expiration, '%Y-%m-%d') AS dtExpiration,
            bs.value, ${STATE_SQL(s)} AS state,
            ${ACCOUNT_LABEL} AS bankAccountLabel,
            ${CUSTOMER_NAME_SQL(s)} AS customerName,
            (SELECT COUNT(*) FROM \`${s}\`.tb_bank_slip_title t
              WHERE t.tb_institution_id = bs.tb_institution_id AND t.tb_bank_slip_id = bs.id
                AND t.deleted = 'N') AS titles
     ${where}
     ${having}
     ORDER BY bs.dt_expiration DESC, bs.id DESC
     LIMIT ? OFFSET ?`,
    [...params, ...havingParams, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total FROM (
       SELECT ${STATE_SQL(s)} AS state ${where} ${having}
     ) t`,
    [...params, ...havingParams]
  )
  return { rows, total: Number(count[0].total) }
}

export async function getBankSlip(
  id: number, schemaName: string, institutionId: number
): Promise<BankSlipFull | null> {
  assertSchemaName(schemaName)
  const s = schemaName
  const [rows] = await pool.query<any[]>(
    `SELECT bs.id, bs.our_number AS ourNumber, bs.document_number AS documentNumber,
            DATE_FORMAT(bs.dt_emission, '%Y-%m-%d') AS dtEmission,
            DATE_FORMAT(bs.dt_expiration, '%Y-%m-%d') AS dtExpiration,
            bs.value, ${LAST_EVENT_KIND_SQL(s)} AS lastKind,
            ${ACCOUNT_LABEL} AS bankAccountLabel,
            ${CUSTOMER_NAME_SQL(s)} AS customerName,
            bs.tb_bank_charge_agreement_id AS agreementId,
            bs.tb_bank_account_id AS bankAccountId, bs.accept,
            bs.aliq_discount AS aliqDiscount, bs.discount_value AS discountValue,
            DATE_FORMAT(bs.dt_discount_until, '%Y-%m-%d') AS dtDiscountUntil,
            bs.aliq_interest AS aliqInterest, bs.aliq_late AS aliqLate,
            bs.value_late_min AS valueLateMin, bs.aliq_fine AS aliqFine,
            bs.value_fine AS valueFine, bs.value_rate AS valueRate,
            bs.instruction, bs.protest_days AS protestDays
       FROM \`${s}\`.tb_bank_slip bs
       LEFT JOIN \`${s}\`.tb_bank_account a
              ON a.id = bs.tb_bank_account_id AND a.tb_institution_id = bs.tb_institution_id
       LEFT JOIN setes_central.tb_bank b ON b.id = a.tb_bank_id
      WHERE bs.id = ? AND bs.tb_institution_id = ? AND bs.deleted = 'N'`,
    [id, institutionId]
  )
  if (!rows[0]) return null
  const [titleRows] = await pool.query<any[]>(
    `SELECT t.tb_order_id AS orderId, t.parcel, t.value, fb.number,
            DATE_FORMAT(f.dt_expiration, '%Y-%m-%d') AS dtExpiration,
            COALESCE(e.nick_trade, e.name_company) AS entityName
       FROM \`${s}\`.tb_bank_slip_title t
       LEFT JOIN \`${s}\`.tb_financial f
         ON f.tb_institution_id = t.tb_institution_id AND f.tb_order_id = t.tb_order_id
        AND f.terminal = t.terminal AND f.parcel = t.parcel
       LEFT JOIN \`${s}\`.tb_financial_bills fb
         ON fb.tb_institution_id = t.tb_institution_id AND fb.tb_order_id = t.tb_order_id
        AND fb.terminal = t.terminal AND fb.parcel = t.parcel AND fb.deleted = 'N'
       LEFT JOIN \`${s}\`.tb_order_sale osl
         ON osl.id = t.tb_order_id AND osl.tb_institution_id = t.tb_institution_id AND osl.terminal = t.terminal
       LEFT JOIN \`${s}\`.tb_order_service osv
         ON osv.id = t.tb_order_id AND osv.tb_institution_id = t.tb_institution_id AND osv.terminal = t.terminal
       LEFT JOIN \`${s}\`.tb_order_financial ofn
         ON ofn.id = t.tb_order_id AND ofn.tb_institution_id = t.tb_institution_id AND ofn.terminal = t.terminal
       LEFT JOIN setes_central.tb_entity e
         ON e.id = COALESCE(osl.tb_customer_id, osv.tb_customer_id, ofn.tb_entity_id)
      WHERE t.tb_institution_id = ? AND t.tb_bank_slip_id = ? AND t.deleted = 'N'
      ORDER BY t.tb_order_id, t.parcel`,
    [institutionId, id]
  )
  const [events] = await pool.query<any[]>(
    `SELECT event, kind, DATE_FORMAT(dt_record, '%Y-%m-%d') AS dtRecord, source,
            settled_code AS settledCode, paid_value AS paidValue, bank_code AS bankCode,
            bank_message AS bankMessage, origin_event AS originEvent, note,
            tb_user_id AS userId
       FROM \`${s}\`.tb_bank_slip_event
      WHERE tb_institution_id = ? AND tb_bank_slip_id = ? AND deleted = 'N'
      ORDER BY event`,
    [institutionId, id]
  )
  const r = rows[0]
  const { lastKind, ...header } = r
  return {
    ...header, state: stateFromLastEvent(lastKind),
    titles: titleRows.length,
    titleRows: titleRows as BankSlipTitleRow[],
    events: events as BankSlipEventRow[],
  }
}

/** Lookup: carteiras ATIVAS (D8) com a conta corrente. */
export async function listAgreementsLookup(
  schemaName: string, institutionId: number
): Promise<AgreementLookupRow[]> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT ag.id, ag.agreement, ${ACCOUNT_LABEL} AS bankAccountLabel,
            CASE WHEN ag.our_number_next IS NULL THEN 'N' ELSE 'S' END AS hasRange
       FROM \`${schemaName}\`.tb_bank_charge_agreement ag
       LEFT JOIN \`${schemaName}\`.tb_bank_account a
              ON a.id = ag.tb_bank_account_id AND a.tb_institution_id = ag.tb_institution_id
       LEFT JOIN setes_central.tb_bank b ON b.id = a.tb_bank_id
      WHERE ag.tb_institution_id = ? AND ag.active = 'S' AND ag.deleted = 'N'
      ORDER BY ag.id`,
    [institutionId]
  )
  return rows
}

/** Lookup: títulos a RECEBER abertos sem boleto vigente (candidatos à emissão). */
export async function listOpenTitles(
  filter: string, customerId: number | null, schemaName: string, institutionId: number
): Promise<OpenTitleRow[]> {
  assertSchemaName(schemaName)
  const s = schemaName
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT * FROM (
       SELECT f.tb_order_id AS orderId, f.parcel, fb.number,
              COALESCE(osl.tb_customer_id, osv.tb_customer_id, ofn.tb_entity_id) AS customerId,
              COALESCE(e.nick_trade, e.name_company) AS entityName,
              DATE_FORMAT(f.dt_expiration, '%Y-%m-%d') AS dtExpiration,
              GREATEST(f.tag_value - (SELECT COALESCE(SUM(p.paid_value), 0)
                 FROM \`${s}\`.tb_financial_payment p
                WHERE p.tb_institution_id = f.tb_institution_id AND p.tb_order_id = f.tb_order_id
                  AND p.terminal = f.terminal AND p.parcel = f.parcel
                  AND p.status = 'N' AND p.deleted = 'N'), 0) AS balance,
              pt.description AS paymentTypeDescription,
              (SELECT COUNT(*) FROM \`${s}\`.tb_bank_slip_title t
                 INNER JOIN \`${s}\`.tb_bank_slip bs
                    ON bs.id = t.tb_bank_slip_id AND bs.tb_institution_id = t.tb_institution_id
                   AND bs.deleted = 'N'
                WHERE t.tb_institution_id = f.tb_institution_id AND t.tb_order_id = f.tb_order_id
                  AND t.terminal = f.terminal AND t.parcel = f.parcel AND t.deleted = 'N'
                  AND ${LAST_EVENT_KIND_SQL(s)} NOT IN ('L', 'C')) AS openSlips
         FROM \`${s}\`.tb_financial f
         INNER JOIN \`${s}\`.tb_financial_bills fb
            ON fb.tb_institution_id = f.tb_institution_id AND fb.tb_order_id = f.tb_order_id
           AND fb.terminal = f.terminal AND fb.parcel = f.parcel AND fb.deleted = 'N'
         LEFT JOIN \`${s}\`.tb_order_sale osl
           ON osl.id = f.tb_order_id AND osl.tb_institution_id = f.tb_institution_id AND osl.terminal = f.terminal
         LEFT JOIN \`${s}\`.tb_order_service osv
           ON osv.id = f.tb_order_id AND osv.tb_institution_id = f.tb_institution_id AND osv.terminal = f.terminal
         LEFT JOIN \`${s}\`.tb_order_financial ofn
           ON ofn.id = f.tb_order_id AND ofn.tb_institution_id = f.tb_institution_id AND ofn.terminal = f.terminal
         LEFT JOIN setes_central.tb_entity e
           ON e.id = COALESCE(osl.tb_customer_id, osv.tb_customer_id, ofn.tb_entity_id)
         LEFT JOIN setes_central.tb_payment_types pt ON pt.id = f.tb_payment_types_id
        WHERE f.tb_institution_id = ? AND f.terminal = 0 AND f.deleted = 'N'
          AND COALESCE(fb.operation, 'C') <> 'D'
          AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ? OR fb.number LIKE ?)
     ) x
     WHERE x.balance > 0 AND x.openSlips = 0
       AND (? IS NULL OR x.customerId = ?)
     ORDER BY x.dtExpiration, x.orderId, x.parcel
     LIMIT 100`,
    [institutionId, like, like, like, like, customerId, customerId]
  )
  return rows.map(({ openSlips, ...r }) => r) as OpenTitleRow[]
}

// ---------------------------------------------------------------------
// Ações — transação única sobre a peça compartilhada
// ---------------------------------------------------------------------

/** D-B4 (Rodada 2 do boleto, 2026-09-04): mesmo retry em deadlock do faturamento — ver `@shared/db/deadlock-retry`. */
const BANK_SLIP_DEADLOCK_ATTEMPTS = 3

async function inTx<T>(
  label: string, meta: Record<string, unknown>, fn: (conn: any) => Promise<T>
): Promise<T> {
  return withDeadlockRetry(label, meta, BANK_SLIP_DEADLOCK_ATTEMPTS, async () => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const r = await fn(conn)
      await conn.commit()
      return r
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
  })
}

export function issue(
  input: IssueBankSlipInput, schemaName: string, institutionId: number, userId: number
): Promise<IssueBankSlipResult> {
  assertSchemaName(schemaName)
  return inTx('emissão de boleto', { institutionId },
    conn => issueBankSlip(conn, schemaName, institutionId, userId, input))
}

export function settle(
  input: SettleBankSlipInput, schemaName: string, institutionId: number, userId: number
): Promise<SettleBankSlipResult> {
  assertSchemaName(schemaName)
  return inTx('liquidação de boleto', { institutionId, slipId: input.slipId },
    conn => settleBankSlip(conn, schemaName, institutionId, userId, input))
}

export function cancel(
  id: number, note: string | null, schemaName: string, institutionId: number, userId: number
): Promise<number> {
  assertSchemaName(schemaName)
  return inTx('cancelamento de boleto', { institutionId, slipId: id },
    conn => cancelBankSlip(conn, schemaName, institutionId, userId, id, note))
}

export function reverse(
  id: number, reason: string, schemaName: string, institutionId: number, userId: number
) {
  assertSchemaName(schemaName)
  return inTx('estorno de boleto', { institutionId, slipId: id },
    conn => reverseBankSlipSettlement(conn, schemaName, institutionId, userId, id, reason))
}
