import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { openOrderDto, orderItemDto, negotiationDto } from './orders.dto'
import {
  OrdersScope, fetchOrders, fetchOrder, createOrder, createItem,
  editItem, deleteItem, removeOrder, fetchProductsLookup,
  fetchNegotiation, updateNegotiation, fetchPaymentTypesLookup, fetchBanksLookup,
} from './orders.service'

function scopeOf(req: Request): OrdersScope {
  const { schemaName, institutionId, userId } = req.institution!
  return { schemaName, institutionId, userId }
}

function parseItemId(req: Request, res: Response): number | null {
  const id = Number(req.params.itemId)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ ok: false, error: 'itemId inválido' })
    return null
  }
  return id
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const status = String(req.query.status ?? '')
    const parsed = status === 'A' || status === 'F' ? status : ''
    const query = await parseListQuery(req, 'orders')
    res.json(pagedEnvelope(query, await fetchOrders(parsed, query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'orders GET')
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchOrder(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'orders/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(openOrderDto, req, res)
  if (body === null) return
  try {
    const id = await createOrder(body, scopeOf(req))
    logger.info('Pedido aberto', { institutionId: req.institution!.institutionId, id })
    res.status(201).json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'orders POST')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeOrder(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'orders/:id DELETE')
  }
}

export async function addOrderItem(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(orderItemDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'orders', body)
    const itemId = await createItem(id, body, scopeOf(req))
    res.status(201).json({ ok: true, data: { id: itemId } })
  } catch (err) {
    handleError(res, err, 'orders/:id/items POST')
  }
}

export async function updateOrderItem(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const itemId = parseItemId(req, res)
  if (itemId === null) return
  const body = parseBody(orderItemDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'orders', body)
    await editItem(id, itemId, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'orders/:id/items/:itemId PUT')
  }
}

export async function removeOrderItem(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const itemId = parseItemId(req, res)
  if (itemId === null) return
  try {
    await deleteItem(id, itemId, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'orders/:id/items/:itemId DELETE')
  }
}

export async function merchandiseLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchProductsLookup('merchandise', filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'orders/merchandise-lookup GET')
  }
}

export async function serviceLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchProductsLookup('service', filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'orders/service-lookup GET')
  }
}

/** GET /:id/negotiation — cabeçalho (via simples), grade elaborada, preview e base do pedido. */
export async function getNegotiation(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchNegotiation(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'orders/:id/negotiation GET')
  }
}

/** PUT /:id/negotiation — grava (transação única) e devolve a negociação recomposta. */
export async function putNegotiation(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(negotiationDto, req, res)
  if (body === null) return
  try {
    const data = await updateNegotiation(id, body, scopeOf(req))
    logger.info('Negociação gravada', {
      institutionId: req.institution!.institutionId, orderId: id, mode: data.mode,
    })
    res.json({ ok: true, data })
  } catch (err) {
    handleError(res, err, 'orders/:id/negotiation PUT')
  }
}

/** GET /payment-types-lookup — formas vinculadas/habilitadas ({ id, description, kind, maxParcels }). */
export async function paymentTypesLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchPaymentTypesLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'orders/payment-types-lookup GET')
  }
}

/** GET /banks-lookup — bancos do catálogo ({ id, number, description }) para os cheques do faturamento. */
export async function banksLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchBanksLookup(filter) })
  } catch (err) {
    handleError(res, err, 'orders/banks-lookup GET')
  }
}
