import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import {
  issueBankSlipDto, settleBankSlipDto, cancelBankSlipDto, reverseBankSlipDto,
} from './bank-slips.dto'
import {
  BankSlipScope, parseState, fetchBankSlips, fetchBankSlip, fetchAgreementsLookup,
  fetchOpenTitles, issueSlip, settleSlip, cancelSlip, reverseSlip,
} from './bank-slips.service'

/** Escopo SEMPRE do JWT (institution + autor das ações). */
function scopeOf(req: Request): BankSlipScope {
  const { schemaName, institutionId, userId } = req.institution!
  return { schemaName, institutionId, userId: Number(userId) }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const status = parseState(req.query.status)
    const query = await parseListQuery(req, 'bank-slips')
    res.json(pagedEnvelope(query, await fetchBankSlips(status, query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'bank-slips GET')
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchBankSlip(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'bank-slips/:id GET')
  }
}

export async function agreementsLookup(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchAgreementsLookup(scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'bank-slips/agreements GET')
  }
}

export async function openTitlesLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    const rawCustomer = req.query.customerId
    const customerId = rawCustomer == null || rawCustomer === '' ? null : Number(rawCustomer)
    if (customerId !== null && !Number.isInteger(customerId)) {
      res.status(400).json({ error: 'customerId inválido', fields: [{ field: 'customerId', message: 'Inválido' }] })
      return
    }
    res.json({ ok: true, data: await fetchOpenTitles(filter, customerId, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'bank-slips/open-titles GET')
  }
}

export async function issue(req: Request, res: Response): Promise<void> {
  const body = parseBody(issueBankSlipDto, req, res)
  if (body === null) return
  try {
    const result = await issueSlip(body, scopeOf(req))
    logger.info('Boleto emitido', { institutionId: req.institution!.institutionId, ...result })
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'bank-slips POST')
  }
}

export async function settle(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(settleBankSlipDto, req, res)
  if (body === null) return
  try {
    res.status(201).json({ ok: true, data: await settleSlip(id, body, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'bank-slips/:id/settle POST')
  }
}

export async function cancel(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(cancelBankSlipDto, req, res)
  if (body === null) return
  try {
    res.status(201).json({ ok: true, data: await cancelSlip(id, body, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'bank-slips/:id/cancel POST')
  }
}

export async function reverse(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(reverseBankSlipDto, req, res)
  if (body === null) return
  try {
    res.status(201).json({ ok: true, data: await reverseSlip(id, body, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'bank-slips/:id/reverse POST')
  }
}
