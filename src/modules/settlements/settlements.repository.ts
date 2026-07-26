import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { assertSchemaName } from '@shared/field-config'
import { round2, addDays, partnerShare } from './settlements.calc'
import {
  BillRow, SettleBatchInput, SettleBatchResult, SettledRow,
  ReversalInput, ReversalResult, StatementReport,
} from './settlements.interface'

/**
 * Repositório da Baixa/Estorno/Movimento (Fases 5.5 e 6 do
 * 05-ORDEM-SERVICO). REGRA DE OURO: financeiro NÃO SE APAGA — payment e
 * statement nunca recebem UPDATE de valores nem delete (nem soft); o
 * cancelamento é sempre um LANÇAMENTO INVERSO (status 'R' + origem) com
 * marcação 'E' no original. settled_code nasce aqui (MAX+1 por
 * institution — DP9) e liga N baixas a 1 movimento.
 * GANCHO Onda 6: a baixa de RECEBIMENTO disparará a rotina de parcerias
 * (ordens PA via tb_order_financial + bills PA; estorno em cadeia com
 * compensação PA+C — DP11).
 */

/** JOINs da entidade do título — deriva da CADEIA DA ORDEM (DP10). */
const ENTITY_JOINS = (schema: string) => `
     LEFT JOIN \`${schema}\`.tb_order_service osv
        ON osv.id = f.tb_order_id AND osv.tb_institution_id = f.tb_institution_id
       AND osv.terminal = f.terminal
     LEFT JOIN \`${schema}\`.tb_order_financial ofn
        ON ofn.id = f.tb_order_id AND ofn.tb_institution_id = f.tb_institution_id
       AND ofn.terminal = f.terminal
     LEFT JOIN setes_central.tb_entity e
        ON e.id = COALESCE(osv.tb_customer_id, ofn.tb_entity_id)`

const PAID_SUM = (schema: string) => `
    (SELECT COALESCE(SUM(p.paid_value), 0)
       FROM \`${schema}\`.tb_financial_payment p
      WHERE p.tb_institution_id = f.tb_institution_id
        AND p.tb_order_id = f.tb_order_id AND p.terminal = f.terminal
        AND p.parcel = f.parcel AND p.status = 'N' AND p.deleted = 'N')`

// ---------------------------------------------------------------------
// Carteira de títulos
// ---------------------------------------------------------------------

export async function listBills(
  status: 'open' | 'settled' | '', kind: string, filter: string,
  schemaName: string, institutionId: number
): Promise<BillRow[]> {
  assertSchemaName(schemaName)
  const like = filter ? `%${filter}%` : null
  const kindFilter = kind || null
  const having = status === 'open' ? 'HAVING balance > 0'
               : status === 'settled' ? 'HAVING paidValue > 0' : ''
  const [rows] = await pool.query<any[]>(
    `SELECT f.tb_order_id AS orderId,
            f.parcel,
            b.number, b.kind, b.situation, b.operation, b.stage,
            DATE_FORMAT(f.dt_expiration, '%Y-%m-%d') AS dtExpiration,
            f.tag_value AS tagValue,
            ${PAID_SUM(schemaName)} AS paidValue,
            GREATEST(f.tag_value - ${PAID_SUM(schemaName)}, 0) AS balance,
            COALESCE(e.nick_trade, e.name_company) AS entityName,
            f.tb_payment_types_id AS paymentTypeId,
            pt.description AS paymentTypeDescription
     FROM \`${schemaName}\`.tb_financial f
     INNER JOIN \`${schemaName}\`.tb_financial_bills b
        ON b.tb_institution_id = f.tb_institution_id
       AND b.tb_order_id = f.tb_order_id AND b.terminal = f.terminal
       AND b.parcel = f.parcel AND b.deleted = 'N'
     ${ENTITY_JOINS(schemaName)}
     LEFT JOIN setes_central.tb_payment_types pt ON pt.id = f.tb_payment_types_id
     WHERE f.tb_institution_id = ? AND f.deleted = 'N'
       AND (? IS NULL OR b.kind = ?)
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ? OR b.number LIKE ?)
     ${having}
     ORDER BY f.dt_expiration, f.tb_order_id, f.parcel
     LIMIT 300`,
    [institutionId, kindFilter, kindFilter, like, like, like, like]
  )
  return rows
}

