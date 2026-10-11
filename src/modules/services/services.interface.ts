/**
 * Tipos do módulo services — Cadastro de Serviços (prompt_modulo_services.md,
 * rodadas 1–2 FECHADAS 2026-09-01). Serviço = tb_product com kind='S'
 * (D2 da fase de notas: natureza por AUSÊNCIA de especialização — nunca
 * tabela paralela). D5: caminho INDIVIDUAL — este módulo trata SÓ
 * kind='S' (fixo no INSERT e no WHERE de UPDATE/DELETE; mercadoria terá o
 * caminho dela no futuro módulo products, tela irmã — D6).
 * D4/D7: serviço TEM preço — grade tb_price por tb_price_list viva,
 * sincronizada na MESMA transação do serviço (presença = sincroniza).
 * D3: sem guarda de sync — o form só é liberado a cliente sem legado.
 * Espelho no app: apps/web/lib/app/modules/services/.
 */

export interface ServiceListRow {
  id:                  number
  identifier:          string
  description:         string
  categoryId:          number
  categoryDescription: string | null
  active:              'S' | 'N'
}

/** Preço do serviço numa tabela de preço (grade do form). */
export interface ServicePriceRow {
  priceListId:          number
  priceListDescription: string | null
  priceTag:             number | null
}

export interface ServiceFull extends ServiceListRow {
  /** D1 (regra de tributacao de servico): FK literal tb_service -> regra;
   *  null = sem regra (bloqueia o faturamento — D6). */
  serviceTaxRuleId:          number | null
  serviceTaxRuleLabel:       string | null
  financialPlansId:          number | null
  financialPlansDescription: string | null
  promotion:                 'S' | 'N'
  highlights:                'S' | 'N'
  published:                 'S' | 'N'
  note:                      string | null
  /** Grade: TODAS as tabelas de preço vivas, com o preço atual (null = sem). */
  prices:                    ServicePriceRow[]
  /** NBS do serviço (natureza — cNBS do DPS; fase IBS/CBS D-IB6). */
  nbs:                       string | null
  nbsDescription:            string | null
  /** Classificação IBS/CBS que o serviço presume (D-IB6/D-IB22); null = não classificado. */
  ibscbs:                    ServiceIbscbsRow | null
}

export interface ServiceIbscbsRow {
  classificationCode:        string
  /** CST derivado (= prefixo do cClassTrib — E0959; nunca guardado). */
  cst:                       string
  classificationName:        string | null
  /** Vigência da linha exibida (D-IB29 — a tela mostra "vale a partir de"/"válida até"). */
  validFrom:                 string | null
  validUntil:                string | null
  placeIndicatorCode:        string
  placeIndicatorDescription: string | null
}

export interface ServicePriceInput {
  priceListId: number
  /** null = remover o preço desta tabela. */
  priceTag:    number | null
}

export interface ServiceInput {
  /** D1: em branco → a API preenche com o próprio id na criação. */
  identifier?:       string | null
  /** Regra de tributacao de servico (FK literal). null/ausente = sem regra. */
  serviceTaxRuleId?: number | null
  description:       string
  categoryId:        number
  financialPlansId?: number | null
  promotion?:        'S' | 'N'
  highlights?:       'S' | 'N'
  published?:        'S' | 'N'
  active?:           'S' | 'N'
  note?:             string | null
  prices?:           ServicePriceInput[]
  /** Fase IBS/CBS (D-IB6): ausente = não mexe · null = remove · valor = grava. */
  nbs?:              string | null
  ibscbs?:           { classificationCode: string; placeIndicatorCode: string } | null
}

/** Lookups de apoio do form (id + descrição, LIMIT 100). */
export interface ServiceLookupRow {
  id:          number
  description: string | null
  /** = description — contrato { id, name } das listas de apoio da pesquisa avançada */
  name?:       string | null
}
