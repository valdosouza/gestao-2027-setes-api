import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { openOrderDto, orderItemDto } from './orders.dto'
import {
  OrdersScope, fetchOrders, fetchOrder, createOrder, createItem,
  editItem, deleteItem, removeOrder, fetchProductsLookup,
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
