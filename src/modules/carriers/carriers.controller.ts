import { Request, Response } from 'express'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { carrierCreateDto, carrierUpdateDto } from './carriers.dto'
import {
  CarrierScope, fetchCarriers, fetchCarrier,
  createCarrier, editCarrier, removeCarrier,
} from './carriers.service'

/** Escopo SEMPRE do JWT (o papel é por institution). */
function scopeOf(req: Request): CarrierScope {
  const { schemaName, institutionId, userId } = req.institution!
  return { schemaName, institutionId, userId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'carriers')
    res.json(pagedEnvelope(query, await fetchCarriers(query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'carriers GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchCarrier(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'carriers/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(carrierCreateDto, req, res)
  if (body === null) return
  try {
    const result = await createCarrier(body, scopeOf(req))
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'carriers POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(carrierUpdateDto, req, res)
  if (body === null) return
  try {
    await editCarrier(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'carriers/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeCarrier(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'carriers/:id DELETE')
  }
}
