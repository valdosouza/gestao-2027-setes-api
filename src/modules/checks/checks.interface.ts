/**
 * Tipos do módulo checks — Cheques (tela de PROCESSO: depositar, descontar,
 * retornar com reembolso, retornar bom, usar em pagamento, devolver,
 * estornar; migration 040 —
 * Infra-IA/prompts/prompt_cheque_rastreabilidade.md D1–D10 + D7a–c). O
 * motor vive em @shared/check; aqui só leituras + wrappers transacionais.
 * Estado do cheque é DERIVADO do último evento. Espelho no app:
 * apps/web/lib/app/modules/checks/.
 */

import type { CheckState } from '@shared/check'

export interface CheckListRow {
  id:          number
  bankLabel:   string | null
  agency:      string
  account:     string
  number:      string
  issuer:      string
  value:       number
  dtCheck:     string
  headerKind:  'P' | 'T'
  state:       CheckState
  entityName:  string | null // quem entregou (evento R)
}

export interface CheckEventRow {
  event:        number
  kind:         string
  dtRecord:     string
  entityId:     number | null
  entityName:   string | null
  settledCode:  number | null
  orderId:      number | null
  parcel:       number | null
  bankAccountId: number | null
  originEvent:  number | null
  note:         string | null
  userId:       number | null
}

export interface CheckFull extends CheckListRow {
  events: CheckEventRow[]
}

/** Lookup dos bancos do catálogo central (form do cabeçalho). */
export interface BankLookupRow {
  id:          number
  number:      string
  description: string | null
}

/** Lookup das contas correntes da institution (depósito/desconto/reembolso). */
export interface BankAccountLookupRow {
  id:    number
  label: string
}

/** Lookup de fornecedores da institution (factoring costuma ser um provider). */
export interface ProviderLookupRow {
  id:   number
  name: string
}

/** Lookup dos títulos a PAGAR abertos (uso em pagamento — D2). */
export interface OpenPayableRow {
  orderId:                number
  parcel:                 number
  number:                 string | null
  entityName:             string | null
  dtExpiration:           string | null
  balance:                number
}
