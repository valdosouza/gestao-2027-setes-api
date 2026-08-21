/**
 * Tipos do módulo state-tax-rates — catálogo MVA/FCP por UF×NCM (W2 Onda 2,
 * prompt_fase_faturamento_financeiro.md Rodada 3). Dado do CLIENTE (schema
 * do institution, sem compartilhamento — decisão Q22). Shape camelCase.
 */

export interface StateMvaNcmRow {
  id: number
  stateId: number
  stateName: string | null
  ncm: string
  internalAliq: number
  mvaOriginal: number
  mvaAdjusted: number | null
}

export interface StateMvaNcmInput {
  stateId: number
  ncm: string
  internalAliq: number
  mvaOriginal: number
  mvaAdjusted?: number | null
}

export interface StateFcpNcmRow {
  id: number
  stateId: number
  stateName: string | null
  ncm: string
  aliq: number
}

export interface StateFcpNcmInput {
  stateId: number
  ncm: string
  aliq: number
}
