import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { HttpError } from '@shared/errors/http-error'

/**
 * Peça compartilhada do MOVIMENTO financeiro imutável (payment + statement)
 * — núcleo mínimo TRANSACTION-AWARE (1º parâmetro conn), sem a rotina de
 * parcerias (exclusiva do módulo `settlements`, baixa em LOTE). Consumida
 * por `billing` (baixa automática à vista, kind='E') e `cashier`
 * (retirada/transferência — movimento manual, sem título).
 *
 * `bankAccountId = 0` é o sentinela de CAIXA — mesma convenção JÁ usada em
 * `settlements.repository.settleBatch` (`stage = bankAccountId>0 ? 'B' :
 * 'C'`); não é maquete, é precedente real do legado (`MVF_CODCTB=0`).
 * `cashierId` (migration 033) amarra o movimento à SESSÃO de caixa —
 * preenchido só quando `bankAccountId=0`.
 */

export interface SettleOneTitleInput {
  orderId: number
  parcel: number
  paidValue: number
  dtPayment: string
  bankAccountId: number       // 0 = caixa
  cashierId?: number | null
}

export interface SettleOneTitleResult {
  settledCode: number
  statementId: number
  event: number
}

/** Baixa de UM título (sem lote, sem parcerias) — usado pela baixa automática do billing. */
export async function settleOneTitle(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, input: SettleOneTitleInput
): Promise<SettleOneTitleResult> {
  const s = assertSchema(schemaName)

  const [fin] = await conn.query<any[]>(
    `SELECT f.tb_payment_types_id AS paymentTypeId, b.operation
       FROM \`${s}\`.tb_financial f
       INNER JOIN \`${s}\`.tb_financial_bills b
          ON b.tb_institution_id = f.tb_institution_id
         AND b.tb_order_id = f.tb_order_id AND b.terminal = f.terminal
         AND b.parcel = f.parcel AND b.deleted = 'N'
      WHERE f.tb_institution_id = ? AND f.tb_order_id = ? AND f.terminal = 0
        AND f.parcel = ? AND f.deleted = 'N' FOR UPDATE`,
    [institutionId, input.orderId, input.parcel]
  )
  if (!fin[0]) {
    throw new HttpError(404, `Título ${input.orderId}/${input.parcel} não encontrado`,
      undefined, 'TITLE_NOT_FOUND')
  }

  const [mxCode] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(settled_code), 0) + 1 AS nextCode
       FROM \`${s}\`.tb_financial_payment WHERE tb_institution_id = ? FOR UPDATE`,
    [institutionId]
  )
  const settledCode = Number(mxCode[0].nextCode)

  const [mxEvent] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(event), 0) + 1 AS nextEvent
       FROM \`${s}\`.tb_financial_payment
      WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0
        AND parcel = ? FOR UPDATE`,
    [institutionId, input.orderId, input.parcel]
  )
  const event = Number(mxEvent[0].nextEvent)

  await conn.query(
    `INSERT INTO \`${s}\`.tb_financial_payment
       (tb_institution_id, tb_order_id, terminal, parcel, event,
        interest_value, late_value, discount_aliquot, paid_value,
        dt_payment, dt_real_payment, settled, tb_financial_plans_id,
        settled_code, tb_payment_types_id, status, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?, 0, 0, 0, ?, ?, ?, 'S', 0, ?, ?, 'N', NOW(), NOW())`,
    [institutionId, input.orderId, input.parcel, event, input.paidValue,
     input.dtPayment, input.dtPayment, settledCode, fin[0].paymentTypeId]
  )

  const stage = input.bankAccountId > 0 ? 'B' : 'C'
  await conn.query(
    `UPDATE \`${s}\`.tb_financial_bills SET stage = ?, updated_at = NOW()
      WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0 AND parcel = ?`,
    [stage, institutionId, input.orderId, input.parcel]
  )

  const credit = fin[0].operation === 'D' ? 0 : input.paidValue
  const debit  = fin[0].operation === 'D' ? input.paidValue : 0

  const [mxSt] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId
       FROM \`${s}\`.tb_financial_statement WHERE tb_institution_id = ? FOR UPDATE`,
    [institutionId]
  )
  const statementId = Number(mxSt[0].nextId)
  await conn.query(
    `INSERT INTO \`${s}\`.tb_financial_statement
       (id, tb_institution_id, terminal, tb_bank_account_id, tb_cashier_id, dt_record,
        tb_bank_historic_id, credit_value, debit_value, manual_history,
        kind, settled_code, tb_user_id, future, dt_original, conferred,
        tb_payment_types_id, tb_financial_plans_id_cre, tb_financial_plans_id_deb,
        status, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'N', ?, 'N', ?, 0, 0, 'N', NOW(), NOW())`,
    [statementId, institutionId, input.bankAccountId, input.cashierId ?? null,
     input.dtPayment, credit, debit, `Baixa automática ${settledCode}`,
     credit >= debit ? 'C' : 'D', settledCode, userId, input.dtPayment, fin[0].paymentTypeId]
  )

  return { settledCode, statementId, event }
}

/** Sessão de caixa ABERTA (`hr_end IS NULL`) do usuário — terminal web fixo 0. */
export async function findOpenCashierId(
  schemaName: string, institutionId: number, userId: number
): Promise<number | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT id FROM \`${s}\`.tb_cashier
      WHERE tb_institution_id = ? AND terminal = 0 AND tb_user_id = ?
        AND hr_end IS NULL AND deleted = 'N'
      ORDER BY id DESC LIMIT 1`,
    [institutionId, userId]
  )
  return rows[0] ? Number(rows[0].id) : null
}

