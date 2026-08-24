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
  direction: 'E' | 'S'          // sentido da regra — SEM coringa (decisão 35:
                                // paridade com NAT_SENTIDO; "Ambos" não existe)
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
/**
 * ── Cálculo por item (Onda 1 do W2 — prompt_fase_faturamento_financeiro.md) ──
 * Funções puras (`calc.ts`), sem banco/I-O: recebem os dados já resolvidos
 * pelo caller (alíquotas de UF×NCM, regime do emitente, contexto do
 * destinatário) e devolvem base/alíquota/valor por tributo, seguindo a
 * ordem T1 e a pilha de bases T3 de tributacao.md. A persistência por item
 * (tabela nova × reuso legado) fica para a próxima onda, após consulta ao
 * setes-conceito.
 */

export interface IcmsCalcContext {
  cst: string                        // P2.5 — despacho por CST (regime normal)
  csosn?: string | null              // P2.9 — despacho por CSOSN (Simples); presente = regime SN
  aliq: number                       // alíquota interna/interestadual já resolvida
  aliqReduction: number              // TRB_RD_AQ_ICMS — só CST 00
  baseReduction: number              // TRB_RD_BS_ICMS (%)
  deferredAliqPct: number            // TRB_AQ_DIF (%) — CST 51 e CSOSN (gate: destinationIsResale)
  destinationIsResale: boolean       // TRB_CONSUMIDOR = 'N' (CST 10/70 p/ ST; CSOSN p/ diferimento)
  destinationIsContributor: boolean  // indIEDest = 1 (exceção IPI na base, P2.4)
  purpose: string                    // finalidade do produto (PRO_TRIBUTACAO)
  stAliq: number | null              // alíquota do ST (UF destino) — null = sem ST
  mvaPct: number | null              // MVA (já ajustada ou original — decisão do faturamento)
  stBaseReduction: number            // TRB_RD_BS_ICMS_ST (%)
  creditAliqPct?: number             // P2.9 — alíquota do crédito SN (config da institution, GRL_G_AQ_CRED_ICMS)
}

export interface IcmsCalcResult {
  base: number
  aliq: number
  value: number
  operationValue?: number  // vICMSOp — CST 51 e CSOSN (informativo, nunca zerado pelo grupo)
  deferredValue?: number   // vICMSDif — CST 51 e CSOSN
  baseSt?: number
  valueSt?: number
  creditAliq?: number      // pCredSN — CSOSN 101/201/500/900 (P2.9)
  creditValue?: number     // vCredICMSSN — idem
}

export interface FcpCalcResult {
  base: number
  value: number
}

export interface IpiCalcContext {
  cst: string   // só 00/49/50/99 calculam (P4)
  aliq: number
}

export interface IpiCalcResult {
  base: number
  aliq: number
  value: number
}

/** Decisão 2/Q24: PIS e COFINS usam a MESMA fórmula — kind só rotula o resultado. */
export interface PisCofinsCalcContext {
  kind: 'P' | 'C'
  cst: string
  aliq: number
  quantity?: number    // CST 03 — por quantidade
  unitAliqValue?: number // CST 03 — ITF_VL_UNIT (valor da alíquota por unidade)
}

export interface PisCofinsCalcResult {
  kind: 'P' | 'C'
  base: number
  aliq: number
  value: number
}

export interface IiCalcContext {
  iiAliq: number | null
  irpjAliq: number | null
  csllAliq: number | null
  afrmmAliq: number | null
  siscomexAliq: number | null
}

export interface IiCalcResult {
  base: number
  iiValue: number
  irpjValue: number
  csllValue: number
  afrmmValue: number
  siscomexValue: number
}

/** P6.1 — alíquota vem do cadastro da CIDADE do destinatário, NUNCA da regra. */
export interface IssqnCalcContext {
  cityAliqPct: number
  deductionValue: number   // ITF_VL_DESC
  withheld: boolean        // flag do cliente issretido='S'
}

export interface IssqnCalcResult {
  base: number
  aliq: number
  value: number
  withheldValue: number
}

export interface ItemTaxCalcInput {
  merchandiseValue: number  // T3 raiz: unit×qtde − desconto incondicional (já calculado)
  freight: number           // já rateado no item (T2)
  insurance: number
  other: number
  kind: 'P' | 'M' | 'S'
  icms?: IcmsCalcContext
  fcp?: { aliqFcp: number | null; aliqFcpSt: number | null }
  ipi?: IpiCalcContext
  pisCofins?: PisCofinsCalcContext[]
  ii?: IiCalcContext
  issqn?: IssqnCalcContext
}

export interface ItemTaxCalcResult {
  ipi?: IpiCalcResult
  icms?: IcmsCalcResult
  fcp?: FcpCalcResult
  fcpSt?: FcpCalcResult
  ii?: IiCalcResult
  pisCofins?: PisCofinsCalcResult[]
  issqn?: IssqnCalcResult
}

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
  direction: 'E' | 'S'          // sentido da OPERAÇÃO (way da natureza —
                                // NAT_SENTIDO = :sentido do legado, decisão 35)
  destinationStateId: number    // UF do destinatário
  emitterStateId: number        // UF do estabelecimento
  presential?: boolean          // IndicaPresenca = 1
  contributorIndicator?: string // IndicadorInscricaoEstadual '1'|'2'|'9'
  cfopId?: string | null        // natureza escolhida (ajuste) → força purpose '0'
  directRuleId?: number | null  // escolha POR ITEM (modo RegraDireta — Q16/Q19)
}
