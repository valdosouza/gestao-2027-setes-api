import { InstitutionPayload } from '@shared/types/express'
import { existsSalesman } from './session-context.repository'
import { SessionContext } from './session-context.types'

/**
 * Resolução do SessionContext com cache TTL (molde field-config/flag.service
 * — decisão 17): o fato é recalculado no máximo a cada TTL, sem defasar o
 * token de 24h nem obrigar relogin quando o papel muda.
 */

const TTL_MS = Number(process.env.SESSION_CONTEXT_CACHE_TTL_MS ?? 60_000)

interface CacheEntry { expires: number; data: SessionContext }
const cache = new Map<string, CacheEntry>()

function cacheKey(institutionId: number, userId: number): string {
  return `${institutionId}:${userId}`
}

export async function getSessionContext(
  payload: InstitutionPayload
): Promise<SessionContext> {
  const key = cacheKey(payload.institutionId, payload.userId)
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.data

  const isSalesman = await existsSalesman(
    payload.schemaName, payload.institutionId, payload.userId
  )
  const data: SessionContext = { isSalesman }
  cache.set(key, { expires: Date.now() + TTL_MS, data })
  return data
}

export function invalidateSessionContext(institutionId: number, userId: number): void {
  cache.delete(cacheKey(institutionId, userId))
}
