import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { assertClientRequired } from '@shared/field-config'
import { financialPlanDto } from './financial-plans.dto'
import {
  FinancialPlanScope, fetchFinancialPlans, fetchFinancialPlan,
  createFinancialPlan, editFinancialPlan, removeFinancialPlan,
} from './financial-plans.service'

/** Escopo SEMPRE do JWT (o cadastro é por institution). */
function scopeOf(req: Request): FinancialPlanScope {
  const { schemaName, institutionId } = req.institution!
  return { schemaName, institutionId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchFinancialPlans(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'financial-plans GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchFinancialPlan(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'financial-plans/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(financialPlanDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'financial-plans', body)
    const result = await createFinancialPlan(body, scopeOf(req))
    logger.info('Conta do plano criada', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'financial-plans POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(financialPlanDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'financial-plans', body)
    await editFinancialPlan(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'financial-plans/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeFinancialPlan(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'financial-plans/:id DELETE')
  }
}
