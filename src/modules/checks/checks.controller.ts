import { Request, Response } from 'express'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import {
  depositCheckDto, discountCheckDto, returnCheckRefundDto, returnCheckGoodDto,
  useCheckInPaymentDto, returnCheckDto, reverseCheckDto,
} from './checks.dto'
import {
  CheckScope, parseState, fetchChecks, fetchCheck, fetchBanksLookup,
  fetchBankAccountsLookup, fetchProvidersLookup, fetchOpenPayables,
  depositCheckAction, discountCheckAction, returnCheckRefundAction,
  returnCheckGoodAction, useCheckInPaymentAction, returnCheckAction, reverseCheckAction,
} from './checks.service'

/** Escopo SEMPRE do JWT (institution + autor das ações). */
function scopeOf(req: Request): CheckScope {
  const { schemaName, institutionId, userId } = req.institution!
  return { schemaName, institutionId, userId: Number(userId) }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const status = parseState(req.query.status)
    const query = await parseListQuery(req, 'checks')
    res.json(pagedEnvelope(query, await fetchChecks(status, query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'checks GET')
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchCheck(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'checks/:id GET')
  }
}

export async function banksLookup(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchBanksLookup(String(req.query.filter ?? '')) })
  } catch (err) {
    handleError(res, err, 'checks/banks GET')
  }
}
export async function bankAccountsLookup(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchBankAccountsLookup(String(req.query.filter ?? ''), scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'checks/bank-accounts GET')
  }
}
export async function providersLookup(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchProvidersLookup(String(req.query.filter ?? ''), scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'checks/providers GET')
  }
}
export async function openPayablesLookup(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchOpenPayables(String(req.query.filter ?? ''), scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'checks/open-payables GET')
  }
}

export async function deposit(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(depositCheckDto, req, res)
  if (body === null) return
  try {
    res.status(201).json({ ok: true, data: await depositCheckAction(id, body, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'checks/:id/deposit POST')
  }
}

export async function discount(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(discountCheckDto, req, res)
  if (body === null) return
  try {
    res.status(201).json({ ok: true, data: await discountCheckAction(id, body, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'checks/:id/discount POST')
  }
}

export async function returnRefund(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(returnCheckRefundDto, req, res)
  if (body === null) return
  try {
    res.status(201).json({ ok: true, data: await returnCheckRefundAction(id, body, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'checks/:id/return-refund POST')
  }
}

export async function returnGood(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(returnCheckGoodDto, req, res)
  if (body === null) return
  try {
    res.status(201).json({ ok: true, data: await returnCheckGoodAction(id, body, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'checks/:id/return-good POST')
  }
}

export async function pay(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(useCheckInPaymentDto, req, res)
  if (body === null) return
  try {
    res.status(201).json({ ok: true, data: await useCheckInPaymentAction(id, body, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'checks/:id/pay POST')
  }
}

export async function returnToOrigin(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(returnCheckDto, req, res)
  if (body === null) return
  try {
    res.status(201).json({ ok: true, data: await returnCheckAction(id, body, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'checks/:id/return POST')
  }
}

export async function reverse(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(reverseCheckDto, req, res)
  if (body === null) return
  try {
    res.status(201).json({ ok: true, data: await reverseCheckAction(id, body, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'checks/:id/reverse POST')
  }
}
