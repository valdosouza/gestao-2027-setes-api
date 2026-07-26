/**
 * Tipos do módulo interface-fields (painel de campos configuráveis —
 * decisão 6 da Fase 2). Shapes camelCase que o app consome.
 * Os tipos de campo (CatalogFieldRow/ResolvedField) vêm de @shared/field-config;
 * a vitrine (InterfaceVitrineRow) foi promovida para @shared/interface-vitrine.
 */

/** Entrada do PUT de configuração de um campo. */
export interface FieldConfigInput {
  fieldCaption?: string | null
  required?:     'S' | 'N' | null
  mask?:         string | null
}
