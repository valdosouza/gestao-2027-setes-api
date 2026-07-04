import { insertInstitution, insertDefaultFlags, institutionSchemaExists } from './admin.repository'
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
