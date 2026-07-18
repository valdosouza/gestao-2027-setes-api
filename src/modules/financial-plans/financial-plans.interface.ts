/**
 * Tipos do módulo financial-plans — PLANO DE CONTAS em ÁRVORE
 * (tb_financial_plans no SCHEMA DO CLIENTE, PK composta
 * id + tb_institution_id). 2º cadastro recursivo do produto (referência:
 * Delphi reg_plano_contas.pas; molde: categories): `posit_level`
 * materializado calculado SEMPRE pela API; mover de pai recalcula a
 * subárvore; excluir bloqueado com subníveis. Árvore ÚNICA — os domínios
 * são ATRIBUTOS do nó (radios no form):
 *   source ('source_' no banco) = Natureza: 'C' Credora / 'D' Devedora
 *   kind    = Tipo da Conta: 'C' Centro de Custo / 'R' Contas de Resultado
 *   cluster = Nível de Visualização: 'S' Sintética / 'A' Analítica
 * Espelho no app: apps/web/lib/app/modules/financial_plans/.
 */

export interface FinancialPlanRow {
  id:          number
  description: string
  positLevel:  string
  /** id do pai derivado do posit_level (null = nível raiz). */
  parentId:    number | null
  source:      'C' | 'D'
  kind:        'C' | 'R'
  cluster:     'S' | 'A'
  active:      'S' | 'N'
}

/** POST — parentId null/omitido = raiz; defaults do Delphi: C/C/S. */
export interface FinancialPlanCreateInput {
  description: string
  source?:     'C' | 'D'
  kind?:       'C' | 'R'
  cluster?:    'S' | 'A'
  parentId?:   number | null
  active?:     'S' | 'N'
}

/** PUT — parentId presente = posição desejada (null = raiz): se diferente
 *  da atual, a API move a subárvore. */
export interface FinancialPlanUpdateInput extends FinancialPlanCreateInput {}
