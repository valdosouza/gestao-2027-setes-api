import { EntityFiscalInput, EntityFiscalFull } from '@shared/entity'
import { EntityTaxInput, EntityTaxRow, SN } from '@shared/entity-tax/entity-tax.types'

/**
 * Tipos do CONCRETO Customer (tb_customer no SCHEMA DO CLIENTE — PK composta
 * id + tb_institution_id: o papel de cliente é POR INSTITUTION, decisão 2 da
 * Fase 3). A cadeia de entidade fiscal é COMPARTILHADA (@shared/entity, skill
 * cadastro-entidade-fiscal.md) e vive em setes_central — aqui fica só o que
 * é do concreto. Espelho no app: apps/web/lib/app/modules/customers/.
 */

/**
 * Cadeia completa + campos do concreto enviados no POST/PUT.
 * Rodada 4 (2026-07-16): consumer/byPassSt migraram para a aba Tributação
 * (`tax` — peça @shared/entity-tax, salva na MESMA transação; undefined =
 * não tocar). `wallet` é a INTENÇÃO da UI (radiobox Sim/Não): 'S' → a API
 * garante a forma de pagamento "Carteira" (autocreate) e grava o id em
 * tb_payment_types_id; 'N' → 0 (decisão 18).
 * UI: creditStatus = radiobox [L]iberado / [B]loqueado.
 */
export interface CustomerInput extends EntityFiscalInput {
  tbSalesmanId?: number | null
  tbCarrierId?:  number | null
  creditStatus?: string | null
  creditValue?:  number | null
  wallet?:       SN | null
  multiplier?:   number | null
  active?:       SN
  tax?:          EntityTaxInput | null
}

/** Linha da pesquisa (GET /api/customers). */
export interface CustomerListRow {
  id:          number
  nickTrade:   string | null
  nameCompany: string | null
  active:      'S' | 'N' | null
}

/** Objeto COMPLETO devolvido no GET /api/customers/:id.
 *  wallet é DERIVADO (tb_payment_types_id > 0); tax = aba Tributação. */
export interface CustomerFull extends EntityFiscalFull {
  tbSalesmanId:      number | null
  salesmanName:      string | null
  tbCarrierId:       number | null
  carrierName:       string | null
  creditStatus:      string | null
  creditValue:       number | null
  wallet:            SN
  tbPaymentTypesId:  number
  multiplier:        number | null
  active:            SN | null
  tax:               EntityTaxRow | null
}

/** Item dos lookups de salesman/carrier (padrão countries/states). */
export interface RoleLookupRow {
  id:   number
  name: string | null
}
