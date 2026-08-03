import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import { interfaceDto, interfaceConfigDto } from './interfaces.dto'
import {
  fetchInterfaces, fetchInterface, createInterface, editInterface, removeInterface,
  fetchInterfaceConfigs, saveInterfaceConfig, removeInterfaceConfig,
} from './interfaces.service'

const CONFIG_NAME_RE = /^[a-z][a-z0-9_]{0,49}$/

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'interfaces')
    res.json(pagedEnvelope(query, await fetchInterfaces(query)))
  } catch (err) {
    handleError(res, err, 'interfaces GET')
  }
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchInterface(id) })
  } catch (err) {
    handleError(res, err, 'interfaces/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(interfaceDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'interfaces', body)
    const { privilegeIds, ...input } = body
    const result = await createInterface(input, privilegeIds ?? [])
    logger.info('Interface criada', result)
    res.status(201).json({ ok: true, data: result })
  } catch (err) {
    handleError(res, err, 'interfaces POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(interfaceDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'interfaces', body)
    const { privilegeIds, ...input } = body
    await editInterface(id, input, privilegeIds ?? [])
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'interfaces/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await removeInterface(id)
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'interfaces/:id DELETE')
  }
}

// --- Catálogo de configurações (seção "Configurações" — decisão 7) ---

export async function listConfigs(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await fetchInterfaceConfigs(id) })
  } catch (err) {
    handleError(res, err, 'interfaces/:id/configs GET')
  }
}

export async function putConfig(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const name = String(req.params.name ?? '')
  if (!CONFIG_NAME_RE.test(name)) {
    res.status(400).json({ error: 'name inválido (snake_case minúsculo, até 50 chars)' })
    return
  }
  const body = parseBody(interfaceConfigDto, req, res)
  if (body === null) return
  try {
    await saveInterfaceConfig(id, name, body)
    logger.info('Configuração do catálogo salva', { interfaceId: id, name })
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'interfaces/:id/configs/:name PUT')
  }
}

export async function deleteConfig(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const name = String(req.params.name ?? '')
  if (!CONFIG_NAME_RE.test(name)) {
    res.status(400).json({ error: 'name inválido' })
    return
  }
  try {
    await removeInterfaceConfig(id, name)
    logger.info('Configuração do catálogo removida', { interfaceId: id, name })
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'interfaces/:id/configs/:name DELETE')
  }
}
