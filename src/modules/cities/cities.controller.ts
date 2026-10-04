import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId, parseOptionalQueryId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { cityCreateDto, cityUpdateDto } from './cities.dto'
import {
  fetchCities, fetchCity, createCity, editCity, removeCity,
  CITY_SEARCH_CRITERIA, fetchCitySearchCriteria, fetchStatesLookup,
} from './cities.service'

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query   = await parseListQuery(req, 'cities', CITY_SEARCH_CRITERIA)
    const stateId = parseOptionalQueryId(req, 'stateId') ?? undefined
    res.json(pagedEnvelope(query, await fetchCities(query, stateId)))
  } catch (err) {
    handleError(res, err, 'cities GET')
  }
}

/** GET /search-criteria — lista branca da pesquisa avançada (D-BA2). */
export async function searchCriteria(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchCitySearchCriteria() })
  } catch (err) {
    handleError(res, err, 'cities/search-criteria GET')
  }
}

/** GET /states-lookup — lista de apoio do critério "estado". */
export async function statesLookup(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchStatesLookup(String(req.query.filter ?? '').trim()) })
  } catch (err) {
    handleError(res, err, 'cities/states-lookup GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchCity(id) })
  } catch (err) {
    handleError(res, err, 'cities/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(cityCreateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'cities', body)
    const { id, ...input } = body
    const result = await createCity({ ...input, id })
    logger.info('Cidade criada', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'cities POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(cityUpdateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'cities', body)
    await editCity(id, body)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'cities/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeCity(id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'cities/:id DELETE')
  }
}
