import { ListQuery, PagedRows } from '@shared/list'
import {
  ClientInstitutionRow, InterfaceGrantRow, InterfaceLinkChange, InterfaceDescriptor, describeInterface,
  getInstitutionSchemaName, listClientInstitutions, listInterfacesWithGrant, setInstitutionInterfaceLink,
} from '@shared/institution-interfaces'

/** Leitura e escrita do vínculo pela peça ÚNICA (a mesma da aba do Super — `/api/admin`). D-PV34: escrita POR MARCA. */
export const findSchemaName = (institutionId: number): Promise<string | null> => getInstitutionSchemaName(institutionId)
export const listClients = (query: ListQuery, excludeId: number | null): Promise<PagedRows<ClientInstitutionRow>> =>
  listClientInstitutions(query, excludeId)
/** D-PV35: a porta delegada lista só as VENDÁVEIS (o grupo Super não aparece). */
export const listGrants = (schemaName: string, institutionId: number): Promise<InterfaceGrantRow[]> =>
  listInterfacesWithGrant(schemaName, institutionId, { sellableOnly: true })
export const findInterface = (interfaceId: number): Promise<InterfaceDescriptor | null> => describeInterface(interfaceId)
export const saveGrant = (
  schemaName: string, institutionId: number, interfaceId: number, linked: boolean
): Promise<InterfaceLinkChange> => setInstitutionInterfaceLink(schemaName, institutionId, interfaceId, linked)
