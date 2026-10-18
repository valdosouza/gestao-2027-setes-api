import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { isSuper } from '@shared/auth/roles'
import { institutionInterfacesDto } from './institution-interfaces.dto'
import { InstitutionInterfacesScope } from './institution-interfaces.interface'
import { fetchClients, fetchGrants, saveClientGrants } from './institution-interfaces.service'

function scopeOf(req: Request): InstitutionInterfacesScope {
  return { isSuper: isSuper(req.institution), userId: req.institution!.userId }
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
    res.json({ ok: true, data: await fetchGrants(id) })
  } catch (err) {
    handleError(res, err, 'institution-interfaces/:id GET')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(institutionInterfacesDto, req, res)
  if (body === null) return
  try {
    const change = await saveClientGrants(id, body.interfaceIds, scopeOf(req))
    // trilha: quem mudou o quê no vínculo de qual estabelecimento (a tela é delegável — D-PV11)
    logger.info('Interfaces do estabelecimento atualizadas', {
      door: 'institution-interfaces', targetInstitutionId: id, added: change.added, removed: change.removed,
      byInstitutionId: req.institution!.institutionId, byUserId: req.institution!.userId, byRole: req.institution!.role,
    })
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'institution-interfaces/:id PUT')
  }
}
