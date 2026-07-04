import { getFlagsForTenant, FeatureFlag } from './flag.repository'

interface CacheEntry {
  flags:     FeatureFlag[]
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
const TTL   = Number(process.env.FLAG_CACHE_TTL_MS ?? 60_000)

export async function isModuleEnabled(tenantId: string, moduleKey: string): Promise<boolean> {
  // Setes admin tem acesso a tudo
  if (tenantId === 'setes') return true

  const now    = Date.now()
  const cached = cache.get(tenantId)

  if (cached && cached.expiresAt > now) {
    return cached.flags.some(f => f.moduleKey === moduleKey && f.enabled)
  }

  const flags = await getFlagsForTenant(tenantId)
  cache.set(tenantId, { flags, expiresAt: now + TTL })
  return flags.some(f => f.moduleKey === moduleKey && f.enabled)
}

export function invalidateCache(tenantId: string) {
  cache.delete(tenantId)
}
