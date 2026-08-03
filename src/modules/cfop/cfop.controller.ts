import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { cfopCreateDto, cfopUpdateDto, CFOP_CODE_RE } from './cfop.dto'
import {
  fetchCfopList, fetchCfop, createCfop, editCfop, removeCfop,
} from './cfop.service'

/** O id do CFOP é STRING (código fiscal) — validação própria, sem parseId. */
function parseCode(req: Request, res: Response): string | null {
  const id = String(req.params.id ?? '')
  if (!CFOP_CODE_RE.test(id)) {
    res.status(400).json({ error: 'Código CFOP inválido' })
    return null
  }
  return id
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'cfop')
    res.json(pagedEnvelope(query, await fetchCfopList(query)))
  } catch (err) {
    handleError(res, err, 'cfop GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseCode(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchCfop(id) })
  } catch (err) {
    handleError(res, err, 'cfop/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(cfopCreateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'cfop', body)
    const { id, ...input } = body
    const result = await createCfop(id, input)
    logger.info('CFOP criado', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'cfop POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseCode(req, res)
  if (id === null) return
  const body = parseBody(cfopUpdateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'cfop', body)
    await editCfop(id, body)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'cfop/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseCode(req, res)
  if (id === null) return
  try {
    await removeCfop(id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'cfop/:id DELETE')
  }
}
