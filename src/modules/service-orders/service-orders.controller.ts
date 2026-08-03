import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import {
  openOrderDto, orderItemDto, monthlyRunDto, invoiceDto,
} from './service-orders.dto'
import {
  ServiceOrderScope, fetchOrders, fetchOrder, createOrder, createItem,
  editItem, deleteItem, removeOrder, runMonthly, invoiceOrder,
  expirationSuggestion, fetchProductsLookup,
} from './service-orders.service'

/** Escopo SEMPRE do JWT (institution + usuário que assina a tb_order). */
function scopeOf(req: Request): ServiceOrderScope {
  const { schemaName, institutionId, userId } = req.institution!
  return { schemaName, institutionId, userId }
}

/** :itemId validado no mesmo espírito do parseId. */
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
    const query = await parseListQuery(req, 'service-orders')
    res.json(pagedEnvelope(query, await fetchOrders(parsed, query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'service-orders GET')
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchOrder(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'service-orders/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(openOrderDto, req, res)
  if (body === null) return
  try {
    const id = await createOrder(body, scopeOf(req))
    logger.info('OS aberta', { institutionId: req.institution!.institutionId, id })
    res.status(201).json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'service-orders POST')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeOrder(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'service-orders/:id DELETE')
  }
}

export async function addOrderItem(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(orderItemDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'service-orders', body)
    const itemId = await createItem(id, body, scopeOf(req))
    res.status(201).json({ ok: true, data: { id: itemId } })
  } catch (err) {
    handleError(res, err, 'service-orders/:id/items POST')
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
    await assertClientRequired(req.institution!, 'service-orders', body)
    await editItem(id, itemId, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'service-orders/:id/items/:itemId PUT')
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
    handleError(res, err, 'service-orders/:id/items/:itemId DELETE')
  }
}

export async function monthly(req: Request, res: Response): Promise<void> {
  const body = parseBody(monthlyRunDto, req, res)
  if (body === null) return
  try {
    const report = await runMonthly(body, scopeOf(req))
    logger.info('Rotina mensal executada', {
      institutionId: req.institution!.institutionId, ...body,
      processed: report.processed, injected: report.injected,
    })
    res.json({ ok: true, data: report })
  } catch (err) {
    handleError(res, err, 'service-orders/monthly-run POST')
  }
}

export async function invoice(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(invoiceDto, req, res)
  if (body === null) return
  try {
    const result = await invoiceOrder(id, body, scopeOf(req))
    logger.info('OS faturada', {
      institutionId: req.institution!.institutionId, id, ...result,
    })
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'service-orders/:id/invoice POST')
  }
}

export async function suggestion(req: Request, res: Response): Promise<void> {
  try {
    const year  = Number(req.query.year)
    const month = Number(req.query.month)
    if (!Number.isInteger(year) || !Number.isInteger(month) ||
        month < 1 || month > 12) {
      res.status(400).json({ ok: false, error: 'Informe year e month válidos' })
      return
    }
    res.json({ ok: true, data: { dtExpiration: expirationSuggestion(year, month) } })
  } catch (err) {
    handleError(res, err, 'service-orders/expiration-suggestion GET')
  }
}

export async function productsLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchProductsLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'service-orders/products GET')
  }
}
