/**
 * Tipos do módulo price-lists — Tabelas de Preço (D7 do
 * prompt_modulo_services.md, 2026-09-01). tb_price_list no SCHEMA DO
 * CLIENTE (PK id + tb_institution_id; id MAX+1 por institution). Consumida
 * pela grade de preços do cadastro de serviço (tb_price) e, no futuro,
 * pelo cadastro de produtos — telas irmãs (D6). Convivência com o sync:
 * D3 — sem guarda; o form só é liberado a cliente sem legado.
 * Espelho no app: apps/web/lib/app/modules/price_lists/.
 */

export interface PriceListRow {
  id:          number
  description: string
  /** Vigência (YYYY-MM-DD) — null = sem prazo. */
  validity:    string | null
  /** Modalidade (char livre do legado — sem catálogo na web ainda). */
  modality:    string | null
  published:   'S' | 'N'
}

export interface PriceListInput {
  description: string
  validity?:   string | null
  modality?:   string | null
  published?:  'S' | 'N'
}
