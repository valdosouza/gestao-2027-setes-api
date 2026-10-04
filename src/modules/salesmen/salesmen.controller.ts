import { Request, Response } from 'express'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { salesmanCreateDto, salesmanUpdateDto } from './salesmen.dto'
import {
  SalesmanScope, fetchSalesmen, fetchSalesman, fetchCollaboratorLookup,
  createSalesman, editSalesman, removeSalesman,
  SALESMAN_SEARCH_CRITERIA, fetchSalesmanSearchCriteria,
} from './salesmen.service'

/** Escopo SEMPRE do JWT (o papel é por institution). */
function scopeOf(req: Request): SalesmanScope {
  const { schemaName, institutionId, userId } = req.institution!
  return { schemaName, institutionId, userId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'salesmen', SALESMAN_SEARCH_CRITERIA)
    res.json(pagedEnvelope(query, await fetchSalesmen(query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'salesmen GET')
  }
}

/** GET /search-criteria — lista branca da pesquisa avançada (D-BA2). */
export async function searchCriteria(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchSalesmanSearchCriteria() })
  } catch (err) {
    handleError(res, err, 'salesmen/search-criteria GET')
  }
}

export async function collaboratorLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '').trim()
    res.json({ ok: true, data: await fetchCollaboratorLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'salesmen/collaborator-lookup GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchSalesman(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'salesmen/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(salesmanCreateDto, req, res)
  if (body === null) return
  try {
    const { id, ...roleFields } = body
    const result = await createSalesman(id, roleFields, scopeOf(req))
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'salesmen POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(salesmanUpdateDto, req, res)
  if (body === null) return
  try {
    await editSalesman(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'salesmen/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeSalesman(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'salesmen/:id DELETE')
  }
}
