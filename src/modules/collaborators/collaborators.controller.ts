import { Request, Response } from 'express'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { collaboratorCreateDto, collaboratorUpdateDto } from './collaborators.dto'
import {
  CollaboratorScope, fetchCollaborators, fetchCollaborator,
  createCollaborator, editCollaborator, removeCollaborator,
} from './collaborators.service'

/** Escopo SEMPRE do JWT (o papel é por institution). */
function scopeOf(req: Request): CollaboratorScope {
  const { schemaName, institutionId, userId } = req.institution!
  return { schemaName, institutionId, userId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchCollaborators(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'collaborators GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchCollaborator(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'collaborators/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(collaboratorCreateDto, req, res)
  if (body === null) return
  try {
    const result = await createCollaborator(body, scopeOf(req))
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'collaborators POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(collaboratorUpdateDto, req, res)
  if (body === null) return
  try {
    await editCollaborator(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'collaborators/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeCollaborator(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'collaborators/:id DELETE')
  }
}
