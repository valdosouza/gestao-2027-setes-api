import { Request, Response } from 'express'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { stateMvaNcmBodyDto, stateFcpNcmBodyDto } from './state-tax-rates.dto'
import {
  fetchMvaList, fetchMva, createMva, editMva, removeMva,
  fetchFcpList, fetchFcp, createFcp, editFcp, removeFcp,
} from './state-tax-rates.service'

/** Controller: HTTP ↔ service (envelope { ok, data }; listas paginadas). */

export async function listMvaHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'state-tax-rates')
    res.json(pagedEnvelope(query, await fetchMvaList(
      req.institution!.schemaName, req.institution!.institutionId, query)))
  } catch (err) {
    handleError(res, err, 'state-tax-rates/mva GET')
  }
}

export async function getMvaHandler(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchMva(
      req.institution!.schemaName, req.institution!.institutionId, id) })
  } catch (err) {
    handleError(res, err, 'state-tax-rates/mva/:id GET')
  }
}

export async function createMvaHandler(req: Request, res: Response): Promise<void> {
  const body = parseBody(stateMvaNcmBodyDto, req, res)
  if (body === null) return
  try {
    const result = await createMva(
      req.institution!.schemaName, req.institution!.institutionId, body)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'state-tax-rates/mva POST')
  }
}

export async function updateMvaHandler(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(stateMvaNcmBodyDto, req, res)
  if (body === null) return
  try {
    await editMva(req.institution!.schemaName, req.institution!.institutionId, id, body)
    res.json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'state-tax-rates/mva PUT')
  }
}

export async function removeMvaHandler(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeMva(req.institution!.schemaName, req.institution!.institutionId, id)
    res.json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'state-tax-rates/mva DELETE')
  }
}

export async function listFcpHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'state-tax-rates')
    res.json(pagedEnvelope(query, await fetchFcpList(
      req.institution!.schemaName, req.institution!.institutionId, query)))
  } catch (err) {
    handleError(res, err, 'state-tax-rates/fcp GET')
  }
}

export async function getFcpHandler(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchFcp(
      req.institution!.schemaName, req.institution!.institutionId, id) })
  } catch (err) {
    handleError(res, err, 'state-tax-rates/fcp/:id GET')
  }
}

export async function createFcpHandler(req: Request, res: Response): Promise<void> {
  const body = parseBody(stateFcpNcmBodyDto, req, res)
  if (body === null) return
  try {
    const result = await createFcp(
      req.institution!.schemaName, req.institution!.institutionId, body)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'state-tax-rates/fcp POST')
  }
}

export async function updateFcpHandler(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(stateFcpNcmBodyDto, req, res)
  if (body === null) return
  try {
    await editFcp(req.institution!.schemaName, req.institution!.institutionId, id, body)
    res.json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'state-tax-rates/fcp PUT')
  }
}

export async function removeFcpHandler(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeFcp(req.institution!.schemaName, req.institution!.institutionId, id)
    res.json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'state-tax-rates/fcp DELETE')
  }
}
