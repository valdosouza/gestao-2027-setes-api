import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { priceListDto } from './price-lists.dto'
import {
  PriceListScope, fetchPriceLists, fetchPriceList, createPriceList,
  editPriceList, removePriceList,
  PRICE_LIST_SEARCH_CRITERIA, fetchPriceListSearchCriteria,
} from './price-lists.service'

/** Escopo SEMPRE do JWT (cadastro por institution). */
function scopeOf(req: Request): PriceListScope {
  const { schemaName, institutionId } = req.institution!
  return { schemaName, institutionId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'price-lists', PRICE_LIST_SEARCH_CRITERIA)
    res.json(pagedEnvelope(query, await fetchPriceLists(query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'price-lists GET')
  }
}

/** GET /search-criteria — lista branca da pesquisa avançada (D-BA2). */
export async function searchCriteria(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchPriceListSearchCriteria() })
  } catch (err) {
    handleError(res, err, 'price-lists/search-criteria GET')
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchPriceList(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'price-lists/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(priceListDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'price-lists', body)
    const id = await createPriceList(body, scopeOf(req))
    logger.info('Tabela de preço criada', {
      institutionId: req.institution!.institutionId, id,
    })
    res.status(201).json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'price-lists POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(priceListDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'price-lists', body)
    await editPriceList(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'price-lists/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removePriceList(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'price-lists/:id DELETE')
  }
}
