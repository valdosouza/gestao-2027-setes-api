import {
  insertInstitution, insertDefaultFlags, institutionSchemaExists,
  getInstitutionSchemaName, listInterfacesWithGrant, setInstitutionInterfaces,
  upsertFeatureFlag, InterfaceGrantRow,
} from './admin.repository'
import { runMigrationsForSchema } from '../../migrations/runner'
import { HttpError } from '@shared/errors/http-error'

export interface OnboardInput {
  name:       string
  schemaName: string
}

export interface OnboardResult {
  institutionId: number
  name:          string
  schemaName:    string
}

export async function onboardInstitution(input: OnboardInput): Promise<OnboardResult> {
  const { name, schemaName } = input

  // Valida formato e prefixo obrigatorio setes_ (padrao setes_<schema>)
  if (!/^setes_[a-z0-9_]+$/.test(schemaName)) {
    throw new HttpError(400, 'schemaName deve comecar com "setes_" e conter apenas letras minusculas, numeros e underscores')
  }

  const exists = await institutionSchemaExists(schemaName)
  if (exists) {
    throw new HttpError(409, `Schema "${schemaName}" ja esta em uso`)
  }

  const institutionId = await insertInstitution({ name, schemaName })
  await insertDefaultFlags(institutionId)
  await runMigrationsForSchema(schemaName)

  return { institutionId, name, schemaName }
}

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
