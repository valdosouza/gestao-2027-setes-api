/**
 * Tipos do framework de campos configuráveis (Fase 2, decisões 4, 5 e 12):
 * catálogo setes_central.tb_interface_has_field (baseline técnico) ×
 * setes_<schema>.tb_institution_has_field (especialização do cliente).
 */

/** Linha do catálogo central (baseline técnico do produto). */
export interface CatalogFieldRow {
  fieldName: string
  tableName: string | null
  kind:      string          // String | Integer | Float | Boolean | Date
  required:  'S' | 'N'       // 'S' = travado no painel (decisão 2)
}

/** Linha de especialização do cliente (tb_institution_has_field). */
export interface FieldConfigRow {
  fieldName:    string
  fieldCaption: string | null
  required:     'S' | 'N' | null  // null = herda o catálogo
  mask:         string | null
}

/**
 * Campo RESOLVIDO (merge custom → catálogo — decisão 7): o shape que o app
 * consome para montar a tela e que o painel exibe.
 */
export interface ResolvedField {
  fieldName:    string
  tableName:    string | null
  kind:         string
  requiredTech: 'S' | 'N'      // baseline técnico (travado quando 'S')
  required:     'S' | 'N'      // efetivo (técnico OU apertado pelo cliente)
  caption:      string | null  // custom do cliente (null = i18n padrão do app)
  mask:         string | null
  customized:   'S' | 'N'
}
