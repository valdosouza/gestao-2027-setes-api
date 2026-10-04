import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId, parseOptionalQueryId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { stateCreateDto, stateUpdateDto } from './states.dto'
import {
  fetchStates, fetchState, createState, editState, removeState,
  STATE_SEARCH_CRITERIA, fetchStateSearchCriteria, fetchCountriesLookup,
} from './states.service'

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query     = await parseListQuery(req, 'states', STATE_SEARCH_CRITERIA)
    const countryId = parseOptionalQueryId(req, 'countryId') ?? undefined
    res.json(pagedEnvelope(query, await fetchStates(query, countryId)))
  } catch (err) {
    handleError(res, err, 'states GET')
  }
}

/** GET /search-criteria — lista branca da pesquisa avançada (D-BA2). */
export async function searchCriteria(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchStateSearchCriteria() })
  } catch (err) {
    handleError(res, err, 'states/search-criteria GET')
  }
}

/** GET /countries-lookup — lista de apoio do critério "país". */
export async function countriesLookup(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchCountriesLookup(String(req.query.filter ?? '').trim()) })
  } catch (err) {
    handleError(res, err, 'states/countries-lookup GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchState(id) })
  } catch (err) {
    handleError(res, err, 'states/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(stateCreateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'states', body)
    const { id, ...input } = body
    const result = await createState(id, input)
    logger.info('Estado criado', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'states POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(stateUpdateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'states', body)
    await editState(id, body)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'states/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeState(id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'states/:id DELETE')
  }
}
