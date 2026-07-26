import { EntityFiscalInput, EntityFiscalFull } from '@shared/entity'

/**
 * Tipos do CONCRETO Collaborator (tb_collaborator no SCHEMA DO CLIENTE —
 * PK composta id + tb_institution_id: o papel é POR INSTITUTION). Onda 2 da
 * Entidade Única (hierarquia de papéis, decisão 16): colaborador pode ser
 * só administrativo; todo vendedor É colaborador (a precedência entra
 * quando o cadastro de salesman nascer). A cadeia de entidade fiscal é
 * COMPARTILHADA (@shared/entity, skill cadastro-entidade-fiscal.md).
 * Espelho no app: apps/web/lib/app/modules/collaborators/.
 */

type SN = 'S' | 'N'

/** Cadeia completa + campos do concreto enviados no POST/PUT.
 *  Datas ISO 'YYYY-MM-DD'; sem aba Tributação (exclusiva do Customer). */
export interface CollaboratorInput extends EntityFiscalInput {
  dtAdmission?:         string | null
  dtResignation?:       string | null
  salary?:              number | null
  fathersName?:         string | null
  mothersName?:         string | null
  voteNumber?:          string | null
  voteZone?:            string | null
  voteSection?:         string | null
  militaryCertificate?: string | null
  pis?:                 string | null
  active?:              SN
}

/** Linha da pesquisa (GET /api/collaborators). */
export interface CollaboratorListRow {
  id:          number
  nickTrade:   string | null
  nameCompany: string | null
  active:      'S' | 'N' | null
}

/** Objeto COMPLETO devolvido no GET /api/collaborators/:id. */
export interface CollaboratorFull extends EntityFiscalFull {
  dtAdmission:         string | null
  dtResignation:       string | null
  salary:              number | null
  fathersName:         string | null
  mothersName:         string | null
  voteNumber:          string | null
  voteZone:            string | null
  voteSection:         string | null
  militaryCertificate: string | null
  pis:                 string | null
  active:              SN | null
}
