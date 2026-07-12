import {
  getInstitutionSchemaName, listInterfacesWithGrant, setInstitutionInterfaces,
  upsertFeatureFlag, InterfaceGrantRow,
} from './admin.repository'
import { HttpError } from '@shared/errors/http-error'

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
  return listInterfacesWithGrant(schemaName)
}

export async function updateInstitutionInterfaces(
  institutionId: number, interfaceIds: number[]
): Promise<void> {
  const schemaName = await resolveTargetSchema(institutionId)
  await setInstitutionInterfaces(schemaName, institutionId, interfaceIds)
}

// Gate técnico (decisão 17): a tela de cliente do Super chama este endpoint
// para manter tb_feature_flag coerente com o contrato de interfaces.
export async function updateFeatureFlag(
  institutionId: number, moduleKey: string, enabled: boolean
): Promise<void> {
  await resolveTargetSchema(institutionId) // valida existência
  await upsertFeatureFlag(institutionId, moduleKey, enabled)
}
