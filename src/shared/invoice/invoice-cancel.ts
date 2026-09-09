import { PoolConnection } from 'mysql2/promise'
import { HttpError, FieldError } from '@shared/errors/http-error'
import { assertSchema } from '@shared/db/schema'
import { findOpenCashierIdTx } from '@shared/financial-settlement'
import {
  cancelBankSlip, LAST_EVENT_KIND_SQL as LAST_SLIP_EVENT_KIND_SQL,
  stateFromLastEvent as slipStateFromLastEvent,
} from '@shared/bank-slip'
import { reverseCheckEvent, isCheckEventCurrent } from '@shared/check'
import { insertCommissions, getCommissionBalanceByItem, CommissionEntryInput } from '@shared/commission'
import { findServiceOrderForReopen, reopenServiceOrder } from '@shared/service-order'
import { lockInvoice, insertInvoiceEvent, localTodayIso, LockedInvoice } from './invoice'

/**
 * COMPOSIÇÃO "desfazer o faturamento" (prompt_cancelamento_nota.md D1–D17 +
 * parecer setes-conceito, 2026-09-08). Não reimplementa nenhuma reversão:
 * boleto (`cancelBankSlip`), cheque (`reverseCheckEvent` — que já reverte a
 * baixa do R via `reverseOnePayment`), comissão (`insertCommissions` com o
 * saldo vivo NEGATIVO — R4) e as peças de dados da nota.
 *
 * Três tempos sob a transação do CHAMADOR (o módulo envolve com
 * `withDeadlockRetry`):
 *   1. TRAVAR   pedido + nota FOR UPDATE; exige último evento E
 *   2. PLANEJAR `CancelPlan` (só leitura, com os locks): o que BLOQUEIA
 *      (D2 título baixado · D9 boleto liquidado · D8 cheque que avançou ·
 *      D10 devolução vigente) × o que vai ser desfeito; qualquer bloqueio →
 *      409 INVOICE_CANCEL_BLOCKED com `fields[]` tipado (um código só —
 *      Q-P4; a tela mostra "resolva isto antes")
 *   3. EXECUTAR  D16 como invariante ÚNICO (touchesCash → caixa aberto),
 *      depois as peças, soft-delete do financeiro aberto (D6), dos snapshots
 *      fiscais por item e dos ramos, evento C (motivo, origem = E), nota
 *      `deleted='S'` (D3), pedido volta a 'A' (D5).
 *
 * Fora daqui: estorno de título baixado (settlements — D2), cancelar
 * devolução (order-returns), ramo SEFAZ (fase de transmissão), estoque (D11),
 * privilégio/HTTP (módulo billing). O vínculo tb_order_item_tax_rule é do
 * PEDIDO e NÃO se toca (parecer §3).
 */

export type CancelBlockField = 'title' | 'bankSlip' | 'check' | 'return' | 'serviceOrder'

/** D-G9: título de OUTRO pedido que estava no boleto agrupado cancelado — fica independente. */
export interface ReleasedTitle {
  bankSlipId: number
  orderId: number
  parcel: number
}

export interface CancelBlock extends FieldError {
  field: CancelBlockField
  message: string
  /** Referência legível (título "pedido/parcela", nº do cheque, id do boleto/devolução). */
  ref: string
}

export interface CancelPlan {
  orderId: number
  invoice: LockedInvoice
  blocks: CancelBlock[]
  bankSlipsToCancel: number[]
  /** D-G9: títulos vizinhos liberados pelo cancelamento de boleto agrupado. */
  releasedTitles: ReleasedTitle[]
  /** Q-G3: pedido é ordem de serviço → reabre (trava D5) na execução. */
  serviceOrder: { openLock: string } | null
  /** Um por GRUPO de recebimento (settled_code): `reverseCheckEvent` reverte os irmãos junto. */
  checksToReverse: { checkId: number; event: number; number: string }[]
  commissionEntries: CommissionEntryInput[]
  /** D16: alguma linha de caixa vai ser gravada (hoje: todo R de cheque nasce na conta 0). */
  touchesCash: boolean
}

