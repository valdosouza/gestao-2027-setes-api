/**
 * Tipos do módulo states (tb_state na setes_central).
 * Espelho no app: apps/web/lib/app/modules/states/domain/entity/state_entity.dart
 */

export interface StateRow {
  id:           number
  tbCountryId:  number
  abbreviation: string | null
  name:         string | null
  aliquota:     number | null
  /** Nome do país (JOIN em tb_country) — exibição no lookup do app. */
  countryName:  string | null
}

export interface StateInput {
  tbCountryId:  number
  abbreviation: string
  name:         string
  aliquota?:    number | null
}
