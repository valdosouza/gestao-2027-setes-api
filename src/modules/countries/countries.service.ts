import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import { CountryRow } from './countries.interface'
import {
  listCountries, getCountry, countryIdExists,
  insertCountry, updateCountry, deleteCountry,
  COUNTRY_SEARCH_CRITERIA,
} from './countries.repository'

export { COUNTRY_SEARCH_CRITERIA }

/** Critérios da pesquisa avançada servidos ao app (D-BA2) — sem expressão SQL. */
export async function fetchCountrySearchCriteria(): Promise<PublicSearchCriterion[]> {
  return publicCriteria(COUNTRY_SEARCH_CRITERIA)
}

export async function fetchCountries(query: ListQuery): Promise<PagedRows<CountryRow>> {
  return listCountries(query)
}

export async function fetchCountry(id: number): Promise<CountryRow> {
  const row = await getCountry(id)
  if (!row) throw new HttpError(404, `País ${id} não encontrado`)
  return row
}

/**
 * Cria país com código informado (padrão mundial BACEN — não sequencial).
 * Se o código já existir (mesmo com deleted='S'), rejeita com 409: o código
 * de país nunca é reaproveitado (decisão do Valdo, 2026-07-10).
 */
export async function createCountry(id: number, name: string): Promise<{ id: number }> {
  if (await countryIdExists(id)) {
    throw new HttpError(409, `Já existe um país com o código ${id} (mesmo que excluído)`)
  }
  try {
    await insertCountry(id, name)
  } catch (err: any) {
    // Corrida entre a verificação e o INSERT: o PK duplicado vira 409 também.
    if (err?.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, `Já existe um país com o código ${id}`)
    }
    throw err
  }
  return { id }
}

export async function editCountry(id: number, name: string): Promise<void> {
  await fetchCountry(id) // garante existência
  await updateCountry(id, name)
}

export async function removeCountry(id: number): Promise<void> {
  await fetchCountry(id)
  await deleteCountry(id)
}
