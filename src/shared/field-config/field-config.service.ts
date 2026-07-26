import { InstitutionPayload } from '@shared/types/express'
import { HttpError, FieldError } from '@shared/errors/http-error'
import {
  listCatalogFields, listFieldConfig, findInterfaceIdByKey,
} from './field-config.repository'
import { ResolvedField } from './field-config.types'

/**
 * Config RESOLVIDA de campos por interface (decisão 7: custom → catálogo)
 * com cache TTL em memória (molde do flag.service) — consultada na montagem
 * de TODA tela e na validação de obrigatoriedade comercial (decisão 2).
 */

const TTL_MS = Number(process.env.FIELD_CONFIG_CACHE_TTL_MS ?? 60_000)

interface CacheEntry { expires: number; data: ResolvedField[] }
const cache = new Map<string, CacheEntry>()

interface KeyCacheEntry { expires: number; id: number | null }
const interfaceKeyCache = new Map<string, KeyCacheEntry>()

function cacheKey(institutionId: number, interfaceId: number): string {
  return `${institutionId}:${interfaceId}`
}

/** Merge catálogo × especialização (regra da decisão 2: cliente só aperta). */
export async function getResolvedFields(
  schemaName: string, institutionId: number, interfaceId: number
): Promise<ResolvedField[]> {
  const key = cacheKey(institutionId, interfaceId)
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.data

  const [catalog, config] = await Promise.all([
    listCatalogFields(interfaceId),
    listFieldConfig(schemaName, institutionId, interfaceId),
  ])
  const configByField = new Map(config.map(c => [c.fieldName, c]))

  const resolved: ResolvedField[] = catalog.map(cat => {
    const custom = configByField.get(cat.fieldName)
    return {
      fieldName:    cat.fieldName,
      tableName:    cat.tableName,
      kind:         cat.kind,
      requiredTech: cat.required,
      // técnico 'S' é inegociável; no resto vale o aperto do cliente
      required:     cat.required === 'S' ? 'S' : (custom?.required ?? 'N'),
      caption:      custom?.fieldCaption ?? null,
      mask:         custom?.mask ?? null,
      customized:   custom ? 'S' : 'N',
    }
  })

  cache.set(key, { expires: Date.now() + TTL_MS, data: resolved })
  return resolved
}

/** Invalidação após o painel salvar (mesmo processo; o TTL cobre o resto). */
export function invalidateFieldConfig(institutionId: number, interfaceId: number): void {
  cache.delete(cacheKey(institutionId, interfaceId))
}

/** snake_case da coluna → camelCase do payload (contrato JSON da casa). */
export function fieldNameToCamel(fieldName: string): string {
  return fieldName.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

async function findInterfaceIdByKeyCached(moduleKey: string): Promise<number | null> {
  const hit = interfaceKeyCache.get(moduleKey)
  if (hit && hit.expires > Date.now()) return hit.id
  const id = await findInterfaceIdByKey(moduleKey)
  interfaceKeyCache.set(moduleKey, { expires: Date.now() + TTL_MS, id })
  return id
}

/**
 * Obrigatoriedade COMERCIAL no salvar (decisões 1 e 2): valida apenas os
 * campos que o CLIENTE apertou (requiredTech='N' e required efetivo='S') —
 * o baseline técnico já é coberto pelo DTO Zod do módulo. Erro por campo
 * em camelCase (decisão 20). Módulo sem catálogo: nada a validar.
 */
export async function assertClientRequired(
  institution: InstitutionPayload,
  moduleKey: string,
  values: Record<string, unknown>
): Promise<void> {
  const interfaceId = await findInterfaceIdByKeyCached(moduleKey)
  if (interfaceId === null) return

  const fields = await getResolvedFields(
    institution.schemaName, institution.institutionId, interfaceId
  )
  const missing: FieldError[] = []
  for (const field of fields) {
    if (field.requiredTech === 'S' || field.required !== 'S') continue
    const value = values[fieldNameToCamel(field.fieldName)]
    if (value === undefined || value === null || String(value).trim() === '') {
      missing.push({
        field:   fieldNameToCamel(field.fieldName),
        message: 'Campo obrigatório (configuração do cliente)',
      })
    }
  }
  if (missing.length > 0) {
    throw new HttpError(400, 'Campos obrigatórios não preenchidos', missing,
      'REQUIRED_FIELDS')
  }
}
