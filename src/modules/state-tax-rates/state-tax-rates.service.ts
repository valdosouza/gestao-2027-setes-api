import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import {
  listMva, getMva, insertMva, updateMva, deleteMva,
  listFcp, getFcp, insertFcp, updateFcp, deleteFcp,
} from './state-tax-rates.repository'
import { StateMvaNcmRow, StateFcpNcmRow } from './state-tax-rates.interface'
import { StateMvaNcmBodyDto, StateFcpNcmBodyDto } from './state-tax-rates.dto'

/** Regra de negócio do catálogo MVA/FCP por UF×NCM — id MAX+1 no backend. */

export async function fetchMvaList(
  schemaName: string, institutionId: number, query: ListQuery
): Promise<PagedRows<StateMvaNcmRow>> {
  return listMva(schemaName, institutionId, query)
}

export async function fetchMva(
  schemaName: string, institutionId: number, id: number
): Promise<StateMvaNcmRow> {
  const row = await getMva(schemaName, institutionId, id)
  if (!row) throw new HttpError(404, `Alíquota MVA ${id} não encontrada`)
  return row
}

export async function createMva(
  schemaName: string, institutionId: number, input: StateMvaNcmBodyDto
): Promise<{ id: number }> {
  const id = await insertMva(schemaName, institutionId, input)
  return { id }
}

export async function editMva(
  schemaName: string, institutionId: number, id: number, input: StateMvaNcmBodyDto
): Promise<void> {
  await updateMva(schemaName, institutionId, id, input)
}

export async function removeMva(
  schemaName: string, institutionId: number, id: number
): Promise<void> {
  await deleteMva(schemaName, institutionId, id)
}

export async function fetchFcpList(
  schemaName: string, institutionId: number, query: ListQuery
): Promise<PagedRows<StateFcpNcmRow>> {
  return listFcp(schemaName, institutionId, query)
}

export async function fetchFcp(
  schemaName: string, institutionId: number, id: number
): Promise<StateFcpNcmRow> {
  const row = await getFcp(schemaName, institutionId, id)
  if (!row) throw new HttpError(404, `Alíquota FCP ${id} não encontrada`)
  return row
}

export async function createFcp(
  schemaName: string, institutionId: number, input: StateFcpNcmBodyDto
): Promise<{ id: number }> {
  const id = await insertFcp(schemaName, institutionId, input)
  return { id }
}

export async function editFcp(
  schemaName: string, institutionId: number, id: number, input: StateFcpNcmBodyDto
): Promise<void> {
  await updateFcp(schemaName, institutionId, id, input)
}

export async function removeFcp(
  schemaName: string, institutionId: number, id: number
): Promise<void> {
  await deleteFcp(schemaName, institutionId, id)
}
