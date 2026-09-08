/**
 * Tipos do módulo bank-charge-agreements — Carteiras de Cobrança
 * (tb_bank_charge_agreement, ex-tb_bank_charge_slip renomeada na migration
 * 039 — prompt_boleto_emitido.md D1/D8). É a contratação de cobrança com o
 * banco: define a conta de crédito e as taxas/instruções que o BOLETO
 * congela na emissão (@shared/bank-slip). `active` decide se entra no gate
 * 0/1/n do faturamento automático (D18 do contrato financeiro/D9 do
 * boleto). Espelho no app: apps/web/lib/app/modules/bank_charge_agreements/.
 *
 * `tb_bank_charge_kind_id`/`tb_bank_charge_ticket_id` (espécie do
 * documento/carteira bancária) e os campos de REMESSA CNAB (layout,
 * transmission_code, path_files...) ficam FORA do cadastro: são catálogos
 * vazios sem consumidor hoje (D7 do prompt do boleto — canal fora desta
 * onda); nascem 0/NULL e a frente do canal os expõe quando existir.
 */

export interface ChargeAgreementListRow {
  id:               number
  agreement:        string
  bankAccountId:    number
  bankAccountLabel: string | null
  active:           'S' | 'N'
  ourNumberNext:    number | null
}

export interface ChargeAgreementFull extends ChargeAgreementListRow {
  accept:        'S' | 'N' | null
  aliqDiscount:  number | null
  aliqInterest:  number | null
  aliqLate:      number | null
  valueLateMin:  number | null
  aliqFine:      number | null
  valueFine:     number | null
  valueRate:     number | null
  instruction:   string | null
  protest:       'S' | 'N' | null
  dayProtest:    number | null
}

export interface ChargeAgreementInput {
  agreement:     string
  bankAccountId: number
  active:        'S' | 'N'
  accept:        'S' | 'N'
  aliqDiscount?: number | null
  aliqInterest?: number | null
  aliqLate?:     number | null
  valueLateMin?: number | null
  aliqFine?:     number | null
  valueFine?:    number | null
  valueRate?:    number | null
  instruction?:  string | null
  protest:       'S' | 'N'
  dayProtest?:   number | null
  ourNumberNext?: number | null
}

/** Lookup das contas correntes da institution (form). */
export interface BankAccountLookupRow {
  id:    number
  label: string
}
