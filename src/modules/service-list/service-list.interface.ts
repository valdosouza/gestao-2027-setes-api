/**
 * Tipos do módulo service-list — Lista de Serviços da LC 116/2003
 * (setes_central.tb_service_list, seção "Referência fiscal" do sql/01 —
 * catálogo CENTRAL, módulo Super; prompt_regra_tributacao_servico.md
 * D10/D12). O id é o PRÓPRIO item da lista ('1.01' — padrão de código
 * externo, precedente cfop: 409 se já existir, imutável na edição).
 *   local_incidence = 'P' município do PRESTADOR (regra geral) /
 *                     'E' município da EXECUÇÃO (exceções do art. 3º)
 * Espelho no app: apps/web/lib/app/modules/service_list/.
 */

export interface ServiceListRow {
  id:             string
  description:    string
  localIncidence: 'P' | 'E'
  active:         'S' | 'N'
}

export interface ServiceListInput {
  description:     string
  localIncidence?: 'P' | 'E'
  active?:         'S' | 'N'
}
