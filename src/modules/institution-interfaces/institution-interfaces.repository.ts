import { ListQuery, PagedRows } from '@shared/list'
import {
  ClientInstitutionRow, InterfaceGrantRow, InterfaceGrantChange, getInstitutionSchemaName, listClientInstitutions,
  listInterfacesWithGrant, setInstitutionInterfaces,
} from '@shared/institution-interfaces'

/** Leitura e escrita do vínculo pela peça ÚNICA (a mesma da aba do Super — `/api/admin`). */
export const findSchemaName = (institutionId: number): Promise<string | null> => getInstitutionSchemaName(institutionId)
export const listClients = (query: ListQuery, excludeId: number | null): Promise<PagedRows<ClientInstitutionRow>> =>
  listClientInstitutions(query, excludeId)
export const listGrants = (schemaName: string, institutionId: number): Promise<InterfaceGrantRow[]> =>
  listInterfacesWithGrant(schemaName, institutionId)
export const saveGrants = (schemaName: string, institutionId: number, interfaceIds: number[]): Promise<InterfaceGrantChange> =>
  setInstitutionInterfaces(schemaName, institutionId, interfaceIds)
