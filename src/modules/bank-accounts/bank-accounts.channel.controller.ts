import { Request, Response } from 'express'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { bankChannelDto, bankChannelSecretsDto, bankChannelWebhookDto } from './bank-accounts.channel.dto'
import {
  ChannelScope, fetchChannel, saveChannel, removeChannel, rotateChannelToken,
  saveChannelSecrets, clearChannelSecrets, testChannel,
  fetchBankWebhook, saveBankWebhook, removeBankWebhook,
} from './bank-accounts.channel.service'

function scopeOf(req: Request): ChannelScope {
  const { schemaName, institutionId } = req.institution!
  return { schemaName, institutionId }
}

export async function getChannel(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res); if (id === null) return
  try { res.json({ ok: true, data: await fetchChannel(id, scopeOf(req)) }) }
  catch (err) { handleError(res, err, 'bank-accounts/:id/channel GET') }
}

export async function putChannel(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res); if (id === null) return
  const body = parseBody(bankChannelDto, req, res); if (body === null) return
  try { res.json({ ok: true, data: await saveChannel(id, body, scopeOf(req)) }) }
  catch (err) { handleError(res, err, 'bank-accounts/:id/channel PUT') }
}

export async function deleteChannel(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res); if (id === null) return
  try { await removeChannel(id, scopeOf(req)); res.json({ ok: true }) }
  catch (err) { handleError(res, err, 'bank-accounts/:id/channel DELETE') }
}

export async function rotateToken(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res); if (id === null) return
  try { res.json({ ok: true, data: await rotateChannelToken(id, scopeOf(req)) }) }
  catch (err) { handleError(res, err, 'bank-accounts/:id/channel/rotate-token POST') }
}

export async function putSecrets(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res); if (id === null) return
  const body = parseBody(bankChannelSecretsDto, req, res); if (body === null) return
  try { res.json({ ok: true, data: await saveChannelSecrets(id, body, scopeOf(req)) }) }
  catch (err) { handleError(res, err, 'bank-accounts/:id/channel/secrets PUT') }
}

export async function deleteSecrets(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res); if (id === null) return
  try { res.json({ ok: true, data: await clearChannelSecrets(id, scopeOf(req)) }) }
  catch (err) { handleError(res, err, 'bank-accounts/:id/channel/secrets DELETE') }
}

export async function test(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res); if (id === null) return
  try { res.json({ ok: true, data: await testChannel(id, scopeOf(req)) }) }
  catch (err) { handleError(res, err, 'bank-accounts/:id/channel/test POST') }
}

export async function getWebhook(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res); if (id === null) return
  try { res.json({ ok: true, data: await fetchBankWebhook(id, scopeOf(req)) }) }
  catch (err) { handleError(res, err, 'bank-accounts/:id/channel/webhook GET') }
}

export async function putWebhook(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res); if (id === null) return
  const body = parseBody(bankChannelWebhookDto, req, res); if (body === null) return
  try { res.json({ ok: true, data: await saveBankWebhook(id, body.url, scopeOf(req)) }) }
  catch (err) { handleError(res, err, 'bank-accounts/:id/channel/webhook PUT') }
}

export async function deleteWebhook(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res); if (id === null) return
  try { await removeBankWebhook(id, scopeOf(req)); res.json({ ok: true }) }
  catch (err) { handleError(res, err, 'bank-accounts/:id/channel/webhook DELETE') }
}
