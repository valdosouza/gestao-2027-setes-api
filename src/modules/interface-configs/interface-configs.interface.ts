/**
 * Tipos do módulo interface-configs (painel do Framework de Configurações
 * do Sistema — decisões 7 e 9). Shapes camelCase que o app consome.
 * Catálogo/resolução (CatalogConfigRow/ResolvedConfig) vêm de
 * @shared/interface-config; a vitrine de @shared/interface-vitrine.
 */

/** Entrada do PUT de valor de UMA configuração. */
export interface ConfigValueInput {
  /**
   * Valor escolhido; null = volta a herdar (remove o override/valor).
   * Só grava o que diverge do herdado (nota de projeto b).
   */
  content: string | null
  /** 'I' = valor da institution (admin); 'U' = override do usuário (scope 'U'). */
  target:  'I' | 'U'
}
