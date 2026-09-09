import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { HttpError } from '@shared/errors/http-error'

/**
 * Peça compartilhada do MOVIMENTO financeiro imutável (payment + statement)
 * — núcleo mínimo TRANSACTION-AWARE (1º parâmetro conn), sem a rotina de
 * parcerias (exclusiva do módulo `settlements`, baixa em LOTE). Consumida
 * por `billing` (baixa automática por CONTRATO FINANCEIRO) e `cashier`
 * (retirada/transferência — movimento manual, sem título).
 *
 * `bankAccountId = 0` é o sentinela de CAIXA — mesma convenção JÁ usada em
 * `settlements.repository.settleBatch` (`stage = bankAccountId>0 ? 'B' :
 * 'C'`); não é maquete, é precedente real do legado (`MVF_CODCTB=0`).
 * `cashierId` (migration 033) amarra o movimento à SESSÃO de caixa —
 * preenchido só quando `bankAccountId=0`.
 *
 * Contrato financeiro (migration 038 — prompt_contrato_financeiro_
 * baixa_automatica.md, D1–D22): a PRESENÇA de `tb_financial_contract` na
 * forma de pagamento é o ÚNICO gatilho de baixa automática no faturamento
 * (D1/D9). `tryAutoSettleByContract` substituiu a antiga baixa por kind='E'
 * (absorvida — D1/D22: espécie também exige contrato, com conta 0).
 */

export interface SettleOneTitleInput {
  orderId: number
  parcel: number
  paidValue: number
  /** Data da BAIXA do título (fato gerador — `dt_original` do statement). */
  dtPayment: string
  bankAccountId: number       // 0 = caixa
  cashierId?: number | null
  /** Data em que o dinheiro fica DISPONÍVEL (`dt_record`) — D6/D12 do
   *  contrato; omitido = dtPayment ("cai na hora"). */
  dtRecord?: string
  /** Histórico do movimento (máx. 100) — default "Baixa automática <código>". */
  history?: string
  /** Planos financeiros do movimento (D5 — os do vínculo da forma). */
  financialPlanCreId?: number
  financialPlanDebId?: number
}

export interface SettleOneTitleResult {
  settledCode: number
  statementId: number
  event: number
  /** 'C' crédito a favor da empresa / 'D' débito (contas a pagar). */
  operation: 'C' | 'D'
  paymentTypeId: number
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

  // Fonte única (ver nextSettledCode abaixo) — não reler tb_financial_payment aqui.
  const settledCode = await nextSettledCode(conn, s, institutionId)

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

  const operation: 'C' | 'D' = fin[0].operation === 'D' ? 'D' : 'C'
  const credit = operation === 'D' ? 0 : input.paidValue
  const debit  = operation === 'D' ? input.paidValue : 0

  const statementId = await insertStatement(conn, s, institutionId, {
    bankAccountId: input.bankAccountId, cashierId: input.cashierId ?? null,
    dtRecord: input.dtRecord ?? input.dtPayment, dtOriginal: input.dtPayment,
    credit, debit, history: input.history ?? `Baixa automática ${settledCode}`,
    settledCode, userId, paymentTypeId: Number(fin[0].paymentTypeId),
    planCre: input.financialPlanCreId ?? 0, planDeb: input.financialPlanDebId ?? 0,
  })

  return { settledCode, statementId, event, operation, paymentTypeId: Number(fin[0].paymentTypeId) }
}

export interface StatementLine {
  bankAccountId: number
  cashierId: number | null
  dtRecord: string
  dtOriginal: string
  credit: number
  debit: number
  history: string
  settledCode: number | null
  userId: number
  paymentTypeId: number | null
  planCre: number
  planDeb: number
  /** 'R' = linha de estorno (espelho); padrão 'N'. */
  status?: 'N' | 'R'
  /** Linha original espelhada (tb_financial_statement_id_origin) — só no estorno. */
  originId?: number | null
}

/**
 * Próximo código de baixa/movimento (MAX+1 por institution, FOR UPDATE) — a
 * MESMA sequência de tb_financial_payment.settled_code usada por
 * settleBatchTx/reverseOnePayment (settlement-batch.ts). Movimentos SEM
 * título (ex.: desconto de cheque na factoring — @shared/check) também
 * mintam código aqui: é só um identificador de agrupamento de linhas do
 * extrato, não exige uma linha em tb_financial_payment.
 */
export async function nextSettledCode(
  conn: PoolConnection, s: string, institutionId: number
): Promise<number> {
  // FONTE ÚNICA: tb_financial_statement, não tb_financial_payment. Todo
  // settleOneTitle/settleBatchTx grava as DUAS (o statement é superset —
  // gate socrático 2026-09-04, achado do smoke do cheque: um desconto de
  // cheque não toca tb_financial_payment nenhuma vez; se o contador lesse
  // só o payment, dois movimentos-sem-título seguidos mintavam o MESMO
  // código, colidindo o agrupamento de reversão).
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(settled_code), 0) + 1 AS nextCode
       FROM \`${s}\`.tb_financial_statement WHERE tb_institution_id = ? FOR UPDATE`,
    [institutionId]
  )
  return Number(mx[0].nextCode)
}

