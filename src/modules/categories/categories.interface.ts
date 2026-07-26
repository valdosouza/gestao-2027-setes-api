/**
 * Tipos do módulo categories — Categorias de produtos e serviços em ÁRVORE
 * (tb_category no SCHEMA DO CLIENTE, PK composta id + tb_institution_id).
 *
 * Cadastro RECURSIVO (referência: Delphi reg_category.pas; decisões do
 * Valdo 2026-07-18): `posit_level` é o CAMINHO MATERIALIZADO — cada
 * segmento é o próprio código com 3 dígitos ('001', '001.005',
 * '001.005.012'); profundidade = nº de pontos. A posição nasce na criação
 * (caminho do pai + código) e MOVER de pai recalcula a subárvore inteira
 * em transação. Duas árvores independentes por kind: 'P' = produtos,
 * 'S' = serviços (abas no app; kind imutável após criar).
 * Espelho no app: apps/web/lib/app/modules/categories/.
 */

export interface CategoryRow {
  id:          number
  description: string
  positLevel:  string
  /** id do pai derivado do posit_level (null = nível raiz). */
  parentId:    number | null
  kind:        'P' | 'S'
  active:      'S' | 'N'
}

/** POST — kind obrigatório (define a árvore); parentId null/omitido = raiz. */
export interface CategoryCreateInput {
  description: string
  kind:        'P' | 'S'
  parentId?:   number | null
  active?:     'S' | 'N'
}

/** PUT — kind NÃO muda; parentId presente = posição desejada (null = raiz):
 *  se diferente da atual, a API move a subárvore. */
export interface CategoryUpdateInput {
  description: string
  parentId?:   number | null
  active?:     'S' | 'N'
}
