import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { assertClientRequired } from '@shared/field-config'
import { categoryCreateDto, categoryUpdateDto } from './categories.dto'
import {
  CategoryScope, fetchCategories, fetchCategory,
  createCategory, editCategory, removeCategory,
} from './categories.service'

/** Escopo SEMPRE do JWT (o cadastro é por institution). */
function scopeOf(req: Request): CategoryScope {
  const { schemaName, institutionId } = req.institution!
  return { schemaName, institutionId }
}

export async function list(req: Request, res: Response): Promise<void> {
  const kindParam = String(req.query.kind ?? '')
  if (kindParam && kindParam !== 'P' && kindParam !== 'S') {
    res.status(400).json({ error: "kind deve ser 'P' ou 'S'" })
    return
  }
  try {
    const filter = String(req.query.filter ?? '')
    res.json({
      ok: true,
      data: await fetchCategories(filter, kindParam || null, scopeOf(req)),
    })
  } catch (err) {
    handleError(res, err, 'categories GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchCategory(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'categories/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(categoryCreateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'categories', body)
    const result = await createCategory(body, scopeOf(req))
    logger.info('Categoria criada', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'categories POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(categoryUpdateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'categories', body)
    await editCategory(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'categories/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeCategory(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'categories/:id DELETE')
  }
}
