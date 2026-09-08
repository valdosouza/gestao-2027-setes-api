import pool from '@shared/db/connection'
import { assertSchemaName } from '@shared/field-config'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import {
  LAST_CHECK_STATE_SQL, CheckState,
  depositCheck, discountCheck, returnCheckWithRefund, returnCheckGood,
  useCheckInPayment, returnCheck, reverseCheckEvent,
  DepositCheckInput, DiscountCheckInput, ReturnCheckRefundInput,
  UseCheckInPaymentInput, ReturnCheckInput, ReverseCheckEventInput,
} from '@shared/check'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import {
  CheckListRow, CheckFull, CheckEventRow, BankLookupRow, BankAccountLookupRow,
  ProviderLookupRow, OpenPayableRow,
} from './checks.interface'

/**
 * Repositório do módulo checks: LEITURAS (lista por estado derivado,
 * detalhe com a história completa, lookups) e wrappers TRANSACIONAIS sobre
 * a peça @shared/check (depositar / descontar / retornar / usar em
 * pagamento / devolver / estornar).
 */

const ORIGIN_ENTITY_SQL = (s: string) => `
  (SELECT ev.tb_entity_id FROM \`${s}\`.tb_check_event ev
    WHERE ev.tb_institution_id = c.tb_institution_id AND ev.tb_check_id = c.id
      AND ev.kind = 'R' AND ev.deleted = 'N' ORDER BY ev.event DESC LIMIT 1)`

const LIST_FIELDS = (s: string) => `c.id,
            CONCAT(COALESCE(b.number, ''), ' - ', COALESCE(b.description, '')) AS bankLabel,
            c.agency, c.account, c.number, c.issuer, c.value,
            DATE_FORMAT(c.dt_check, '%Y-%m-%d') AS dtCheck, c.kind AS headerKind,
            ${LAST_CHECK_STATE_SQL(s)} AS state,
            (SELECT COALESCE(e.nick_trade, e.name_company) FROM setes_central.tb_entity e
              WHERE e.id = ${ORIGIN_ENTITY_SQL(s)}) AS entityName`

/** Lista PAGINADA por estado derivado — HAVING sobre alias (molde bank-slips). */
export async function listChecks(
  status: CheckState | '', query: ListQuery, schemaName: string, institutionId: number
): Promise<PagedRows<CheckListRow>> {
  assertSchemaName(schemaName)
  const s = schemaName
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const having = status ? 'HAVING state = ?' : ''
  const where =
    `FROM \`${s}\`.tb_check c
     LEFT JOIN setes_central.tb_bank b ON b.id = c.tb_bank_id
     WHERE c.tb_institution_id = ? AND c.deleted = 'N'
       AND (? IS NULL OR c.number LIKE ? OR c.issuer LIKE ?)`
  const params: any[] = [institutionId, like, like, like]
  const havingParams = status ? [status] : []

  const [rows] = await pool.query<any[]>(
    `SELECT ${LIST_FIELDS(s)}
     ${where}
     ${having}
     ORDER BY c.dt_check DESC, c.id DESC
     LIMIT ? OFFSET ?`,
    [...params, ...havingParams, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total FROM (SELECT ${LAST_CHECK_STATE_SQL(s)} AS state ${where} ${having}) t`,
    [...params, ...havingParams]
  )
  return { rows: rows as CheckListRow[], total: Number(count[0].total) }
}

export async function getCheck(
  id: number, schemaName: string, institutionId: number
): Promise<CheckFull | null> {
  assertSchemaName(schemaName)
  const s = schemaName
  const [rows] = await pool.query<any[]>(
    `SELECT ${LIST_FIELDS(s)}
       FROM \`${s}\`.tb_check c
       LEFT JOIN setes_central.tb_bank b ON b.id = c.tb_bank_id
      WHERE c.id = ? AND c.tb_institution_id = ? AND c.deleted = 'N'`,
    [id, institutionId]
  )
  if (!rows[0]) return null
  const [events] = await pool.query<any[]>(
    `SELECT ev.event, ev.kind, DATE_FORMAT(ev.dt_record, '%Y-%m-%d') AS dtRecord,
            ev.tb_entity_id AS entityId,
            COALESCE(e.nick_trade, e.name_company) AS entityName,
            ev.settled_code AS settledCode, ev.tb_order_id AS orderId, ev.parcel,
            ev.tb_bank_account_id AS bankAccountId, ev.origin_event AS originEvent,
            ev.note, ev.tb_user_id AS userId
       FROM \`${s}\`.tb_check_event ev
       LEFT JOIN setes_central.tb_entity e ON e.id = ev.tb_entity_id
      WHERE ev.tb_institution_id = ? AND ev.tb_check_id = ? AND ev.deleted = 'N'
      ORDER BY ev.event`,
    [institutionId, id]
  )
  return { ...(rows[0] as CheckListRow), events: events as CheckEventRow[] }
}

/** Lookup do catálogo CENTRAL de bancos (cabeçalho do cheque). */
export async function listBanksLookup(filter: string): Promise<BankLookupRow[]> {
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT id, number, description FROM setes_central.tb_bank
      WHERE deleted = 'N' AND (? IS NULL OR description LIKE ? OR number LIKE ?)
      ORDER BY description LIMIT 100`,
    [like, like, like]
  )
  return rows
}

/** Lookup das contas correntes da institution. */
export async function listBankAccountsLookup(
  filter: string, schemaName: string, institutionId: number
): Promise<BankAccountLookupRow[]> {
  assertSchemaName(schemaName)
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT a.id,
            CONCAT(COALESCE(b.description, ''), ' — ', COALESCE(a.agency, ''), '/', COALESCE(a.number, '')) AS label
       FROM \`${schemaName}\`.tb_bank_account a
       LEFT JOIN setes_central.tb_bank b ON b.id = a.tb_bank_id
      WHERE a.tb_institution_id = ? AND a.deleted = 'N'
        AND (? IS NULL OR b.description LIKE ? OR a.number LIKE ?)
      ORDER BY b.description, a.agency, a.number LIMIT 100`,
    [institutionId, like, like, like]
  )
  return rows
}

