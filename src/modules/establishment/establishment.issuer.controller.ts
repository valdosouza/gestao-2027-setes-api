import { Request, Response } from 'express'
import { z } from 'zod'
import { handleError, parseBody } from '@shared/http/controller-utils'
import { ErrorCodes } from '@shared/errors/error-codes'
import {
  issuerDto, issuerCertificateDto, issuerModelParam,
} from './establishment.issuer.dto'
import {
  IssuerScope, fetchIssuerView, saveIssuer, removeIssuer, saveIssuerCertificate, removeIssuerCertificate,
} from './establishment.issuer.service'

/**
 * Controller do sub-recurso EMISSOR FISCAL — como o resto do módulo, NUNCA lê
 * um id de institution da URL: o escopo vem de req.institution (adminGuard no
 * gateway). Os únicos parâmetros de rota são o MODELO e o AMBIENTE.
 */

function scopeOf(req: Request): IssuerScope {
  const { schemaName, institutionId, userId } = req.institution!
  return { schemaName, institutionId, userId: userId ?? null }
}

/** Valida um parâmetro de rota com um enum Zod; responde 400 e devolve null se inválido. */
function parseParam<S extends z.ZodTypeAny>(schema: S, name: string, req: Request, res: Response): z.infer<S> | null {
  const parsed = schema.safeParse(req.params[name])
  if (!parsed.success) {
    res.status(400).json({ error: 'Validação falhou', code: ErrorCodes.VALIDATION_FAILED,
      fields: [{ field: name, message: `${name} inválido` }] })
    return null
  }
  return parsed.data
}

export async function getIssuer(req: Request, res: Response): Promise<void> {
  try { res.json({ ok: true, data: await fetchIssuerView(scopeOf(req)) }) }
  catch (err) { handleError(res, err, 'establishment/issuer GET') }
}

export async function putIssuer(req: Request, res: Response): Promise<void> {
  const model = parseParam(issuerModelParam, 'model', req, res); if (model === null) return
  const body = parseBody(issuerDto, req, res); if (body === null) return
  try { res.json({ ok: true, data: await saveIssuer(model, body, scopeOf(req)) }) }
  catch (err) { handleError(res, err, 'establishment/issuer/:model PUT') }
}

export async function deleteIssuer(req: Request, res: Response): Promise<void> {
  const model = parseParam(issuerModelParam, 'model', req, res); if (model === null) return
  try { res.json({ ok: true, data: await removeIssuer(model, scopeOf(req)) }) }
  catch (err) { handleError(res, err, 'establishment/issuer/:model DELETE') }
}

export async function putCertificate(req: Request, res: Response): Promise<void> {
  const body = parseBody(issuerCertificateDto, req, res); if (body === null) return
  try { res.json({ ok: true, data: await saveIssuerCertificate(body, scopeOf(req)) }) }
  catch (err) { handleError(res, err, 'establishment/issuer/certificate PUT') }
}

export async function deleteCertificate(req: Request, res: Response): Promise<void> {
  try { res.json({ ok: true, data: await removeIssuerCertificate(scopeOf(req)) }) }
  catch (err) { handleError(res, err, 'establishment/issuer/certificate DELETE') }
}
