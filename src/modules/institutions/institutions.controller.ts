import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseId } from '@shared/http/controller-utils'
import { institutionCreateDto, institutionUpdateDto } from './institutions.dto'
import {
  fetchInstitutions, fetchInstitution, createInstitution,
  editInstitution, removeInstitution,
} from './institutions.service'

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchInstitutions(filter) })
  } catch (err) {
    handleError(res, err, 'institutions GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchInstitution(id) })
  } catch (err) {
    handleError(res, err, 'institutions/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const parsed = institutionCreateDto.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    const { schemaName, ...input } = parsed.data
    const result = await createInstitution(input, schemaName)
    logger.info('Estabelecimento criado e provisionado', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'institutions POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const parsed = institutionUpdateDto.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten().fieldErrors })
    return
  }
  try {
    await editInstitution(id, parsed.data)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'institutions/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeInstitution(id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'institutions/:id DELETE')
  }
}
