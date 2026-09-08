import { PoolConnection } from 'mysql2/promise'
import { HttpError } from '@shared/errors/http-error'
import { nextSettledCode } from './financial-settlement'

/**
 * Peça compartilhada: BAIXA EM LOTE (settled_code N:1), rotina de parcerias
 * (ordens PA) e ESTORNO de uma baixa — extraídas de settlements.repository
 * em 2026-09-04 (onda do boleto: liquidar N títulos sob UM código e
 * estornar pelo mesmo núcleo). Regra de ouro preservada: financeiro NÃO SE
 * APAGA — estorno é lançamento inverso (status R + origem) com marcação E.
 * Tudo aqui é transaction-aware (1º parâmetro conn).
 */

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/** Soma dias corridos a 'YYYY-MM-DD' (DP12: venc. PA = baixa+12). */
function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

/** Quinhão do parceiro: % sobre o valor efetivamente pago (4.3). */
function partnerShare(paidValue: number, rate: number): number {
  return round2(paidValue * rate / 100)
}

/** Um título dentro do LOTE de baixa (valores informados — P5). */
export interface SettleTitleInput {
  orderId:         number
  parcel:          number
  interestValue:   number
  lateValue:       number
  discountAliquot: number
  paidValue:       number
}

/** Lote de baixa: N títulos → 1 settled_code → 1 statement (N:1). */
export interface SettleBatchInput {
  titles:        SettleTitleInput[]
  bankAccountId: number
  dtPayment:     string
  dtRealPayment?: string | null
  financialPlanCreId?: number | null
  financialPlanDebId?: number | null
  /** Histórico do movimento (default "Baixa <código>") — boleto: "RECEBIMENTO BOLETO <nosso nº>". */
  history?: string
  /** Referência do documento no extrato (boleto: nosso número). */
  docReference?: string | null
  /**
   * D-B1 (Rodada 2 do boleto, 2026-09-04): título com BOLETO VIGENTE não
   * pode ser baixado por outro meio (equivalente ao FIN_SITUACAO='D' do
   * legado) — 409 TITLE_HAS_OPEN_SLIP até cancelar o boleto. Passe o id do
   * PRÓPRIO boleto quando a baixa É a liquidação dele (settleBankSlip);
   * omitido = baixa manual, qualquer boleto vigente bloqueia.
   */
  allowedBankSlipId?: number | null
}

export interface SettleBatchResult {
  settledCode: number
  statementId: number
  totalValue:  number
  titles:      number
  /** Ordens PA geradas pela rotina de parcerias (4.3 — recebimentos). */
  paOrders:    number
}

/**
 * Núcleo TRANSACTION-AWARE da baixa em lote (settled_code N:1 — Fase 6.1):
 * usado pelo módulo settlements (baixa manual) e pelo boleto (liquidação de
 * N títulos sob UM código). Quem chama abre/commita a transação.
 */