// ---------------------------------------------------------------------
// Baixa em lote (settled_code N:1 — Fase 6.1)
// ---------------------------------------------------------------------

export async function settleBatch(
  input: SettleBatchInput, schemaName: string, institutionId: number,
  userId: number
): Promise<SettleBatchResult> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    if (input.bankAccountId > 0) {
      const [acc] = await conn.query<any[]>(
        `SELECT 1 FROM \`${schemaName}\`.tb_bank_account
          WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
        [input.bankAccountId, institutionId]
      )
      if (acc.length === 0) {
        throw new HttpError(400, 'Conta bancária inexistente',
          [{ field: 'bankAccountId', message: 'Conta não encontrada' }],
          'BANK_NOT_FOUND')
      }
    }

    // DP9: o código nasce no payment — MAX+1 por institution
    const [mxCode] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(settled_code), 0) + 1 AS nextCode
         FROM \`${schemaName}\`.tb_financial_payment
        WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId]
    )
    const settledCode = Number(mxCode[0].nextCode)

    const stage = input.bankAccountId > 0 ? 'B' : 'C'
    let totalCredit = 0
    let totalDebit  = 0
    let firstPaymentTypeId: number | null = null

    let paOrders = 0
    for (const title of input.titles) {
      const [fin] = await conn.query<any[]>(
        `SELECT f.tag_value AS tagValue, f.tb_payment_types_id AS paymentTypeId,
                b.kind, b.operation
           FROM \`${schemaName}\`.tb_financial f
           INNER JOIN \`${schemaName}\`.tb_financial_bills b
              ON b.tb_institution_id = f.tb_institution_id
             AND b.tb_order_id = f.tb_order_id AND b.terminal = f.terminal
             AND b.parcel = f.parcel AND b.deleted = 'N'
          WHERE f.tb_institution_id = ? AND f.tb_order_id = ? AND f.terminal = 0
            AND f.parcel = ? AND f.deleted = 'N' FOR UPDATE`,
        [institutionId, title.orderId, title.parcel]
      )
      if (!fin[0]) {
        throw new HttpError(404,
          `Título ${title.orderId}/${title.parcel} não encontrado`,
          undefined, 'TITLE_NOT_FOUND')
      }
      if (firstPaymentTypeId === null) {
        firstPaymentTypeId = Number(fin[0].paymentTypeId) || null
      }

      const [mxEvent] = await conn.query<any[]>(
        `SELECT COALESCE(MAX(event), 0) + 1 AS nextEvent
           FROM \`${schemaName}\`.tb_financial_payment
          WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0
            AND parcel = ? FOR UPDATE`,
        [institutionId, title.orderId, title.parcel]
      )
      const event = Number(mxEvent[0].nextEvent)

      await conn.query(
        `INSERT INTO \`${schemaName}\`.tb_financial_payment
           (tb_institution_id, tb_order_id, terminal, parcel, event,
            interest_value, late_value, discount_aliquot, paid_value,
            dt_payment, dt_real_payment, settled, tb_financial_plans_id,
            settled_code, tb_payment_types_id, status, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'S', 0, ?, ?, 'N', NOW(), NOW())`,
        [institutionId, title.orderId, title.parcel, event,
         title.interestValue, title.lateValue, title.discountAliquot,
         title.paidValue, input.dtPayment, input.dtRealPayment ?? null,
         settledCode, fin[0].paymentTypeId]
      )

      // stage do título: finalizado em Banco/Caixa (5.2)
      await conn.query(
        `UPDATE \`${schemaName}\`.tb_financial_bills
            SET stage = ?, updated_at = NOW()
          WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0
            AND parcel = ?`,
        [stage, institutionId, title.orderId, title.parcel]
      )

      // C = crédito a favor da empresa; D = débito contra (5.2)
      if (fin[0].operation === 'D') totalDebit += title.paidValue
      else totalCredit += title.paidValue

      // ROTINA DE PARCERIAS (4.3): baixa de RECEBIMENTO gera as ordens PA
      if ((fin[0].kind === 'RA' || fin[0].kind === 'RM') &&
          fin[0].operation !== 'D') {
        paOrders += await generatePartnershipOrders(conn, schemaName,
          institutionId, userId, title.orderId, title.parcel, event,
          title.paidValue, input.dtPayment, Number(fin[0].paymentTypeId))
      }
    }

    // planos financeiros: override do lote > defaults da forma de pagamento
    let planCre = input.financialPlanCreId ?? 0
    let planDeb = input.financialPlanDebId ?? 0
    if ((planCre === 0 || planDeb === 0) && firstPaymentTypeId != null) {
      const [link] = await conn.query<any[]>(
        `SELECT tb_financial_plans_id_cre AS cre, tb_financial_plans_id_deb AS deb
           FROM \`${schemaName}\`.tb_institution_has_payment_types
          WHERE tb_institution_id = ? AND tb_payment_types_id = ? AND deleted = 'N'`,
        [institutionId, firstPaymentTypeId]
      )
      if (link[0]) {
        if (planCre === 0) planCre = Number(link[0].cre) || 0
        if (planDeb === 0) planDeb = Number(link[0].deb) || 0
      }
    }

    // movimento ÚNICO do código (N:1 — 5.3)
    const [mxSt] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId
         FROM \`${schemaName}\`.tb_financial_statement
        WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId]
    )
    const statementId = Number(mxSt[0].nextId)
    totalCredit = round2(totalCredit)
    totalDebit  = round2(totalDebit)
    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_financial_statement
         (id, tb_institution_id, terminal, tb_bank_account_id, dt_record,
          tb_bank_historic_id, credit_value, debit_value, manual_history,
          kind, settled_code, tb_user_id, future, dt_original, conferred,
          tb_payment_types_id, tb_financial_plans_id_cre,
          tb_financial_plans_id_deb, status, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'N', ?, 'N', ?, ?, ?, 'N',
               NOW(), NOW())`,
      [statementId, institutionId, input.bankAccountId,
       input.dtRealPayment ?? input.dtPayment,
       totalCredit, totalDebit, `Baixa ${settledCode}`,
       totalCredit >= totalDebit ? 'C' : 'D', settledCode, userId,
       input.dtPayment, firstPaymentTypeId, planCre, planDeb]
    )

    await conn.commit()
    return {
      settledCode, statementId,
      totalValue: round2(totalCredit - totalDebit),
      titles: input.titles.length,
      paOrders,
    }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------
