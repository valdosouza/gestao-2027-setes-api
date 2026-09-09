import { PoolConnection } from 'mysql2/promise'
import { insertStatement, nextSettledCode } from '@shared/financial-settlement'

/**
 * Convenção ÚNICA de estorno do extrato (Q-CH1, decidida pelo Valdo em
 * 2026-09-08) para um `settled_code` SEM título — movimento próprio:
 * depósito / desconto / retorno com reembolso de cheque (B/D/T).
 *
 * Espelha o que o núcleo `reverseOnePayment` (settlement-batch, D-G3 do
 * contrato financeiro) já fazia para baixas de título e seus satélites:
 *   - cada linha viva ('N') ganha um ESPELHO com status 'R' e
 *     `tb_financial_statement_id_origin` apontando para ela;
 *   - `dt_record` é HERDADO da original (anula na MESMA data de
 *     disponibilidade — um crédito futuro estornado não deixa o saldo de hoje
 *     negativo);
 *   - `dt_original` = fato gerador do estorno (data informada ou hoje);
 *   - a original vira 'E'.
 *
 * Antes (achado do passeio logado do módulo Cheques): o cheque gravava o
 * espelho sem origem, com status 'N' e com a data do estorno em
 * `dt_record` — duas convenções no mesmo extrato.
 *
 * O código do estorno é SEMPRE mintado (é o identificador do grupo de
 * linhas e do evento X), mesmo que não haja linha viva.
 */
export async function reverseStatementLines(
  conn: PoolConnection, s: string, institutionId: number, userId: number,
  settledCode: number, note: string, dtOriginal?: string
): Promise<number> {
  const [lines] = await conn.query<any[]>(
    `SELECT id, tb_bank_account_id AS bankAccountId, tb_cashier_id AS cashierId,
            DATE_FORMAT(dt_record, '%Y-%m-%d') AS dtRecord,
            credit_value AS creditValue, debit_value AS debitValue,
            manual_history AS history, tb_payment_types_id AS paymentTypeId,
            tb_financial_plans_id_cre AS planCre, tb_financial_plans_id_deb AS planDeb
       FROM \`${s}\`.tb_financial_statement
      WHERE tb_institution_id = ? AND settled_code = ? AND status NOT IN ('R', 'E')
      ORDER BY id FOR UPDATE`,
    [institutionId, settledCode]
  )
  const reversalCode = await nextSettledCode(conn, s, institutionId)
  const factDate = dtOriginal ?? localTodayIso()
  for (const line of lines) {
    await mirrorStatementLine(conn, s, institutionId, userId, line, {
      reversalCode, history: `Estorno: ${note}`, dtOriginal: factDate,
    })
  }
  return reversalCode
}

/** Linha do extrato como o SELECT acima a devolve (aliases). */
export interface StatementLineRow {
  id: number
  bankAccountId: number
  cashierId: number | null
  dtRecord?: string | null
  creditValue: number | string
  debitValue: number | string
  paymentTypeId?: number | null
  planCre?: number | null
  planDeb?: number | null
}

export interface MirrorOptions {
  reversalCode: number
  history: string
  /** Fato gerador do estorno (dt_original); também vale como dt_record quando a original não informa. */
  dtOriginal: string
}

/** Espelho de UMA linha ('R' + origem + dt_record herdado) e marcação 'E' da original. */
export async function mirrorStatementLine(
  conn: PoolConnection, s: string, institutionId: number, userId: number,
  line: StatementLineRow, opts: MirrorOptions
): Promise<number> {
  const mirrorId = await insertStatement(conn, s, institutionId, {
    bankAccountId: Number(line.bankAccountId),
    cashierId: line.cashierId == null ? null : Number(line.cashierId),
    dtRecord: line.dtRecord ?? opts.dtOriginal,
    dtOriginal: opts.dtOriginal,
    credit: Number(line.debitValue) || 0,
    debit: Number(line.creditValue) || 0,
    history: opts.history.slice(0, 100),
    settledCode: opts.reversalCode, userId,
    paymentTypeId: line.paymentTypeId == null ? null : Number(line.paymentTypeId),
    planCre: Number(line.planCre) || 0, planDeb: Number(line.planDeb) || 0,
    status: 'R', originId: Number(line.id),
  })
  await conn.query(
    `UPDATE \`${s}\`.tb_financial_statement SET status = 'E', updated_at = NOW()
      WHERE tb_institution_id = ? AND id = ?`,
    [institutionId, line.id]
  )
  return mirrorId
}

function localTodayIso(): string {
  const d = new Date()
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')].join('-')
}
