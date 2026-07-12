/**
 * Tipos do módulo interface-fields (painel de campos configuráveis —
 * decisão 6 da Fase 2). Shapes camelCase que o app consome.
 * Os tipos de campo (CatalogFieldRow/ResolvedField) vêm de @shared/field-config.
 */

/** Linha da vitrine de interfaces (decisão 6: mostra TODAS as interfaces). */
export interface InterfaceVitrineRow {
  id:          number
  description: string | null
  i18nKey:     string | null
  /** 'S' = interface adquirida pelo institution (contrato comercial). */
  acquired:    'S' | 'N'
  /** Módulos do cliente que contêm a interface (GROUP_CONCAT) — filtro do painel. */
  moduleNames: string | null
}

/** Entrada do PUT de configuração de um campo. */
export interface FieldConfigInput {
  fieldCaption?: string | null
  required?:     'S' | 'N' | null
  mask?:         string | null
}
