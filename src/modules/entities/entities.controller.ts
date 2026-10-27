import { Request, Response } from 'express'
import { handleError } from '@shared/http/controller-utils'
import { isValidCpf, isValidCnpj, normalizeCpf, normalizeCnpj } from '@shared/validation'
import { findEntityByDocument } from './entities.service'

/**
 * GET /api/entities/by-document?personType=F|J&doc=<CPF/CNPJ>
 * D-CJ3 (frente do CNPJ alfanumérico): LEITURA canonicaliza a entrada pela peça (máscara sai, minúscula sobe, nada é apagado) e compara
 * por IGUALDADE da forma canônica; a ESCRITA é que exige a forma canônica.
 */
export async function byDocument(req: Request, res: Response): Promise<void> {
  const personType = String(req.query.personType ?? '')
  const raw        = String(req.query.doc ?? '')
  const doc        = (personType === 'F' ? normalizeCpf(raw) : normalizeCnpj(raw)) ?? raw

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
