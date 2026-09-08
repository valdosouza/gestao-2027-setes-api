import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import type { CheckState } from '@shared/check'
import {
  CheckListRow, CheckFull, BankLookupRow, BankAccountLookupRow,
  ProviderLookupRow, OpenPayableRow,
} from './checks.interface'
import {
  listChecks, getCheck, listBanksLookup, listBankAccountsLookup,
  listProvidersLookup, listOpenPayables,
  deposit, discount, returnRefund, returnGood, payWith, returnToOrigin, reverse,
} from './checks.repository'
import {
  DepositCheckDto, DiscountCheckDto, ReturnCheckRefundDto, ReturnCheckGoodDto,
  UseCheckInPaymentDto, ReturnCheckDto, ReverseCheckDto,
} from './checks.dto'

/** Regras do módulo checks: escopo SEMPRE da institution/usuário do JWT. */
export interface CheckScope {
  schemaName:    string
  institutionId: number
  userId:        number
}

const STATES: CheckState[] = ['custody', 'bank', 'factoring', 'supplier', 'refunded', 'collection']

export function parseState(raw: unknown): CheckState | '' {
  const v = String(raw ?? '')
  if (v === '') return ''
  if ((STATES as string[]).includes(v)) return v as CheckState
  throw new HttpError(400, 'status inválido', [{ field: 'status', message: 'Valor inválido' }], 'INVALID_STATUS')
}

export async function fetchChecks(
  status: CheckState | '', query: ListQuery, scope: CheckScope
): Promise<PagedRows<CheckListRow>> {
  return listChecks(status, query, scope.schemaName, scope.institutionId)
}

export async function fetchCheck(id: number, scope: CheckScope): Promise<CheckFull> {
  const row = await getCheck(id, scope.schemaName, scope.institutionId)
  if (!row) throw new HttpError(404, `Cheque ${id} não encontrado`, undefined, 'CHECK_NOT_FOUND')
  return row
}

export function fetchBanksLookup(filter: string): Promise<BankLookupRow[]> {
  return listBanksLookup(filter)
}
export function fetchBankAccountsLookup(filter: string, scope: CheckScope): Promise<BankAccountLookupRow[]> {
  return listBankAccountsLookup(filter, scope.schemaName, scope.institutionId)
}
export function fetchProvidersLookup(filter: string, scope: CheckScope): Promise<ProviderLookupRow[]> {
  return listProvidersLookup(filter, scope.schemaName, scope.institutionId)
}
export function fetchOpenPayables(filter: string, scope: CheckScope): Promise<OpenPayableRow[]> {
  return listOpenPayables(filter, scope.schemaName, scope.institutionId)
}

export function depositCheckAction(id: number, input: DepositCheckDto, scope: CheckScope) {
  return deposit({ checkId: id, ...input }, scope.schemaName, scope.institutionId, scope.userId)
}
export function discountCheckAction(id: number, input: DiscountCheckDto, scope: CheckScope) {
  return discount({ checkId: id, ...input }, scope.schemaName, scope.institutionId, scope.userId)
}
export function returnCheckRefundAction(id: number, input: ReturnCheckRefundDto, scope: CheckScope) {
  return returnRefund({ checkId: id, ...input }, scope.schemaName, scope.institutionId, scope.userId)
}
export async function returnCheckGoodAction(
  id: number, input: ReturnCheckGoodDto, scope: CheckScope
): Promise<{ event: number }> {
  const event = await returnGood(id, input.note ?? null, scope.schemaName, scope.institutionId, scope.userId)
  return { event }
}
export function useCheckInPaymentAction(id: number, input: UseCheckInPaymentDto, scope: CheckScope) {
  return payWith({ checkId: id, ...input }, scope.schemaName, scope.institutionId, scope.userId)
}
export function returnCheckAction(id: number, input: ReturnCheckDto, scope: CheckScope) {
  return returnToOrigin({ checkId: id, ...input }, scope.schemaName, scope.institutionId, scope.userId)
}
export function reverseCheckAction(id: number, input: ReverseCheckDto, scope: CheckScope) {
  return reverse({ checkId: id, ...input }, scope.schemaName, scope.institutionId, scope.userId)
}
