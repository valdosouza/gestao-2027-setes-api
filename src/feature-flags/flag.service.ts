import { getFlagsForInstitution, FeatureFlag } from './flag.repository'

interface CacheEntry {
  flags:     FeatureFlag[]
  expiresAt: number
}

const cache = new Map<number, CacheEntry>()
const TTL   = Number(process.env.FLAG_CACHE_TTL_MS ?? 60_000)

export async function isModuleEnabled(institutionId: number, moduleKey: string): Promise<boolean> {
  // D-PV10 (Valdo 2026-10-18 — prompt_privilegios_interfaces.md): a Setes é um cliente como os outros — morreu o atalho
  // "a própria Setes (institution 1) tem acesso a tudo". Só o SUPER escapa das flags (featureFlagMiddleware).

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
