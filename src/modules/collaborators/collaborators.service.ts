import { HttpError } from '@shared/errors/http-error'
import {
  CollaboratorInput, CollaboratorListRow, CollaboratorFull,
} from './collaborators.interface'
import {
  listCollaborators, getCollaborator, collaboratorExists,
  insertCollaboratorCascade, updateCollaboratorCascade, deleteCollaborator,
} from './collaborators.repository'

/**
 * Regras do módulo collaborators (onda 2 da Entidade Única): o reuso por
 * documento e o last-write-wins são da CADEIA (@shared/entity); aqui ficam
 * o escopo por institution (JWT), o 404 e a tradução de corrida em 409.
 * Precedência Collaborator→Salesman: será verificada AQUI quando o cadastro
 * de salesman nascer (criar salesman exige colaborador — decisão 16).
 */

/** Escopo do usuário logado — sempre derivado do JWT, nunca do payload. */
export interface CollaboratorScope {
  schemaName:    string
  institutionId: number
  userId:        number
}

/** Corrida no INSERT (UNIQUE de cpf/cnpj ou PK do papel) vira 409 legível. */
function dupEntryTo409(err: any): never {
  if (err?.code === 'ER_DUP_ENTRY') {
    throw new HttpError(409, 'Registro em conflito — tente novamente (cadastro simultâneo detectado)')
  }
  throw err
}

export async function fetchCollaborators(
  filter: string, scope: CollaboratorScope
): Promise<CollaboratorListRow[]> {
  return listCollaborators(filter, scope.schemaName, scope.institutionId)
}

export async function fetchCollaborator(
  id: number, scope: CollaboratorScope
): Promise<CollaboratorFull> {
  const row = await getCollaborator(id, scope.schemaName, scope.institutionId)
  if (!row) throw new HttpError(404, `Colaborador ${id} não encontrado`)
  return row
}

export async function createCollaborator(
  input: CollaboratorInput, scope: CollaboratorScope
): Promise<{ id: number; reused: boolean }> {
  try {
    return await insertCollaboratorCascade(
      input, scope.schemaName, scope.institutionId, scope.userId)
  } catch (err) {
    dupEntryTo409(err)
  }
}

export async function editCollaborator(
  id: number, input: CollaboratorInput, scope: CollaboratorScope
): Promise<void> {
  if (!(await collaboratorExists(id, scope.schemaName, scope.institutionId))) {
    throw new HttpError(404, `Colaborador ${id} não encontrado`)
  }
  try {
    await updateCollaboratorCascade(
      id, input, scope.schemaName, scope.institutionId, scope.userId)
  } catch (err) {
    dupEntryTo409(err)
  }
}

export async function removeCollaborator(
  id: number, scope: CollaboratorScope
): Promise<void> {
  if (!(await collaboratorExists(id, scope.schemaName, scope.institutionId))) {
    throw new HttpError(404, `Colaborador ${id} não encontrado`)
  }
  await deleteCollaborator(id, scope.schemaName, scope.institutionId)
}
