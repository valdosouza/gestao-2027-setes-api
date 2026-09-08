/**
 * Tipos do módulo bank-slips — Boletos (tela de PROCESSO: emitir, baixar
 * manualmente, cancelar, estornar; migration 039 —
 * Infra-IA/prompts/prompt_boleto_emitido.md D1–D11). O motor vive em
 * @shared/bank-slip; aqui só leituras + wrappers transacionais. Estado do
 * boleto é DERIVADO do último evento (open | settled | cancelled).
 * Espelho no app: apps/web/lib/app/modules/bank_slips/.
 */

import type { BankSlipState } from '@shared/bank-slip'

export interface BankSlipListRow {
  id:              number
  ourNumber:       string
  documentNumber:  string
  dtEmission:      string
  dtExpiration:    string
  value:           number
  state:           BankSlipState
  bankAccountLabel: string | null
  customerName:    string | null
  titles:          number
}

export interface BankSlipTitleRow {
  orderId:       number
  parcel:        number
  number:        string | null
  value:         number
  entityName:    string | null
  dtExpiration:  string | null
}

export interface BankSlipEventRow {
  event:         number
  kind:          string
  dtRecord:      string
  source:        string
  settledCode:   number | null
  paidValue:     number | null
  bankCode:      string | null
  bankMessage:   string | null
  originEvent:   number | null
  note:          string | null
  userId:        number | null
}

export interface BankSlipFull extends BankSlipListRow {
  agreementId:      number
  bankAccountId:    number
  accept:           string | null
  aliqDiscount:     number | null
  discountValue:    number | null
  dtDiscountUntil:  string | null
  aliqInterest:     number | null
  aliqLate:         number | null
  valueLateMin:     number | null
  aliqFine:         number | null
  valueFine:        number | null
  valueRate:        number | null
  instruction:      string | null
  protestDays:      number | null
  titleRows:        BankSlipTitleRow[]
  events:           BankSlipEventRow[]
}

/** Lookup das carteiras ATIVAS (D8). */
export interface AgreementLookupRow {
  id:               number
  agreement:        string | null
  bankAccountLabel: string | null
  hasRange:         'S' | 'N'
}

/** Lookup dos títulos a receber ABERTOS sem boleto vigente. */
export interface OpenTitleRow {
  orderId:                number
  parcel:                 number
  number:                 string | null
  customerId:             number | null
  entityName:             string | null
  dtExpiration:           string | null
  balance:                number
  paymentTypeDescription: string | null
}
