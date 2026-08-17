import { TaxRuleSelector, TaxRulePieces } from '@shared/tax-rule'

/**
 * Tipos do módulo tax-rules (cadastro da Regra de Tributação — fase
 * Faturamento Fiscal e Financeiro, decisões 1/23/28). Shape camelCase =
 * fromJson do módulo gêmeo do app.
 */

/** Linha da LISTA paginada — seletor + presença das peças (flags has*). */
export interface TaxRuleListRow {
  id: number
  ncm: string | null
  origin: string
  purpose: string
  st: 'S' | 'N'
  finalConsumer: 'S' | 'N'
  simples: 'S' | 'N'
  productId: number | null
  productName: string | null
  entityId: number | null
  stateId: number | null
  stateName: string | null
  cfopId: string | null
  hasIcms: boolean
  hasIcmsSt: boolean
  hasIpi: boolean
  hasPisCofins: boolean
  hasIi: boolean
}

/** GET :id — seletor + peças completas. */
export interface TaxRuleDetail {
  selector: TaxRuleSelector
  pieces: TaxRulePieces
}

/** Lookup dos catálogos centrais para os combos do form. */
export interface CatalogEntry { id: string | number; description: string | null }
export interface TaxRuleCatalogs {
  icmsNr: CatalogEntry[]
  icmsSn: CatalogEntry[]
  modBc: CatalogEntry[]
  modBcSt: CatalogEntry[]
  discharge: CatalogEntry[]
  ipi: CatalogEntry[]
  pis: CatalogEntry[]
  cofins: CatalogEntry[]
}
