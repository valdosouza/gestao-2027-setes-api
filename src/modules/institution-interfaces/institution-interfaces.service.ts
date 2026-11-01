import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { ListQuery, PagedRows } from '@shared/list'
import {
  SETES_INSTITUTION_ID, isOwnVendorInstitution, isSellableInterface, isStructuralInterface,
} from '@shared/institution-interfaces'
import { ClientInstitutionRow, InterfaceGrantRow, InterfaceLinkChange, InstitutionInterfacesScope } from './institution-interfaces.interface'
import { findInterface, findSchemaName, listClients, listGrants, saveGrant } from './institution-interfaces.repository'

/**
 * Regra da tela "Interfaces dos clientes" (D-PV11). Quem chega aqui já passou pela guarda delegada (super, ou usuário da Setes com o
 * privilégio marcado pelo Super). O vínculo da PRÓPRIA Setes só o Super LÊ e altera (D-PV11 (c) + D-PV38): para o usuário liberado
 * ela nem aparece na lista, a leitura e o salvar recusam — UM predicado (`isOwnVendorInstitution`) nas três portas.
 * D-PV34: grava POR MARCA; D-PV35: só vendáveis, e as estruturais não se revogam por aqui.
 */
export async function fetchClients(query: ListQuery, scope: InstitutionInterfacesScope): Promise<PagedRows<ClientInstitutionRow>> {
  return listClients(query, scope.isSuper ? null : SETES_INSTITUTION_ID)
}

async function targetSchema(institutionId: number): Promise<string> {
  const schemaName = await findSchemaName(institutionId)
  if (!schemaName) throw new HttpError(404, `Estabelecimento ${institutionId} não encontrado`, undefined, ErrorCodes.NOT_FOUND)
  return schemaName
}

/** D-PV11 (c)/D-PV38: a própria Setes só pelo Super — mesmo veredito na leitura e na escrita. */
function assertNotOwnVendor(institutionId: number, scope: InstitutionInterfacesScope): void {
  if (isOwnVendorInstitution(institutionId) && !scope.isSuper) {
    throw new HttpError(403, 'As interfaces da própria Setes só o Super lê e altera', [], ErrorCodes.SETES_INTERFACES_SUPER_ONLY)
  }
}

export async function fetchGrants(institutionId: number, scope: InstitutionInterfacesScope): Promise<InterfaceGrantRow[]> {
  assertNotOwnVendor(institutionId, scope)
  return listGrants(await targetSchema(institutionId), institutionId)
}

export async function saveClientGrant(
  institutionId: number, interfaceId: number, linked: boolean, scope: InstitutionInterfacesScope
): Promise<InterfaceLinkChange> {
  assertNotOwnVendor(institutionId, scope)
  const schemaName = await targetSchema(institutionId)
  // D-PV35: a porta delegada só vincula VENDÁVEIS (kind T/R fora do grupo Super) e NÃO revoga as ESTRUTURAIS — para o Super a
  // aba do Estabelecimento (`/api/admin`) segue com o catálogo inteiro; aqui a regra vale para ele também (é a porta que está usando).
  const iface = await findInterface(interfaceId)
  if (!iface) {
    throw new HttpError(400, 'Interface fora do catálogo',
      [{ field: 'interfaceId', message: `Fora do catálogo: ${interfaceId}` }], ErrorCodes.VALIDATION_FAILED)
  }
  if (!isSellableInterface(iface)) {
    throw new HttpError(400, 'A porta delegada só vincula interfaces vendáveis (fora do grupo Super)',
      [{ field: 'interfaceId', message: `Interface ${iface.key ?? interfaceId} não é vendável` }], ErrorCodes.INTERFACE_NOT_SELLABLE)
  }
  if (!linked && isStructuralInterface(iface.key)) {
    throw new HttpError(409, 'Interface estrutural não se revoga pela porta delegada — só o Super, pelo cadastro do Estabelecimento',
      [{ field: 'interfaceId', message: `Interface ${iface.key} é estrutural` }], ErrorCodes.INTERFACE_STRUCTURAL_LOCKED)
  }
  return saveGrant(schemaName, institutionId, interfaceId, linked)
}
