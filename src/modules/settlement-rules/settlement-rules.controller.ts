import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { settlementRuleCreateDto, settlementRuleUpdateDto } from './settlement-rules.dto'
import {
  SettlementRuleScope, fetchSettlementRules, fetchSettlementRule,
  createSettlementRule, editSettlementRule, removeSettlementRule,
  fetchPaymentTypesLookup, fetchBankAccountsLookup,
} from './settlement-rules.service'

/** Escopo SEMPRE do JWT (cadastro por institution). */
function scopeOf(req: Request): SettlementRuleScope {
  const { schemaName, institutionId } = req.institution!
  return { schemaName, institutionId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'settlement-rules')
    res.json(pagedEnvelope(query, await fetchSettlementRules(query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'settlement-rules GET')
  }
}

/** :id = tb_payment_types_id (PK compartilhada com o vínculo — D2). */
export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchSettlementRule(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'settlement-rules/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(settlementRuleCreateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'settlement-rules', body)
    const id = await createSettlementRule(body, scopeOf(req))
    logger.info('Regra de recebimento criada', {
      institutionId: req.institution!.institutionId, paymentTypeId: id,
    })
    res.status(201).json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'settlement-rules POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(settlementRuleUpdateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'settlement-rules', body)
    await editSettlementRule(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'settlement-rules/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeSettlementRule(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'settlement-rules/:id DELETE')
  }
}

export async function paymentTypesLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchPaymentTypesLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'settlement-rules/payment-types GET')
  }
}

export async function bankAccountsLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchBankAccountsLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'settlement-rules/bank-accounts GET')
  }
}
