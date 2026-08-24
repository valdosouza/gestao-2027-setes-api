import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { HttpError } from '@shared/errors/http-error'
import { writeManualCashierMovement, ManualCashierMovementResult } from '@shared/financial-settlement'
import { CashierRow, ClosingItemResult } from './cashier.interface'

/**
 * Repositório do caixa (W3.2). `tb_cashier`/`tb_cashier_items` são do
 * BASELINE (dormentes pro lado web — só o Sincronizador escreve, indexado
 * por terminal 1..N do PDV); a web usa `terminal = 0` fixo (Q-Caixa 5) —
 * nunca colide com os terminais do PDV.
 */

const WEB_TERMINAL = 0

function mapRow(r: any): CashierRow {
  return {
    id: Number(r.id),
    dtRecord: r.dtRecord instanceof Date ? r.dtRecord.toISOString().slice(0, 10) : String(r.dtRecord),
    userId: Number(r.userId),
    hrBegin: r.hrBegin ? String(r.hrBegin) : null,
    hrEnd: r.hrEnd ? String(r.hrEnd) : null,
  }
}

export async function findOpenCashier(
  schemaName: string, institutionId: number, userId: number
): Promise<CashierRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT id, dt_record AS dtRecord, tb_user_id AS userId,
            hr_begin AS hrBegin, hr_end AS hrEnd
       FROM \`${s}\`.tb_cashier
      WHERE tb_institution_id = ? AND terminal = ? AND tb_user_id = ?
        AND hr_end IS NULL AND deleted = 'N'
      ORDER BY id DESC LIMIT 1`,
    [institutionId, WEB_TERMINAL, userId]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getCashier(
  schemaName: string, institutionId: number, cashierId: number
): Promise<CashierRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT id, dt_record AS dtRecord, tb_user_id AS userId,
            hr_begin AS hrBegin, hr_end AS hrEnd
       FROM \`${s}\`.tb_cashier
      WHERE tb_institution_id = ? AND terminal = ? AND id = ? AND deleted = 'N'`,
    [institutionId, WEB_TERMINAL, cashierId]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

/** Abre uma sessão nova — 409 se já existe uma aberta para o usuário (Q-Caixa 5). */
export async function openCashier(
  schemaName: string, institutionId: number, userId: number
): Promise<CashierRow> {
  const s = assertSchema(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [open] = await conn.query<any[]>(
      `SELECT id FROM \`${s}\`.tb_cashier
        WHERE tb_institution_id = ? AND terminal = ? AND tb_user_id = ?
          AND hr_end IS NULL AND deleted = 'N' FOR UPDATE`,
      [institutionId, WEB_TERMINAL, userId]
    )
    if (open[0]) {
      throw new HttpError(409, 'Já existe um caixa aberto para este usuário',
        undefined, 'CASHIER_ALREADY_OPEN')
    }
    const [mx] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId
         FROM \`${s}\`.tb_cashier WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId]
    )
    const id = Number(mx[0].nextId)
    await conn.query(
      `INSERT INTO \`${s}\`.tb_cashier
         (id, tb_institution_id, terminal, dt_record, tb_user_id, hr_begin,
          created_at, updated_at, deleted)
       VALUES (?, ?, ?, CURDATE(), ?, NOW(), NOW(), NOW(), 'N')`,
      [id, institutionId, WEB_TERMINAL, userId]
    )
    await conn.commit()
    const row = await getCashier(schemaName, institutionId, id)
    return row!
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Saldo DERIVADO da sessão (créditos − débitos dos movimentos do caixa). */
export async function getCashierBalance(
  schemaName: string, institutionId: number, cashierId: number
): Promise<number> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT COALESCE(SUM(credit_value), 0) AS credit,
            COALESCE(SUM(debit_value), 0) AS debit
       FROM \`${s}\`.tb_financial_statement
      WHERE tb_institution_id = ? AND tb_cashier_id = ? AND deleted = 'N'
        AND status IN ('N', 'R')`,
    [institutionId, cashierId]
  )
  return Math.round((Number(rows[0].credit) - Number(rows[0].debit)) * 100) / 100
}

/** Registrado por forma de pagamento — insumo da conferência do fechamento. */
export async function getRegisteredByPaymentType(
  schemaName: string, institutionId: number, cashierId: number
): Promise<{ paymentTypeId: number; paymentTypeDescription: string | null; value: number }[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT s.tb_payment_types_id AS paymentTypeId, pt.description AS paymentTypeDescription,
            COALESCE(SUM(s.credit_value), 0) - COALESCE(SUM(s.debit_value), 0) AS value
       FROM \`${s}\`.tb_financial_statement s
       LEFT JOIN setes_central.tb_payment_types pt ON pt.id = s.tb_payment_types_id
      WHERE s.tb_institution_id = ? AND s.tb_cashier_id = ? AND s.deleted = 'N'
        AND s.status IN ('N', 'R')
      GROUP BY s.tb_payment_types_id, pt.description`,
    [institutionId, cashierId]
  )
  return rows.map(r => ({
    paymentTypeId: Number(r.paymentTypeId), paymentTypeDescription: r.paymentTypeDescription ?? null,
    value: Number(r.value),
  }))
}