export interface AutoSettleCashInput {
  orderId: number
  parcel: number
  paidValue: number
  dtPayment: string
  paymentTypeId: number
}

export interface AutoSettleCashResult {
  settled: boolean
  settledCode?: number
  statementId?: number
  cashierId?: number
  reason?: 'NOT_CASH' | 'BANK_PREFERRED' | 'NO_OPEN_CASHIER'
}

/**
 * Baixa automática à vista em ESPÉCIE (`tb_payment_types.kind='E'`) — W3.2.
 * Decisão do Valdo: sem caixa aberto, NÃO bloqueia o faturamento — só
 * deixa o título ABERTO pra baixa manual depois (/settlements). `kind`
 * PIX ('X') fica fora desta função (baixa em conta corrente pré-
 * cadastrada, sem gate de caixa — frente própria, ainda não implementada).
 */
export async function tryAutoSettleCash(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, input: AutoSettleCashInput
): Promise<AutoSettleCashResult> {
  const s = assertSchema(schemaName)

  const [pt] = await conn.query<any[]>(
    `SELECT kind FROM setes_central.tb_payment_types WHERE id = ? AND deleted = 'N'`,
    [input.paymentTypeId]
  )
  if (!pt[0] || pt[0].kind !== 'E') return { settled: false, reason: 'NOT_CASH' }

  const [link] = await conn.query<any[]>(
    `SELECT usage_preference AS usagePreference
       FROM \`${s}\`.tb_institution_has_payment_types
      WHERE tb_institution_id = ? AND tb_payment_types_id = ? AND deleted = 'N'`,
    [institutionId, input.paymentTypeId]
  )
  // usagePreference 'B' = o cliente prefere lançar espécie direto no banco
  // (sem caixa) — fora do escopo desta função (não há conta pra escolher
  // automaticamente); 'C'/'A'/ausente = caixa (default do domínio).
  if (link[0]?.usagePreference === 'B') return { settled: false, reason: 'BANK_PREFERRED' }

  const cashierId = await findOpenCashierId(schemaName, institutionId, userId)
  if (cashierId === null) return { settled: false, reason: 'NO_OPEN_CASHIER' }

  const result = await settleOneTitle(conn, schemaName, institutionId, userId, {
    orderId: input.orderId, parcel: input.parcel, paidValue: input.paidValue,
    dtPayment: input.dtPayment, bankAccountId: 0, cashierId,
  })
  return { settled: true, settledCode: result.settledCode, statementId: result.statementId, cashierId }
}

export interface ManualCashierMovementInput {
  cashierId: number
  value: number
  history: string
  dtRecord: string
  destinationBankAccountId?: number | null
}

export interface ManualCashierMovementResult {
  statementId: number
  destinationStatementId: number | null
}

/**
 * Movimento MANUAL do caixa — sem título (retirada) ou com espelho numa
 * conta corrente (transferência). `Pc_RetiraValorCaixa`/
 * `Pc_InsereValorCaixaTranferencia` do legado: mesma operação, a
 * transferência é a retirada com destino rastreado.
 */
export async function writeManualCashierMovement(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, input: ManualCashierMovementInput
): Promise<ManualCashierMovementResult> {
  const s = assertSchema(schemaName)
  const nextStatementId = async (): Promise<number> => {
    const [mx] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId
         FROM \`${s}\`.tb_financial_statement WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId]
    )
    return Number(mx[0].nextId)
  }

  const statementId = await nextStatementId()
  await conn.query(
    `INSERT INTO \`${s}\`.tb_financial_statement
       (id, tb_institution_id, terminal, tb_bank_account_id, tb_cashier_id, dt_record,
        tb_bank_historic_id, credit_value, debit_value, manual_history,
        kind, tb_user_id, future, dt_original, conferred, status, created_at, updated_at)
     VALUES (?, ?, 0, 0, ?, ?, 0, 0, ?, ?, 'D', ?, 'N', ?, 'N', 'N', NOW(), NOW())`,
    [statementId, institutionId, input.cashierId, input.dtRecord,
     input.value, input.history, userId, input.dtRecord]
  )

  let destinationStatementId: number | null = null
  if (input.destinationBankAccountId != null && input.destinationBankAccountId > 0) {
    const [acc] = await conn.query<any[]>(
      `SELECT 1 FROM \`${s}\`.tb_bank_account
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [input.destinationBankAccountId, institutionId]
    )
    if (acc.length === 0) {
      throw new HttpError(400, 'Conta bancária de destino inexistente',
        [{ field: 'destinationBankAccountId', message: 'Conta não encontrada' }],
        'BANK_NOT_FOUND')
    }
    destinationStatementId = await nextStatementId()
    await conn.query(
      `INSERT INTO \`${s}\`.tb_financial_statement
         (id, tb_institution_id, terminal, tb_bank_account_id, tb_cashier_id, dt_record,
          tb_bank_historic_id, credit_value, debit_value, manual_history,
          kind, tb_user_id, future, dt_original, conferred, status, created_at, updated_at)
       VALUES (?, ?, 0, ?, NULL, ?, 0, ?, 0, ?, 'C', ?, 'N', ?, 'N', 'N', NOW(), NOW())`,
      [destinationStatementId, institutionId, input.destinationBankAccountId,
       input.dtRecord, input.value, `Transferência do caixa: ${input.history}`.slice(0, 100),
       userId, input.dtRecord]
    )
  }
  return { statementId, destinationStatementId }
}