// Rotina de parcerias (4.3 — DP10/DP12): baixa de recebimento → ordens PA
// ---------------------------------------------------------------------

/**
 * Gera as ordens PA da baixa: parceria VIVA do cliente da OS de origem →
 * 1 tb_order + tb_order_financial (colaborador + trilha da baixa) +
 * tb_financial/bills 'PA' (operation 'D' — a pagar) POR PARCEIRO, com
 * valor = % × pago e vencimento = data da baixa + 12 dias (DP12).
 * Ordens que não são OS (PA/PM etc.) não disparam parceria.
 */
async function generatePartnershipOrders(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, originOrderId: number, originParcel: number,
  originEvent: number, paidValue: number, dtPayment: string,
  paymentTypeId: number
): Promise<number> {
  const [svc] = await conn.query<any[]>(
    `SELECT tb_customer_id AS customerId FROM \`${schemaName}\`.tb_order_service
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
    [originOrderId, institutionId]
  )
  if (!svc[0]) return 0

  // Parceria v2 (tb_partnership FLAT — angariação): a parceria É do
  // cliente; só parceiros ATIVOS (D7) entram no rateio.
  const [partners] = await conn.query<any[]>(
    `SELECT p.tb_collaborator_id AS collaboratorId, p.rate
     FROM \`${schemaName}\`.tb_partnership p
     WHERE p.tb_institution_id = ? AND p.tb_customer_id = ?
       AND p.deleted = 'N' AND p.active = 'S'`,
    [institutionId, Number(svc[0].customerId)]
  )
  if (partners.length === 0) return 0

  const dtExpiration = addDays(dtPayment, 12)  // DP12
  let created = 0
  for (const partner of partners) {
    const share = partnerShare(paidValue, Number(partner.rate))
    if (share <= 0) continue

    const [mx] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${schemaName}\`.tb_order
        WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId]
    )
    const paOrderId = Number(mx[0].nextId)

    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_order
         (id, tb_institution_id, terminal, tb_user_id, dt_record, status,
          created_at, updated_at)
       VALUES (?, ?, 0, ?, CURDATE(), 'F', NOW(), NOW())`,
      [paOrderId, institutionId, userId]
    )
    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_order_financial
         (id, tb_institution_id, terminal, tb_entity_id, tb_order_id_origin,
          origin_parcel, origin_event, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, NOW(), NOW())`,
      [paOrderId, institutionId, Number(partner.collaboratorId),
       originOrderId, originParcel, originEvent]
    )
    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_financial
         (tb_institution_id, tb_order_id, terminal, parcel, dt_expiration,
          tb_payment_types_id, tag_value, created_at, updated_at)
       VALUES (?, ?, 0, 1, ?, ?, ?, NOW(), NOW())`,
      [institutionId, paOrderId, dtExpiration, paymentTypeId, share]
    )
    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_financial_bills
         (tb_institution_id, tb_order_id, terminal, parcel,
          tb_financial_plans_id, number, kind, situation, operation, stage,
          created_at, updated_at)
       VALUES (?, ?, 0, 1, 0, ?, 'PA', 'N', 'D', 'N', NOW(), NOW())`,
      [institutionId, paOrderId, `${paOrderId}/PA-1`]
    )
    created += 1
  }
  return created
}

/**
 * Título de COMPENSAÇÃO na ordem PA (DP11 — semântica invertida da 5.2):
 * kind 'PA' + operation 'C' = empresa tem crédito com o colaborador; o
 * saldo líquido do parceiro zera na apuração (P10 automático = futuro).
 */
async function createPaCompensation(
  conn: PoolConnection, schemaName: string, institutionId: number,
  paOrderId: number, tagValue: number, paymentTypeId: number
): Promise<void> {
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(parcel), 0) + 1 AS nextParcel
       FROM \`${schemaName}\`.tb_financial
      WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0
      FOR UPDATE`,
    [institutionId, paOrderId]
  )
  const parcel = Number(mx[0].nextParcel)
  await conn.query(
    `INSERT INTO \`${schemaName}\`.tb_financial
       (tb_institution_id, tb_order_id, terminal, parcel, dt_expiration,
        tb_payment_types_id, tag_value, created_at, updated_at)
     VALUES (?, ?, 0, ?, CURDATE(), ?, ?, NOW(), NOW())`,
    [institutionId, paOrderId, parcel, paymentTypeId, tagValue]
  )
  await conn.query(
    `INSERT INTO \`${schemaName}\`.tb_financial_bills
       (tb_institution_id, tb_order_id, terminal, parcel,
        tb_financial_plans_id, number, kind, situation, operation, stage,
        created_at, updated_at)
     VALUES (?, ?, 0, ?, 0, ?, 'PA', 'N', 'C', 'N', NOW(), NOW())`,
    [institutionId, paOrderId, parcel, `${paOrderId}/PA-C${parcel}`]
  )
}

