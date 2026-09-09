/**
 * Tipos do módulo settlements — Baixa de Títulos, Estorno e Movimento
 * (Módulo Software House, seções 5.1–5.5 do prompt FECHADO e Fase 6 do
 * doc 05-ORDEM-SERVICO).
 *
 * Princípios: financeiro NÃO se apaga (5.5) — baixa e movimento são
 * imutáveis; estorno = lançamento INVERSO (status R + origin) + marcação
 * E no original. settled_code liga baixas ao movimento em N:1 (várias
 * baixas num único PIX = UM statement). Título aberto é ESTADO DERIVADO
 * (saldo = tag_value − Σ paid de payments status 'N').
 * A entidade do título deriva da CADEIA DA ORDEM (DP10): OS → cliente;
 * ordem financeira → tb_order_financial.tb_entity_id.
 * Espelho no app: apps/web/lib/app/modules/settlements/.
 */

/** Título da CARTEIRA (tb_financial × bills × cadeia da ordem). */
export interface BillRow {
  orderId:      number
  parcel:       number
  number:       string | null
  kind:         string | null
  situation:    string | null
  operation:    'C' | 'D' | null
  stage:        'N' | 'B' | 'C' | null
  dtExpiration: string | null
  tagValue:     number
  paidValue:    number
  balance:      number
  entityName:   string | null
  paymentTypeId: number | null
  paymentTypeDescription: string | null
}

// Tipos do lote vivem na peça compartilhada (boleto também liquida em lote)
export type { SettleTitleInput, SettleBatchInput, SettleBatchResult } from '@shared/financial-settlement/settlement-batch'

/** Baixa registrada (evento da parcela) para a aba Baixados. */
export interface SettledRow {
  orderId:       number
  parcel:        number
  event:         number
  number:        string | null
  kind:          string | null
  entityName:    string | null
  paidValue:     number
  dtPayment:     string | null
  dtRealPayment: string | null
  settledCode:   number | null
  status:        'N' | 'E' | 'R'
  originEvent:   number | null
  reversalReason: string | null
}

export interface ReversalInput {
  orderId: number
  parcel:  number
  event:   number
  reason:  string
}

export interface ReversalResult {
  reversalEvent: number
  settledCode:   number
  /** D-G7: cheques cujo R/P foi cancelado (X) junto com a baixa — [] quando a baixa não era com cheque. */
  checksReversed: number[]
  /** D-G7a: cheques da baixa que já transitaram e ficaram como estão (não interferem). */
  checksKept: number[]
  /** Cadeia PA (4.3.2/3): baixas de PA estornadas recursivamente. */
  paReversed:    number
  /** Títulos de compensação PA+C gerados (DP11). */
  paCompensated: number
}

/** Linha do MOVIMENTO (extrato banco/caixa). */
export interface StatementRow {
  id:            number
  dtRecord:      string | null
  bankAccountId: number
  creditValue:   number
  debitValue:    number
  manualHistory: string | null
  settledCode:   number | null
  status:        'N' | 'E' | 'R'
  future:        string | null
  conferred:     string | null
}

export interface StatementReport {
  rows:        StatementRow[]
  totalCredit: number
  totalDebit:  number
  balance:     number
}
