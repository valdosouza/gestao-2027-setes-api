import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { fieldConfigDto } from './interface-fields.dto'
import {
  fetchVitrine, fetchResolvedFields, fetchResolvedFieldsByKey, saveFieldConfig,
} from './interface-fields.service'

const FIELD_NAME_RE  = /^[a-z][a-z0-9_]{0,99}$/
const MODULE_KEY_RE  = /^[a-z][a-z0-9_-]{0,99}$/

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'interface-fields')
    res.json(pagedEnvelope(query, await fetchVitrine(req.institution!, query)))
  } catch (err) {
    handleError(res, err, 'interface-fields GET')
  }
}

export async function getFields(req: Request, res: Response): Promise<void> {
  const interfaceId = parseId(req, res)
  if (interfaceId === null) return
  try {
    res.json({ ok: true, data: await fetchResolvedFields(req.institution!, interfaceId) })
  } catch (err) {
    handleError(res, err, 'interface-fields/:id GET')
  }
}

export async function getFieldsByKey(req: Request, res: Response): Promise<void> {
  const moduleKey = String(req.params.moduleKey ?? '')
  if (!MODULE_KEY_RE.test(moduleKey)) {
    res.status(400).json({ error: 'moduleKey inválido' })
    return
  }
  try {
    res.json({ ok: true, data: await fetchResolvedFieldsByKey(req.institution!, moduleKey) })
  } catch (err) {
    handleError(res, err, 'interface-fields/key/:moduleKey GET')
  }
}

export async function putField(req: Request, res: Response): Promise<void> {
  const interfaceId = parseId(req, res)
  if (interfaceId === null) return
  const fieldName = String(req.params.fieldName ?? '')
  if (!FIELD_NAME_RE.test(fieldName)) {
    res.status(400).json({ error: 'fieldName inválido' })
    return
  }
  const body = parseBody(fieldConfigDto, req, res)
  if (body === null) return
  try {
    await saveFieldConfig(req.institution!, interfaceId, fieldName, body)
    logger.info('Config de campo salva', {
      institutionId: req.institution!.institutionId, interfaceId, fieldName,
    })
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'interface-fields/:id/:fieldName PUT')
  }
}