// ---------------------------------------------------------------------
// Baixados (eventos) e Estorno (5.5 — imutável)
// ---------------------------------------------------------------------

export async function listSettled(
  filter: string, schemaName: string, institutionId: number
): Promise<SettledRow[]> {
  assertSchemaName(schemaName)
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT p.tb_order_id AS orderId, p.parcel, p.event,
            b.number, b.kind,
            COALESCE(e.nick_trade, e.name_company) AS entityName,
            p.paid_value AS paidValue,
            DATE_FORMAT(p.dt_payment, '%Y-%m-%d')      AS dtPayment,
            DATE_FORMAT(p.dt_real_payment, '%Y-%m-%d') AS dtRealPayment,
            p.settled_code AS settledCode,
            p.status, p.origin_event AS originEvent,
            p.reversal_reason AS reversalReason
     FROM \`${schemaName}\`.tb_financial_payment p
     INNER JOIN \`${schemaName}\`.tb_financial f
        ON f.tb_institution_id = p.tb_institution_id
       AND f.tb_order_id = p.tb_order_id AND f.terminal = p.terminal
       AND f.parcel = p.parcel
     LEFT JOIN \`${schemaName}\`.tb_financial_bills b
        ON b.tb_institution_id = p.tb_institution_id
       AND b.tb_order_id = p.tb_order_id AND b.terminal = p.terminal
       AND b.parcel = p.parcel AND b.deleted = 'N'
     ${ENTITY_JOINS(schemaName)}
     WHERE p.tb_institution_id = ? AND p.deleted = 'N'
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ? OR b.number LIKE ?)
     ORDER BY p.created_at DESC, p.tb_order_id, p.parcel, p.event
     LIMIT 300`,
    [institutionId, like, like, like, like]
  )
  return rows
}

