import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId, parseOptionalQueryId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { isSuper } from '@shared/auth/roles'
import { UserScope } from './users.interface'
import {
  userCreateDto, userUpdateDto, userInstitutionsDto, userPrivilegesDto,
} from './users.dto'
import {
  fetchUsers, fetchUser, createUser, editUser, removeUser,
  fetchInstitutionLinks, saveInstitutionLinks,
  fetchUserPrivileges, saveUserPrivileges,
  userSearchCriteriaFor, fetchUserSearchCriteria, fetchInstitutionLookup,
} from './users.service'

/** Escopo derivado do JWT: super opera qualquer institution; admin, a sua. */
function scopeOf(req: Request): UserScope {
  return {
    isSuper:       isSuper(req.institution),
    institutionId: req.institution!.institutionId,
    schemaName:    req.institution!.schemaName,
  }
}

/** Foco (super): `institutionId` da query — ausente = sem foco; inválido = 400 (antes virava
 *  NaN no SQL → 500; achado do gate adversarial de 2026-10-03). */
function focusOf(req: Request): number | null {
  return parseOptionalQueryId(req, 'institutionId')
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const institutionId = focusOf(req)
    // catálogo servido = catálogo aceito (chave fora do escopo = 400 "não existe nesta tela")
    const query = await parseListQuery(req, 'users', userSearchCriteriaFor(scopeOf(req), institutionId))
    res.json(pagedEnvelope(query, await fetchUsers(scopeOf(req), query, institutionId)))
  } catch (err) {
    handleError(res, err, 'users GET')
  }
}

/** GET /search-criteria — lista branca da pesquisa avançada (D-BA2); mesmo institutionId da lista. */
export async function searchCriteria(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await fetchUserSearchCriteria(scopeOf(req), focusOf(req)) })
  } catch (err) {
    handleError(res, err, 'users/search-criteria GET')
  }
}

/** GET /institution-lookup — lista de apoio do critério "instituição" (só Super). */
export async function institutionLookup(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '').trim()
    res.json({ ok: true, data: await fetchInstitutionLookup(scopeOf(req), filter) })
  } catch (err) {
    handleError(res, err, 'users/institution-lookup GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchUser(scopeOf(req), id) })
  } catch (err) {
    handleError(res, err, 'users/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(userCreateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'users', body)
    const result = await createUser(scopeOf(req), body)
    logger.info('Usuário criado', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'users POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(userUpdateDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'users', body)
    await editUser(scopeOf(req), id, body)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'users/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeUser(scopeOf(req), id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'users/:id DELETE')
  }
}

export async function getPrivileges(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const institutionId =
    req.query.institutionId ? Number(req.query.institutionId) : null
  try {
    res.json({
      ok: true,
      data: await fetchUserPrivileges(scopeOf(req), id, institutionId),
    })
  } catch (err) {
    handleError(res, err, 'users/:id/privileges GET')
  }
}

export async function putPrivileges(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const interfaceId = Number(req.params.interfaceId)
  if (!Number.isInteger(interfaceId) || interfaceId <= 0) {
    res.status(400).json({ error: 'interfaceId inválido' })
    return
  }
  const body = parseBody(userPrivilegesDto, req, res)
  if (body === null) return
  try {
    await saveUserPrivileges(
      scopeOf(req), id, interfaceId, body.privilegeIds, body.institutionId ?? null)
    // trilha (gate socrático da D-PV11): quem concedeu o quê a quem — inclusive a liberação da tela delegável
    logger.info('Privilégios do usuário atualizados', {
      userId: id, interfaceId, privilegeIds: body.privilegeIds,
      byInstitutionId: req.institution!.institutionId, byUserId: req.institution!.userId, byRole: req.institution!.role,
    })
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'users/:id/privileges/:interfaceId PUT')
  }
}

export async function listInstitutions(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchInstitutionLinks(scopeOf(req), id) })
  } catch (err) {
    handleError(res, err, 'users/:id/institutions GET')
  }
}

export async function putInstitutions(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(userInstitutionsDto, req, res)
  if (body === null) return
  try {
    await saveInstitutionLinks(scopeOf(req), id, body.links)
    logger.info('Vínculos do usuário atualizados', { userId: id, total: body.links.length })
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'users/:id/institutions PUT')
  }
}
