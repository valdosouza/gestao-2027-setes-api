import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import {
  FinancialContractListRow, FinancialContractFull, FinancialContractInput,
  FinancialContractCreateInput, PaymentTypeLookupRow, BankAccountLookupRow,
} from './financial-contracts.interface'
import {
  listFinancialContracts, getFinancialContract, insertFinancialContract,
  updateFinancialContract, softDeleteFinancialContract,
  listPaymentTypesLookup, listBankAccountsLookup,
} from './financial-contracts.repository'

/**
 * Regras do módulo financial-contracts: escopo SEMPRE da institution do
 * JWT; 1 contrato por forma (409 no repositório); conta validada na
 * transação (400); 404 sem vazar outros escopos. Cadastro NÃO recusa
 * contrato por kind da forma (D16 — o usuário assume; cheque/boleto têm
 * comportamento fixo no faturamento, D18).
 */

export interface FinancialContractScope {
  schemaName:    string
  institutionId: number
}

export async function fetchFinancialContracts(
  query: ListQuery, scope: FinancialContractScope
): Promise<PagedRows<FinancialContractListRow>> {
  return listFinancialContracts(query, scope.schemaName, scope.institutionId)
}

export async function fetchFinancialContract(
  paymentTypeId: number, scope: FinancialContractScope
): Promise<FinancialContractFull> {
  const row = await getFinancialContract(paymentTypeId, scope.schemaName, scope.institutionId)
  if (!row) throw new HttpError(404, `Contrato financeiro ${paymentTypeId} não encontrado`)
  return row
}

/**
 * D-G1 (Rodada 4, 2026-09-04): contrato no CAIXA (conta 0) "cai na hora" por
 * construção — prazo ou taxa junto com conta 0 é recusado (o fechamento de
 * caixa soma a sessão sem olhar dt_record; dinheiro futuro/taxa no caixa
 * físico não existe).
 */
function assertCashTerms(input: FinancialContractInput): void {
  if (input.bankAccountId !== 0) return
  const fields: { field: string; message: string }[] = []
  if (input.paymentTerm > 0) fields.push({ field: 'paymentTerm', message: 'Caixa não aceita prazo' })
  if (input.feeRate > 0) fields.push({ field: 'feeRate', message: 'Caixa não aceita taxa' })
  if (fields.length > 0) {
    throw new HttpError(422, 'Contrato no caixa não aceita prazo nem taxa (cai na hora)',
      fields, 'FINANCIAL_CONTRACT_CASH_NO_TERMS')
  }
}

export async function createFinancialContract(
  input: FinancialContractCreateInput, scope: FinancialContractScope
): Promise<number> {
  assertCashTerms(input)
  return insertFinancialContract(input, scope.schemaName, scope.institutionId)
}

export async function editFinancialContract(
  paymentTypeId: number, input: FinancialContractInput, scope: FinancialContractScope
): Promise<void> {
  assertCashTerms(input)
  const found = await updateFinancialContract(
    paymentTypeId, input, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Contrato financeiro ${paymentTypeId} não encontrado`)
}

export async function removeFinancialContract(
  paymentTypeId: number, scope: FinancialContractScope
): Promise<void> {
  const found = await softDeleteFinancialContract(
    paymentTypeId, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Contrato financeiro ${paymentTypeId} não encontrado`)
}

export async function fetchPaymentTypesLookup(
  filter: string, scope: FinancialContractScope
): Promise<PaymentTypeLookupRow[]> {
  return listPaymentTypesLookup(filter, scope.schemaName, scope.institutionId)
}

export async function fetchBankAccountsLookup(
  filter: string, scope: FinancialContractScope
): Promise<BankAccountLookupRow[]> {
  return listBankAccountsLookup(filter, scope.schemaName, scope.institutionId)
}