/** Retirada/transferência (`Pc_RetiraValorCaixa` do legado) — exige caixa ABERTO. */
export async function withdrawTx(
  schemaName: string, institutionId: number, userId: number, cashierId: number,
  value: number, history: string, destinationBankAccountId: number | null | undefined
): Promise<ManualCashierMovementResult> {
  const s = assertSchema(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // dono da sessão (achado QA adversarial 2026-08-22): sem isso, qualquer
    // usuário da institution sacava/transferia de caixa ALHEIO — 404 (não
    // vaza existência, mesmo padrão multi-tenant do resto da API).
    const [row] = await conn.query<any[]>(
      `SELECT hr_end FROM \`${s}\`.tb_cashier
        WHERE tb_institution_id = ? AND terminal = 0 AND id = ? AND tb_user_id = ?
          AND deleted = 'N' FOR UPDATE`,
      [institutionId, cashierId, userId]
    )
    if (!row[0]) throw new HttpError(404, `Caixa ${cashierId} não encontrado`)
    if (row[0].hr_end) throw new HttpError(409, 'Caixa fechado', undefined, 'CASHIER_NOT_OPEN')

    const result = await writeManualCashierMovement(conn, schemaName, institutionId, userId, {
      cashierId, value, history, dtRecord: new Date().toISOString().slice(0, 10),
      destinationBankAccountId,
    })
    await conn.commit()
    return result
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Grava a CONFERÊNCIA (registrado × digitado) e fecha a sessão — UMA transação. */
export async function closeCashierTx(
  schemaName: string, institutionId: number, userId: number, cashierId: number,
  items: { paymentTypeId: number; countedValue: number }[],
  transfer: (conn: PoolConnection) => Promise<{ statementId: number; destinationStatementId: number | null } | null>
): Promise<{ hrEnd: string; closingItems: ClosingItemResult[]; transferResult: { statementId: number; destinationStatementId: number | null } | null }> {
  const s = assertSchema(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    // dono da sessão (achado QA adversarial 2026-08-22) — mesma trava do withdraw.
    const [row] = await conn.query<any[]>(
      `SELECT hr_end FROM \`${s}\`.tb_cashier
        WHERE tb_institution_id = ? AND terminal = 0 AND id = ? AND tb_user_id = ?
          AND deleted = 'N' FOR UPDATE`,
      [institutionId, cashierId, userId]
    )
    if (!row[0]) throw new HttpError(404, `Caixa ${cashierId} não encontrado`)
    if (row[0].hr_end) throw new HttpError(409, 'Caixa já fechado', undefined, 'CASHIER_ALREADY_CLOSED')

    const registered = await getRegisteredByPaymentType(schemaName, institutionId, cashierId)
    const registeredMap = new Map(registered.map(r => [r.paymentTypeId, r]))

    const closingItems: ClosingItemResult[] = []
    for (const item of items) {
      await conn.query(
        `INSERT INTO \`${s}\`.tb_cashier_items
           (id, tb_institution_id, terminal, tb_cashier_id, kind, tb_payment_types_id,
            set_value, created_at, updated_at, deleted)
         VALUES (
           (SELECT COALESCE(MAX(i2.id), 0) + 1 FROM \`${s}\`.tb_cashier_items i2
             WHERE i2.tb_institution_id = ? AND i2.terminal = 0),
           ?, 0, ?, 'F', ?, ?, NOW(), NOW(), 'N')`,
        [institutionId, institutionId, cashierId, item.paymentTypeId, item.countedValue]
      )
      const reg = registeredMap.get(item.paymentTypeId)
      const registeredValue = reg?.value ?? 0
      closingItems.push({
        paymentTypeId: item.paymentTypeId,
        paymentTypeDescription: reg?.paymentTypeDescription ?? null,
        registeredValue,
        countedValue: item.countedValue,
        difference: Math.round((item.countedValue - registeredValue) * 100) / 100,
      })
    }

    const transferResult = await transfer(conn)

    await conn.query(
      `UPDATE \`${s}\`.tb_cashier SET hr_end = NOW(), updated_at = NOW()
        WHERE tb_institution_id = ? AND terminal = 0 AND id = ?`,
      [institutionId, cashierId]
    )
    const [after] = await conn.query<any[]>(
      `SELECT hr_end AS hrEnd FROM \`${s}\`.tb_cashier
        WHERE tb_institution_id = ? AND terminal = 0 AND id = ?`,
      [institutionId, cashierId]
    )

    await conn.commit()
    return { hrEnd: String(after[0].hrEnd), closingItems, transferResult }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}
