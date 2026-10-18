import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { ListQuery, PagedRows } from '@shared/list'
import { SETES_INSTITUTION_ID } from '@shared/auth/roles'
import { ClientInstitutionRow, InterfaceGrantRow, InstitutionInterfacesScope } from './institution-interfaces.interface'
import { InterfaceGrantChange } from '@shared/institution-interfaces'
import { findSchemaName, listClients, listGrants, saveGrants } from './institution-interfaces.repository'

/**
 * Regra da tela "Interfaces dos clientes" (D-PV11). Quem chega aqui já passou pela guarda delegada (super, ou usuário da Setes com o
 * privilégio marcado pelo Super). O vínculo da PRÓPRIA Setes só o Super altera (D-PV11 (c)): para o usuário liberado ela nem aparece
 * na lista, e o salvar recusa.
 */
export async function fetchClients(query: ListQuery, scope: InstitutionInterfacesScope): Promise<PagedRows<ClientInstitutionRow>> {
  return listClients(query, scope.isSuper ? null : SETES_INSTITUTION_ID)
}

async function targetSchema(institutionId: number): Promise<string> {
  const schemaName = await findSchemaName(institutionId)
  if (!schemaName) throw new HttpError(404, `Estabelecimento ${institutionId} não encontrado`, undefined, ErrorCodes.NOT_FOUND)
  return schemaName
}

export async function fetchGrants(institutionId: number): Promise<InterfaceGrantRow[]> {
  return listGrants(await targetSchema(institutionId), institutionId)
}

export async function saveClientGrants(
  institutionId: number, interfaceIds: number[], scope: InstitutionInterfacesScope
): Promise<InterfaceGrantChange> {
  if (institutionId === SETES_INSTITUTION_ID && !scope.isSuper) {
    throw new HttpError(403, 'As interfaces da própria Setes só o Super altera', [], ErrorCodes.SETES_INTERFACES_SUPER_ONLY)
  }
  // repetidos e catálogo: regra da peça (a mesma da aba do Super)
  return saveGrants(await targetSchema(institutionId), institutionId, interfaceIds)
}
