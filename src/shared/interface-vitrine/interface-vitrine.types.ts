/**
 * Vitrine de interfaces — promovida de modules/interface-fields quando o
 * painel de CONFIGURAÇÕES virou o 2º consumidor (regra de promoção:
 * módulo nunca importa módulo; compartilhado vive em shared/).
 */

/** Linha da vitrine (mostra TODAS as interfaces, marcando as adquiridas). */
export interface InterfaceVitrineRow {
  id:          number
  description: string | null
  i18nKey:     string | null
  /** 'S' = interface adquirida pelo institution (contrato comercial). */
  acquired:    'S' | 'N'
  /** Módulos do cliente que contêm a interface (GROUP_CONCAT) — filtro do painel. */
  moduleNames: string | null
}
