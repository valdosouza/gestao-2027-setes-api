import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import {
  CatalogConfigRow, listCatalogConfigs, validateConfigContent,
  invalidateInterfaceConfigCatalog,
} from '@shared/interface-config'
import { InterfaceRow, InterfaceInput, InterfaceConfigInput } from './interfaces.interface'
import {
  listInterfaces, getInterface, insertInterface, updateInterface,
  deleteInterface, syncInterfacePrivileges,
  upsertInterfaceConfig, interfaceConfigExists, softDeleteInterfaceConfig,
} from './interfaces.repository'

export async function fetchInterfaces(query: ListQuery): Promise<PagedRows<InterfaceRow>> {
  return listInterfaces(query)
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

// ---------------------------------------------------------------------
// Catálogo de CONFIGURAÇÕES da interface (Framework de Configurações,
// decisões 6 e 7): cadastrado pelo Super na seção "Configurações" da tela
// de Interfaces; o painel do cliente nasce dele sem tela artesanal.
// ---------------------------------------------------------------------

export async function fetchInterfaceConfigs(id: number): Promise<CatalogConfigRow[]> {
  await fetchInterface(id) // garante existência
  return listCatalogConfigs(id)
}

export async function saveInterfaceConfig(
  id: number, name: string, input: InterfaceConfigInput
): Promise<void> {
  await fetchInterface(id)

  if (input.kind === 'Options' && !input.options) {
    throw new HttpError(400, 'Configuração inválida',
      [{ field: 'options', message: 'kind Options exige a lista de opções' }])
  }
  const error = validateConfigContent(input.kind, input.options ?? null, input.defaultContent)
  if (error !== null) {
    throw new HttpError(400, 'Default incompatível com o kind',
      [{ field: 'defaultContent', message: error }])
  }

  await upsertInterfaceConfig(id, name, input)
  invalidateInterfaceConfigCatalog(id)
}

export async function removeInterfaceConfig(id: number, name: string): Promise<void> {
  await fetchInterface(id)
  if (!(await interfaceConfigExists(id, name))) {
    throw new HttpError(404, 'Configuração não encontrada no catálogo desta interface')
  }
  await softDeleteInterfaceConfig(id, name)
  invalidateInterfaceConfigCatalog(id)
}
