import { HttpError } from '@shared/errors/http-error'
import { PrivilegeRow } from './privileges.interface'
import {
  listPrivileges, getPrivilege, insertPrivilege, updatePrivilege, deletePrivilege,
} from './privileges.repository'

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
