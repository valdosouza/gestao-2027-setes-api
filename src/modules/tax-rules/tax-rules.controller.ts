import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { taxRuleBodyDto } from './tax-rules.dto'
import {
  fetchTaxRules, fetchTaxRule, createTaxRule, editTaxRule, removeTaxRule,
  fetchCatalogs,
} from './tax-rules.service'

/**
 * Controller: HTTP ↔ service (envelope { ok, data }; lista paginada).
 * Escopo = schema + institution do JWT.
 */

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'tax-rules')
    res.json(pagedEnvelope(query, await fetchTaxRules(
      req.institution!.schemaName, req.institution!.institutionId, query)))
  } catch (err) {
    handleError(res, err, 'tax-rules GET')
  }
}

export async function catalogs(_req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchCatalogs() })
  } catch (err) {
    handleError(res, err, 'tax-rules/catalogs GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchTaxRule(
      req.institution!.schemaName, req.institution!.institutionId, id) })
  } catch (err) {
    handleError(res, err, 'tax-rules/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(taxRuleBodyDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'tax-rules', body)
    const result = await createTaxRule(
      req.institution!.schemaName, req.institution!.institutionId, body)
    logger.info('Regra de tributação criada',
      { ...result, schema: req.institution!.schemaName })
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'tax-rules POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(taxRuleBodyDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'tax-rules', body)
    await editTaxRule(
      req.institution!.schemaName, req.institution!.institutionId, id, body)
    res.json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'tax-rules PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeTaxRule(
      req.institution!.schemaName, req.institution!.institutionId, id)
    res.json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'tax-rules DELETE')
  }
}
