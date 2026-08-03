import { Request, Response } from 'express'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { providerCreateDto, providerUpdateDto } from './providers.dto'
import {
  ProviderScope, fetchProviders, fetchProvider,
  createProvider, editProvider, removeProvider,
} from './providers.service'

/** Escopo SEMPRE do JWT (o papel é por institution). */
function scopeOf(req: Request): ProviderScope {
  const { schemaName, institutionId, userId } = req.institution!
  return { schemaName, institutionId, userId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'providers')
    res.json(pagedEnvelope(query, await fetchProviders(query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'providers GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchProvider(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'providers/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(providerCreateDto, req, res)
  if (body === null) return
  try {
    const result = await createProvider(body, scopeOf(req))
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'providers POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(providerUpdateDto, req, res)
  if (body === null) return
  try {
    await editProvider(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'providers/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeProvider(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'providers/:id DELETE')
  }
}
