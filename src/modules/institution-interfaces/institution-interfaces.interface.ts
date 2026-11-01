import type { ClientInstitutionRow, InterfaceGrantRow, InterfaceLinkChange } from '@shared/institution-interfaces'

export type { ClientInstitutionRow, InterfaceGrantRow, InterfaceLinkChange }

/** Quem opera a tela "Interfaces dos clientes" (derivado do JWT no controller). */
export interface InstitutionInterfacesScope {
  isSuper: boolean
  userId:  number
}
