import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { contractDto } from './contracts.dto'
import {
  ContractScope, fetchContracts, fetchContract, createContract,
  editContract, removeContract, fetchProductsLookup,
} from './contracts.service'

/** Escopo SEMPRE do JWT (cadastro por institution). */
function scopeOf(req: Request): ContractScope {
  const { schemaName, institutionId } = req.institution!
  return { schemaName, institutionId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'contracts')
    res.json(pagedEnvelope(query, await fetchContracts(query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'contracts GET')
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchContract(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'contracts/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(contractDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'contracts', body)
    const id = await createContract(body, scopeOf(req))
    logger.info('Contrato criado', {
      institutionId: req.institution!.institutionId, id,
    })
    res.status(201).json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'contracts POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(contractDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'contracts', body)
    await editContract(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'contracts/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeContract(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'contracts/:id DELETE')
  }
}

export async function productsLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchProductsLookup(filter, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'contracts/products GET')
  }
}