/** Linha do extrato (tb_financial_statement) — id MAX+1 por institution em transação. */
export async function insertStatement(
  conn: PoolConnection, s: string, institutionId: number, line: StatementLine
): Promise<number> {
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
        status, tb_financial_statement_id_origin, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'N', ?, 'N', ?, ?, ?, ?, ?, NOW(), NOW())`,
    [statementId, institutionId, line.bankAccountId, line.cashierId, line.dtRecord,
     line.credit, line.debit, line.history.slice(0, 100),
     line.credit >= line.debit ? 'C' : 'D', line.settledCode, line.userId,
     line.dtOriginal, line.paymentTypeId, line.planCre, line.planDeb,
     line.status ?? 'N', line.originId ?? null]
  )
  return statementId
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

/**
 * Mesma consulta DENTRO da transação, com FOR UPDATE: trava a sessão de
 * caixa até o commit do faturamento — o fechamento concorrente do caixa
 * (FOR UPDATE em tb_cashier) espera, e o movimento nunca nasce numa sessão
 * já fechada (gate socrático/adversarial 2026-09-03).
 */
export async function findOpenCashierIdTx(
  conn: PoolConnection, schemaName: string, institutionId: number, userId: number
): Promise<number | null> {
  const s = assertSchema(schemaName)
  const [rows] = await conn.query<any[]>(
    `SELECT id FROM \`${s}\`.tb_cashier
      WHERE tb_institution_id = ? AND terminal = 0 AND tb_user_id = ?
        AND hr_end IS NULL AND deleted = 'N'
      ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [institutionId, userId]
  )
  return rows[0] ? Number(rows[0].id) : null
}

// ---------------------------------------------------------------------
// Contrato financeiro (migration 038) — política de baixa automática
// ---------------------------------------------------------------------

export interface FinancialContractPolicy {
  paymentTypeId: number
  paymentTypeDescription: string
  paymentTypeKind: string | null
  bankAccountId: number       // 0 = caixa
  feeRate: number             // %
  paymentTerm: number         // dias
  expirationDate: string | null
  /** Planos do VÍNCULO da forma (D5) — 0 = não definido. */
  financialPlanCreId: number
  financialPlanDebId: number
}

/**
 * Contrato VIVO da forma de pagamento nesta institution (presença =
 * política de baixa automática). Lê na MESMA transação do faturamento.
 */
export async function getFinancialContract(
  conn: PoolConnection, schemaName: string, institutionId: number,
  paymentTypeId: number
): Promise<FinancialContractPolicy | null> {
  const s = assertSchema(schemaName)
  const [rows] = await conn.query<any[]>(
    `SELECT c.tb_payment_types_id AS paymentTypeId,
            pt.description        AS paymentTypeDescription,
            pt.kind               AS paymentTypeKind,
            c.tb_bank_account_id  AS bankAccountId,
            c.fee_rate            AS feeRate,
            c.payment_term        AS paymentTerm,
            DATE_FORMAT(c.expiration_date, '%Y-%m-%d') AS expirationDate,
            h.tb_financial_plans_id_cre AS financialPlanCreId,
            h.tb_financial_plans_id_deb AS financialPlanDebId
       FROM \`${s}\`.tb_financial_contract c
       INNER JOIN \`${s}\`.tb_institution_has_payment_types h
          ON h.tb_institution_id = c.tb_institution_id
         AND h.tb_payment_types_id = c.tb_payment_types_id AND h.deleted = 'N'
       LEFT JOIN setes_central.tb_payment_types pt ON pt.id = c.tb_payment_types_id
      WHERE c.tb_institution_id = ? AND c.tb_payment_types_id = ? AND c.deleted = 'N'`,
    [institutionId, paymentTypeId]
  )
  if (!rows[0]) return null
  const r = rows[0]
  return {
    paymentTypeId: Number(r.paymentTypeId),
    paymentTypeDescription: String(r.paymentTypeDescription ?? ''),
    paymentTypeKind: r.paymentTypeKind ?? null,
    bankAccountId: Number(r.bankAccountId) || 0,
    feeRate: Number(r.feeRate) || 0,
    paymentTerm: Number(r.paymentTerm) || 0,
    expirationDate: r.expirationDate ?? null,
    financialPlanCreId: Number(r.financialPlanCreId) || 0,
    financialPlanDebId: Number(r.financialPlanDebId) || 0,
  }
}

export interface AutoSettleContractInput {
  orderId: number
  parcel: number
  paidValue: number
  /** Data do faturamento (fato gerador — dt_payment/dt_original). */
  dtPayment: string
  paymentTypeId: number
}

export type AutoSettleReason =
  | 'NO_CONTRACT'            // forma sem contrato — título nasce aberto (regra 4)
  | 'KIND_FIXED'             // cheque 'Q' (onda própria) / boleto 'B' (nunca baixa no nascimento) — D18
  | 'CONTRACT_EXPIRED'       // expiration_date < faturamento — avisa e gera aberto (D11)
  | 'NO_OPEN_CASHIER'        // contrato p/ caixa (conta 0) sem caixa do usuário aberto (regra 1)
  | 'BANK_ACCOUNT_NOT_FOUND' // conta do contrato não existe/excluída (regra 2)

