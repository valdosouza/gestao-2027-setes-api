import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { assertClientRequired } from '@shared/field-config'
import { cityCreateDto, cityUpdateDto } from './cities.dto'
import {
  fetchCities, fetchCity, createCity, editCity, removeCity,
} from './cities.service'

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const filter  = String(req.query.filter ?? '')
    const stateId = req.query.stateId ? Number(req.query.stateId) : undefined
    res.json({ ok: true, data: await fetchCities(filter, stateId) })
  } catch (err) {
    handleError(res, err, 'cities GET')
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
