/**
 * Tipos do módulo cfop — CFOP para suporte à emissão de nota
 * (setes_central.tb_cfop, seção "Referência fiscal" do sql/01 — catálogo
 * CENTRAL, módulo Super). O id é o PRÓPRIO código CFOP (varchar 10,
 * informado pelo usuário — padrão de código externo: 409 se já existir,
 * imutável na edição).
 *
 * Semântica do legado (reg_cfop.pas / ControllerNatureza.pas):
 *   way          = Sentido: 'E' Entrada / 'S' Saída
 *   jurisdiction = Alçada: 'E' Estadual / 'N' Nacional / 'X' Exterior
 *   register     = "Registro" (inteiro livre)
 *   concise      = Descrição abreviada
 *   note         = "Aplicação" (texto longo — BLOB no banco)
 * Espelho no app: apps/web/lib/app/modules/cfop/.
 */

export interface CfopRow {
  id:           string
  description:  string | null
  concise:      string | null
  register:     number | null
  way:          'E' | 'S' | null
  jurisdiction: 'E' | 'N' | 'X' | null
  note:         string | null
  active:       'S' | 'N' | null
}

export interface CfopInput {
  description:   string
  concise?:      string | null
  register?:     number | null
  // Decisão 35: não existe CFOP sem sentido (obrigatório no cadastro; linhas
  // legadas sem way seguem no Row até revisão).
  way:           'E' | 'S'
  jurisdiction?: 'E' | 'N' | 'X' | null
  note?:         string | null
  active?:       'S' | 'N'
}
