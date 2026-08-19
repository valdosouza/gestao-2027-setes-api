import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import { findInvalidCatalogCodes } from '@shared/tax-rule'
import {
  listTaxRules, getTaxRule, insertTaxRuleCascade, updateTaxRuleCascade,
  deleteTaxRuleCascade, listCatalogs,
} from './tax-rules.repository'
import { TaxRuleListRow, TaxRuleDetail, TaxRuleCatalogs } from './tax-rules.interface'
import { TaxRuleBodyDto } from './tax-rules.dto'

/**
 * Regra de negócio do cadastro tax-rules. Código: MAX+1 no backend (sem
 * padrão externo — decisão registrada; id readOnly no app). CSTs/modBC são
 * validados contra os catálogos CENTRAIS aqui (decisão 33 — sem FK física em
 * coluna string; a integridade é da peça @shared/tax-rule) → 422 com fields[].
 */

function toPieces(input: TaxRuleBodyDto) {
  return {
    icms: input.icms ?? undefined,
    icmsSt: input.icmsSt ?? undefined,
    ipi: input.ipi ?? undefined,
    pisCofins: input.pisCofins ?? undefined,
    ii: input.ii ?? undefined,
  }
}

async function assertCatalogCodes(input: TaxRuleBodyDto): Promise<void> {
  const invalid = await findInvalidCatalogCodes(
    toPieces(input) as any, { cfopId: input.selector.cfopId })
  if (invalid.length > 0) {
    throw new HttpError(422, 'Código fiscal inexistente no catálogo', invalid)
  }
}

export async function fetchTaxRules(
  schemaName: string, institutionId: number, query: ListQuery
): Promise<PagedRows<TaxRuleListRow>> {
  return listTaxRules(schemaName, institutionId, query)
}

export async function fetchTaxRule(
  schemaName: string, institutionId: number, id: number
): Promise<TaxRuleDetail> {
  const rule = await getTaxRule(schemaName, institutionId, id)
  if (!rule) throw new HttpError(404, `Regra de tributação ${id} não encontrada`)
  return rule
}

export async function createTaxRule(
  schemaName: string, institutionId: number, input: TaxRuleBodyDto
): Promise<{ id: number }> {
  await assertCatalogCodes(input)
  const id = await insertTaxRuleCascade(schemaName, institutionId, input)
  return { id }
}

export async function editTaxRule(
  schemaName: string, institutionId: number, id: number, input: TaxRuleBodyDto
): Promise<void> {
  await assertCatalogCodes(input)
  await updateTaxRuleCascade(schemaName, institutionId, id, input)
}

export async function removeTaxRule(
  schemaName: string, institutionId: number, id: number
): Promise<void> {
  await deleteTaxRuleCascade(schemaName, institutionId, id)
}

// Catálogos são centrais e de baixa rotatividade (só o Super mexe):
// cache TTL em memória no molde do flag.service/field-config.
const CATALOG_TTL_MS = Number(process.env.TAX_CATALOG_CACHE_TTL_MS ?? 60_000)
let catalogCache: { expires: number; data: TaxRuleCatalogs } | null = null

export async function fetchCatalogs(): Promise<TaxRuleCatalogs> {
  if (catalogCache && catalogCache.expires > Date.now()) return catalogCache.data
  const data = await listCatalogs()
  catalogCache = { expires: Date.now() + CATALOG_TTL_MS, data }
  return data
}

/** Invalidação para testes/manutenção futura do catálogo (mesmo processo). */
export function invalidateCatalogCache(): void {
  catalogCache = null
}
