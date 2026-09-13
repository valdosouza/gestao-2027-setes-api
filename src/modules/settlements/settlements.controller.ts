import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { assertDiscountPolicy } from './settlements.discount-policy'
import { settleBatchDto, reversalDto, retargetChargeDto } from './settlements.dto'
import {
  SettlementScope, fetchBills, settle, fetchSettled, reverse,
  fetchStatements,
  retargetCharge,
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
    await assertDiscountPolicy(req.institution!, body.titles)   // D-G32: teto por config × privilégio DESCONTO
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

/**
 * PUT /api/settlements/bills/:orderId/:parcel/charge — redirecionar a cobrança
 * (D17/D22). O sub-recurso é `charge` (a CONDIÇÃO de cobrança), não
 * `payment-type`: nomear pelo campo obrigaria rota nova quando o vencimento
 * entrar na tela.
 */
export async function retarget(req: Request, res: Response): Promise<void> {
  const orderId = Number(req.params.orderId)
  const parcel  = Number(req.params.parcel)
  if (!Number.isInteger(orderId) || orderId <= 0 ||
      !Number.isInteger(parcel)  || parcel  <= 0) {
    res.status(400).json({ ok: false, error: 'Título inválido (orderId/parcel)' })
    return
  }
  const body = parseBody(retargetChargeDto, req, res)
  if (body === null) return
  try {
    const data = await retargetCharge(orderId, parcel, body, scopeOf(req))
    logger.info('Cobrança redirecionada', {
      institutionId: req.institution!.institutionId,
      orderId, parcel, de: data.previousPaymentTypeId, para: data.paymentTypeId,
    })
    res.json({ ok: true, data })
  } catch (err) {
    handleError(res, err, 'settlements/bills/:orderId/:parcel/charge PUT')
  }
}
