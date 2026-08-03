import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { countryCreateDto, countryUpdateDto } from './countries.dto'
import {
  fetchCountries, fetchCountry, createCountry, editCountry, removeCountry,
} from './countries.service'

/**
 * Controller: traduz HTTP ↔ service (valida DTO, status codes, envelope
 * { ok, data }). Regra de negócio fica no service; SQL no repository.
 */

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'countries')
    res.json(pagedEnvelope(query, await fetchCountries(query)))
  } catch (err) {
    handleError(res, err, 'countries GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchCountry(id) })
  } catch (err) {
    handleError(res, err, 'countries/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(countryCreateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'countries', body)
    const result = await createCountry(body.id, body.name)
    logger.info('País criado', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'countries POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(countryUpdateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'countries', body)
    await editCountry(id, body.name)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'countries/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeCountry(id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'countries/:id DELETE')
  }
}