interface ReversalCore {
  reversalEvent: number
  settledCode:   number
}

/**
 * NÚCLEO do estorno de UMA baixa (5.5) — transaction-aware (1º parâmetro
 * conn); usado pelo endpoint e pela CADEIA PA (estorno recursivo, 4.3.3).
 */
async function reverseOnePayment(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, orderId: number, parcel: number, event: number,
  reason: string
): Promise<ReversalCore> {
    const [orig] = await conn.query<any[]>(
      `SELECT p.interest_value AS interestValue, p.late_value AS lateValue,
              p.discount_aliquot AS discountAliquot, p.paid_value AS paidValue,
              p.dt_payment AS dtPayment, p.dt_real_payment AS dtRealPayment,
              p.settled_code AS settledCode, p.tb_payment_types_id AS paymentTypeId,
              p.status, b.operation
         FROM \`${schemaName}\`.tb_financial_payment p
         LEFT JOIN \`${schemaName}\`.tb_financial_bills b
            ON b.tb_institution_id = p.tb_institution_id
           AND b.tb_order_id = p.tb_order_id AND b.terminal = p.terminal
           AND b.parcel = p.parcel AND b.deleted = 'N'
        WHERE p.tb_institution_id = ? AND p.tb_order_id = ? AND p.terminal = 0
          AND p.parcel = ? AND p.event = ? FOR UPDATE`,
      [institutionId, orderId, parcel, event]
    )
    if (!orig[0]) {
      throw new HttpError(404,
        `Baixa ${orderId}/${parcel} evento ${event} não encontrada`)
    }
    if (orig[0].status !== 'N') {
      throw new HttpError(409,
        'Só baixas vigentes (status N) podem ser estornadas',
        undefined, 'REVERSAL_NOT_CURRENT')
    }
    const o = orig[0]

    // código PRÓPRIO do estorno (5.5.1)
    const [mxCode] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(settled_code), 0) + 1 AS nextCode
         FROM \`${schemaName}\`.tb_financial_payment
        WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId]
    )
    const reversalCode = Number(mxCode[0].nextCode)

    const [mxEvent] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(event), 0) + 1 AS nextEvent
         FROM \`${schemaName}\`.tb_financial_payment
        WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0
          AND parcel = ? FOR UPDATE`,
      [institutionId, orderId, parcel]
    )
    const reversalEvent = Number(mxEvent[0].nextEvent)

    // lançamento INVERSO (status R + origem + motivo — 5.5.1/3/4)
    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_financial_payment
         (tb_institution_id, tb_order_id, terminal, parcel, event,
          interest_value, late_value, discount_aliquot, paid_value,
          dt_payment, dt_real_payment, settled, tb_financial_plans_id,
          settled_code, tb_payment_types_id, status, origin_event,
          reversal_reason, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, CURDATE(), CURDATE(), 'S', 0,
               ?, ?, 'R', ?, ?, NOW(), NOW())`,
      [institutionId, orderId, parcel, reversalEvent,
       o.interestValue, o.lateValue, o.discountAliquot, o.paidValue,
       reversalCode, o.paymentTypeId, event, reason]
    )

    // statement INVERSO compensa exatamente a parte estornada (5.5.7)
    const [origSt] = await conn.query<any[]>(
      `SELECT id, tb_bank_account_id AS bankAccountId,
              tb_payment_types_id AS paymentTypeId,
              tb_financial_plans_id_cre AS planCre,
              tb_financial_plans_id_deb AS planDeb
         FROM \`${schemaName}\`.tb_financial_statement
        WHERE tb_institution_id = ? AND settled_code = ? AND status <> 'R'
        LIMIT 1 FOR UPDATE`,
      [institutionId, o.settledCode]
    )
    const [mxSt] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId
         FROM \`${schemaName}\`.tb_financial_statement
        WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId]
    )
    const credit = o.operation === 'D' ? Number(o.paidValue) : 0
    const debit  = o.operation === 'D' ? 0 : Number(o.paidValue)
    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_financial_statement
         (id, tb_institution_id, terminal, tb_bank_account_id, dt_record,
          tb_bank_historic_id, credit_value, debit_value, manual_history,
          kind, settled_code, tb_user_id, future, dt_original, conferred,
          tb_payment_types_id, tb_financial_plans_id_cre,
          tb_financial_plans_id_deb, status,
          tb_financial_statement_id_origin, created_at, updated_at)
       VALUES (?, ?, 0, ?, CURDATE(), 0, ?, ?, ?, ?, ?, ?, 'N', CURDATE(),
               'N', ?, ?, ?, 'R', ?, NOW(), NOW())`,
      [Number(mxSt[0].nextId), institutionId,
       origSt[0] ? origSt[0].bankAccountId : 0,
       credit, debit, `Estorno baixa ${o.settledCode}`,
       credit >= debit ? 'C' : 'D', reversalCode, userId,
       origSt[0] ? origSt[0].paymentTypeId : o.paymentTypeId,
       origSt[0] ? origSt[0].planCre : 0,
       origSt[0] ? origSt[0].planDeb : 0,
       origSt[0] ? origSt[0].id : null]
    )

    // marcação 'E' no payment original (5.5.2)
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_financial_payment
          SET status = 'E', updated_at = NOW()
        WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0
          AND parcel = ? AND event = ?`,
      [institutionId, orderId, parcel, event]
    )

    // statement original vira 'E' quando TODOS os payments do código foram estornados
    const [alive] = await conn.query<any[]>(
      `SELECT COUNT(*) AS n FROM \`${schemaName}\`.tb_financial_payment
        WHERE tb_institution_id = ? AND settled_code = ? AND status = 'N'`,
      [institutionId, o.settledCode]
    )
    if (Number(alive[0].n) === 0 && origSt[0]) {
      await conn.query(
        `UPDATE \`${schemaName}\`.tb_financial_statement
            SET status = 'E', updated_at = NOW()
          WHERE tb_institution_id = ? AND id = ?`,
        [institutionId, origSt[0].id]
      )
    }

    // título reaberto (estado derivado — 5.5.5): sem payment 'N' → stage 'N'
    const [aliveParcel] = await conn.query<any[]>(
      `SELECT COUNT(*) AS n FROM \`${schemaName}\`.tb_financial_payment
        WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0
          AND parcel = ? AND status = 'N'`,
      [institutionId, orderId, parcel]
    )
    if (Number(aliveParcel[0].n) === 0) {
      await conn.query(
        `UPDATE \`${schemaName}\`.tb_financial_bills
            SET stage = 'N', updated_at = NOW()
          WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0
            AND parcel = ?`,
        [institutionId, orderId, parcel]
      )
    }

    return { reversalEvent, settledCode: reversalCode }
}

