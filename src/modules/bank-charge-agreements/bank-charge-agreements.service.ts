import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import {
  ChargeAgreementListRow, ChargeAgreementFull, ChargeAgreementInput, BankAccountLookupRow,
} from './bank-charge-agreements.interface'
import {
  listChargeAgreements, getChargeAgreement, insertChargeAgreement,
  updateChargeAgreement, softDeleteChargeAgreement, listBankAccountsLookup,
} from './bank-charge-agreements.repository'

/** Regras do módulo: escopo SEMPRE da institution do JWT; conta validada na transação. */
export interface ChargeAgreementScope {
  schemaName:    string
  institutionId: number
}

export async function fetchChargeAgreements(
  query: ListQuery, scope: ChargeAgreementScope
): Promise<PagedRows<ChargeAgreementListRow>> {
  return listChargeAgreements(query, scope.schemaName, scope.institutionId)
}

export async function fetchChargeAgreement(
  id: number, scope: ChargeAgreementScope
): Promise<ChargeAgreementFull> {
  const row = await getChargeAgreement(id, scope.schemaName, scope.institutionId)
  if (!row) throw new HttpError(404, `Carteira de cobrança ${id} não encontrada`)
  return row
}

export async function createChargeAgreement(
  input: ChargeAgreementInput, scope: ChargeAgreementScope
): Promise<number> {
  return insertChargeAgreement(input, scope.schemaName, scope.institutionId)
}

export async function editChargeAgreement(
  id: number, input: ChargeAgreementInput, scope: ChargeAgreementScope
): Promise<void> {
  const found = await updateChargeAgreement(id, input, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Carteira de cobrança ${id} não encontrada`)
}

export async function removeChargeAgreement(
  id: number, scope: ChargeAgreementScope
): Promise<void> {
  const found = await softDeleteChargeAgreement(id, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Carteira de cobrança ${id} não encontrada`)
}

export async function fetchBankAccountsLookup(
  filter: string, scope: ChargeAgreementScope
): Promise<BankAccountLookupRow[]> {
  return listBankAccountsLookup(filter, scope.schemaName, scope.institutionId)
}
