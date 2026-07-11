import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseId } from '@shared/http/controller-utils'
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
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchCountries(filter) })
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
  const parsed = countryCreateDto.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    const result = await createCountry(parsed.data.id, parsed.data.name)
    logger.info('País criado', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'countries POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const parsed = countryUpdateDto.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    await editCountry(id, parsed.data.name)
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
