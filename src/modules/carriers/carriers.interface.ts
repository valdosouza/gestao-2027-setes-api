import { EntityFiscalInput, EntityFiscalFull } from '@shared/entity'
import { EntityTaxInput, EntityTaxRow } from '@shared/entity-tax/entity-tax.types'

/**
 * Tipos do CONCRETO Carrier (tb_carrier no SCHEMA DO CLIENTE — PK composta
 * id + tb_institution_id: o papel é POR INSTITUTION). Onda 2 da Entidade
 * Única (prompt_onda2_salesman_carrier.md): transportadora é papel COMPLETO
 * da cadeia fiscal (molde collaborators) e ganha a aba Tributação (D2 —
 * peça @shared/entity-tax, salva na MESMA transação; undefined = não tocar).
 * Espelho no app: apps/web/lib/app/modules/carriers/.
 */

type SN = 'S' | 'N'

/** Cadeia completa + campos do concreto enviados no POST/PUT. */
export interface CarrierInput extends EntityFiscalInput {
  active?: SN
  tax?:    EntityTaxInput | null
}

/** Linha da pesquisa (GET /api/carriers). */
export interface CarrierListRow {
  id:          number
  nickTrade:   string | null
  nameCompany: string | null
  active:      'S' | 'N' | null
}

/** Objeto COMPLETO devolvido no GET /api/carriers/:id. */
export interface CarrierFull extends EntityFiscalFull {
  active: SN | null
  tax:    EntityTaxRow | null
}
