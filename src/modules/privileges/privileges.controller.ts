import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseId } from '@shared/http/controller-utils'
import { privilegeDto } from './privileges.dto'
import {
  fetchPrivileges, fetchPrivilege, createPrivilege, editPrivilege, removePrivilege,
} from './privileges.service'

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchPrivileges(filter) })
  } catch (err) {
    handleError(res, err, 'privileges GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchPrivilege(id) })
  } catch (err) {
    handleError(res, err, 'privileges/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const parsed = privilegeDto.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    const result = await createPrivilege(parsed.data.description)
    logger.info('Privilégio criado', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'privileges POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const parsed = privilegeDto.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    await editPrivilege(id, parsed.data.description)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'privileges/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removePrivilege(id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'privileges/:id DELETE')
  }
}
