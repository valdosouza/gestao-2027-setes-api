import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { assertSchemaName } from '@shared/field-config'
import { reversePaymentWithChecks } from '@shared/check'
import type { ReversalCore } from '@shared/financial-settlement/settlement-batch'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { PRINCIPAL_PAID_SQL } from '@shared/financial-settlement/title-balance'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { round2 } from './settlements.calc'
import {
  settleBatchTx, reverseOnePayment, createPaCompensation,
} from '@shared/financial-settlement/settlement-batch'
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

// Q-G21: saldo em aberto pela peça ÚNICA (@shared/financial-settlement/title-balance)
// — principal coberto por baixa = paid − juros − multa + desconto; baixa com
// desconto QUITA (antes: Σ paid bruto, e o título "quitado com desconto"
// ficava em Abertos).
const PAID_SUM = (schema: string) => PRINCIPAL_PAID_SQL(schema, 'f')

// ---------------------------------------------------------------------
// Carteira de títulos
// ---------------------------------------------------------------------

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE
 * (D2). O status open/settled é HAVING sobre aliases DERIVADOS
 * (balance/paidValue) — o COUNT não pode ser um COUNT(*) simples: envolve
 * o SELECT interno (reduzido ao mínimo que o HAVING precisa) numa
 * subquery e conta as linhas dela. ORDER BY já tem desempate composto
 * (dt_expiration, orderId, parcel) — OFFSET estável (D8).
 */
export async function listBills(
  status: 'open' | 'settled' | '', kind: string, query: ListQuery,
  schemaName: string, institutionId: number
): Promise<PagedRows<BillRow>> {
  assertSchemaName(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const kindFilter = kind || null
  const having = status === 'open' ? 'HAVING balance > 0'
               : status === 'settled' ? 'HAVING paidValue > 0' : ''
  const where =
    `FROM \`${schemaName}\`.tb_financial f
     INNER JOIN \`${schemaName}\`.tb_financial_bills b
        ON b.tb_institution_id = f.tb_institution_id
       AND b.tb_order_id = f.tb_order_id AND b.terminal = f.terminal
       AND b.parcel = f.parcel AND b.deleted = 'N'
     ${ENTITY_JOINS(schemaName)}
     LEFT JOIN setes_central.tb_payment_types pt ON pt.id = f.tb_payment_types_id
     WHERE f.tb_institution_id = ? AND f.deleted = 'N'
       AND (? IS NULL OR b.kind = ?)
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ? OR b.number LIKE ?)`
  const params = [institutionId, kindFilter, kindFilter, like, like, like, like]

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
     ${where}
     ${having}
     ORDER BY f.dt_expiration, f.tb_order_id, f.parcel
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total FROM (
       SELECT ${PAID_SUM(schemaName)} AS paidValue,
              GREATEST(f.tag_value - ${PAID_SUM(schemaName)}, 0) AS balance
       ${where}
       ${having}
     ) t`,
    params
  )
  return { rows, total: Number(count[0].total) }
}

// ---------------------------------------------------------------------
// Baixa em lote (settled_code N:1 — Fase 6.1)
// ---------------------------------------------------------------------

export async function settleBatch(
  input: SettleBatchInput, schemaName: string, institutionId: number,
  userId: number
): Promise<SettleBatchResult> {
  assertSchemaName(schemaName)
  // M-1 (gate socrático da Rodada 2 do cancelamento, Q-G13): baixa × plano do
  // cancelamento × peça do cheque travam objetos em ordens que podem se cruzar;
  // em deadlock o InnoDB escolhe a vítima — reexecutar do zero é seguro
  // (mesmo wrapper do billing, bank-slips e checks).
  return withDeadlockRetry('baixa em lote', { institutionId, titles: input.titles.length }, 3, async () => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const result = await settleBatchTx(conn, input, schemaName, institutionId, userId)
      await conn.commit()
      return result
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
  })
}

// Núcleo do lote (settleBatchTx), rotina de parcerias (ordens PA — 4.3),
// compensação PA+C (DP11) e estorno de UMA baixa (reverseOnePayment)
// vivem em @shared/financial-settlement/settlement-batch (extraídos em
// 2026-09-04 — o boleto liquida/estorna pelo MESMO núcleo).

// ---------------------------------------------------------------------
// Baixados (eventos) e Estorno (5.5 — imutável)
// ---------------------------------------------------------------------

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE
 * (D2 — sem HAVING aqui: padrão puro do piloto). ORDER BY já tem
 * desempate composto (created_at DESC, orderId, parcel, event) — OFFSET
 * estável (D8).
 */
export async function listSettled(
  query: ListQuery, schemaName: string, institutionId: number
): Promise<PagedRows<SettledRow>> {
  assertSchemaName(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM \`${schemaName}\`.tb_financial_payment p
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
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ? OR b.number LIKE ?)`
  const params = [institutionId, like, like, like, like]

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
     ${where}
     ORDER BY p.created_at DESC, p.tb_order_id, p.parcel, p.event
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

/**
 * NÚCLEO do estorno de UMA baixa (5.5) — transaction-aware (1º parâmetro
 * conn); usado pelo endpoint e pela CADEIA PA (estorno recursivo, 4.3.3).
 */

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
  // M-1 / Q-G13: ver settleBatch — vítima de deadlock reexecuta, nunca 500.
  return withDeadlockRetry('estorno de baixa', { institutionId, orderId: input.orderId, parcel: input.parcel }, 3, async () => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()

      // D-G7 / D-G7a (cancelamento de nota, Valdo 2026-09-09): quando o cliente
      // paga com cheque ele deixa de dever o TÍTULO e passa a dever o CHEQUE
      // (módulo de cheque = rastreabilidade). Estornar essa baixa aqui SEMPRE
      // acontece: a peça do cheque desfaz a baixa e cancela (X) o R/P de cada
      // cheque ainda em custódia; cheque que já TRANSITOU (depositado/descontado/
      // usado) não interfere em momento algum — fica como está, a vida dele segue
      // no módulo de cheque. Quem trava, na ordem canônica (cheque → eventos →
      // payment), é a peça.
      const withChecks = await reversePaymentWithChecks(conn, schemaName, institutionId, userId, {
        orderId: input.orderId, parcel: input.parcel, paymentEvent: input.event, reason: input.reason,
      })
      let core: ReversalCore
      let checksReversed: number[] = []
      let checksKept: number[] = []
      if (withChecks) {
        core = withChecks.core
        checksReversed = withChecks.checksReversed
        checksKept = withChecks.checksKept
      } else {
        core = await reverseOnePayment(conn, schemaName, institutionId,
          userId, input.orderId, input.parcel, input.event, input.reason)
      }

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
          // H2 (gate socrático da Rodada 3): a cadeia PA também é uma porta de
          // estorno de baixa — um PA pago com cheque de terceiro (evento P) segue
          // a MESMA regra D-G7a: em custódia ganha X, transitado fica como está.
          const paChecks = await reversePaymentWithChecks(conn, schemaName, institutionId, userId, {
            orderId: paOrderId, parcel: Number(pay.parcel), paymentEvent: Number(pay.event), reason: chainReason,
          })
          if (paChecks) {
            checksReversed.push(...paChecks.checksReversed)
            checksKept.push(...paChecks.checksKept)
          } else {
            await reverseOnePayment(conn, schemaName, institutionId, userId,
              paOrderId, Number(pay.parcel), Number(pay.event), chainReason)
          }
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
      return { ...core, checksReversed, checksKept, paReversed, paCompensated }
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
  })
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
