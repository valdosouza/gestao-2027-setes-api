import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import {
  BankAccountListRow, BankAccountFull, BankAccountInput, BankLookupRow,
} from './bank-accounts.interface'
import {
  listBankAccounts, getBankAccount, insertBankAccount, updateBankAccount,
  softDeleteBankAccount, listBanksLookup,
} from './bank-accounts.repository'

/**
 * Regras do módulo bank-accounts: escopo SEMPRE da institution do JWT;
 * banco validado no catálogo central dentro da transação (400); 404 sem
 * vazar existência de outros escopos.
 */

export interface BankAccountScope {
  schemaName:    string
  institutionId: number
}

export async function fetchBankAccounts(
  query: ListQuery, scope: BankAccountScope
): Promise<PagedRows<BankAccountListRow>> {
  return listBankAccounts(query, scope.schemaName, scope.institutionId)
}

export async function fetchBankAccount(
  id: number, scope: BankAccountScope
): Promise<BankAccountFull> {
  const account = await getBankAccount(id, scope.schemaName, scope.institutionId)
  if (!account) throw new HttpError(404, `Conta bancária ${id} não encontrada`)
  return account
}

export async function createBankAccount(
  input: BankAccountInput, scope: BankAccountScope
): Promise<number> {
  return insertBankAccount(input, scope.schemaName, scope.institutionId)
}

export async function editBankAccount(
  id: number, input: BankAccountInput, scope: BankAccountScope
): Promise<void> {
  const found = await updateBankAccount(id, input, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Conta bancária ${id} não encontrada`)
}

export async function removeBankAccount(
  id: number, scope: BankAccountScope
): Promise<void> {
  const found = await softDeleteBankAccount(id, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Conta bancária ${id} não encontrada`)
}

export async function fetchBanksLookup(filter: string): Promise<BankLookupRow[]> {
  return listBanksLookup(filter)
}
