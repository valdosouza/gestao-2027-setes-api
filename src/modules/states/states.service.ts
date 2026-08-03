import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import { StateRow, StateInput } from './states.interface'
import {
  listStates, getState, stateIdExists,
  insertState, updateState, deleteState,
} from './states.repository'

export async function fetchStates(
  query: ListQuery, countryId?: number
): Promise<PagedRows<StateRow>> {
  return listStates(query, countryId)
}

export async function fetchState(id: number): Promise<StateRow> {
  const row = await getState(id)
  if (!row) throw new HttpError(404, `Estado ${id} não encontrado`)
  return row
}

/**
 * Cria estado com código informado (código IBGE da UF — ex.: Paraná 41).
 * Se o código já existir (mesmo com deleted='S'), rejeita com 409: o código
 * de estado nunca é reaproveitado (decisão do Valdo, 2026-07-11).
 */
export async function createState(id: number, input: StateInput): Promise<{ id: number }> {
  if (await stateIdExists(id)) {
    throw new HttpError(409, `Já existe um estado com o código ${id} (mesmo que excluído)`)
  }
  try {
    await insertState(id, input)
  } catch (err: any) {
    // Corrida entre a verificação e o INSERT: o PK duplicado vira 409 também.
    if (err?.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, `Já existe um estado com o código ${id}`)
    }
    throw err
  }
  return { id }
}

export async function editState(id: number, input: StateInput): Promise<void> {
  await fetchState(id)
  await updateState(id, input)
}

export async function removeState(id: number): Promise<void> {
  await fetchState(id)
  await deleteState(id)
}
