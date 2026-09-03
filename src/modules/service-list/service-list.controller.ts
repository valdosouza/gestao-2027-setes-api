import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { serviceListCreateDto, serviceListUpdateDto, SERVICE_LIST_CODE_RE } from './service-list.dto'
import {
  fetchServiceList, fetchServiceListItem, createServiceListItem,
  editServiceListItem, removeServiceListItem,
} from './service-list.service'

/** id de rota é o item da lista (string 'N.NN') — validado pelo regex. */
function parseCode(req: Request, res: Response): string | null {
  const id = String(req.params.id ?? '')
  if (!SERVICE_LIST_CODE_RE.test(id)) {
    res.status(400).json({ error: 'Item da lista inválido',
      fields: [{ field: 'id', message: 'Formato esperado: N.NN (ex.: 1.01)' }] })
    return null
  }
  return id
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'service-list')
    res.json(pagedEnvelope(query, await fetchServiceList(query)))
  } catch (err) {
    handleError(res, err, 'service-list GET')
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseCode(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchServiceListItem(id) })
  } catch (err) {
    handleError(res, err, 'service-list/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(serviceListCreateDto, req, res)
  if (body === null) return
  try {
    const { id, ...input } = body
    const data = await createServiceListItem(id, input)
    logger.info('Item da lista de serviços criado', { id })
    res.status(201).json({ ok: true, data })
  } catch (err) {
    handleError(res, err, 'service-list POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseCode(req, res)
  if (id === null) return
  const body = parseBody(serviceListUpdateDto, req, res)
  if (body === null) return
  try {
    await editServiceListItem(id, body)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'service-list/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseCode(req, res)
  if (id === null) return
  try {
    await removeServiceListItem(id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'service-list/:id DELETE')
  }
}
