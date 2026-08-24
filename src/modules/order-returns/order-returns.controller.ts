import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { openReturnDto, returnItemQuantityDto } from './order-returns.dto'
import {
  OrderReturnsScope, fetchReturns, fetchReturn, createReturn,
  editItemQuantity, deleteItem, removeReturn,
} from './order-returns.service'

function scopeOf(req: Request): OrderReturnsScope {
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
    const query = await parseListQuery(req, 'order-returns')
    res.json(pagedEnvelope(query, await fetchReturns(parsed, query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'order-returns GET')
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchReturn(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'order-returns/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(openReturnDto, req, res)
  if (body === null) return
  try {
    const id = await createReturn(body.saleOrderId, scopeOf(req))
    logger.info('Devolução aberta', {
      institutionId: req.institution!.institutionId, id, saleOrderId: body.saleOrderId,
    })
    res.status(201).json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'order-returns POST')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeReturn(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'order-returns/:id DELETE')
  }
}

export async function updateItem(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const itemId = parseItemId(req, res)
  if (itemId === null) return
  const body = parseBody(returnItemQuantityDto, req, res)
  if (body === null) return
  try {
    await editItemQuantity(id, itemId, body.quantity, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'order-returns/:id/items/:itemId PUT')
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
    handleError(res, err, 'order-returns/:id/items/:itemId DELETE')
  }
}