export interface CancelInvoiceInput {
  orderId: number
  reason: string
}

export interface CancelInvoiceResult {
  orderId: number
  invoiceNumber: string | null
  event: number
  checksReversed: number[]
  bankSlipsCancelled: number[]
  releasedTitles: ReleasedTitle[]
  commissionsCompensated: number
}

/** Tabelas de SNAPSHOT fiscal por item (derivadas — soft-delete no cancelamento). */
const ITEM_SNAPSHOT_TABLES = [
  'tb_order_item_icms', 'tb_order_item_icms_fcp', 'tb_order_item_ipi', 'tb_order_item_ii',
  'tb_order_item_pis', 'tb_order_item_cofins', 'tb_order_item_issqn',
] as const

export async function buildCancelPlan(
  conn: PoolConnection, s: string, institutionId: number, orderId: number
): Promise<CancelPlan> {
  // 1. travar o pedido (status derivado: só 'F' tem nota viva)
  const [ord] = await conn.query<any[]>(
    `SELECT status FROM \`${s}\`.tb_order
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N' FOR UPDATE`,
    [orderId, institutionId]
  )
  if (!ord[0]) throw new HttpError(404, `Pedido ${orderId} não encontrado`, undefined, 'ORDER_NOT_FOUND')
  if (String(ord[0].status) !== 'F') {
    throw new HttpError(409, `Pedido ${orderId} não está faturado`, undefined, 'INVOICE_NOT_CANCELLABLE')
  }
  const invoice = await lockInvoice(conn, s, institutionId, orderId)
  if (invoice.lastKind == null) {
    // Q-P1: nota sem história = produzida fora da web (sync) — o cancelamento
    // não chegaria ao Firebird; cancela-se na origem.
    throw new HttpError(409, 'Nota sem evento de emissão na web (sincronizada) — cancele na origem',
      undefined, 'INVOICE_NOT_CANCELLABLE')
  }
  if (invoice.lastKind !== 'E') {
    throw new HttpError(409, `Nota ${invoice.number ?? orderId} já cancelada`, undefined, 'INVOICE_NOT_CANCELLABLE')
  }
  // Q-A2 (Valdo 2026-09-09): cinto do `status` até existirem os eventos T/A —
  // status é ESPELHO, mas 'A'/'F' escrito fora da peça (sync, Q-G6) não é
  // "pendente": recusa em vez de soft-deletar documento marcado autorizado.
  if (String(invoice.status) !== '0') {
    throw new HttpError(409,
      `Nota ${invoice.number ?? orderId} com status '${invoice.status}' — só nota pendente cancela nesta onda`,
      undefined, 'INVOICE_NOT_CANCELLABLE')
  }

  // H1 / Q-G1 (gate socrático 2026-09-09): nota de DEVOLUÇÃO faturada — a
  // composição não conhece o ramo adjust (elos por item, saldo da venda de
  // origem); Onda 1 RECUSA (assunção registrada; ramo adjust na Onda 2).
  const [anchor] = await conn.query<any[]>(
    `SELECT 1 FROM \`${s}\`.tb_order_stock_adjust_return
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N' FOR UPDATE`,
    [orderId, institutionId]
  )
  if (anchor.length > 0) {
    throw new HttpError(409, 'Nota de devolução — o cancelamento nasce na tela de devoluções (fora desta onda)',
      undefined, 'INVOICE_NOT_CANCELLABLE')
  }
  const blocks: CancelBlock[] = []

  // Q-G3 (Valdo 2026-09-09: "a nota da OS deve ser cancelável"): ordem de
  // serviço faturada volta a ABERTA — a trava D5 (1 OS aberta por cliente) é
  // conferida AQUI, sob lock, antes de qualquer gravação. Pedido de venda → null.
  const serviceOrder = await findServiceOrderForReopen(conn, s, institutionId, orderId)
  if (serviceOrder?.blockingOrderId != null) {
    blocks.push({
      field: 'serviceOrder', ref: String(serviceOrder.blockingOrderId),
      message: `Cliente já tem a ordem de serviço ${serviceOrder.blockingOrderId} aberta — feche-a antes de cancelar a nota desta`,
    })
  }

  // C1 (gate socrático): o plano decide gravação, então toma o MESMO lock que
  // os escritores concorrentes — baixa manual (settleBatchTx), baixa de
  // cheque (settleOneTitle) e emissão de boleto (lockTitle) travam
  // tb_financial FOR UPDATE. Ordem vigente: pedido → título → CHEQUE →
  // payment (a mesma da peça do cheque e da tela de Baixas — M-1 da Rodada 2;
  // boletos e devoluções depois). As leituras abaixo também travam
  // (REPEATABLE READ veria o snapshot anterior).
  await conn.query(
    `SELECT parcel FROM \`${s}\`.tb_financial
      WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0 AND deleted = 'N'
      ORDER BY parcel FOR UPDATE`,
    [institutionId, orderId]
  )

  // 2a. cheques recebidos NESTA vida da nota (evento R do pedido ainda não
  // neutralizado por X — C2: os R das vidas anteriores já foram estornados
  // no cancelamento delas e não contam): reversíveis ou bloqueio. Lidos ANTES
  // das baixas — ordem canônica do financeiro cheque → baixa, a MESMA da peça
  // do cheque (lockCheck → eventos → payment) e da tela de Baixas (D-G7); ler
  // payments primeiro invertia o ciclo (M-1 do gate socrático da Rodada 2).
  const [receipts] = await conn.query<any[]>(
    `SELECT e.tb_check_id AS checkId, e.event, e.parcel, e.payment_event AS paymentEvent,
            e.settled_code AS settledCode, c.number
       FROM \`${s}\`.tb_check_event e
       JOIN \`${s}\`.tb_check c ON c.id = e.tb_check_id AND c.tb_institution_id = e.tb_institution_id
      WHERE e.tb_institution_id = ? AND e.tb_order_id = ? AND e.kind = 'R' AND e.deleted = 'N'
        AND NOT EXISTS (SELECT 1 FROM \`${s}\`.tb_check_event x
                         WHERE x.tb_institution_id = e.tb_institution_id AND x.tb_check_id = e.tb_check_id
                           AND x.kind = 'X' AND x.origin_event = e.event AND x.deleted = 'N')
      ORDER BY e.settled_code, e.tb_check_id, e.event FOR UPDATE`,
    [institutionId, orderId]
  )
  // 2b. baixas VIVAS do pedido (FOR UPDATE — C1). O conjunto decide o que o
  // cancelamento estorna: só R em custódia com baixa viva (D-G7a abaixo).
  const [payments] = await conn.query<any[]>(
    `SELECT parcel, event, paid_value AS paidValue
       FROM \`${s}\`.tb_financial_payment
      WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0
        AND status = 'N' AND deleted = 'N'
      ORDER BY parcel, event FOR UPDATE`,
    [institutionId, orderId]
  )
  const alivePaymentKeys = new Set<string>(payments.map(p => `${Number(p.parcel)}|${Number(p.event)}`))
  // D-G7a (Valdo 2026-09-09): "cheque que já transitou não pode interferir no
  // cancelamento — em momento algum". O cancelamento só estorna o R cujo
  // GRUPO (D9: um settled_code por parcela/baixa) está INTEIRO em custódia e
  // cuja baixa está VIVA. Cheque que transitou (depositado/descontado/usado)
  // fica como está e quem decide é a BAIXA (D2): título baixado → bloqueio de
  // título apontando a tela de Baixas (que desfaz a baixa e cancela só os R
  // em custódia — reversePaymentWithChecks). R vigente cuja baixa já morreu
  // (Baixas D-G7 ou dado legado) → nada a estornar: a vida do cheque segue no
  // módulo de cheque.
  type Member = { checkId: number; event: number; number: string; current: boolean }
  const groups = new Map<string, Member[]>()
  for (const r of receipts) {
    const current = await isCheckEventCurrent(conn, s, institutionId, Number(r.checkId), Number(r.event))
    const paymentKey = `${Number(r.parcel)}|${Number(r.paymentEvent)}`
    const members = groups.get(paymentKey) ?? []
    members.push({ checkId: Number(r.checkId), event: Number(r.event), number: String(r.number), current })
    groups.set(paymentKey, members)
  }
  const chequePaymentKeys = new Set<string>()
  const transitedByPayment = new Map<string, string[]>()
  const checksToReverse: CancelPlan['checksToReverse'] = []
  for (const [paymentKey, members] of groups) {
    if (!alivePaymentKeys.has(paymentKey)) continue
    const transited = members.filter(m => !m.current).map(m => m.number)
    if (transited.length > 0) {
      transitedByPayment.set(paymentKey, transited)
      continue
    }
    chequePaymentKeys.add(paymentKey)
    checksToReverse.push({ checkId: members[0].checkId, event: members[0].event, number: members[0].number })
  }

  // 2c. títulos com baixa VIVA que não seja o R de cheque acima (D2/D7 — estornar antes)
  for (const p of payments) {
    const key = `${Number(p.parcel)}|${Number(p.event)}`
    if (chequePaymentKeys.has(key)) continue
    const transited = transitedByPayment.get(key)
    blocks.push({
      field: 'title', ref: `${orderId}/${Number(p.parcel)}`,
      message: transited
        ? `Título ${orderId}/${Number(p.parcel)} está baixado com cheque que já transitou (${transited.join(', ')}) — estorne a baixa na tela de Baixas antes`
        : `Título ${orderId}/${Number(p.parcel)} tem baixa de ${Number(p.paidValue).toFixed(2)} — estorne a baixa antes`,
    })
  }

  // 2c. boletos dos títulos desta nota: aberto → cancelar; liquidado → bloqueio (D9/D-B5)
  const [slips] = await conn.query<any[]>(
    `SELECT DISTINCT bs.id, ${LAST_SLIP_EVENT_KIND_SQL(s, 'bs')} AS lastKind,
            (SELECT COUNT(*) FROM \`${s}\`.tb_bank_slip_title t2
              WHERE t2.tb_institution_id = bs.tb_institution_id AND t2.tb_bank_slip_id = bs.id
                AND t2.deleted = 'N' AND t2.tb_order_id <> ?) AS otherOrders
       FROM \`${s}\`.tb_bank_slip_title t
       JOIN \`${s}\`.tb_bank_slip bs
         ON bs.id = t.tb_bank_slip_id AND bs.tb_institution_id = t.tb_institution_id AND bs.deleted = 'N'
      WHERE t.tb_institution_id = ? AND t.tb_order_id = ? AND t.terminal = 0 AND t.deleted = 'N'
      ORDER BY bs.id FOR UPDATE`,
    [orderId, institutionId, orderId]
  )
  const bankSlipsToCancel: number[] = []
  const groupedSlipIds: number[] = []
  for (const sl of slips) {
    const state = slipStateFromLastEvent(sl.lastKind)
    if (state === 'settled') {
      blocks.push({
        field: 'bankSlip', ref: String(sl.id),
        message: `Boleto ${sl.id} está liquidado — estorne a liquidação antes`,
      })
    } else if (state === 'open') {
      bankSlipsToCancel.push(Number(sl.id))
      if (Number(sl.otherOrders ?? 0) > 0) groupedSlipIds.push(Number(sl.id))
    }
  }
  // D-G9 (Valdo 2026-09-09): boleto AGRUPADO com título de OUTRO pedido é
  // CANCELADO (C) e os títulos vizinhos ficam INDEPENDENTES — sem boleto
  // vigente sobre eles, livres para nova cobrança ou baixa por outro meio
  // (D-B1 só olha boleto vigente). O vínculo tb_bank_slip_title é história do
  // boleto (imutável) e fica; a resposta LISTA os títulos liberados — nada
  // acontece em silêncio (achado MEDIUM do gate adversarial).
  const releasedTitles: ReleasedTitle[] = []
  if (groupedSlipIds.length > 0) {
    const [rel] = await conn.query<any[]>(
      `SELECT tb_bank_slip_id AS bankSlipId, tb_order_id AS orderId, parcel
         FROM \`${s}\`.tb_bank_slip_title
        WHERE tb_institution_id = ? AND tb_bank_slip_id IN (?) AND tb_order_id <> ? AND deleted = 'N'
        ORDER BY tb_bank_slip_id, tb_order_id, parcel FOR UPDATE`,
      [institutionId, groupedSlipIds, orderId]
    )
    for (const r of rel) {
      releasedTitles.push({ bankSlipId: Number(r.bankSlipId), orderId: Number(r.orderId), parcel: Number(r.parcel) })
    }
  }

  // 2d. devoluções vigentes apontando para esta nota (Q-P7: qualquer status da ordem viva)
  const [returns] = await conn.query<any[]>(
    `SELECT r.id FROM \`${s}\`.tb_order_stock_adjust_return r
       JOIN \`${s}\`.tb_order o
         ON o.id = r.id AND o.tb_institution_id = r.tb_institution_id
        AND o.terminal = r.terminal AND o.deleted = 'N'
      WHERE r.tb_institution_id = ? AND r.tb_order_id_ori = ? AND r.deleted = 'N'
      ORDER BY r.id FOR UPDATE`,
    [institutionId, orderId]
  )
  for (const rt of returns) {
    blocks.push({
      field: 'return', ref: String(rt.id),
      message: `Devolução ${rt.id} aponta para esta nota — cancele a devolução antes`,
    })
  }

  // 2e. comissão: compensação pelo SALDO vivo por item (Q-P8)
  const balances = await getCommissionBalanceByItem(conn, s, institutionId, orderId)
  const commissionEntries: CommissionEntryInput[] = balances.map(b => ({
    kind: 'F', orderId, orderItemId: b.orderItemId, orderItemKind: b.orderItemKind,
    customerId: b.customerId, salesmanId: b.salesmanId,
    baseValue: 0, aliq: b.aliq, value: -b.balance,
  }))

  return {
    orderId, invoice, blocks, bankSlipsToCancel, releasedTitles,
    serviceOrder: serviceOrder ? { openLock: serviceOrder.openLock } : null,
    checksToReverse, commissionEntries,
    touchesCash: checksToReverse.length > 0,
  }
}

