import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { settleBatchDto, reversalDto } from './settlements.dto'
import {
  SettlementScope, fetchBills, settle, fetchSettled, reverse,
  fetchStatements,
} from './settlements.service'

/** Escopo SEMPRE do JWT (usuário assina o movimento). */
function scopeOf(req: Request): SettlementScope {
  const { schemaName, institutionId, userId } = req.institution!
  return { schemaName, institutionId, userId }
}

export async function bills(req: Request, res: Response): Promise<void> {
  try {
    const statusRaw = String(req.query.status ?? '')
    const status = statusRaw === 'open' || statusRaw === 'settled' ? statusRaw : ''
    const kind   = String(req.query.kind ?? '')
    const query  = await parseListQuery(req, 'settlements')
    res.json(pagedEnvelope(query, await fetchBills(status, kind, query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'settlements/bills GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(settleBatchDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'settlements', body)
    const result = await settle(body, scopeOf(req))
    logger.info('Baixa registrada', {
      institutionId: req.institution!.institutionId, ...result,
    })
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'settlements POST')
  }
}

export async function settled(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'settlements')
    res.json(pagedEnvelope(query, await fetchSettled(query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'settlements/settled GET')
  }
}

export async function reversal(req: Request, res: Response): Promise<void> {
  const body = parseBody(reversalDto, req, res)
  if (body === null) return
  try {
    const result = await reverse(body, scopeOf(req))
    logger.info('Baixa estornada', {
      institutionId: req.institution!.institutionId,
      orderId: body.orderId, parcel: body.parcel, event: body.event,
      ...result,
    })
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'settlements/reversal POST')
  }
}

export async function statements(req: Request, res: Response): Promise<void> {
  try {
    const accRaw = req.query.bankAccountId
    const bankAccountId = accRaw != null && String(accRaw) !== ''
      ? Number(accRaw) : null
    if (bankAccountId != null && !Number.isInteger(bankAccountId)) {
      res.status(400).json({ ok: false, error: 'bankAccountId inválido' })
      return
    }
    const dtFrom = String(req.query.dtFrom ?? '') || null
    const dtTo   = String(req.query.dtTo ?? '') || null
    res.json({
      ok: true,
      data: await fetchStatements(bankAccountId, dtFrom, dtTo, scopeOf(req)),
    })
  } catch (err) {
    handleError(res, err, 'settlements/statements GET')
  }
}
