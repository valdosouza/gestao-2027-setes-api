import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody } from '@shared/http/controller-utils'
import { validateBodyDto, invoiceBodyDto, cancelBodyDto } from './billing.dto'
import { validateOrder, invoiceOrder, cancelOrderInvoice } from './billing.service'

/** Controller: HTTP ↔ service (envelope { ok, data }). Autoria = JWT. */

export async function validate(req: Request, res: Response): Promise<void> {
  const body = parseBody(validateBodyDto, req, res)
  if (body === null) return
  try {
    const report = await validateOrder(req.institution!, body)
    res.json({ ok: true, data: report })
  } catch (err) {
    handleError(res, err, 'billing/validate POST')
  }
}

export async function cancel(req: Request, res: Response): Promise<void> {
  const body = parseBody(cancelBodyDto, req, res)
  if (body === null) return
  try {
    const result = await cancelOrderInvoice(req.institution!, body)
    logger.info('Nota cancelada', {
      ...result, schema: req.institution!.schemaName, userId: req.institution!.userId,
    })
    res.json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'billing/cancel POST')
  }
}

export async function invoice(req: Request, res: Response): Promise<void> {
  const body = parseBody(invoiceBodyDto, req, res)
  if (body === null) return
  try {
    const result = await invoiceOrder(req.institution!, body)
    logger.info('Ordem faturada', {
      ...result, schema: req.institution!.schemaName,
      userId: req.institution!.userId,
    })
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'billing/invoice POST')
  }
}
