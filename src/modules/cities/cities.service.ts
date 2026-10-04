import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import { CityRow, CityInput, CityCreateInput, LookupRow } from './cities.interface'
import {
  listCities, getCity, cityIdExists,
  insertCity, updateCity, deleteCity,
  CITY_SEARCH_CRITERIA, listStatesLookup,
} from './cities.repository'

export { CITY_SEARCH_CRITERIA }

/** Critérios da pesquisa avançada servidos ao app (D-BA2) — sem expressão SQL. */
export async function fetchCitySearchCriteria(): Promise<PublicSearchCriterion[]> {
  return publicCriteria(CITY_SEARCH_CRITERIA)
}

export async function fetchStatesLookup(filter: string): Promise<LookupRow[]> {
  return listStatesLookup(filter)
}

export async function fetchCities(
  query: ListQuery, stateId?: number
): Promise<PagedRows<CityRow>> {
  return listCities(query, stateId)
}

export async function fetchCity(id: number): Promise<CityRow> {
  const row = await getCity(id)
  if (!row) throw new HttpError(404, `Cidade ${id} não encontrada`)
  return row
}

/**
 * Cria cidade com código informado (código IBGE do município — ex.: Curitiba 4004).
 * Se o código já existir (mesmo com deleted='S'), rejeita com 409: o código
 * de cidade nunca é reaproveitado (decisão do Valdo, 2026-07-11).
 */
export async function createCity(input: CityCreateInput): Promise<{ id: number }> {
  if (await cityIdExists(input.id)) {
    throw new HttpError(409, `Já existe uma cidade com o código ${input.id} (mesmo que excluída)`)
  }
  try {
    const id = await insertCity(input)
    return { id }
  } catch (err: any) {
    // Corrida entre a verificação e o INSERT: o PK duplicado vira 409 também.
    if (err?.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, `Já existe uma cidade com o código ${input.id}`)
    }
    throw err
  }
}

export async function editCity(id: number, input: CityInput): Promise<void> {
  await fetchCity(id)
  await updateCity(id, input)
}

export async function removeCity(id: number): Promise<void> {
  await fetchCity(id)
  await deleteCity(id)
}
