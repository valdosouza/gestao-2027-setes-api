import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { configValueDto } from './interface-configs.dto'
import {
  fetchVitrine, fetchResolvedConfigs, fetchResolvedConfigsByKey, saveConfigValue,
} from './interface-configs.service'

const CONFIG_NAME_RE = /^[a-z][a-z0-9_]{0,49}$/
const MODULE_KEY_RE  = /^[a-z][a-z0-9_-]{0,99}$/

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const filter = String(req.query.filter ?? '')
    res.json({ ok: true, data: await fetchVitrine(req.institution!, filter) })
  } catch (err) {
    handleError(res, err, 'interface-configs GET')
  }
}

export async function getConfigs(req: Request, res: Response): Promise<void> {
  const interfaceId = parseId(req, res)
  if (interfaceId === null) return
  try {
    res.json({ ok: true, data: await fetchResolvedConfigs(req.institution!, interfaceId) })
  } catch (err) {
    handleError(res, err, 'interface-configs/:id GET')
  }
}

export async function getConfigsByKey(req: Request, res: Response): Promise<void> {
  const moduleKey = String(req.params.moduleKey ?? '')
  if (!MODULE_KEY_RE.test(moduleKey)) {
    res.status(400).json({ error: 'moduleKey inválido' })
    return
  }
  try {
    res.json({ ok: true, data: await fetchResolvedConfigsByKey(req.institution!, moduleKey) })
  } catch (err) {
    handleError(res, err, 'interface-configs/key/:moduleKey GET')
  }
}

export async function putValue(req: Request, res: Response): Promise<void> {
  const interfaceId = parseId(req, res)
  if (interfaceId === null) return
  const name = String(req.params.name ?? '')
  if (!CONFIG_NAME_RE.test(name)) {
    res.status(400).json({ error: 'name inválido' })
    return
  }
  const body = parseBody(configValueDto, req, res)
  if (body === null) return
  try {
    await saveConfigValue(req.institution!, interfaceId, name, body)
    logger.info('Valor de configuração salvo', {
      institutionId: req.institution!.institutionId,
      interfaceId, name, target: body.target,
    })
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'interface-configs/:id/:name PUT')
  }
}
