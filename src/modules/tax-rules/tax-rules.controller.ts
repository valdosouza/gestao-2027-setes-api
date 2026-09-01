import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { taxRuleBodyDto } from './tax-rules.dto'
import {
  fetchTaxRules, fetchTaxRule, createTaxRule, editTaxRule, removeTaxRule,
  fetchCatalogs, fetchEmitterCrt, fetchCfopOptions,
} from './tax-rules.service'
import { cfopOptionsQueryDto } from './tax-rules.dto'

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

export async function catalogs(req: Request, res: Response): Promise<void> {
  try {
    // Catálogos são centrais/cacheados; o CRT do emitente (D39.3 — o form
    // se adapta ao regime do estabelecimento) é POR INSTITUTION e vai por
    // fora do cache: 1 lookup indexado por request.
    const emitterCrt = await fetchEmitterCrt(
      req.institution!.schemaName, req.institution!.institutionId)
    res.json({ ok: true, data: { ...await fetchCatalogs(), emitterCrt } })
  } catch (err) {
    handleError(res, err, 'tax-rules/catalogs GET')
  }
}

export async function cfops(req: Request, res: Response): Promise<void> {
  const parsed = cfopOptionsQueryDto.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({
      error: 'Validação falhou', code: 'VALIDATION_FAILED',
      fields: parsed.error.issues.map(i => ({
        field: i.path.join('.'), message: i.message })),
    })
    return
  }
  try {
    const { direction, stateId, filter } = parsed.data
    res.json({ ok: true, data: await fetchCfopOptions(
      req.institution!.institutionId, direction, stateId ?? null, filter ?? null) })
  } catch (err) {
    handleError(res, err, 'tax-rules/cfops GET')
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
