import { HttpError } from '@shared/errors/http-error'
import { getEntityTax } from '@shared/entity-tax/entity-tax.repository'
import { parseCrt } from '@shared/entity-tax/entity-tax.types'
import { ListQuery, PagedRows } from '@shared/list'
import { findInvalidCatalogCodes, findInvalidSelectorRefs } from '@shared/tax-rule'
import {
  listTaxRules, getTaxRule, insertTaxRuleCascade, updateTaxRuleCascade,
  deleteTaxRuleCascade, listCatalogs,
  getEmitterStateId, getStateAbbreviation, listCfopOptions,
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

async function assertCatalogCodes(
  schemaName: string, institutionId: number, input: TaxRuleBodyDto
): Promise<void> {
  const invalid = [
    ...await findInvalidCatalogCodes(
      toPieces(input) as any,
      { cfopId: input.selector.cfopId, direction: input.selector.direction }),
    // Decisão 38: produto/cliente da especialização precisam EXISTIR
    // (vêm do cadastro de origem; typo criaria regra morta ou 500 de FK).
    ...await findInvalidSelectorRefs(schemaName, institutionId, {
      productId: input.selector.productId,
      entityId: input.selector.entityId,
    }),
  ]
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
  await assertCatalogCodes(schemaName, institutionId, input)
  const id = await insertTaxRuleCascade(schemaName, institutionId, input)
  return { id }
}

export async function editTaxRule(
  schemaName: string, institutionId: number, id: number, input: TaxRuleBodyDto
): Promise<void> {
  await assertCatalogCodes(schemaName, institutionId, input)
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

/**
 * CFOPs por ALÇADA (rodada 2026-09-01): sentido + UF do destinatário
 * determinam o 1º dígito — mesma UF do emitente = 1/5, UF diferente = 2/6,
 * EX (Exterior) = 3/7. UF do seletor vazia (coringa) = os 3 dígitos do
 * sentido. Emitente sem endereço com UF não consegue distinguir mesmo ×
 * outro estado — devolve os dois (nunca esconder opção por dado faltante).
 */
export async function fetchCfopOptions(
  institutionId: number, direction: 'E' | 'S', stateId: number | null,
  filter: string | null
): Promise<Array<{ id: string; description: string | null }>> {
  const bases = direction === 'E' ? ['1', '2', '3'] : ['5', '6', '7']
  let digits = bases
  if (stateId !== null) {
    const abbr = await getStateAbbreviation(stateId)
    if (abbr === null) {
      throw new HttpError(422, 'Estado informado não existe',
        [{ field: 'stateId', message: `Estado ${stateId} não encontrado` }])
    }
    if (abbr === 'EX') {
      digits = [bases[2]]
    } else {
      const emitterStateId = await getEmitterStateId(institutionId)
      digits = emitterStateId === null
        ? [bases[0], bases[1]]
        : [stateId === emitterStateId ? bases[0] : bases[1]]
    }
  }
  return listCfopOptions(digits, filter)
}

/** CRT do estabelecimento logado (D39.3) — null se regime não configurado
 *  (form cai no fallback: mostra CST e CSOSN). Fonte única: tb_entity_tax
 *  do próprio emitente (mesma leitura do billing). */
export async function fetchEmitterCrt(
  schemaName: string, institutionId: number
): Promise<string | null> {
  const tax = await getEntityTax(schemaName, institutionId, institutionId)
  return parseCrt(tax?.taxRegime)
}
