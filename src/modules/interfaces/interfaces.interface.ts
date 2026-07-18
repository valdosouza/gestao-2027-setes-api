/**
 * Tipos do módulo interfaces (tb_interface + tb_interface_has_privilege).
 * Espelho no app: apps/web/lib/app/modules/interfaces/domain/entity/interface_entity.dart
 * O vínculo N:N com tb_privilege PERTENCE a este módulo (é ele quem o gerencia).
 */

export interface InterfaceRow {
  id:           number
  groupDefault: string | null
  i18nKey:      string | null
  description:  string | null
  kind:         string | null
  position:     string | null
  /** Privilégios vinculados (tb_interface_has_privilege com deleted='N' e active='S'). */
  privilegeIds: number[]
}

export interface InterfaceInput {
  groupDefault?: string | null
  i18nKey?:      string | null
  description:   string
  /** 'T' = tela (vai a menu); 'R' = recurso/aba (decisão 13). Omitido = 'T'. */
  kind?:         'T' | 'R' | null
  position?:     string | null
}

/** Entrada do upsert de UMA configuração do catálogo (tb_interface_has_config). */
export interface InterfaceConfigInput {
  description:    string
  kind:           string          // String|Integer|Float|Boolean|Date|Options
  options?:       string | null   // obrigatório quando kind = Options
  defaultContent: string
  scope:          'I' | 'U'
}
