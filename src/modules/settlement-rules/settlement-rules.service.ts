import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import {
  SettlementRuleListRow, SettlementRuleFull, SettlementRuleInput,
  SettlementRuleCreateInput, PaymentTypeLookupRow, BankAccountLookupRow,
} from './settlement-rules.interface'
import {
  listSettlementRules, getSettlementRule, insertSettlementRule,
  updateSettlementRule, softDeleteSettlementRule,
  listPaymentTypesLookup, listBankAccountsLookup,
} from './settlement-rules.repository'

/**
 * Regras do módulo settlement-rules: escopo SEMPRE da institution do
 * JWT; 1 contrato por forma (409 no repositório); conta validada na
 * transação (400); 404 sem vazar outros escopos. Cadastro NÃO recusa
 * contrato por kind da forma (D16 — o usuário assume; cheque/boleto têm
 * comportamento fixo no faturamento, D18).
 */

export interface SettlementRuleScope {
  schemaName:    string
  institutionId: number
}

export async function fetchSettlementRules(
  query: ListQuery, scope: SettlementRuleScope
): Promise<PagedRows<SettlementRuleListRow>> {
  return listSettlementRules(query, scope.schemaName, scope.institutionId)
}

export async function fetchSettlementRule(
  paymentTypeId: number, scope: SettlementRuleScope
): Promise<SettlementRuleFull> {
  const row = await getSettlementRule(paymentTypeId, scope.schemaName, scope.institutionId)
  if (!row) throw new HttpError(404, `Regra de recebimento da forma ${paymentTypeId} não encontrada`)
  return row
}

/**
 * D-G1 (Rodada 4, 2026-09-04): contrato no CAIXA (conta 0) "cai na hora" por
 * construção — prazo ou taxa junto com conta 0 é recusado (o fechamento de
 * caixa soma a sessão sem olhar dt_record; dinheiro futuro/taxa no caixa
 * físico não existe).
 */
function assertCashTerms(input: SettlementRuleInput): void {
  if (input.bankAccountId !== 0) return
  const fields: { field: string; message: string }[] = []
  if (input.paymentTerm > 0) fields.push({ field: 'paymentTerm', message: 'Caixa não aceita prazo' })
  if (input.feeRate > 0) fields.push({ field: 'feeRate', message: 'Caixa não aceita taxa' })
  if (fields.length > 0) {
    throw new HttpError(422, 'Contrato no caixa não aceita prazo nem taxa (cai na hora)',
      fields, 'SETTLEMENT_RULE_CASH_NO_TERMS')
  }
}

export async function createSettlementRule(
  input: SettlementRuleCreateInput, scope: SettlementRuleScope
): Promise<number> {
  assertCashTerms(input)
  return insertSettlementRule(input, scope.schemaName, scope.institutionId)
}

export async function editSettlementRule(
  paymentTypeId: number, input: SettlementRuleInput, scope: SettlementRuleScope
): Promise<void> {
  assertCashTerms(input)
  const found = await updateSettlementRule(
    paymentTypeId, input, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Regra de recebimento da forma ${paymentTypeId} não encontrada`)
}

export async function removeSettlementRule(
  paymentTypeId: number, scope: SettlementRuleScope
): Promise<void> {
  const found = await softDeleteSettlementRule(
    paymentTypeId, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Regra de recebimento da forma ${paymentTypeId} não encontrada`)
}

export async function fetchPaymentTypesLookup(
  filter: string, scope: SettlementRuleScope
): Promise<PaymentTypeLookupRow[]> {
  return listPaymentTypesLookup(filter, scope.schemaName, scope.institutionId)
}

export async function fetchBankAccountsLookup(
  filter: string, scope: SettlementRuleScope
): Promise<BankAccountLookupRow[]> {
  return listBankAccountsLookup(filter, scope.schemaName, scope.institutionId)
}
