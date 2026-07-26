import { HttpError } from '@shared/errors/http-error'
import { CityRow, CityInput, CityCreateInput } from './cities.interface'
import {
  listCities, getCity, cityIdExists,
  insertCity, updateCity, deleteCity,
} from './cities.repository'

export async function fetchCities(filter: string, stateId?: number): Promise<CityRow[]> {
  return listCities(filter, stateId)
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