/**
 * Estorno com CADEIA PA (4.3.3 + DP11): estorna a baixa e, se ela gerou
 * ordens PA (trilha em tb_order_financial), estorna recursivamente as
 * baixas vigentes dos títulos PA e gera o título de COMPENSAÇÃO 'PA'+
 * operation 'C' por payable (empresa tem crédito com o colaborador —
 * semântica invertida da 5.2), zerando o saldo do parceiro. Re-baixa do
 * título de origem gera ordens PA novas — sem duplicidade de saldo.
 */
export async function reverseSettlement(
  input: ReversalInput, schemaName: string, institutionId: number,
  userId: number
): Promise<ReversalResult> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const core = await reverseOnePayment(conn, schemaName, institutionId,
      userId, input.orderId, input.parcel, input.event, input.reason)

    let paReversed = 0
    let paCompensated = 0
    const chainReason = `Estorno em cadeia: ${input.reason}`.slice(0, 100)

    const [paOrders] = await conn.query<any[]>(
      `SELECT id FROM \`${schemaName}\`.tb_order_financial
        WHERE tb_institution_id = ? AND tb_order_id_origin = ?
          AND origin_parcel = ? AND origin_event = ? AND deleted = 'N'
        FOR UPDATE`,
      [institutionId, input.orderId, input.parcel, input.event]
    )

    for (const pa of paOrders) {
      const paOrderId = Number(pa.id)

      // baixas VIGENTES dos títulos a pagar do PA → estorno recursivo (4.3.3)
      const [alivePays] = await conn.query<any[]>(
        `SELECT p.parcel, p.event
           FROM \`${schemaName}\`.tb_financial_payment p
           INNER JOIN \`${schemaName}\`.tb_financial_bills b
              ON b.tb_institution_id = p.tb_institution_id
             AND b.tb_order_id = p.tb_order_id AND b.terminal = p.terminal
             AND b.parcel = p.parcel AND b.deleted = 'N'
          WHERE p.tb_institution_id = ? AND p.tb_order_id = ? AND p.terminal = 0
            AND p.status = 'N' AND b.kind = 'PA' AND b.operation = 'D'
          FOR UPDATE`,
        [institutionId, paOrderId]
      )
      for (const pay of alivePays) {
        await reverseOnePayment(conn, schemaName, institutionId, userId,
          paOrderId, Number(pay.parcel), Number(pay.event), chainReason)
        paReversed += 1
      }

      // compensação PA+C por payable vivo (DP11) — zera o saldo em aberto
      const [payables] = await conn.query<any[]>(
        `SELECT f.parcel, f.tag_value AS tagValue,
                f.tb_payment_types_id AS paymentTypeId
           FROM \`${schemaName}\`.tb_financial f
           INNER JOIN \`${schemaName}\`.tb_financial_bills b
              ON b.tb_institution_id = f.tb_institution_id
             AND b.tb_order_id = f.tb_order_id AND b.terminal = f.terminal
             AND b.parcel = f.parcel AND b.deleted = 'N'
          WHERE f.tb_institution_id = ? AND f.tb_order_id = ? AND f.terminal = 0
            AND f.deleted = 'N' AND b.kind = 'PA' AND b.operation = 'D'`,
        [institutionId, paOrderId]
      )
      for (const payable of payables) {
        await createPaCompensation(conn, schemaName, institutionId,
          paOrderId, Number(payable.tagValue), Number(payable.paymentTypeId))
        paCompensated += 1
      }
    }

    await conn.commit()
    return { ...core, paReversed, paCompensated }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

