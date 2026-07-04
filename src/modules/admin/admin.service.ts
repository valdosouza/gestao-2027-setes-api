import { randomUUID } from 'crypto'
import { insertTenant, insertDefaultFlags, tenantSchemaExists } from './admin.repository'
import { runMigrationsForSchema } from '../../migrations/runner'
import { HttpError } from '@shared/errors/http-error'

export interface OnboardInput {
  name:       string
  schemaName: string
}

export interface OnboardResult {
  tenantId:   string
  name:       string
  schemaName: string
}

export async function onboardTenant(input: OnboardInput): Promise<OnboardResult> {
  const { name, schemaName } = input

  // Valida formato e prefixo obrigatorio gestao_
  if (!/^gestao_[a-z0-9_]+$/.test(schemaName)) {
    throw new HttpError(400, 'schemaName deve comecar com "gestao_" e conter apenas letras minusculas, numeros e underscores')
  }

  const exists = await tenantSchemaExists(schemaName)
  if (exists) {
    throw new HttpError(409, `Schema "${schemaName}" ja esta em uso`)
  }

  const tenantId = randomUUID()

  await insertTenant({ id: tenantId, name, schemaName })
  await insertDefaultFlags(tenantId)
  await runMigrationsForSchema(schemaName)

  return { tenantId, name, schemaName }
}
