import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import { CarrierInput, CarrierListRow, CarrierFull } from './carriers.interface'
import {
  listCarriers, getCarrier, carrierExists,
  insertCarrierCascade, updateCarrierCascade, deleteCarrier,
} from './carriers.repository'

/**
 * Regras do módulo carriers (Onda 2 da Entidade Única): o reuso por
 * documento e o last-write-wins são da CADEIA (@shared/entity); aqui ficam
 * o escopo por institution (JWT), o 404 e a tradução de corrida em 409.
 */

/** Escopo do usuário logado — sempre derivado do JWT, nunca do payload. */
export interface CarrierScope {
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

export async function fetchCarriers(
  query: ListQuery, scope: CarrierScope
): Promise<PagedRows<CarrierListRow>> {
  return listCarriers(query, scope.schemaName, scope.institutionId)
}

export async function fetchCarrier(
  id: number, scope: CarrierScope
): Promise<CarrierFull> {
  const row = await getCarrier(id, scope.schemaName, scope.institutionId)
  if (!row) throw new HttpError(404, `Transportadora ${id} não encontrada`)
  return row
}

export async function createCarrier(
  input: CarrierInput, scope: CarrierScope
): Promise<{ id: number; reused: boolean }> {
  try {
    return await insertCarrierCascade(
      input, scope.schemaName, scope.institutionId, scope.userId)
  } catch (err) {
    dupEntryTo409(err)
  }
}

export async function editCarrier(
  id: number, input: CarrierInput, scope: CarrierScope
): Promise<void> {
  if (!(await carrierExists(id, scope.schemaName, scope.institutionId))) {
    throw new HttpError(404, `Transportadora ${id} não encontrada`)
  }
  try {
    await updateCarrierCascade(
      id, input, scope.schemaName, scope.institutionId, scope.userId)
  } catch (err) {
    dupEntryTo409(err)
  }
}

export async function removeCarrier(
  id: number, scope: CarrierScope
): Promise<void> {
  if (!(await carrierExists(id, scope.schemaName, scope.institutionId))) {
    throw new HttpError(404, `Transportadora ${id} não encontrada`)
  }
  await deleteCarrier(id, scope.schemaName, scope.institutionId)
}
