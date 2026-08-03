/**
 * Tipos do CONCRETO Salesman (tb_salesman no SCHEMA DO CLIENTE — PK composta
 * id + tb_institution_id). Onda 2 da Entidade Única
 * (prompt_onda2_salesman_carrier.md, D1): vendedor é PROMOÇÃO de um
 * colaborador — o cadastro NÃO edita a cadeia fiscal (a pessoa já existe);
 * o "novo" nasce do lookup de colaboradores e a precedência
 * Collaborator→Salesman morre por construção. Espelho no app:
 * apps/web/lib/app/modules/salesmen/.
 */

type SN = 'S' | 'N'

/** Campos do PAPEL enviados no POST (id = colaborador promovido) e no PUT. */
export interface SalesmanInput {
  active?:          SN
  aliqKickback?:    number | null
  kickbackProduct?: SN | null
  flexValue?:       number
}

/** Linha da pesquisa (GET /api/salesmen). */
export interface SalesmanListRow {
  id:          number
  nickTrade:   string | null
  nameCompany: string | null
  active:      'S' | 'N' | null
}

/** Objeto devolvido no GET /api/salesmen/:id — identificação do colaborador
 *  (readonly no form) + campos do papel. */
export interface SalesmanFull {
  id:              number
  nickTrade:       string | null
  nameCompany:     string | null
  document:        string | null
  active:          SN | null
  aliqKickback:    number | null
  kickbackProduct: SN | null
  flexValue:       number
}

/** Item do lookup de colaboradores (origem da promoção — D1). */
export interface CollaboratorLookupRow {
  id:   number
  name: string
}
