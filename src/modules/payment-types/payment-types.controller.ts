import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { assertClientRequired } from '@shared/field-config'
import { paymentTypeLinkDto, paymentTypeLinkUpdateDto } from './payment-types.dto'
import {
  PaymentTypeScope, fetchLinked, fetchCatalog, saveLink, editLink, removeLink,
} from './payment-types.service'

/** Escopo SEMPRE do JWT (o vínculo é por institution). */
function scopeOf(req: Request): PaymentTypeScope {
  const { schemaName, institutionId } = req.institution!
  return { schemaName, institutionId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchLinked(scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'payment-types GET')
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
