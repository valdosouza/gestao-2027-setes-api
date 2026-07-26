import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { assertClientRequired } from '@shared/field-config'
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
  const body = parseBody(privilegeDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'privileges', body)
    const result = await createPrivilege(body.description)
    logger.info('Privilégio criado', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'privileges POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(privilegeDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'privileges', body)
    await editPrivilege(id, body.description)
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
