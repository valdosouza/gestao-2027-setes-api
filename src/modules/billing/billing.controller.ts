import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody } from '@shared/http/controller-utils'
import { validateBodyDto, invoiceBodyDto, cancelBodyDto, cancelWaiverBodyDto } from './billing.dto'
import {
  validateOrder, invoiceOrder, cancelOrderInvoice, waiveOrderInvoiceCancel, getOrderCancelPlan, getOrderFiscalEffect,
} from './billing.service'
import { ErrorCodes } from '@shared/errors/error-codes'

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

export async function cancelWaiver(req: Request, res: Response): Promise<void> {
  const body = parseBody(cancelWaiverBodyDto, req, res)
  if (body === null) return
  try {
    const result = await waiveOrderInvoiceCancel(req.institution!, body)
    logger.info('Nota mantida diante da NFS-e substituída', {
      ...result, schema: req.institution!.schemaName, userId: req.institution!.userId,
    })
    res.json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'billing/cancel-waiver POST')
  }
}

/** `:orderId` da URL — inteiro positivo, senão 400 INVALID_ID. */
function orderIdParam(req: Request, res: Response): number | null {
  const raw = String(req.params.orderId ?? '')
  const id = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: 'orderId inválido', code: ErrorCodes.INVALID_ID, fields: [{ field: 'orderId', message: 'Informe um id (inteiro positivo)' }] })
    return null
  }
  return id
}

export async function cancelPlan(req: Request, res: Response): Promise<void> {
  const orderId = orderIdParam(req, res)
  if (orderId === null) return
  try {
    res.json({ ok: true, data: await getOrderCancelPlan(req.institution!, orderId) })
  } catch (err) {
    handleError(res, err, 'billing/:orderId/cancel-plan GET')
  }
}

export async function fiscalEffect(req: Request, res: Response): Promise<void> {
  const orderId = orderIdParam(req, res)
  if (orderId === null) return
  try {
    res.json({ ok: true, data: await getOrderFiscalEffect(req.institution!, orderId) })
  } catch (err) {
    handleError(res, err, 'billing/:orderId/fiscal-effect GET')
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
