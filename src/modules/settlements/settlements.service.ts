import { ListQuery, PagedRows } from '@shared/list'
import {
  BillRow, SettleBatchInput, SettleBatchResult, SettledRow,
  ReversalInput, ReversalResult, StatementReport,
} from './settlements.interface'
import {
  listBills, settleBatch, listSettled, reverseSettlement, listStatements,
} from './settlements.repository'

/**
 * Regras do módulo settlements: escopo SEMPRE da institution do JWT
 * (usuário assina o movimento); imutabilidade e máquina de estados vivem
 * no repositório (transações + FOR UPDATE + 409).
 */

export interface SettlementScope {
  schemaName:    string
  institutionId: number
  userId:        number
}

export async function fetchBills(
  status: 'open' | 'settled' | '', kind: string, query: ListQuery,
  scope: SettlementScope
): Promise<PagedRows<BillRow>> {
  return listBills(status, kind, query, scope.schemaName, scope.institutionId)
}

export async function settle(
  input: SettleBatchInput, scope: SettlementScope
): Promise<SettleBatchResult> {
  return settleBatch(input, scope.schemaName, scope.institutionId, scope.userId)
}

export async function fetchSettled(
  query: ListQuery, scope: SettlementScope
): Promise<PagedRows<SettledRow>> {
  return listSettled(query, scope.schemaName, scope.institutionId)
}

export async function reverse(
  input: ReversalInput, scope: SettlementScope
): Promise<ReversalResult> {
  return reverseSettlement(input, scope.schemaName, scope.institutionId, scope.userId)
}

export async function fetchStatements(
  bankAccountId: number | null, dtFrom: string | null, dtTo: string | null,
  scope: SettlementScope
): Promise<StatementReport> {
  return listStatements(bankAccountId, dtFrom, dtTo,
    scope.schemaName, scope.institutionId)
}