export interface AutoSettleContractResult {
  settled: boolean
  reason?: AutoSettleReason
  settledCode?: number
  statementId?: number
  feeStatementId?: number | null
  cashierId?: number | null
  /** Data em que o dinheiro fica disponível (faturamento + prazo × parcela — D12). */
  dtRecord?: string
}

/** Formas cujo comportamento é FIXO por kind — o contrato não muda o fluxo (D16/D18). */
const KIND_FIXED = new Set(['Q', 'B'])

/** Soma dias a 'YYYY-MM-DD' sem depender do fuso (aritmética em UTC). */
export function addDaysIso(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return t.toISOString().slice(0, 10)
}

/** Arredondamento half-up estável em 2 casas (1.005 → 1.01, não 1.00). */
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * Baixa automática por CONTRATO FINANCEIRO (D1–D22). Gates GRACIOSOS:
 * nunca lança por motivo de negócio — devolve `{settled:false, reason}` e
 * o título fica ABERTO para baixa manual (regra 3 do Valdo: faturamento
 * nunca é proibido). Motivo vai só a log (D14 — resposta do faturamento é
 * apenas "pedido faturado com sucesso").
 *
 * Quando baixa: 1 payment + 1 statement (crédito do valor da parcela na
 * conta do contrato — conta 0 = caixa com a sessão aberta — com
 * dt_record = faturamento + payment_term × parcela e dt_original =
 * faturamento) + 1 statement de DÉBITO da taxa (fee_rate) sob o MESMO
 * settled_code (estorno em cadeia inverte os dois). Espécie/PIX = contrato
 * com taxa 0 e prazo 0 → cai na hora (D4/D22).
 */
export async function tryAutoSettleByContract(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, input: AutoSettleContractInput
): Promise<AutoSettleContractResult> {
  const s = assertSchema(schemaName)

  const [pt] = await conn.query<any[]>(
    `SELECT kind FROM setes_central.tb_payment_types WHERE id = ? AND deleted = 'N'`,
    [input.paymentTypeId]
  )
  if (pt[0] && KIND_FIXED.has(pt[0].kind)) return { settled: false, reason: 'KIND_FIXED' }

  const contract = await getFinancialContract(conn, schemaName, institutionId, input.paymentTypeId)
  if (!contract) return { settled: false, reason: 'NO_CONTRACT' }
  if (contract.expirationDate && contract.expirationDate < input.dtPayment) {
    return { settled: false, reason: 'CONTRACT_EXPIRED' }
  }

  let cashierId: number | null = null
  if (contract.bankAccountId === 0) {
    cashierId = await findOpenCashierIdTx(conn, schemaName, institutionId, userId)
    if (cashierId === null) return { settled: false, reason: 'NO_OPEN_CASHIER' }
  } else {
    const [acc] = await conn.query<any[]>(
      `SELECT 1 FROM \`${s}\`.tb_bank_account
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [contract.bankAccountId, institutionId]
    )
    if (acc.length === 0) return { settled: false, reason: 'BANK_ACCOUNT_NOT_FOUND' }
  }

  const dtRecord = addDaysIso(input.dtPayment, contract.paymentTerm * input.parcel)
  const label = contract.paymentTypeDescription || `forma ${contract.paymentTypeId}`

  const settled = await settleOneTitle(conn, schemaName, institutionId, userId, {
    orderId: input.orderId, parcel: input.parcel, paidValue: input.paidValue,
    dtPayment: input.dtPayment, dtRecord,
    bankAccountId: contract.bankAccountId, cashierId,
    history: `Baixa automática ${label} | Pedido ${input.orderId} parcela ${input.parcel}`,
    financialPlanCreId: contract.financialPlanCreId,
    financialPlanDebId: contract.financialPlanDebId,
  })
  // histórico definitivo carrega o código gerado (sem 2ª ida ao banco:
  // o código só existe após settleOneTitle) — mantido como está.

  let feeStatementId: number | null = null
  const feeValue = round2(input.paidValue * contract.feeRate / 100)
  if (settled.operation === 'C' && feeValue > 0) {
    feeStatementId = await insertStatement(conn, s, institutionId, {
      bankAccountId: contract.bankAccountId, cashierId,
      dtRecord, dtOriginal: input.dtPayment,
      credit: 0, debit: feeValue,
      history: `Taxa ${contract.feeRate}% ${label} | Pedido ${input.orderId} parcela ${input.parcel}`,
      settledCode: settled.settledCode, userId,
      paymentTypeId: settled.paymentTypeId,
      planCre: contract.financialPlanCreId, planDeb: contract.financialPlanDebId,
    })
  }

  return {
    settled: true, settledCode: settled.settledCode, statementId: settled.statementId,
    feeStatementId, cashierId, dtRecord,
  }
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
