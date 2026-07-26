import { Request, Response } from 'express'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { isValidCpf, isValidCnpj } from '@shared/validation'
import { entityTaxBody } from '@shared/entity-tax/entity-tax.dto'
import { findEntityByDocument, fetchEntityTax, saveEntityTax } from './entities.service'

/** GET /api/entities/by-document?personType=F|J&doc=<somente dígitos> */
export async function byDocument(req: Request, res: Response): Promise<void> {
  const personType = String(req.query.personType ?? '')
  const doc        = String(req.query.doc ?? '')

  if (personType !== 'F' && personType !== 'J') {
    res.status(400).json({ error: "personType deve ser 'F' ou 'J' (sem documento não tem busca)" })
    return
  }
  if (personType === 'F' && !isValidCpf(doc)) {
    res.status(400).json({ error: 'CPF inválido',
      fields: [{ field: 'cpf', message: 'CPF inválido (dígito verificador não confere)' }] })
    return
  }
  if (personType === 'J' && !isValidCnpj(doc)) {
    res.status(400).json({ error: 'CNPJ inválido',
      fields: [{ field: 'cnpj', message: 'CNPJ inválido (dígito verificador não confere)' }] })
    return
  }

  try {
    const { schemaName, institutionId } = req.institution!
    const data = await findEntityByDocument(personType, doc, schemaName, institutionId)
    res.json({ ok: true, data })
  } catch (err) {
    handleError(res, err, 'entities/by-document GET')
  }
}

/** GET /api/entities/:id/tax — tributação da relação entity × institution. */
export async function getTax(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    const { schemaName, institutionId } = req.institution!
    res.json({ ok: true, data: await fetchEntityTax(id, schemaName, institutionId) })
  } catch (err) {
    handleError(res, err, 'entities/:id/tax GET')
  }
}

/** PUT /api/entities/:id/tax — upsert avulso da tributação. */
export async function putTax(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(entityTaxBody, req, res)
  if (body === null) return
  try {
    const { schemaName, institutionId } = req.institution!
    await saveEntityTax(id, body, schemaName, institutionId)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'entities/:id/tax PUT')
  }
}
