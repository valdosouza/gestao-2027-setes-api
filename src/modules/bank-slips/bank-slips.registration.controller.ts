import { Request, Response } from 'express'
import { z } from 'zod'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { BankSlipScope } from './bank-slips.service'
import {
  registerSlip, refreshSlip, refreshAll, fetchSlipPdf, paySandbox,
} from './bank-slips.registration.service'

function scopeOf(req: Request): BankSlipScope {
  const { schemaName, institutionId, userId } = req.institution!
  return { schemaName, institutionId, userId: Number(userId) }
}

export async function register(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res); if (id === null) return
  try {
    const r = await registerSlip(id, scopeOf(req))
    logger.info('Boleto registrado no banco', { institutionId: req.institution!.institutionId, ...r })
    res.status(201).json({ ok: true, data: r })
  } catch (err) { handleError(res, err, 'bank-slips/:id/register POST') }
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res); if (id === null) return
  try { res.json({ ok: true, data: await refreshSlip(id, scopeOf(req)) }) }
  catch (err) { handleError(res, err, 'bank-slips/:id/refresh POST') }
}

const refreshAllDto = z.object({
  minMinutes: z.number().int().min(0).max(1440).optional(),
  limit:      z.number().int().min(1).max(50).optional(),
}).default({})

export async function refreshOpen(req: Request, res: Response): Promise<void> {
  const body = parseBody(refreshAllDto, req, res); if (body === null) return
  try {
    const report = await refreshAll(scopeOf(req), body)
    logger.info('Consulta ativa dos boletos registrados', { institutionId: req.institution!.institutionId, ...report, errors: report.errors.length })
    res.json({ ok: true, data: report })
  } catch (err) { handleError(res, err, 'bank-slips/refresh POST') }
}

export async function pdf(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res); if (id === null) return
  try { res.json({ ok: true, data: await fetchSlipPdf(id, scopeOf(req)) }) }
  catch (err) { handleError(res, err, 'bank-slips/:id/pdf GET') }
}

const payDto = z.object({ via: z.enum(['BOLETO', 'PIX']).default('BOLETO') }).default({ via: 'BOLETO' })

export async function paySandboxHandler(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res); if (id === null) return
  const body = parseBody(payDto, req, res); if (body === null) return
  try { res.json({ ok: true, data: await paySandbox(id, body.via, scopeOf(req)) }) }
  catch (err) { handleError(res, err, 'bank-slips/:id/pay-sandbox POST') }
}
