import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { serviceDto } from './services.dto'
import {
  ServiceScope, fetchServices, fetchService, createService, editService,
  removeService, fetchCategoriesLookup, fetchFinancialPlansLookup,
} from './services.service'

/** Escopo SEMPRE do JWT (cadastro por institution). */
function scopeOf(req: Request): ServiceScope {
  const { schemaName, institutionId } = req.institution!
  return { schemaName, institutionId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'services')
    res.json(pagedEnvelope(query, await fetchServices(query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'services GET')
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchService(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'services/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(serviceDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'services', body)
    const id = await createService(body, scopeOf(req))
    logger.info('Serviço criado', {
      institutionId: req.institution!.institutionId, id,
    })
    res.status(201).json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'services POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(serviceDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'services', body)
    await editService(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'services/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeService(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'services/:id DELETE')
  }
}

export async function categoriesLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchCategoriesLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'services/categories GET')
  }
}

export async function financialPlansLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchFinancialPlansLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'services/financial-plans GET')
  }
}
