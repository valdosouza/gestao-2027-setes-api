import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { moduleBodyDto } from './modules.dto'
import {
  fetchModules, fetchModule, fetchEligibleInterfaces,
  createModule, editModule, removeModule,
} from './modules.service'

/**
 * Controller: traduz HTTP ↔ service (valida DTO, status codes, envelope
 * { ok, data }). Escopo = schema do JWT (adminGuard no gateway).
 */

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'modules')
    res.json(pagedEnvelope(query, await fetchModules(req.institution!.schemaName, query)))
  } catch (err) {
    handleError(res, err, 'modules GET')
  }
}

export async function interfaceLookup(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchEligibleInterfaces(req.institution!.schemaName) })
  } catch (err) {
    handleError(res, err, 'modules/interface-lookup GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchModule(req.institution!.schemaName, id) })
  } catch (err) {
    handleError(res, err, 'modules/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(moduleBodyDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'modules', body)
    const result = await createModule(req.institution!.schemaName, body)
    logger.info('Módulo de menu criado', { ...result, schema: req.institution!.schemaName })
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'modules POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(moduleBodyDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'modules', body)
    await editModule(req.institution!.schemaName, id, body)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'modules/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeModule(req.institution!.schemaName, id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'modules/:id DELETE')
  }
}
