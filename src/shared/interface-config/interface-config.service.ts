import { InstitutionPayload } from '@shared/types/express'
import { findInterfaceIdByKey } from '@shared/field-config'
import { listCatalogConfigs, listConfigValues } from './interface-config.repository'
import { ConfigOption, ResolvedConfig } from './interface-config.types'

/**
 * Configuração RESOLVIDA por interface (decisão 4: usuário → institution →
 * default do catálogo) com cache TTL em memória (molde do field-config) —
 * consultada pelo painel, pelo engine do app e pelo enforcement de regras
 * na própria API (ex.: filtro de carteira do piloto — decisão 15).
 */

const TTL_MS = Number(process.env.INTERFACE_CONFIG_CACHE_TTL_MS ?? 60_000)

interface CacheEntry { expires: number; data: ResolvedConfig[] }
const cache = new Map<string, CacheEntry>()

interface KeyCacheEntry { expires: number; id: number | null }
const interfaceKeyCache = new Map<string, KeyCacheEntry>()

function cacheKey(institutionId: number, interfaceId: number, userId: number): string {
  return `${institutionId}:${interfaceId}:${userId}`
}

/** "A=Por item;B=Por total" → [{ value, label }] (kind Options — decisão 6). */
export function parseConfigOptions(options: string | null): ConfigOption[] {
  if (!options) return []
  return options
    .split(';')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(part => {
      const eq = part.indexOf('=')
      if (eq < 0) return { value: part, label: part }
      return { value: part.slice(0, eq).trim(), label: part.slice(eq + 1).trim() }
    })
}

/**
 * Valida um content contra o kind do catálogo (decisão 6). Devolve a
 * mensagem de erro ou null quando válido — quem grava decide o HTTP status.
 */
export function validateConfigContent(
  kind: string, options: string | null, content: string
): string | null {
  switch (kind) {
    case 'Integer':
      return /^-?\d+$/.test(content) ? null : 'Valor deve ser um número inteiro'
    case 'Float':
      return /^-?\d+([.,]\d+)?$/.test(content) ? null : 'Valor deve ser numérico'
    case 'Boolean':
      return content === 'S' || content === 'N' ? null : "Valor deve ser 'S' ou 'N'"
    case 'Date': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(content)) return 'Data deve estar no formato AAAA-MM-DD'
      return Number.isNaN(Date.parse(content)) ? 'Data inválida' : null
    }
    case 'Options': {
      const valid = parseConfigOptions(options).some(o => o.value === content)
      return valid ? null : 'Valor fora da lista de opções da configuração'
    }
    default:
      return content.length <= 100 ? null : 'Valor excede 100 caracteres'
  }
}

/** Merge valores × catálogo com a resolução da decisão 4. */
export async function getResolvedConfigs(
  schemaName: string, institutionId: number, interfaceId: number, userId: number
): Promise<ResolvedConfig[]> {
  const key = cacheKey(institutionId, interfaceId, userId)
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.data

  const [catalog, values] = await Promise.all([
    listCatalogConfigs(interfaceId),
    listConfigValues(schemaName, institutionId, interfaceId, userId),
  ])
  const institutionByName = new Map(
    values.filter(v => v.tbUserId === 0).map(v => [v.name, v.content])
  )
  const userByName = new Map(
    values.filter(v => v.tbUserId !== 0).map(v => [v.name, v.content])
  )

  const resolved: ResolvedConfig[] = catalog.map(cat => {
    const institutionContent = institutionByName.get(cat.name) ?? null
    // Override de usuário só vale quando o catálogo autoriza (scope 'U').
    const userContent = cat.scope === 'U' ? (userByName.get(cat.name) ?? null) : null
    return {
      ...cat,
      institutionContent,
      userContent,
      content: userContent ?? institutionContent ?? cat.defaultContent,
    }
  })

  cache.set(key, { expires: Date.now() + TTL_MS, data: resolved })
  return resolved
}

/**
 * Invalidação após salvar valor OU editar o catálogo — derruba as entradas
 * de TODOS os usuários da interface (a chave inclui o userId).
 */
export function invalidateInterfaceConfig(institutionId: number, interfaceId: number): void {
  const prefix = `${institutionId}:${interfaceId}:`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

/** Catálogo mudou (Super): derruba a interface em TODAS as institutions. */
export function invalidateInterfaceConfigCatalog(interfaceId: number): void {
  for (const key of cache.keys()) {
    const [, iface] = key.split(':')
    if (Number(iface) === interfaceId) cache.delete(key)
  }
}

async function findInterfaceIdByKeyCached(moduleKey: string): Promise<number | null> {
  const hit = interfaceKeyCache.get(moduleKey)
  if (hit && hit.expires > Date.now()) return hit.id
  const id = await findInterfaceIdByKey(moduleKey)
  interfaceKeyCache.set(moduleKey, { expires: Date.now() + TTL_MS, id })
  return id
}

/**
 * Config resolvida pela CHAVE do módulo (i18n_key = nome do módulo nos dois
 * lados). Módulo sem interface no catálogo devolve lista vazia.
 */
export async function getResolvedConfigsByKey(
  institution: InstitutionPayload, moduleKey: string
): Promise<ResolvedConfig[]> {
  const interfaceId = await findInterfaceIdByKeyCached(moduleKey)
  if (interfaceId === null) return []
  return getResolvedConfigs(
    institution.schemaName, institution.institutionId, interfaceId, institution.userId
  )
}

/**
 * Valor EFETIVO de UMA configuração para o request corrente — atalho do
 * enforcement na API (ex.: restrict_customer_to_salesman no módulo
 * customers). null = configuração não existe no catálogo.
 */
export async function getConfigContent(
  institution: InstitutionPayload, moduleKey: string, name: string
): Promise<string | null> {
  const configs = await getResolvedConfigsByKey(institution, moduleKey)
  return configs.find(c => c.name === name)?.content ?? null
}
