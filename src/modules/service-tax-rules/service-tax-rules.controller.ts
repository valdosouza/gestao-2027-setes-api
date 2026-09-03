import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { serviceTaxRuleDto } from './service-tax-rules.dto'
import {
  ServiceTaxRuleScope, fetchServiceTaxRules, fetchServiceTaxRule,
  createServiceTaxRule, editServiceTaxRule, removeServiceTaxRule,
  fetchServiceListLookup,
} from './service-tax-rules.service'

/** Escopo SEMPRE do JWT (cadastro por institution). */
function scopeOf(req: Request): ServiceTaxRuleScope {
  const { schemaName, institutionId } = req.institution!
  return { schemaName, institutionId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'service-tax-rules')
    res.json(pagedEnvelope(query, await fetchServiceTaxRules(query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'service-tax-rules GET')
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchServiceTaxRule(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'service-tax-rules/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(serviceTaxRuleDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'service-tax-rules', body)
    const id = await createServiceTaxRule(body, scopeOf(req))
    logger.info('Regra de tributação de serviço criada', {
      institutionId: req.institution!.institutionId, id,
    })
    res.status(201).json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'service-tax-rules POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(serviceTaxRuleDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'service-tax-rules', body)
    await editServiceTaxRule(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'service-tax-rules/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeServiceTaxRule(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'service-tax-rules/:id DELETE')
  }
}

export async function serviceListLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchServiceListLookup(filter) })
  } catch (err) {
    handleError(res, err, 'service-tax-rules/service-list GET')
  }
}
