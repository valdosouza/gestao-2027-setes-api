import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { withdrawDto, closeCashierDto } from './cashier.dto'
import {
  CashierScope, fetchCurrent, open, fetchBalance, withdraw, close,
} from './cashier.service'

function scopeOf(req: Request): CashierScope {
  const { schemaName, institutionId, userId } = req.institution!
  return { schemaName, institutionId, userId }
}

export async function current(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchCurrent(scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'cashier/current GET')
  }
}

export async function openCashier(req: Request, res: Response): Promise<void> {
  try {
    const result = await open(scopeOf(req))
    logger.info('Caixa aberto', { institutionId: req.institution!.institutionId, cashierId: result.id })
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'cashier/open POST')
  }
}

export async function balance(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchBalance(scopeOf(req), id) })
  } catch (err) {
    handleError(res, err, 'cashier/:id GET')
  }
}

export async function withdrawFromCashier(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(withdrawDto, req, res)
  if (body === null) return
  try {
    const result = await withdraw(scopeOf(req), id, body)
    logger.info('Retirada de caixa', {
      institutionId: req.institution!.institutionId, cashierId: id, ...result,
    })
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'cashier/:id/withdraw POST')
  }
}

export async function closeCashier(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(closeCashierDto, req, res)
  if (body === null) return
  try {
    const result = await close(scopeOf(req), id, body)
    logger.info('Caixa fechado', { institutionId: req.institution!.institutionId, cashierId: id })
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'cashier/:id/close POST')
  }
}
