/**
 * Peça @shared/tax-rule — tipos da Regra de Tributação decomposta.
 * Fase Faturamento Fiscal e Financeiro (decisões 1/23/33 do
 * prompt_fase_faturamento_financeiro.md; mapeamento tributacao.md §2/§6.5).
 * PRESENÇA = a regra DEFINE o tributo (isenção é peça presente com alíquota
 * nula — o XML exige o grupo com CST).
 */

export interface TaxRuleSelector {
  id: number
  institutionId: number
  productId: number | null      // NULL = coringa (qualquer produto)
  entityId: number | null       // NULL = coringa (qualquer destinatário)
  ncm: string | null            // preenchido = regra específica (vence a genérica)
  origin: string                // origem da mercadoria '0'..'8' (match exato)
  finalConsumer: 'S' | 'N'
  simples: 'S' | 'N'
  st: 'S' | 'N'                 // produto sob ST (após override do cliente)
  purpose: string               // finalidade '0'..'7' ('0' = Outras/ajuste)
  direction: string | null      // E/S — filtro de CADASTRO (lookup de CFOP)
  cfopId: string | null         // natureza (participa do match só no ajuste)
  stateId: number | null        // UF do destinatário; NULL = coringa interestadual
  observationId: number | null
  taxesId: number | null        // elo da reforma IBS/CBS (tb_taxes)
}

export interface IcmsPiece {
  cstNr: string | null          // CST (regime normal) — catálogo tb_tax_icms_nr
  csosn: string | null          // CSOSN (Simples) — catálogo tb_tax_icms_sn
  modBc: string | null          // modalidade da base — tb_deter_base_tax_icms
  dischargeId: number | null    // desoneração — tb_discharge_icms
  aliq: number | null
  aliqReduction: number | null
  baseReduction: number | null
  deferred: 'S' | 'N'
  deferredAliq: number | null
  highlight: 'S' | 'N'          // destacar ICMS (vira ItensIcms.Destacar)
}

export interface IcmsStPiece {
  modBcSt: string | null        // tb_deter_base_tax_icms_st
  propagateBaseReduction: 'S' | 'N'
}

export interface IpiPiece {
  cst: string                   // catálogo tb_tax_ipi
  aliq: number | null
}

/** Decisão 2: PIS e COFINS têm a MESMA forma — kind distingue. */
export interface PisCofinsPiece {
  kind: 'P' | 'C'
  cst: string                   // validado contra tb_tax_pis (P) ou tb_tax_cofins (C)
  aliq: number | null
}

export interface IiPiece {
  iiAliq: number | null
  irpjAliq: number | null
  csllAliq: number | null
  afrmmAliq: number | null
  siscomexAliq: number | null
}

/** Peças presentes da regra (ausência de chave = tributo não definido). */
export interface TaxRulePieces {
  icms?: IcmsPiece
  icmsSt?: IcmsStPiece
  ipi?: IpiPiece
  pisCofins?: PisCofinsPiece[]
  ii?: IiPiece
}

export interface TaxRuleFull {
  selector: TaxRuleSelector
  pieces: TaxRulePieces
}

/**
 * Critérios do MATCH — espelho fiel dos parâmetros do motor legado
 * (tributacao.md §2, Fc_tributacao :857-931).
 */
export interface TaxRuleMatchCriteria {
  institutionId: number         // estabelecimento emissor (TRB_CODMHA)
  productId: number
  productNcm: string | null
  productOrigin: string         // PRO_ORIGEM
  productSt: 'S' | 'N'          // PRO_SUB_TRIB
  purpose: string               // PRO_TRIBUTACAO (finalidade do produto)
  entityId: number | null       // destinatário
  customerIgnoreSt?: 'S' | 'N'  // override do cliente (Q18) — só via combinada
  finalConsumer: 'S' | 'N'
  simples: 'S' | 'N'
  destinationStateId: number    // UF do destinatário
  emitterStateId: number        // UF do estabelecimento
  presential?: boolean          // IndicaPresenca = 1
  contributorIndicator?: string // IndicadorInscricaoEstadual '1'|'2'|'9'
  cfopId?: string | null        // natureza escolhida (ajuste) → força purpose '0'
  directRuleId?: number | null  // escolha POR ITEM (modo RegraDireta — Q16/Q19)
}
