import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import { CfopRow, CfopInput } from './cfop.interface'
import {
  listCfop, getCfop, cfopCodeExists, insertCfop, updateCfop, deleteCfop,
} from './cfop.repository'

/**
 * Regras do módulo cfop: código informado pelo usuário (padrão de código
 * externo, precedente countries/BACEN) — 409 se já existir MESMO com
 * deleted='S'; imutável na edição.
 */

export async function fetchCfopList(query: ListQuery): Promise<PagedRows<CfopRow>> {
  return listCfop(query)
}

export async function fetchCfop(id: string): Promise<CfopRow> {
  const row = await getCfop(id)
  if (!row) throw new HttpError(404, `CFOP ${id} não encontrado`)
  return row
}

export async function createCfop(id: string, input: CfopInput): Promise<{ id: string }> {
  if (await cfopCodeExists(id)) {
    throw new HttpError(409, `CFOP ${id} já cadastrado`,
      [{ field: 'id', message: 'Código já utilizado' }])
  }
  await insertCfop(id, input)
  return { id }
}

export async function editCfop(id: string, input: CfopInput): Promise<void> {
  await fetchCfop(id) // garante existência
  await updateCfop(id, input)
}

export async function removeCfop(id: string): Promise<void> {
  await fetchCfop(id)
  await deleteCfop(id)
}
