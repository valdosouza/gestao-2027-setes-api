import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseId } from '@shared/http/controller-utils'
import { interfaceDto } from './interfaces.dto'
import {
  fetchInterfaces, fetchInterface, createInterface, editInterface, removeInterface,
} from './interfaces.service'

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchInterfaces(filter) })
  } catch (err) {
    handleError(res, err, 'interfaces GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchInterface(id) })
  } catch (err) {
    handleError(res, err, 'interfaces/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const parsed = interfaceDto.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    const { privilegeIds, ...input } = parsed.data
    const result = await createInterface(input, privilegeIds ?? [])
    logger.info('Interface criada', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'interfaces POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const parsed = interfaceDto.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    const { privilegeIds, ...input } = parsed.data
    await editInterface(id, input, privilegeIds ?? [])
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'interfaces/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeInterface(id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'interfaces/:id DELETE')
  }
}
