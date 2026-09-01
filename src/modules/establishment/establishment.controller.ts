import { Request, Response } from 'express'
import { handleError, parseBody } from '@shared/http/controller-utils'
import { establishmentUpdateDto } from './establishment.dto'
import { fetchEstablishment, editEstablishment } from './establishment.service'

/**
 * Controller do módulo establishment — NUNCA lê req.params.id: o
 * institutionId vem SEMPRE de req.institution (JWT validado pelo
 * adminGuard, montado no gateway). Elimina IDOR por construção — não há
 * nenhum caminho de código que aceite um id vindo da URL/body.
 */

export async function get(req: Request, res: Response): Promise<void> {
  try {
    const { institutionId, schemaName } = req.institution!
    res.json({ ok: true, data: await fetchEstablishment(institutionId, schemaName) })
  } catch (err) {
    handleError(res, err, 'establishment GET')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const body = parseBody(establishmentUpdateDto, req, res)
  if (body === null) return
  try {
    const { institutionId, schemaName } = req.institution!
    const data = await editEstablishment(
      institutionId, schemaName, body, req.institution?.userId ?? null)
    res.json({ ok: true, data })
  } catch (err) {
    handleError(res, err, 'establishment PUT')
  }
}