export async function cancelInvoice(
  conn: PoolConnection, schemaName: string, institutionId: number, userId: number,
  input: CancelInvoiceInput
): Promise<CancelInvoiceResult> {
  const s = assertSchema(schemaName)
  const reason = String(input.reason ?? '').trim()
  if (!reason) {
    throw new HttpError(400, 'Motivo do cancelamento é obrigatório',
      [{ field: 'reason', message: 'Obrigatório' }], 'INVOICE_REASON_REQUIRED')
  }
  const plan = await buildCancelPlan(conn, s, institutionId, input.orderId)
  if (plan.blocks.length > 0) {
    throw new HttpError(409, 'Cancelamento bloqueado — resolva as pendências listadas antes',
      plan.blocks, 'INVOICE_CANCEL_BLOCKED')
  }
  // D16 — invariante ÚNICO: qualquer linha de caixa exige caixa aberto do operador.
  // (reverseOnePayment/reverseCheckEvent NÃO exigem: herdam a sessão do original — D-G3.)
  if (plan.touchesCash) {
    const cashierId = await findOpenCashierIdTx(conn, schemaName, institutionId, userId)
    if (cashierId == null) {
      throw new HttpError(409, 'Nenhum caixa aberto — abra o caixa para estornar o(s) cheque(s) desta nota',
        undefined, 'NO_OPEN_CASHIER')
    }
  }
  const note = `Cancelamento da nota ${plan.invoice.number ?? input.orderId}: ${reason}`.slice(0, 255)

  // 3. executar — peças existentes, nada reimplementado
  const bankSlipsCancelled: number[] = []
  for (const slipId of plan.bankSlipsToCancel) {
    await cancelBankSlip(conn, schemaName, institutionId, userId, slipId, note)
    bankSlipsCancelled.push(slipId)
  }
  const checksReversed: number[] = []
  for (const c of plan.checksToReverse) {
    const r = await reverseCheckEvent(conn, schemaName, institutionId, userId, {
      checkId: c.checkId, event: c.event, reason: note.slice(0, 100),
    })
    checksReversed.push(...r.affectedCheckIds)
  }
  if (plan.commissionEntries.length > 0) {
    await insertCommissions(conn, schemaName, institutionId, plan.commissionEntries)
  }
  // D6: financeiro ABERTO some (soft-delete); os payments/statements já estão todos 'E' (D2 + X)
  await conn.query(
    `UPDATE \`${s}\`.tb_financial SET deleted = 'S', updated_at = NOW()
      WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0 AND deleted = 'N'`,
    [institutionId, input.orderId]
  )
  await conn.query(
    `UPDATE \`${s}\`.tb_financial_bills SET deleted = 'S', updated_at = NOW()
      WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0 AND deleted = 'N'`,
    [institutionId, input.orderId]
  )
  // snapshots fiscais por item (derivados) — o vínculo tb_order_item_tax_rule é do PEDIDO e fica
  for (const table of ITEM_SNAPSHOT_TABLES) {
    await conn.query(
      `UPDATE \`${s}\`.${table} SET deleted = 'S', updated_at = NOW()
        WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
      [input.orderId, institutionId]
    )
  }
  for (const table of ['tb_invoice_merchandise', 'tb_invoice_service'] as const) {
    await conn.query(
      `UPDATE \`${s}\`.${table} SET deleted = 'S', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
      [input.orderId, institutionId]
    )
  }
  const event = await insertInvoiceEvent(conn, s, institutionId, input.orderId, userId, {
    kind: 'C', dtRecord: localTodayIso(), note: reason, originEvent: plan.invoice.lastEvent,
    snapshot: {
      number: plan.invoice.number, serie: plan.invoice.serie,
      model: plan.invoice.model, value: plan.invoice.value,
    },
  })
  // D3: nota pendente cancelada some da numeração (D4) e das listas; a trilha fica no evento
  await conn.query(
    `UPDATE \`${s}\`.tb_invoice SET deleted = 'S', updated_at = NOW()
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
    [input.orderId, institutionId]
  )
  // D5: pedido volta a aberto (número e negociação intactos; refaturável)
  await conn.query(
    `UPDATE \`${s}\`.tb_order SET status = 'A', updated_at = NOW()
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0`,
    [input.orderId, institutionId]
  )
  // Q-G3: ordem de serviço volta a ABERTA (trava D5 restaurada — editável de novo)
  if (plan.serviceOrder) {
    await reopenServiceOrder(conn, schemaName, institutionId, input.orderId, plan.serviceOrder.openLock)
  }
  return {
    orderId: input.orderId, invoiceNumber: plan.invoice.number, event,
    checksReversed, bankSlipsCancelled, releasedTitles: plan.releasedTitles,
    commissionsCompensated: plan.commissionEntries.length,
  }
}
