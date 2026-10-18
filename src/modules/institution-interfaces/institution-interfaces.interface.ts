/**
 * Tela "Interfaces dos clientes" (D-PV11, Valdo 2026-10-18 — prompt_privilegios_interfaces.md): o vínculo estabelecimento ×
 * interfaces (`tb_institution_has_interface` — quais telas cada cliente tem), delegável pelo Super a usuário da Setes.
 * Os tipos de linha são os da peça `@shared/institution-interfaces`.
 */
export type { ClientInstitutionRow, InterfaceGrantRow } from '@shared/institution-interfaces'

export interface InstitutionInterfacesScope {
  /** Super (escapa de tudo) × usuário da Setes liberado (não mexe no vínculo da própria Setes — D-PV11 (c)). */
  isSuper: boolean
  userId:  number
}
