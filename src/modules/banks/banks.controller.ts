import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { bankCreateDto, bankUpdateDto } from './banks.dto'
import {
  fetchBanks, fetchBank, createBank, editBank, removeBank,
} from './banks.service'

/**
 * Controller: traduz HTTP ↔ service (valida DTO, status codes, envelope
 * { ok, data }). Regra de negócio fica no service; SQL no repository.
 */

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'banks')
    res.json(pagedEnvelope(query, await fetchBanks(query)))
  } catch (err) {
    handleError(res, err, 'banks GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchBank(id) })
  } catch (err) {
    handleError(res, err, 'banks/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(bankCreateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'banks', body)
    const result = await createBank(body.number, body.description)
    logger.info('Banco criado', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'banks POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(bankUpdateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'banks', body)
    await editBank(id, body.number, body.description)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'banks/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeBank(id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'banks/:id DELETE')
  }
}
