/**
 * Tipos do Framework de Configurações do Sistema (decisões 2, 4 e 6 —
 * prompt_framework_configuracoes_sistema.md): catálogo
 * setes_central.tb_interface_has_config (nome/descrição/kind/default/scope) ×
 * setes_<schema>.tb_institution_has_config (valores que divergem do default;
 * tb_user_id = 0 sentinel para o valor da institution).
 */

/** Linha do catálogo central (característica intrínseca do produto). */
export interface CatalogConfigRow {
  name:           string
  description:    string
  kind:           string          // String | Integer | Float | Boolean | Date | Options
  options:        string | null   // lista fechada p/ kind Options: "A=Por item;B=Por total"
  defaultContent: string
  scope:          'I' | 'U'       // 'U' = admite override por usuário (decisão 4)
}

/** Linha de valor do schema do cliente (institution ou override de usuário). */
export interface ConfigValueRow {
  name:     string
  tbUserId: number   // 0 = valor da institution; >0 = override do usuário
  content:  string
}

/**
 * Configuração RESOLVIDA (decisão 4: usuário → institution → default) — o
 * shape que o painel exibe e que o engine do app consome.
 */
export interface ResolvedConfig extends CatalogConfigRow {
  /** Valor da institution (tb_user_id = 0); null = segue o default. */
  institutionContent: string | null
  /** Override do usuário corrente (só relevante em scope 'U'); null = sem override. */
  userContent:        string | null
  /** Valor EFETIVO para o usuário corrente. */
  content:            string
}

/** Opção de um kind Options já separada ("A=Por item" → { value, label }). */
export interface ConfigOption {
  value: string
  label: string
}
