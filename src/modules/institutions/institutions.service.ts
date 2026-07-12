import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'
import { runMigrationsForSchema } from '../../migrations/runner'
import {
  InstitutionInput, InstitutionListRow, InstitutionFull,
} from './institutions.interface'
import {
  listInstitutions, getInstitution, schemaNameExists, institutionExists,
  insertInstitutionCascade, updateInstitutionCascade,
  setInstitutionActive, deleteInstitution, insertDefaultFlags,
} from './institutions.repository'

export async function fetchInstitutions(filter: string): Promise<InstitutionListRow[]> {
  return listInstitutions(filter)
}

export async function fetchInstitution(id: number): Promise<InstitutionFull> {
  const row = await getInstitution(id)
  if (!row) throw new HttpError(404, `Estabelecimento ${id} não encontrado`)
  return row
}

/** CPF/CNPJ/schema_name são UNIQUE — corrida no INSERT vira 409 legível. */
function dupEntryTo409(err: any): never {
  if (err?.code === 'ER_DUP_ENTRY') {
    throw new HttpError(409, 'Já existe um cadastro com este CPF, CNPJ ou schema')
  }
  throw err
}

/**
 * POST absorve o onboarding (decisão do Valdo, 2026-07-11 — o antigo
 * POST /api/admin/institutions foi aposentado):
 * 1. cadeia inteira em transação única (institution nasce active='N');
 * 2. feature flags padrão (gate técnico — decisão 17);
 * 3. APÓS o commit, provisiona o schema (runMigrationsForSchema) — DDL não
 *    tem rollback, então NUNCA dentro da transação;
 * 4. só então marca active='S'. Se a migração falhar, a institution
 *    permanece active='N' e o erro volta ao app.
 */
export async function createInstitution(
  input: InstitutionInput, schemaName: string
): Promise<{ id: number; schemaName: string; active: 'S' | 'N' }> {
  if (await schemaNameExists(schemaName)) {
    throw new HttpError(409, `Schema "${schemaName}" já está em uso`)
  }

  let id: number
  try {
    id = await insertInstitutionCascade(input, schemaName)
  } catch (err) {
    dupEntryTo409(err)
  }

  await insertDefaultFlags(id)

  try {
    await runMigrationsForSchema(schemaName)
  } catch (err) {
    logger.error('Provisionamento do schema falhou — institution permanece inativa', {
      id, schemaName, err,
    })
    throw new HttpError(500,
      `Estabelecimento ${id} foi criado, mas o provisionamento do schema "${schemaName}" ` +
      `falhou — ele permanece INATIVO (active='N'). Corrija a causa e reative pela edição.`)
  }

  await setInstitutionActive(id, 'S')
  return { id, schemaName, active: 'S' }
}

export async function editInstitution(id: number, input: InstitutionInput): Promise<void> {
  if (!(await institutionExists(id))) {
    throw new HttpError(404, `Estabelecimento ${id} não encontrado`)
  }
  try {
    await updateInstitutionCascade(id, input)
  } catch (err) {
    dupEntryTo409(err)
  }
}

export async function removeInstitution(id: number): Promise<void> {
  if (!(await institutionExists(id))) {
    throw new HttpError(404, `Estabelecimento ${id} não encontrado`)
  }
  await deleteInstitution(id)
}
