import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseId } from '@shared/http/controller-utils'
import { stateCreateDto, stateUpdateDto } from './states.dto'
import {
  fetchStates, fetchState, createState, editState, removeState,
} from './states.service'

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const filter    = String(req.query.filter ?? '')
    const countryId = req.query.countryId ? Number(req.query.countryId) : undefined
    res.json({ ok: true, data: await fetchStates(filter, countryId) })
  } catch (err) {
    handleError(res, err, 'states GET')
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
  const parsed = stateCreateDto.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    const { id, ...input } = parsed.data
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
  const parsed = stateUpdateDto.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    await editState(id, parsed.data)
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