// ---------------------------------------------------------------------
// Movimento (extrato banco/caixa)
// ---------------------------------------------------------------------

export async function listStatements(
  bankAccountId: number | null, dtFrom: string | null, dtTo: string | null,
  schemaName: string, institutionId: number
): Promise<StatementReport> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT s.id,
            DATE_FORMAT(s.dt_record, '%Y-%m-%d') AS dtRecord,
            s.tb_bank_account_id AS bankAccountId,
            COALESCE(s.credit_value, 0) AS creditValue,
            COALESCE(s.debit_value, 0)  AS debitValue,
            s.manual_history AS manualHistory,
            s.settled_code   AS settledCode,
            s.status, s.future, s.conferred
     FROM \`${schemaName}\`.tb_financial_statement s
     WHERE s.tb_institution_id = ? AND s.deleted = 'N'
       AND (? IS NULL OR s.tb_bank_account_id = ?)
       AND (? IS NULL OR s.dt_record >= ?)
       AND (? IS NULL OR s.dt_record <= ?)
     ORDER BY s.dt_record, s.id
     LIMIT 500`,
    [institutionId, bankAccountId, bankAccountId,
     dtFrom, dtFrom, dtTo, dtTo]
  )
  // SALDO REAL soma TODOS os lançamentos (N/E/R): no estorno PARCIAL o
  // original fica 'N' e o inverso 'R' o compensa aritmeticamente; no
  // TOTAL o par E+R se anula sozinho. Filtrar por status é visualização
  // (esconder pares cancelados), nunca conta de saldo — refinamento do
  // 5.5.2 registrado na Fase 6.2 do 05-ORDEM-SERVICO. (Nos TÍTULOS é
  // diferente: o saldo deriva só dos payments 'N'.)
  let totalCredit = 0
  let totalDebit  = 0
  for (const row of rows) {
    totalCredit += Number(row.creditValue)
    totalDebit  += Number(row.debitValue)
  }
  return {
    rows,
    totalCredit: round2(totalCredit),
    totalDebit:  round2(totalDebit),
    balance:     round2(totalCredit - totalDebit),
  }
}
