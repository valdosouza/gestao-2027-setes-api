/**
 * Tipos do módulo financial-contracts — Contratos Financeiros (política de
 * baixa automática por forma de pagamento; migration 038 —
 * Infra-IA/prompts/prompt_contrato_financeiro_baixa_automatica.md, D1–D22,
 * Valdo 2026-09-03). tb_financial_contract no SCHEMA DO CLIENTE é
 * ESPECIALIZAÇÃO do vínculo institution × forma (PK compartilhada = 1
 * contrato por forma — D2); por isso o "id" do recurso na URL é o
 * tb_payment_types_id. A PRESENÇA do contrato é o gatilho da baixa
 * automática no faturamento (D1/D9): conta 0 = caixa (exige caixa aberto),
 * > 0 = conta corrente; fee_rate = taxa da operadora; payment_term = dias
 * até o dinheiro cair. Espelho no app: apps/web/lib/app/modules/
 * financial_contracts/.
 */

export interface FinancialContractListRow {
  /** = tb_payment_types_id (PK compartilhada com o vínculo). */
  id:                     number
  paymentTypeId:          number
  paymentTypeDescription: string | null
  paymentTypeKind:        string | null
  bankAccountId:          number          // 0 = caixa
  bankAccountLabel:       string | null   // "Banco — ag/conta"; null quando caixa
  feeRate:                number
  paymentTerm:            number
  expirationDate:         string | null
}

export interface FinancialContractFull extends FinancialContractListRow {
  note: string | null
}

export interface FinancialContractInput {
  bankAccountId:   number
  feeRate:         number
  paymentTerm:     number
  expirationDate?: string | null
  note?:           string | null
}

export interface FinancialContractCreateInput extends FinancialContractInput {
  paymentTypeId: number
}

/** Lookup das formas VINCULADAS e habilitadas da institution (form). */
export interface PaymentTypeLookupRow {
  id:          number
  description: string
  kind:        string | null
  hasContract: 'S' | 'N'
}

/** Lookup das contas correntes da institution (form). */
export interface BankAccountLookupRow {
  id:    number
  label: string
}
