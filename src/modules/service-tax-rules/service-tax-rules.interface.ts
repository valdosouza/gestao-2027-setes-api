/**
 * Tipos do módulo service-tax-rules — Regra de Tributação de SERVIÇO (ISS),
 * prompt_regra_tributacao_servico.md (rodadas 1–2, 2026-09-02): o que o
 * MUNICÍPIO cobra de um item da Lista de Serviços (LC 116) —
 * cidade de INCIDÊNCIA (D12) × item → alíquota (D13) + código municipal
 * (D4). tb_service_tax_rule no SCHEMA DO CLIENTE (PK id + institution,
 * MAX+1); item validado no catálogo central tb_service_list (sem FK
 * física). O serviço aponta a regra por FK literal (D1 — módulo services).
 * Caminho INDIVIDUAL do serviço: nada aqui reusa @shared/tax-rule.
 * Espelho no app: apps/web/lib/app/modules/service_tax_rules/.
 */

export interface ServiceTaxRuleRow {
  id:                     number
  cityId:                 number
  cityName:               string | null
  /** UF da cidade de incidência — lookup dependente do app (UF → cidade). */
  stateId:                number | null
  stateAbbreviation:      string | null
  serviceListId:          string
  serviceListDescription: string | null
  /** 'P' prestador / 'E' execução — vem do catálogo (informativo). */
  localIncidence:         'P' | 'E' | null
  aliq:                   number
  municipalCode:          string | null
  active:                 'S' | 'N'
}

export interface ServiceTaxRuleInput {
  cityId:         number
  serviceListId:  string
  aliq:           number
  municipalCode?: string | null
  active?:        'S' | 'N'
}

/** Lookup de apoio (id + descrição). */
export interface ServiceTaxRuleLookupRow {
  id:          string | number
  description: string | null
}
