import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { findEntityIdByCpf, findEntityIdByCnpj } from '@shared/fiscal/fiscal.repository'
import { isValidCpf, isValidCnpj } from '@shared/validation'
import { institutionCreateDto, institutionUpdateDto } from './institutions.dto'
import {
  fetchInstitutions, fetchInstitution, createInstitution,
  editInstitution, removeInstitution,
} from './institutions.service'

/**
 * Existência antecipada de CPF/CNPJ (decisão 21 da Fase 2): o app consulta
 * ao sair do campo e avisa na hora; a garantia final continua sendo o 409
 * do salvar (cadeia compartilhada). ignoreId = entity em edição.
 */
export async function fiscalExists(req: Request, res: Response): Promise<void> {
  const cpf      = req.query.cpf ? String(req.query.cpf) : null
  const cnpj     = req.query.cnpj ? String(req.query.cnpj) : null
  const ignoreId = req.query.ignoreId ? Number(req.query.ignoreId) : null

  if ((cpf === null) === (cnpj === null)) {
    res.status(400).json({ error: 'Informe cpf OU cnpj (somente dígitos)' })
    return
  }
  if (cpf !== null && !isValidCpf(cpf)) {
    res.status(400).json({ error: 'CPF inválido',
      fields: [{ field: 'cpf', message: 'CPF inválido (dígito verificador não confere)' }] })
    return
  }
  if (cnpj !== null && !isValidCnpj(cnpj)) {
    res.status(400).json({ error: 'CNPJ inválido',
      fields: [{ field: 'cnpj', message: 'CNPJ inválido (dígito verificador não confere)' }] })
    return
  }
  try {
    const owner = cpf !== null
      ? await findEntityIdByCpf(cpf)
      : await findEntityIdByCnpj(cnpj!)
    res.json({ ok: true, data: { exists: owner !== null && owner !== ignoreId } })
  } catch (err) {
    handleError(res, err, 'institutions/fiscal-exists GET')
  }
}

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
  const body = parseBody(institutionCreateDto, req, res)
  if (body === null) return
  try {
    const { schemaName, ...input } = body
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
  const body = parseBody(institutionUpdateDto, req, res)
  if (body === null) return
  try {
    await editInstitution(id, body)
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
