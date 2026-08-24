/**
 * Tipos do módulo cashier — Abertura/Fechamento de Caixa (W3.2, parecer
 * setes-conceito 2026-08-22). Sessão por DIA+USUÁRIO+TERMINAL (terminal
 * fixo 0 pro caixa web — coexiste com os caixas de PDV 1..N que o
 * Sincronizador já escreve, Q-Caixa 5). Saldo é DERIVADO, nunca
 * armazenado — mesmo princípio do financeiro imutável.
 */

export interface CashierRow {
  id: number
  dtRecord: string
  userId: number
  hrBegin: string | null
  hrEnd: string | null
}

export interface CashierBalance {
  cashier: CashierRow
  balance: number
  registeredByPaymentType: { paymentTypeId: number; paymentTypeDescription: string | null; value: number }[]
}

export interface WithdrawInput {
  value: number
  history: string
  destinationBankAccountId?: number | null
}

export interface WithdrawResult {
  statementId: number
  destinationStatementId: number | null
}

export interface ClosingItemInput {
  paymentTypeId: number
  countedValue: number
}

export interface CloseCashierInput {
  items: ClosingItemInput[]
  transferBankAccountId?: number | null
}

export interface ClosingItemResult {
  paymentTypeId: number
  paymentTypeDescription: string | null
  registeredValue: number
  countedValue: number
  difference: number
}

export interface CloseCashierResult {
  cashierId: number
  hrEnd: string
  items: ClosingItemResult[]
  transfer: WithdrawResult | null
}
