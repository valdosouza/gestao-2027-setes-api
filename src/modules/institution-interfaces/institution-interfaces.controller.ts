import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { isSuper } from '@shared/auth/roles'
import { institutionInterfaceLinkDto } from './institution-interfaces.dto'
import { InstitutionInterfacesScope } from './institution-interfaces.interface'
import { fetchClients, fetchGrants, saveClientGrant } from './institution-interfaces.service'

function scopeOf(req: Request): InstitutionInterfacesScope {
  return { isSuper: isSuper(req.institution), userId: req.institution!.userId }
}

/** `:interfaceId` inteiro positivo, senão 400 (mesma leitura do `parseId`). */
function parseInterfaceId(req: Request, res: Response): number | null {
  const raw = String(req.params.interfaceId ?? '')
  const id = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: 'interfaceId inválido', fields: [{ field: 'interfaceId', message: 'Informe um id (inteiro positivo)' }] })
    return null
  }
  return id
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'institution-interfaces')
    res.json(pagedEnvelope(query, await fetchClients(query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'institution-interfaces GET')
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchGrants(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'institution-interfaces/:id GET')
  }
}

/** PUT /:id/interfaces/:interfaceId — UMA marca (D-PV34). */
export async function putLink(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const interfaceId = parseInterfaceId(req, res)
  if (interfaceId === null) return
  const body = parseBody(institutionInterfaceLinkDto, req, res)
  if (body === null) return
  try {
    const change = await saveClientGrant(id, interfaceId, body.linked, scopeOf(req))
    // trilha: quem mudou o quê no vínculo de qual estabelecimento (a tela é delegável — D-PV11); marca sem mudança não é evento
    if (change.changed) {
      logger.info('Interface do estabelecimento alterada', {
        door: 'institution-interfaces', targetInstitutionId: id, interfaceId, linked: change.linked,
        byInstitutionId: req.institution!.institutionId, byUserId: req.institution!.userId, byRole: req.institution!.role,
      })
    }
    res.json({ ok: true, data: change })
  } catch (err) {
    handleError(res, err, 'institution-interfaces/:id/interfaces/:interfaceId PUT')
  }
}