export async function settleBatchTx(
  conn: PoolConnection, input: SettleBatchInput, schemaName: string,
  institutionId: number, userId: number
): Promise<SettleBatchResult> {

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

    // DP9: código único de agrupamento — fonte no @shared nextSettledCode
    // (tb_financial_statement, não tb_financial_payment — achado do smoke
    // do cheque em 2026-09-04, ver comentário na função compartilhada).
    const settledCode = await nextSettledCode(conn, schemaName, institutionId)

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

      // D-B1: leitura TRAVANTE (após o FOR UPDATE do título acima) do
      // boleto vigente — mesmo padrão de hasOpenSlip do @shared/bank-slip;
      // consulta direta às tabelas (settlement-batch não importa o módulo
      // bank-slip para não criar ciclo — bank-slip importa settleBatchTx).
      const [openSlips] = await conn.query<any[]>(
        `SELECT t.tb_bank_slip_id AS id,
                (SELECT ev.kind FROM \`${schemaName}\`.tb_bank_slip_event ev
                  WHERE ev.tb_institution_id = t.tb_institution_id
                    AND ev.tb_bank_slip_id = t.tb_bank_slip_id AND ev.deleted = 'N'
                  ORDER BY ev.event DESC LIMIT 1) AS lastKind
           FROM \`${schemaName}\`.tb_bank_slip_title t
           INNER JOIN \`${schemaName}\`.tb_bank_slip bs
              ON bs.id = t.tb_bank_slip_id AND bs.tb_institution_id = t.tb_institution_id
             AND bs.deleted = 'N'
          WHERE t.tb_institution_id = ? AND t.tb_order_id = ? AND t.terminal = 0
            AND t.parcel = ? AND t.deleted = 'N' FOR UPDATE`,
        [institutionId, title.orderId, title.parcel]
      )
      const blockingSlip = openSlips.find(r =>
        r.lastKind !== 'L' && r.lastKind !== 'C' && Number(r.id) !== Number(input.allowedBankSlipId ?? -1))
      if (blockingSlip) {
        throw new HttpError(409,
          `Título ${title.orderId}/${title.parcel} tem o boleto ${blockingSlip.id} vigente — cancele-o antes de baixar por outro meio`,
          undefined, 'TITLE_HAS_OPEN_SLIP')
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
          doc_reference,
          kind, settled_code, tb_user_id, future, dt_original, conferred,
          tb_payment_types_id, tb_financial_plans_id_cre,
          tb_financial_plans_id_deb, status, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'N', ?, 'N', ?, ?, ?, 'N',
               NOW(), NOW())`,
      [statementId, institutionId, input.bankAccountId,
       input.dtRealPayment ?? input.dtPayment,
       totalCredit, totalDebit,
       (input.history ?? `Baixa ${settledCode}`).slice(0, 100),
       input.docReference ?? null,
       totalCredit >= totalDebit ? 'C' : 'D', settledCode, userId,
       input.dtPayment, firstPaymentTypeId, planCre, planDeb]
    )

    return {
      settledCode, statementId,
      totalValue: round2(totalCredit - totalDebit),
      titles: input.titles.length,
      paOrders,
    }
}

export async function generatePartnershipOrders(
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

export async function createPaCompensation(
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

export interface ReversalCore {
  reversalEvent: number
  settledCode:   number
}

export async function reverseOnePayment(
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

    // código PRÓPRIO do estorno (5.5.1) — mesma fonte única do settleBatchTx
    const reversalCode = await nextSettledCode(conn, schemaName, institutionId)

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

    // statement INVERSO compensa exatamente a parte estornada (5.5.7).
    // origSt[0] = linha PRINCIPAL do código (valor dos títulos); as demais
    // são SATÉLITES do mesmo código (ex.: DÉBITO da taxa do contrato
    // financeiro — migration 038, D3/D5) e são invertidas quando o código
    // morre por inteiro (último payment vigente estornado).
    const [origSt] = await conn.query<any[]>(
      `SELECT id, tb_bank_account_id AS bankAccountId,
              tb_cashier_id AS cashierId,
              DATE_FORMAT(dt_record, '%Y-%m-%d') AS dtRecord,
              credit_value AS creditValue, debit_value AS debitValue,
              manual_history AS history,
              tb_payment_types_id AS paymentTypeId,
              tb_financial_plans_id_cre AS planCre,
              tb_financial_plans_id_deb AS planDeb
         FROM \`${schemaName}\`.tb_financial_statement
        WHERE tb_institution_id = ? AND settled_code = ? AND status <> 'R'
        ORDER BY id FOR UPDATE`,
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
    // D-G3 (contrato financeiro, Rodada 4): o inverso HERDA dt_record (anula
    // na mesma data de disponibilidade — crédito futuro de cartão não deixa
    // o saldo de hoje negativo) e a sessão de caixa do original; dt_original
    // = hoje (fato gerador do estorno). Sem original: CURDATE().
    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_financial_statement
         (id, tb_institution_id, terminal, tb_bank_account_id, tb_cashier_id,
          dt_record, tb_bank_historic_id, credit_value, debit_value, manual_history,
          kind, settled_code, tb_user_id, future, dt_original, conferred,
          tb_payment_types_id, tb_financial_plans_id_cre,
          tb_financial_plans_id_deb, status,
          tb_financial_statement_id_origin, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, COALESCE(?, CURDATE()), 0, ?, ?, ?, ?, ?, ?, 'N', CURDATE(),
               'N', ?, ?, ?, 'R', ?, NOW(), NOW())`,
      [Number(mxSt[0].nextId), institutionId,
       origSt[0] ? origSt[0].bankAccountId : 0,
       origSt[0] ? (origSt[0].cashierId ?? null) : null,
       origSt[0] ? (origSt[0].dtRecord ?? null) : null,
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
      // satélites do código (taxa do contrato etc.): inverso + 'E'
      for (const sat of origSt.slice(1)) {
        const [mxSat] = await conn.query<any[]>(
          `SELECT COALESCE(MAX(id), 0) + 1 AS nextId
             FROM \`${schemaName}\`.tb_financial_statement
            WHERE tb_institution_id = ? FOR UPDATE`,
          [institutionId]
        )
        const satCredit = Number(sat.debitValue) || 0
        const satDebit  = Number(sat.creditValue) || 0
        await conn.query(
          `INSERT INTO \`${schemaName}\`.tb_financial_statement
             (id, tb_institution_id, terminal, tb_bank_account_id, tb_cashier_id,
              dt_record, tb_bank_historic_id, credit_value, debit_value,
              manual_history, kind, settled_code, tb_user_id, future,
              dt_original, conferred, tb_payment_types_id,
              tb_financial_plans_id_cre, tb_financial_plans_id_deb, status,
              tb_financial_statement_id_origin, created_at, updated_at)
           VALUES (?, ?, 0, ?, ?, COALESCE(?, CURDATE()), 0, ?, ?, ?, ?, ?, ?, 'N', CURDATE(),
                   'N', ?, ?, ?, 'R', ?, NOW(), NOW())`,
          [Number(mxSat[0].nextId), institutionId, sat.bankAccountId,
           sat.cashierId ?? null, sat.dtRecord ?? null, satCredit, satDebit,
           `Estorno ${String(sat.history ?? '')}`.slice(0, 100),
           satCredit >= satDebit ? 'C' : 'D', reversalCode, userId,
           sat.paymentTypeId, sat.planCre, sat.planDeb, sat.id]
        )
        await conn.query(
          `UPDATE \`${schemaName}\`.tb_financial_statement
              SET status = 'E', updated_at = NOW()
            WHERE tb_institution_id = ? AND id = ?`,
          [institutionId, sat.id]
        )
      }
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
