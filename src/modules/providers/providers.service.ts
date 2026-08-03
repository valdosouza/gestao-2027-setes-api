import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import { ProviderInput, ProviderListRow, ProviderFull } from './providers.interface'
import {
  listProviders, getProvider, providerExists,
  insertProviderCascade, updateProviderCascade, deleteProvider,
} from './providers.repository'

/**
 * Regras do módulo providers (Onda 3 da Entidade Única): o reuso por
 * documento e o last-write-wins são da CADEIA (@shared/entity); aqui ficam
 * o escopo por institution (JWT), o 404 e a tradução de corrida em 409.
 */

/** Escopo do usuário logado — sempre derivado do JWT, nunca do payload. */
export interface ProviderScope {
  schemaName:    string
  institutionId: number
  userId:        number
}

/** Corrida no INSERT (UNIQUE de cpf/cnpj ou PK do papel) vira 409 legível. */
function dupEntryTo409(err: any): never {
  if (err?.code === 'ER_DUP_ENTRY') {
    throw new HttpError(409, 'Registro em conflito — tente novamente (cadastro simultâneo detectado)',
      undefined, 'CONFLICT_RETRY')
  }
  throw err
}

export async function fetchProviders(
  query: ListQuery, scope: ProviderScope
): Promise<PagedRows<ProviderListRow>> {
  return listProviders(query, scope.schemaName, scope.institutionId)
}

export async function fetchProvider(
  id: number, scope: ProviderScope
): Promise<ProviderFull> {
  const row = await getProvider(id, scope.schemaName, scope.institutionId)
  if (!row) throw new HttpError(404, `Fornecedor ${id} não encontrado`)
  return row
}

export async function createProvider(
  input: ProviderInput, scope: ProviderScope
): Promise<{ id: number; reused: boolean }> {
  try {
    return await insertProviderCascade(
      input, scope.schemaName, scope.institutionId, scope.userId)
  } catch (err) {
    dupEntryTo409(err)
  }
}

export async function editProvider(
  id: number, input: ProviderInput, scope: ProviderScope
): Promise<void> {
  if (!(await providerExists(id, scope.schemaName, scope.institutionId))) {
    throw new HttpError(404, `Fornecedor ${id} não encontrado`)
  }
  try {
    await updateProviderCascade(
      id, input, scope.schemaName, scope.institutionId, scope.userId)
  } catch (err) {
    dupEntryTo409(err)
  }
}

export async function removeProvider(
  id: number, scope: ProviderScope
): Promise<void> {
  if (!(await providerExists(id, scope.schemaName, scope.institutionId))) {
    throw new HttpError(404, `Fornecedor ${id} não encontrado`)
  }
  await deleteProvider(id, scope.schemaName, scope.institutionId)
}
