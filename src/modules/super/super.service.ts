import { HttpError } from '@shared/errors/http-error'
import {
  CountryRow, StateRow, CityRow, StateInput, CityInput, CityCreateInput,
  InterfaceRow, InterfaceInput, PrivilegeRow,
  listCountries, getCountry, countryIdExists, insertCountry, updateCountry, deleteCountry,
  listStates,   getState,   stateIdExists, insertState,   updateState,   deleteState,
  listCities,   getCity,    cityIdExists,  insertCity,    updateCity,    deleteCity,
  listInterfaces, getInterface, insertInterface, updateInterface, deleteInterface,
  syncInterfacePrivileges,
  listPrivileges, getPrivilege, insertPrivilege, updatePrivilege, deletePrivilege,
} from './super.repository'

// =====================================================================
// Country
// =====================================================================

export async function fetchCountries(filter: string): Promise<CountryRow[]> {
  return listCountries(filter)
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

// =====================================================================
// State
// =====================================================================

export async function fetchStates(filter: string, countryId?: number): Promise<StateRow[]> {
  return listStates(filter, countryId)
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

// =====================================================================
// City
// =====================================================================

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

// =====================================================================
// Interface
// =====================================================================

export async function fetchInterfaces(filter: string): Promise<InterfaceRow[]> {
  return listInterfaces(filter)
}

export async function fetchInterface(id: number): Promise<InterfaceRow> {
  const row = await getInterface(id)
  if (!row) throw new HttpError(404, `Interface ${id} não encontrada`)
  return row
}

/**
 * Cria interface com id gerado automaticamente (MAX+1 — sem padrão externo
 * tipo BACEN/IBGE, decisão do Valdo 2026-07-11) e grava os vínculos de
 * privilégio em tb_interface_has_privilege.
 */
export async function createInterface(
  input: InterfaceInput,
  privilegeIds: number[]
): Promise<{ id: number }> {
  const id = await insertInterface(input)
  if (privilegeIds.length > 0) {
    await syncInterfacePrivileges(id, privilegeIds)
  }
  return { id }
}

/** Atualiza os campos (id nunca muda) e sincroniza os vínculos de privilégio. */
export async function editInterface(
  id: number,
  input: InterfaceInput,
  privilegeIds: number[]
): Promise<void> {
  await fetchInterface(id) // garante existência
  await updateInterface(id, input)
  await syncInterfacePrivileges(id, privilegeIds)
}

export async function removeInterface(id: number): Promise<void> {
  await fetchInterface(id)
  await deleteInterface(id)
}

// =====================================================================
// Privilege
// =====================================================================

export async function fetchPrivileges(filter: string): Promise<PrivilegeRow[]> {
  return listPrivileges(filter)
}

export async function fetchPrivilege(id: number): Promise<PrivilegeRow> {
  const row = await getPrivilege(id)
  if (!row) throw new HttpError(404, `Privilégio ${id} não encontrado`)
  return row
}

/**
 * Cria privilégio com id gerado automaticamente (MAX+1 — sem padrão externo
 * tipo BACEN/IBGE, mesma decisão do cadastro de Interfaces — Valdo, 2026-07-11).
 */
export async function createPrivilege(description: string): Promise<{ id: number }> {
  const id = await insertPrivilege(description)
  return { id }
}

/** Atualiza a description (o id nunca muda). */
export async function editPrivilege(id: number, description: string): Promise<void> {
  await fetchPrivilege(id) // garante existência
  await updatePrivilege(id, description)
}

export async function removePrivilege(id: number): Promise<void> {
  await fetchPrivilege(id)
  await deletePrivilege(id)
}
