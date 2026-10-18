import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { paymentTypeLinkDto, paymentTypeLinkUpdateDto } from './payment-types.dto'
import {
  PaymentTypeScope, fetchLinked, fetchCatalog, saveLink, editLink, removeLink,
  PAYMENT_TYPE_SEARCH_CRITERIA, fetchPaymentTypeSearchCriteria,
} from './payment-types.service'
import { fetchFinancialPlansLookup } from './payment-types.service'

/** Escopo SEMPRE do JWT (o vínculo é por institution). */
function scopeOf(req: Request): PaymentTypeScope {
  const { schemaName, institutionId } = req.institution!
  return { schemaName, institutionId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'payment-types', PAYMENT_TYPE_SEARCH_CRITERIA)
    res.json(pagedEnvelope(query, await fetchLinked(query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'payment-types GET')
  }
}

/** GET /search-criteria — lista branca da pesquisa avançada (D-BA2). */
export async function searchCriteria(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchPaymentTypeSearchCriteria() })
  } catch (err) {
    handleError(res, err, 'payment-types/search-criteria GET')
  }
}

export async function catalog(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchCatalog(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'payment-types/catalog GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(paymentTypeLinkDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'payment-types', body)
    const result = await saveLink(body, scopeOf(req))
    logger.info('Forma de pagamento vinculada', {
      institutionId: req.institution!.institutionId, ...result,
    })
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'payment-types POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(paymentTypeLinkUpdateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'payment-types', body)
    await editLink(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'payment-types/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeLink(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'payment-types/:id DELETE')
  }
}

export async function financialPlansLookup(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchFinancialPlansLookup(String(req.query.filter ?? ''), scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'payment-types/financial-plans GET')
  }
}
