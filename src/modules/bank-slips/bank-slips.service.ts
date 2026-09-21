import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import type { BankSlipState, IssueBankSlipResult, SettleBankSlipResult } from '@shared/bank-slip'
import {
  BankSlipListRow, BankSlipFull, AgreementLookupRow, OpenTitleRow,
} from './bank-slips.interface'
import {
  listBankSlips, getBankSlip, listAgreementsLookup, listOpenTitles,
  issue, settle, reverse,
} from './bank-slips.repository'
import {
  IssueBankSlipDto, SettleBankSlipDto, CancelBankSlipDto, ReverseBankSlipDto,
} from './bank-slips.dto'
import { cancelRegisteredBankSlip, listSlipRegistrations } from '@shared/bank-slip-registration'

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

export function parsePendingOnly(raw: unknown): boolean {
  const v = String(raw ?? '').toLowerCase()
  if (v === '' || v === 'false' || v === '0') return false
  if (v === 'true' || v === '1') return true
  throw new HttpError(400, 'pending inválido (true | false)', [{ field: 'pending', message: 'Valor inválido' }], 'INVALID_STATUS')
}

export async function fetchBankSlips(
  status: BankSlipState | '', query: ListQuery, scope: BankSlipScope, pendingOnly = false
): Promise<PagedRows<BankSlipListRow>> {
  return listBankSlips(status, query, scope.schemaName, scope.institutionId, { pendingOnly })
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
    dtExpiration: input.dtExpiration ?? null,
    // D15: a forma explícita tem que CHEGAR à peça. Ela era validada no DTO e
    // descartada aqui (gate adversarial): com 2+ formas kind='B' a peça pedia
    // "informe qual" e informar dava o mesmo 422 — beco sem saída, e nenhum
    // teste pegava porque todos chamavam a peça direto, nunca o service.
    paymentTypeId: input.paymentTypeId,
    source: 'M',
  }, scope.schemaName, scope.institutionId, scope.userId)
}

export async function settleSlip(
  id: number, input: SettleBankSlipDto, scope: BankSlipScope
): Promise<SettleBankSlipResult> {
  return settle({ slipId: id, paidValue: input.paidValue, dtPayment: input.dtPayment, source: 'M' },
    scope.schemaName, scope.institutionId, scope.userId)
}

/**
 * Onda 2 (D-I8): cancelar aqui cancela no BANCO primeiro quando há apresentação
 * vigente — 202 do banco = aceite; banco fora → 409/503 e nada muda. Sem
 * apresentação, é o cancelamento local de sempre (a composição decide).
 */
export async function cancelSlip(
  id: number, input: CancelBankSlipDto, scope: BankSlipScope
): Promise<{ event: number; bankNotified: boolean }> {
  const r = await cancelRegisteredBankSlip(scope.schemaName, scope.institutionId, scope.userId, id, input.note ?? null)
  return { event: r.slipEvent, bankNotified: r.bankNotified }
}

/** Detalhe do boleto + apresentações ao banco e a voz dele (tela de processo). */
export async function fetchBankSlipWithRegistrations(id: number, scope: BankSlipScope) {
  const slip = await fetchBankSlip(id, scope)
  const reg = await listSlipRegistrations(scope.schemaName, scope.institutionId, id)
  return { ...slip, registrations: reg.registrations, registrationEvents: reg.events }
}

export async function reverseSlip(id: number, input: ReverseBankSlipDto, scope: BankSlipScope) {
  return reverse(id, input.reason, scope.schemaName, scope.institutionId, scope.userId)
}
