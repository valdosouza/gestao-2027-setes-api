import { Request, Response, NextFunction } from 'express'
import pool   from '@shared/db/connection'
import logger from '@shared/logger/logger'

export interface SyncClient {
  establishmentCode: string
  institutionId:     number
  schemaName:        string
}

declare global {
  namespace Express {
    interface Request {
      syncClient?: SyncClient
    }
  }
}

// Cache simples em memoria com TTL de 5 minutos
const keyCache = new Map<string, { client: SyncClient; expiresAt: number }>()
const TTL = 5 * 60 * 1000

async function resolveApiKey(apiKey: string): Promise<SyncClient | null> {
  const now    = Date.now()
  const cached = keyCache.get(apiKey)
  if (cached && cached.expiresAt > now) return cached.client

  // Fase 2: tb_sync_api_key indexada por tb_institution_id;
  // schema_name vem de tb_institution (fonte única)
  const [rows] = await pool.query<any[]>(
    `SELECT k.establishment_code, k.tb_institution_id, i.schema_name
     FROM setes_central.tb_sync_api_key k
       INNER JOIN setes_central.tb_institution i ON (i.id = k.tb_institution_id)
     WHERE k.api_key = ? AND k.active = 'S' AND k.deleted = 'N'
       AND i.active = 'S' AND i.deleted = 'N'`,
    [apiKey]
  )

  if (!rows.length) return null

  const client: SyncClient = {
    establishmentCode: rows[0].establishment_code,
    institutionId:     Number(rows[0].tb_institution_id),
    schemaName:        rows[0].schema_name,
  }

  keyCache.set(apiKey, { client, expiresAt: now + TTL })
  return client
}

export function syncAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string

  if (!apiKey) {
    res.status(401).json({ error: 'X-Api-Key header obrigatorio' })
    return
  }

  resolveApiKey(apiKey)
    .then(client => {
      if (!client) {
        logger.warn('API Key invalida ou inativa', { apiKey: apiKey.slice(0, 8) + '...' })
        res.status(401).json({ error: 'API Key invalida' })
        return
      }
      req.syncClient = client
      next()
    })
    .catch(() => res.status(500).json({ error: 'Erro ao validar API Key' }))
}
