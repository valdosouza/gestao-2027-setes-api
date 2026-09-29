import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody } from '@shared/http/controller-utils'
import { ErrorCodes } from '@shared/errors/error-codes'
import { transmitBodyDto, transmitBatchBodyDto, fiscalRefreshBodyDto, fiscalCancelBodyDto } from './billing.dto'
import * as fiscal from './billing.fiscal.service'

/** Controller FISCAL (Onda 3 NFS-e): HTTP ↔ billing.fiscal.service (envelope { ok, data }). */

function parseOrderId(req: Request, res: Response): number | null {
  const id = Number(req.params.orderId)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'orderId inválido', code: ErrorCodes.INVALID_ID })
    return null
  }
  return id
}

export async function transmit(req: Request, res: Response): Promise<void> {
  const body = parseBody(transmitBodyDto, req, res)
  if (body === null) return
  try {
    const result = await fiscal.transmitInvoice(req.institution!, body)
    logger.info('DPS transmitido', { ...result, schema: req.institution!.schemaName, userId: req.institution!.userId })
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'billing/transmit POST')
  }
}

export async function transmitBatch(req: Request, res: Response): Promise<void> {
  const body = parseBody(transmitBatchBodyDto, req, res)
  if (body === null) return
  try {
    const report = await fiscal.transmitInvoiceBatch(req.institution!, body)
    logger.info('Lote de transmissão de NFS-e', { requested: report.requested, transmitted: report.transmitted, failed: report.failed, schema: req.institution!.schemaName })
    res.json({ ok: true, data: report })
  } catch (err) {
    handleError(res, err, 'billing/fiscal/transmit-batch POST')
  }
}

export async function refreshOpen(req: Request, res: Response): Promise<void> {
  const body = parseBody(fiscalRefreshBodyDto, req, res)
  if (body === null) return
  try {
    res.json({ ok: true, data: await fiscal.refreshOpen(req.institution!, body) })
  } catch (err) {
    handleError(res, err, 'billing/fiscal/refresh POST')
  }
}

export async function refreshOne(req: Request, res: Response): Promise<void> {
  const orderId = parseOrderId(req, res)
  if (orderId === null) return
  try {
    res.json({ ok: true, data: await fiscal.refreshInvoice(req.institution!, orderId) })
  } catch (err) {
    handleError(res, err, 'billing/fiscal/:orderId/refresh POST')
  }
}

export async function view(req: Request, res: Response): Promise<void> {
  const orderId = parseOrderId(req, res)
  if (orderId === null) return
  try {
    res.json({ ok: true, data: await fiscal.fiscalView(req.institution!, orderId) })
  } catch (err) {
    handleError(res, err, 'billing/fiscal/:orderId GET')
  }
}

export async function xml(req: Request, res: Response): Promise<void> {
  const orderId = parseOrderId(req, res)
  if (orderId === null) return
  try {
    res.json({ ok: true, data: await fiscal.fiscalXml(req.institution!, orderId) })
  } catch (err) {
    handleError(res, err, 'billing/fiscal/:orderId/xml GET')
  }
}

export async function danfse(req: Request, res: Response): Promise<void> {
  const orderId = parseOrderId(req, res)
  if (orderId === null) return
  try {
    res.json({ ok: true, data: await fiscal.fiscalDanfse(req.institution!, orderId) })
  } catch (err) {
    handleError(res, err, 'billing/fiscal/:orderId/danfse GET')
  }
}

export async function cancel(req: Request, res: Response): Promise<void> {
  const body = parseBody(fiscalCancelBodyDto, req, res)
  if (body === null) return
  try {
    const result = await fiscal.cancelAtAuthority(req.institution!, body)
    logger.info('Cancelamento fiscal', { ...result, schema: req.institution!.schemaName, userId: req.institution!.userId })
    res.json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'billing/fiscal/cancel POST')
  }
}

export async function pending(req: Request, res: Response): Promise<void> {
  const raw = Number(req.query.limit ?? 50)
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 200) : 50
  try {
    res.json({ ok: true, data: await fiscal.pendingInvoices(req.institution!, limit) })
  } catch (err) {
    handleError(res, err, 'billing/fiscal/pending GET')
  }
}
