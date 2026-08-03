import { EntityFiscalInput, EntityFiscalFull } from '@shared/entity'
import { EntityTaxInput, EntityTaxRow } from '@shared/entity-tax/entity-tax.types'

/**
 * Tipos do CONCRETO Provider (tb_provider no SCHEMA DO CLIENTE — PK composta
 * id + tb_institution_id: o papel é POR INSTITUTION). Onda 3 da Entidade
 * Única (prompt_onda3_provider.md): fornecedor é papel COMPLETO da cadeia
 * fiscal (molde carriers — o legado tblProvider.pas prova que o papel não
 * tem campo próprio além de active) e ganha a aba Tributação (D1 — peça
 * @shared/entity-tax, salva na MESMA transação; undefined = não tocar).
 * Convive com linhas nascidas do sync (/provider/sincronize upserta o papel).
 * Espelho no app: apps/web/lib/app/modules/providers/.
 */

type SN = 'S' | 'N'

/** Cadeia completa + campos do concreto enviados no POST/PUT. */
export interface ProviderInput extends EntityFiscalInput {
  active?: SN
  tax?:    EntityTaxInput | null
}

/** Linha da pesquisa (GET /api/providers). */
export interface ProviderListRow {
  id:          number
  nickTrade:   string | null
  nameCompany: string | null
  active:      'S' | 'N' | null
}

/** Objeto COMPLETO devolvido no GET /api/providers/:id. */
export interface ProviderFull extends EntityFiscalFull {
  active: SN | null
  tax:    EntityTaxRow | null
}
