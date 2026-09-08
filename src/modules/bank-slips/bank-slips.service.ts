import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import type { BankSlipState, IssueBankSlipResult, SettleBankSlipResult } from '@shared/bank-slip'
import {
  BankSlipListRow, BankSlipFull, AgreementLookupRow, OpenTitleRow,
} from './bank-slips.interface'
import {
  listBankSlips, getBankSlip, listAgreementsLookup, listOpenTitles,
  issue, settle, cancel, reverse,
} from './bank-slips.repository'
import {
  IssueBankSlipDto, SettleBankSlipDto, CancelBankSlipDto, ReverseBankSlipDto,
} from './bank-slips.dto'

/**
 * Regras do módulo bank-slips: escopo SEMPRE da institution/usuário do
 * JWT; máquina de estados (409 de negócio) vive na peça @shared/bank-slip;
 * 404 sem vazar outros escopos.
 */

export interface BankSlipScope {
  schemaName:    string
  institutionId: number
  userId:        number
}

const STATES: BankSlipState[] = ['open', 'settled', 'cancelled']

export function parseState(raw: unknown): BankSlipState | '' {
  const v = String(raw ?? '')
  if (v === '') return ''
  if ((STATES as string[]).includes(v)) return v as BankSlipState
  throw new HttpError(400, 'status inválido (open | settled | cancelled)',
    [{ field: 'status', message: 'Valor inválido' }], 'INVALID_STATUS')
}

export async function fetchBankSlips(
  status: BankSlipState | '', query: ListQuery, scope: BankSlipScope
): Promise<PagedRows<BankSlipListRow>> {
  return listBankSlips(status, query, scope.schemaName, scope.institutionId)
}

export async function fetchBankSlip(id: number, scope: BankSlipScope): Promise<BankSlipFull> {
  const row = await getBankSlip(id, scope.schemaName, scope.institutionId)
  if (!row) throw new HttpError(404, `Boleto ${id} não encontrado`)
  return row
}

export async function fetchAgreementsLookup(scope: BankSlipScope): Promise<AgreementLookupRow[]> {
  return listAgreementsLookup(scope.schemaName, scope.institutionId)
}

export async function fetchOpenTitles(
  filter: string, customerId: number | null, scope: BankSlipScope
): Promise<OpenTitleRow[]> {
  return listOpenTitles(filter, customerId, scope.schemaName, scope.institutionId)
}

export async function issueSlip(input: IssueBankSlipDto, scope: BankSlipScope): Promise<IssueBankSlipResult> {
  return issue({
    agreementId: input.agreementId, titles: input.titles,
    dtExpiration: input.dtExpiration ?? null, source: 'M',
  }, scope.schemaName, scope.institutionId, scope.userId)
}

export async function settleSlip(
  id: number, input: SettleBankSlipDto, scope: BankSlipScope
): Promise<SettleBankSlipResult> {
  return settle({ slipId: id, paidValue: input.paidValue, dtPayment: input.dtPayment, source: 'M' },
    scope.schemaName, scope.institutionId, scope.userId)
}

export async function cancelSlip(
  id: number, input: CancelBankSlipDto, scope: BankSlipScope
): Promise<{ event: number }> {
  const event = await cancel(id, input.note ?? null, scope.schemaName, scope.institutionId, scope.userId)
  return { event }
}

export async function reverseSlip(id: number, input: ReverseBankSlipDto, scope: BankSlipScope) {
  return reverse(id, input.reason, scope.schemaName, scope.institutionId, scope.userId)
}
