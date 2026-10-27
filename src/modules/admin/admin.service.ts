import {
  getInstitutionSchemaName, listInterfacesWithGrant, setInstitutionInterfaceLink,
  upsertFeatureFlag, InterfaceGrantRow,
} from './admin.repository'
import { HttpError } from '@shared/errors/http-error'
import type { InterfaceLinkChange } from '@shared/institution-interfaces'

// O onboarding de institution foi ABSORVIDO pelo cadastro de Estabelecimento
// (POST /api/institutions — módulo institutions, decisão do Valdo 2026-07-11).
// O antigo POST /api/admin/institutions foi aposentado.

// ---------------------------------------------------------------------
// setes-app Fase 1 — licenciamento de interfaces pelo Super (decisão 23):
// resolve o schema do cliente ALVO via tb_institution.schema_name.
// ---------------------------------------------------------------------

async function resolveTargetSchema(institutionId: number): Promise<string> {
  const schemaName = await getInstitutionSchemaName(institutionId)
  if (!schemaName) throw new HttpError(404, `Institution ${institutionId} não encontrada`)
  return schemaName
}

export async function getInstitutionInterfaces(institutionId: number): Promise<InterfaceGrantRow[]> {
  const schemaName = await resolveTargetSchema(institutionId)
  return listInterfacesWithGrant(schemaName, institutionId)
}

/** D-PV34 (2026-10-20): UMA marca por vez — a aba do Super grava a diferença de cada clique pela peça única. */
export async function setInstitutionInterface(
  institutionId: number, interfaceId: number, linked: boolean
): Promise<InterfaceLinkChange> {
  const schemaName = await resolveTargetSchema(institutionId)
  return setInstitutionInterfaceLink(schemaName, institutionId, interfaceId, linked)
}

// Gate técnico (decisão 17): a tela de cliente do Super chama este endpoint
// para manter tb_feature_flag coerente com o contrato de interfaces.
export async function updateFeatureFlag(
  institutionId: number, moduleKey: string, enabled: boolean
): Promise<void> {
  await resolveTargetSchema(institutionId) // valida existência
  await upsertFeatureFlag(institutionId, moduleKey, enabled)
}
