import { HttpError } from '@shared/errors/http-error'
import { InterfaceRow, InterfaceInput } from './interfaces.interface'
import {
  listInterfaces, getInterface, insertInterface, updateInterface,
  deleteInterface, syncInterfacePrivileges,
} from './interfaces.repository'

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
