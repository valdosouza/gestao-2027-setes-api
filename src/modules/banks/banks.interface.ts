/**
 * Tipos do módulo banks (tb_bank na setes_central — catálogo FEBRABAN,
 * DP2 do Software House + decisão do Valdo 2026-08-04: cadastro GERAL da
 * central, sem cadeia fiscal, consumido por todos os schemas via lookup
 * de conta corrente).
 * Espelho no app: apps/web/lib/app/modules/banks/domain/entity/bank_entity.dart
 */

export interface BankRow {
  id:          number
  number:      string
  description: string | null
}
