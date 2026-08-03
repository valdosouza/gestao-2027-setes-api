import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import {
  SalesmanInput, SalesmanListRow, SalesmanFull, CollaboratorLookupRow,
} from './salesmen.interface'
import {
  listSalesmen, getSalesman, salesmanExists, listCollaboratorLookup,
  insertSalesman, updateSalesman, deleteSalesman,
} from './salesmen.repository'

/**
 * Regras do módulo salesmen (Onda 2 — D1): promoção de colaborador. A
 * validação de precedência vive no repositório (mesma transação do INSERT);
 * aqui ficam o escopo por institution (JWT), o 404 e a tradução de corrida.
 */

/** Escopo do usuário logado — sempre derivado do JWT, nunca do payload. */
export interface SalesmanScope {
  schemaName:    string
  institutionId: number
  userId:        number
}

/** Corrida no INSERT (PK do papel) vira 409 legível. */
function dupEntryTo409(err: any): never {
  if (err?.code === 'ER_DUP_ENTRY') {
    throw new HttpError(409, 'Registro em conflito — tente novamente (cadastro simultâneo detectado)',
      undefined, 'CONFLICT_RETRY')
  }
  throw err
}

export async function fetchSalesmen(
  query: ListQuery, scope: SalesmanScope
): Promise<PagedRows<SalesmanListRow>> {
  return listSalesmen(query, scope.schemaName, scope.institutionId)
}

export async function fetchSalesman(
  id: number, scope: SalesmanScope
): Promise<SalesmanFull> {
  const row = await getSalesman(id, scope.schemaName, scope.institutionId)
  if (!row) throw new HttpError(404, `Vendedor ${id} não encontrado`)
  return row
}

export async function fetchCollaboratorLookup(
  filter: string, scope: SalesmanScope
): Promise<CollaboratorLookupRow[]> {
  return listCollaboratorLookup(filter, scope.schemaName, scope.institutionId)
}

export async function createSalesman(
  id: number, input: SalesmanInput, scope: SalesmanScope
): Promise<{ id: number }> {
  try {
    return await insertSalesman(id, input, scope.schemaName, scope.institutionId)
  } catch (err) {
    dupEntryTo409(err)
  }
}

export async function editSalesman(
  id: number, input: SalesmanInput, scope: SalesmanScope
): Promise<void> {
  if (!(await salesmanExists(id, scope.schemaName, scope.institutionId))) {
    throw new HttpError(404, `Vendedor ${id} não encontrado`)
  }
  await updateSalesman(id, input, scope.schemaName, scope.institutionId)
}

/** Exclusão LIVRE (D4): sempre soft delete; carteira vira histórico. */
export async function removeSalesman(
  id: number, scope: SalesmanScope
): Promise<void> {
  if (!(await salesmanExists(id, scope.schemaName, scope.institutionId))) {
    throw new HttpError(404, `Vendedor ${id} não encontrado`)
  }
  await deleteSalesman(id, scope.schemaName, scope.institutionId)
}
