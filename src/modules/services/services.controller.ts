import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { serviceDto, SERVICE_FIELD_PATHS } from './services.dto'
import {
  ServiceScope, fetchServices, fetchService, createService, editService,
  removeService, fetchCategoriesLookup, fetchFinancialPlansLookup,
  fetchPriceListsLookup, fetchServiceTaxRulesLookup,
  SERVICE_SEARCH_CRITERIA, fetchServiceSearchCriteria,
  fetchNbsLookup, fetchIbscbsClassificationsLookup, fetchIbscbsPlaceIndicatorsLookup,
} from './services.service'

/** Escopo SEMPRE do JWT (cadastro por institution). */
function scopeOf(req: Request): ServiceScope {
  const { schemaName, institutionId, userId } = req.institution!
  return { schemaName, institutionId, userId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'services', SERVICE_SEARCH_CRITERIA)
    res.json(pagedEnvelope(query, await fetchServices(query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'services GET')
  }
}

/** GET /search-criteria — lista branca da pesquisa avançada (D-BA2). */
export async function searchCriteria(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchServiceSearchCriteria() })
  } catch (err) {
    handleError(res, err, 'services/search-criteria GET')
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchService(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'services/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(serviceDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'services', body, SERVICE_FIELD_PATHS)
    const id = await createService(body, scopeOf(req))
    logger.info('Serviço criado', {
      institutionId: req.institution!.institutionId, id,
    })
    res.status(201).json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'services POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(serviceDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'services', body, SERVICE_FIELD_PATHS)
    await editService(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'services/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeService(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'services/:id DELETE')
  }
}

export async function categoriesLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchCategoriesLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'services/categories GET')
  }
}

export async function taxRulesLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchServiceTaxRulesLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'services/tax-rules GET')
  }
}

export async function priceListsLookup(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchPriceListsLookup(scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'services/price-lists GET')
  }
}

export async function financialPlansLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchFinancialPlansLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'services/financial-plans GET')
  }
}

/** GET /nbs — NBS do catálogo oficial (fase IBS/CBS, D-IB6). */
export async function nbsLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchNbsLookup(filter) })
  } catch (err) {
    handleError(res, err, 'services/nbs GET')
  }
}

/** GET /ibscbs-classifications — cClassTrib vigentes hoje e aceitos na NFS-e. */
export async function ibscbsClassificationsLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchIbscbsClassificationsLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'services/ibscbs-classifications GET')
  }
}

/** GET /ibscbs-place-indicators — cIndOp aceitos na NFS-e (Anexo VII). */
export async function ibscbsPlaceIndicatorsLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchIbscbsPlaceIndicatorsLookup(filter) })
  } catch (err) {
    handleError(res, err, 'services/ibscbs-place-indicators GET')
  }
}
