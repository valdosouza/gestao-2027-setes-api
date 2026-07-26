/**
 * Tipos do módulo cities (tb_city na setes_central).
 * Espelho no app: apps/web/lib/app/modules/cities/domain/entity/city_entity.dart
 */

export interface CityRow {
  id:         number
  tbStateId:  number
  ibge:       string | null
  name:       string | null
  aliqIss:    number
  population: number
  density:    number
  area:       number
  /** Nome do estado (JOIN em tb_state) — exibição no lookup do app. */
  stateName:  string | null
}

export interface CityInput {
  tbStateId:   number
  ibge?:       string | null
  name:        string
  aliqIss?:    number
  population?: number
  density?:    number
  area?:       number
}

export interface CityCreateInput extends CityInput {
  id: number  // Código IBGE do município, informado pelo usuário na inclusão
}
