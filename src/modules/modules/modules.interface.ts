/**
 * Tipos do módulo modules — CRUD dos MÓDULOS DE MENU do cliente
 * (tb_module + tb_module_has_interface no schema do cliente; camada 2 do
 * menu — prompt_modulo_menus.md, D1–D4, Valdo 2026-08-04).
 * Espelho no app: apps/web/lib/app/modules/modules/domain/entity/module_entity.dart
 */

export interface ModuleRow {
  id:           number
  description:  string | null
  position:     number | null
  imageIcon:    string | null
  /** Ids das interfaces vinculadas, NA ORDEM do menu (D3). */
  interfaceIds: number[]
}

/** Linha do lookup de interfaces ELEGÍVEIS ao vínculo (contratadas, kind T, fora do Super). */
export interface ModuleInterfaceLookupRow {
  id:           number
  description:  string | null
  i18nKey:      string | null
  groupDefault: string | null
}

/**
 * Escopo da escrita do menu: o schema (os módulos são do GRUPO — D-GE5) e a
 * chave do contrato que decide a elegibilidade (D-GE4 — o contrato é do grupo,
 * D-GE22: na onda 1 vira a chave do grupo; hoje = a institution da sessão).
 * O `req.institution` do JWT satisfaz este tipo.
 */
export interface MenuScope {
  schemaName:    string
  institutionId: number
}
