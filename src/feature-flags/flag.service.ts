import { getFlagsForInstitution, FeatureFlag } from './flag.repository'
import { SETES_INSTITUTION_ID } from '@shared/auth/roles'

interface CacheEntry {
  flags:     FeatureFlag[]
  expiresAt: number
}

const cache = new Map<number, CacheEntry>()
const TTL   = Number(process.env.FLAG_CACHE_TTL_MS ?? 60_000)

export async function isModuleEnabled(institutionId: number, moduleKey: string): Promise<boolean> {
  // A própria Setes (institution 1) tem acesso a tudo
  if (institutionId === SETES_INSTITUTION_ID) return true

  const now    = Date.now()
  const cached = cache.get(institutionId)

  if (cached && cached.expiresAt > now) {
    return cached.flags.some(f => f.moduleKey === moduleKey && f.enabled)
  }

  const flags = await getFlagsForInstitution(institutionId)
  cache.set(institutionId, { flags, expiresAt: now + TTL })
  return flags.some(f => f.moduleKey === moduleKey && f.enabled)
}

export function invalidateCache(institutionId: number) {
  cache.delete(institutionId)
}