/** Lookup de fornecedores (factoring costuma ser um provider — Q3 do parecer). */
export async function listProvidersLookup(
  filter: string, schemaName: string, institutionId: number
): Promise<ProviderLookupRow[]> {
  assertSchemaName(schemaName)
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT p.id, COALESCE(e.nick_trade, e.name_company) AS name
       FROM \`${schemaName}\`.tb_provider p
       INNER JOIN setes_central.tb_entity e ON e.id = p.id
      WHERE p.tb_institution_id = ? AND p.deleted = 'N'
        AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ?)
      ORDER BY e.nick_trade, p.id LIMIT 100`,
    [institutionId, like, like, like]
  )
  return rows
}

/** Lookup dos títulos a PAGAR abertos — molde bank-slips.listOpenTitles. */
export async function listOpenPayables(
  filter: string, schemaName: string, institutionId: number
): Promise<OpenPayableRow[]> {
  assertSchemaName(schemaName)
  const s = schemaName
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT f.tb_order_id AS orderId, f.parcel, fb.number,
            COALESCE(e.nick_trade, e.name_company) AS entityName,
            DATE_FORMAT(f.dt_expiration, '%Y-%m-%d') AS dtExpiration,
            GREATEST(f.tag_value - (SELECT COALESCE(SUM(p.paid_value), 0)
               FROM \`${s}\`.tb_financial_payment p
              WHERE p.tb_institution_id = f.tb_institution_id AND p.tb_order_id = f.tb_order_id
                AND p.terminal = f.terminal AND p.parcel = f.parcel
                AND p.status = 'N' AND p.deleted = 'N'), 0) AS balance
       FROM \`${s}\`.tb_financial f
       INNER JOIN \`${s}\`.tb_financial_bills fb
          ON fb.tb_institution_id = f.tb_institution_id AND fb.tb_order_id = f.tb_order_id
         AND fb.terminal = f.terminal AND fb.parcel = f.parcel AND fb.deleted = 'N'
       LEFT JOIN \`${s}\`.tb_order_financial ofn
          ON ofn.id = f.tb_order_id AND ofn.tb_institution_id = f.tb_institution_id AND ofn.terminal = f.terminal
       LEFT JOIN setes_central.tb_entity e ON e.id = ofn.tb_entity_id
      WHERE f.tb_institution_id = ? AND f.terminal = 0 AND f.deleted = 'N'
        AND fb.operation = 'D'
        AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ? OR fb.number LIKE ?)
      HAVING balance > 0
      ORDER BY dtExpiration, orderId, parcel LIMIT 100`,
    [institutionId, like, like, like, like]
  )
  return rows
}

// ---------------------------------------------------------------------
// Ações — transação única + retry em deadlock (D-B4 do boleto)
// ---------------------------------------------------------------------

const CHECK_DEADLOCK_ATTEMPTS = 3

async function inTx<T>(
  label: string, meta: Record<string, unknown>, fn: (conn: any) => Promise<T>
): Promise<T> {
  return withDeadlockRetry(label, meta, CHECK_DEADLOCK_ATTEMPTS, async () => {
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

export function deposit(
  input: DepositCheckInput, schemaName: string, institutionId: number, userId: number
) {
  assertSchemaName(schemaName)
  return inTx('depósito de cheque', { institutionId, checkId: input.checkId },
    conn => depositCheck(conn, schemaName, institutionId, userId, input))
}

export function discount(
  input: DiscountCheckInput, schemaName: string, institutionId: number, userId: number
) {
  assertSchemaName(schemaName)
  return inTx('desconto de cheque', { institutionId, checkId: input.checkId },
    conn => discountCheck(conn, schemaName, institutionId, userId, input))
}

export function returnRefund(
  input: ReturnCheckRefundInput, schemaName: string, institutionId: number, userId: number
) {
  assertSchemaName(schemaName)
  return inTx('retorno com reembolso', { institutionId, checkId: input.checkId },
    conn => returnCheckWithRefund(conn, schemaName, institutionId, userId, input))
}

export function returnGood(
  checkId: number, note: string | null, schemaName: string, institutionId: number, userId: number
) {
  assertSchemaName(schemaName)
  return inTx('retorno bom', { institutionId, checkId },
    conn => returnCheckGood(conn, schemaName, institutionId, userId, checkId, note))
}

export function payWith(
  input: UseCheckInPaymentInput, schemaName: string, institutionId: number, userId: number
) {
  assertSchemaName(schemaName)
  return inTx('pagamento com cheque', { institutionId, checkId: input.checkId },
    conn => useCheckInPayment(conn, schemaName, institutionId, userId, input))
}

export function returnToOrigin(
  input: ReturnCheckInput, schemaName: string, institutionId: number, userId: number
) {
  assertSchemaName(schemaName)
  return inTx('devolução de cheque', { institutionId, checkId: input.checkId },
    conn => returnCheck(conn, schemaName, institutionId, userId, input))
}

export function reverse(
  input: ReverseCheckEventInput, schemaName: string, institutionId: number, userId: number
) {
  assertSchemaName(schemaName)
  return inTx('estorno de cheque', { institutionId, checkId: input.checkId, event: input.event },
    conn => reverseCheckEvent(conn, schemaName, institutionId, userId, input))
}
