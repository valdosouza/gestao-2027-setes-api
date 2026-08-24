/**
 * Motor de CÁLCULO por item — Onda 1 do W2 (prompt_fase_faturamento_financeiro.md).
 * Funções puras, SEM banco/I-O: `@shared/tax-rule/match.ts` resolve QUAL regra
 * e QUAIS alíquotas se aplicam; este arquivo resolve o VALOR de cada tributo
 * a partir da regra já casada. Fonte-da-verdade: `Infra-IA/Gestao2016/tributacao.md`
 * (P2–P9, T1–T3) — cada função referencia a seção correspondente.
 *
 * Fora de escopo desta onda: IBS/CBS (P10 — stub aguardando regulamento) e a
 * persistência por item (próxima onda, após consulta ao setes-conceito).
 */
import {
  IcmsCalcContext, IcmsCalcResult, FcpCalcResult,
  IpiCalcContext, IpiCalcResult,
  PisCofinsCalcContext, PisCofinsCalcResult,
  IiCalcContext, IiCalcResult,
  IssqnCalcContext, IssqnCalcResult,
  ItemTaxCalcInput, ItemTaxCalcResult,
} from './types'

// ── Aritmética fiscal (arredondamentos do legado, T2/§P6.1) ────────────────

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function floorTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.floor(value * factor + Number.EPSILON) / factor
}

// ── T3 raiz: mercadoria líquida ─────────────────────────────────────────────

export function calcMerchandiseValue(unitValue: number, quantity: number, discountValue: number): number {
  return round2(unitValue * quantity - discountValue)
}

// ── T2 — Rateio de frete/seguro/outras: proporcional, resíduo no ÚLTIMO ────

/**
 * Distribui `total` entre os itens proporcionalmente a `baseValues` (valor
 * líquido de cada item). Proporção arredondada PARA BAIXO em 4 casas; cota de
 * cada item arredondada PARA BAIXO em 2 casas; o ÚLTIMO item recebe o
 * resíduo (`total − soma dos anteriores`) — fecha o total exato por
 * construção (T2 do tributacao.md).
 */
export function prorateWithResidue(baseValues: number[], total: number): number[] {
  if (baseValues.length === 0) return []
  const sumBase = baseValues.reduce((a, b) => a + b, 0)
  if (sumBase === 0 || total === 0) return baseValues.map(() => 0)

  const shares: number[] = []
  let allocated = 0
  for (let i = 0; i < baseValues.length - 1; i++) {
    const proportion = floorTo(baseValues[i] / sumBase, 4)
    const share = floorTo(total * proportion, 2)
    shares.push(share)
    allocated += share
  }
  shares.push(round2(total - allocated))
  return shares
}

// ── P2.4 — bases centralizadas do ICMS ──────────────────────────────────────

/**
 * `Fn_IPIIntegraNaBaseICMS` (invertida): IPI fica FORA da base só quando os
 * TRÊS requisitos valem juntos — destinatário contribuinte + finalidade
 * 2/4 (Produção/Industrialização) + IPI > 0 (exceção art. 155 §2º XI, CF).
 * Nos demais casos o IPI INTEGRA a base (retorna true).
 */
export function icmsIpiIntegratesBase(params: {
  destinationIsContributor: boolean
  purpose: string
  ipiValue: number
}): boolean {
  const isException = params.destinationIsContributor
    && (params.purpose === '2' || params.purpose === '4')
    && params.ipiValue > 0
  return !isException
}

/** `Fn_CalcBaseICMS` (:2431) — Base = (mercadoria + IPI? + frete?) × (1 − red%). */
export function calcBaseIcms(params: {
  merchandiseValue: number
  ipiValue: number
  includeIpi: boolean
  freight: number
  includeFreight: boolean   // só CST 51 passa frete (§P2.5)
  baseReductionPct: number
}): number {
  const base = params.merchandiseValue
    + (params.includeIpi ? params.ipiValue : 0)
    + (params.includeFreight ? params.freight : 0)
  return round2(base * (1 - params.baseReductionPct / 100))
}

/**
 * `Fn_CalcBaseICMSST` (:2460) — no ST o IPI SEMPRE compõe (Lei Kandir); todos
 * os encargos transferíveis ao adquirente entram ANTES da MVA.
 * `Base ST = (mercadoria + IPI + frete + seguro + outras) × (1 − red%) × (1 + MVA%)`.
 */
export function calcBaseIcmsSt(params: {
  merchandiseValue: number
  ipiValue: number
  freight: number
  insurance: number
  other: number
  baseReductionPct: number
  mvaPct: number
}): number {
  const gross = params.merchandiseValue + params.ipiValue + params.freight + params.insurance + params.other
  const reduced = gross * (1 - params.baseReductionPct / 100)
  return round2(reduced * (1 + params.mvaPct / 100))
}

// ── P2.5 — despacho por CST (regime normal) ─────────────────────────────────

/**
 * Despacho por CST — regime normal (`Pc_RegimeTributarioNormal`, P2.5). A
 * variante MANUAL segue a MESMA regra (decisão do autor, P2.6): só troca a
 * fonte da alíquota — não há branch separado aqui.
 */
export function calcIcms(
  ctx: IcmsCalcContext,
  merchandiseValue: number,
  ipiValue: number,
  freight: number,
  insurance = 0,
  other = 0,
): IcmsCalcResult {
  const includeIpi = icmsIpiIntegratesBase({
    destinationIsContributor: ctx.destinationIsContributor,
    purpose: ctx.purpose,
    ipiValue,
  })
  const baseIcmsOf = (includeFreight: boolean, baseReductionPct: number) => calcBaseIcms({
    merchandiseValue, ipiValue, includeIpi, freight, includeFreight, baseReductionPct,
  })
  const stOf = (baseReductionPct: number) => {
    if (ctx.stAliq === null || ctx.mvaPct === null) return undefined
    const baseSt = calcBaseIcmsSt({
      merchandiseValue, ipiValue, freight, insurance, other,
      baseReductionPct, mvaPct: ctx.mvaPct,
    })
    return { baseSt, valueSt: round2(baseSt * (ctx.stAliq / 100)) }
  }

  switch (ctx.cst) {
    case '00': {
      const base = baseIcmsOf(false, 0)
      const aliq = round2(ctx.aliq - ctx.aliqReduction)
      return { base, aliq, value: round2(base * aliq / 100) }
    }
    case '10': {
      const base = baseIcmsOf(false, 0)
      const value = round2(base * ctx.aliq / 100)
      const st = ctx.destinationIsResale ? stOf(0) : undefined // "só se Revenda" (P2.5)
      return { base, aliq: ctx.aliq, value, baseSt: st?.baseSt, valueSt: st?.valueSt }
    }
    case '20': {
      const base = baseIcmsOf(false, ctx.baseReduction)
      return { base, aliq: ctx.aliq, value: round2(base * ctx.aliq / 100) }
    }
    case '30': {
      // Isento de ICMS próprio; calcula "temporário" só p/ apurar o ST e zera o normal (P2.5).
      const st = stOf(ctx.stBaseReduction)
      return { base: 0, aliq: 0, value: 0, baseSt: st?.baseSt, valueSt: st?.valueSt }
    }
    case '40':
    case '41':
    case '50':
      return { base: 0, aliq: 0, value: 0 } // isenta/não tributada/suspensão — sai sem calcular
    case '51': {
      const base = baseIcmsOf(true, 0) // única que passa frete à base (P2.5)
      const operationValue = round2(base * ctx.aliq / 100)
      const deferredValue = round2(operationValue * ctx.deferredAliqPct / 100)
      return {
        base, aliq: ctx.aliq, operationValue, deferredValue,
        value: round2(operationValue - deferredValue),
      }
    }
    case '60':
      return { base: 0, aliq: 0, value: 0 } // ST já retido antes — rastreio é frente própria (P2.8, fora desta onda)
    case '70': {
      const base = baseIcmsOf(false, ctx.baseReduction)
      const value = round2(base * ctx.aliq / 100)
      const st = ctx.destinationIsResale ? stOf(ctx.stBaseReduction) : undefined
      return { base, aliq: ctx.aliq, value, baseSt: st?.baseSt, valueSt: st?.valueSt }
    }
    case '90': {
      const base = baseIcmsOf(false, ctx.baseReduction)
      const aliq = round2(ctx.aliq - ctx.aliqReduction)
      return { base, aliq, value: round2(base * aliq / 100) }
    }
    default:
      return { base: 0, aliq: 0, value: 0 }
  }
}

// ── P2.9 — despacho por CSOSN (Simples Nacional) ────────────────────────────

/**
 * Quem some (base/aliq/valor zerados) e quem sobrevive por grupo CSOSN —
 * evidência `Pc_RegimeTributarioSimplesNacional` (:2797-2935). `icms` e `st`
 * controlam o ICMS próprio e o ST calculados ANTES do despacho (mesma base
 * de CST); `credit` controla se o crédito SN informativo sobrevive. Achados
 * literais do legado, não "corrigidos": CSOSN 400 NÃO zera o ICMS próprio
 * (só o ST); CSOSN 500 NÃO zera o crédito (só ZeraValoresICMS/ST rodam lá).
 */
const CSOSN_GROUPS: Record<string, { icms: boolean; st: boolean; credit: boolean }> = {
  '101': { icms: false, st: false, credit: true },
  '102': { icms: false, st: false, credit: false },
  '103': { icms: false, st: false, credit: false },
  '300': { icms: false, st: false, credit: false },
  '400': { icms: true, st: false, credit: false },
  '201': { icms: false, st: true, credit: true },
  '202': { icms: false, st: true, credit: false },
  '203': { icms: false, st: true, credit: false },
  '500': { icms: false, st: false, credit: true },
  '900': { icms: true, st: true, credit: true },
}

/**
 * `Pc_RegimeTributarioSimplesNacional` (P2.9). Base SEMPRE inclui IPI (regra
 * do art. 155 §2º XI, igual ao CST) e frete (a ÚNICA outra exceção além do
 * CST 51 — `Fn_CalcBaseICMS(pRedBC, vIPI, vFrete)` chamada com frete
 * incondicional). `vICMSOp` e o crédito SN são calculados ANTES do
 * despacho e sobrevivem ao zeramento do grupo conforme `CSOSN_GROUPS`.
 */
export function calcIcmsCsosn(
  ctx: IcmsCalcContext,
  merchandiseValue: number,
  ipiValue: number,
  freight: number,
  insurance = 0,
  other = 0,
): IcmsCalcResult {
  const group = CSOSN_GROUPS[ctx.csosn ?? '']
  const includeIpi = icmsIpiIntegratesBase({
    destinationIsContributor: ctx.destinationIsContributor,
    purpose: ctx.purpose,
    ipiValue,
  })
  const base = calcBaseIcms({
    merchandiseValue, ipiValue, includeIpi, freight, includeFreight: true,
    baseReductionPct: ctx.baseReduction,
  })
  const operationValue = round2(base * ctx.aliq / 100)
  const deferredValue = ctx.destinationIsResale
    ? round2(operationValue * ctx.deferredAliqPct / 100) : 0
  const value = round2(operationValue - deferredValue)

  const creditAliq = round2(ctx.creditAliqPct ?? 0)
  const creditValue = round2(merchandiseValue * (ctx.creditAliqPct ?? 0) / 100)

  let baseSt: number | undefined
  let valueSt: number | undefined
  if (ctx.stAliq !== null && ctx.mvaPct !== null) {
    baseSt = calcBaseIcmsSt({
      merchandiseValue, ipiValue, freight, insurance, other,
      baseReductionPct: ctx.stBaseReduction, mvaPct: ctx.mvaPct,
    })
    valueSt = round2(baseSt * (ctx.stAliq / 100) - value)
  }

  return {
    base: group?.icms ? base : 0,
    aliq: group?.icms ? ctx.aliq : 0,
    value: group?.icms ? value : 0,
    operationValue,
    deferredValue,
    baseSt: group?.st ? baseSt : undefined,
    valueSt: group?.st ? valueSt : undefined,
    creditAliq: group?.credit ? creditAliq : undefined,
    creditValue: group?.credit ? creditValue : undefined,
  }
}

// ── P7.3 — FCP (calculado ANTES do regime; entra na composição do ST) ─────

const FCP_PROPRIO_CSTS = ['00', '10', '20', '51', '70', '90']
const FCP_ST_CSTS = ['10', '30', '70', '90']
const FCP_PROPRIO_CSOSN = ['101', '102', '103', '900']
const FCP_ST_CSOSN = ['201', '202', '203', '900']

/** FCP próprio: `base = mercadoria; valor = base × alíq`. Aceita CST ou CSOSN. */
export function calcFcpProprio(regimeCode: string, merchandiseValue: number, aliqFcp: number | null): FcpCalcResult | undefined {
  const eligible = FCP_PROPRIO_CSTS.includes(regimeCode) || FCP_PROPRIO_CSOSN.includes(regimeCode)
  if (!aliqFcp || aliqFcp <= 0 || !eligible) return undefined
  return { base: round2(merchandiseValue), value: round2(merchandiseValue * aliqFcp / 100) }
}

/**
 * FCP-ST: decisão 7/Q30 — usa a MESMA base do ICMS-ST (unificado; o legado
 * divergia comentando seguro/outras — divergência corrigida na web). Aceita
 * CST ou CSOSN.
 */
export function calcFcpSt(regimeCode: string, baseIcmsSt: number | undefined, aliqFcpSt: number | null): FcpCalcResult | undefined {
  const eligible = FCP_ST_CSTS.includes(regimeCode) || FCP_ST_CSOSN.includes(regimeCode)
  if (!aliqFcpSt || aliqFcpSt <= 0 || baseIcmsSt === undefined || !eligible) return undefined
  return { base: round2(baseIcmsSt), value: round2(baseIcmsSt * aliqFcpSt / 100) }
}

// ── P4 — IPI ─────────────────────────────────────────────────────────────

const IPI_CALCULATING_CSTS = ['00', '49', '50', '99']

/**
 * `Pc_DefineIPI` (P4). Base fiel à decisão 5/Q25 (RIPI art.190 + STF RE
 * 567.935): mercadoria líquida de desconto incondicional (já embutido em
 * `merchandiseValue`) + frete + seguro + acessórias. Só os CSTs 00/49/50/99
 * calculam valor; demais só levam o CST (sem valores).
 */
export function calcIpi(ctx: IpiCalcContext, merchandiseValue: number, freight: number, insurance: number, other: number): IpiCalcResult {
  if (!IPI_CALCULATING_CSTS.includes(ctx.cst)) {
    return { base: 0, aliq: 0, value: 0 }
  }
  const base = round2(merchandiseValue + freight + insurance + other)
  return { base, aliq: ctx.aliq, value: round2(base * ctx.aliq / 100) }
}

// ── P5 — PIS/COFINS (decisão 2/Q24: UMA fórmula para os dois) ─────────────

/**
 * `Pc_DefinePIS`/`Pc_DefineCOFINS` (P5), unificados pela decisão 2/Q24 (o
 * BUG do legado — CST 99 não calculava vPIS — não é reproduzido: PIS = COFINS).
 * CST 01/02 e "demais": ad valorem (`base = mercadoria`). CST 03: por
 * quantidade (`aliq × quantidade`, sem base percentual). CST 99: ad valorem
 * se a base calculada for > 0, senão por quantidade.
 */
export function calcPisCofins(ctx: PisCofinsCalcContext, merchandiseValue: number): PisCofinsCalcResult {
  const adValorem = (): PisCofinsCalcResult => {
    const base = round2(merchandiseValue)
    return { kind: ctx.kind, base, aliq: ctx.aliq, value: round2(base * ctx.aliq / 100) }
  }
  const byQuantity = (): PisCofinsCalcResult => {
    const quantity = ctx.quantity ?? 0
    const unitAliqValue = ctx.unitAliqValue ?? 0
    return { kind: ctx.kind, base: 0, aliq: unitAliqValue, value: round2(quantity * unitAliqValue) }
  }

  if (ctx.cst === '03') return byQuantity()
  if (ctx.cst === '99') return merchandiseValue > 0 ? adValorem() : byQuantity()
  return adValorem() // 01/02 e demais
}

// ── P9 — Importação (II — só ad valorem nesta onda; DI/adições = frente própria) ─

/** `Pc_DefineII` (P9) + peça II completa (decisão 11/Q32: AFRMM/SISCOMEX/IRPJ/CSLL). */
export function calcIi(ctx: IiCalcContext, merchandiseValue: number): IiCalcResult {
  const base = round2(merchandiseValue)
  const applyAliq = (aliq: number | null) => round2(base * (aliq ?? 0) / 100)
  return {
    base,
    iiValue: applyAliq(ctx.iiAliq),
    irpjValue: applyAliq(ctx.irpjAliq),
    csllValue: applyAliq(ctx.csllAliq),
    afrmmValue: applyAliq(ctx.afrmmAliq),
    siscomexValue: applyAliq(ctx.siscomexAliq),
  }
}

// ── P6.1 — ISSQN (só item kind 'S'; alíquota vem da CIDADE, não da regra) ──

export function calcIssqn(ctx: IssqnCalcContext, merchandiseValue: number): IssqnCalcResult {
  const base = round2(merchandiseValue)
  const value = round2(base * ctx.cityAliqPct / 100)
  return {
    base, aliq: ctx.cityAliqPct, value,
    withheldValue: ctx.withheld ? value : 0,
  }
}

// ── T1 — orquestrador: aplica a ordem de dependências do item ──────────────

/**
 * Aplica a ordem T1 (não estética — cada posição depende da anterior):
 * IPI → ICMS (com FCP calculado antes do regime, entrando na base do ST) →
 * II → PIS/COFINS → ISSQN (se `kind === 'S'`). IBS/CBS fica fora desta onda
 * (P10 — stub aguardando regulamento).
 *
 * Peça AUSENTE em `input` = tributo não incide (presença = incidência,
 * decisão 1) — nunca calculado, mesmo que os dados estejam disponíveis.
 */
export function calculateItemTaxes(input: ItemTaxCalcInput): ItemTaxCalcResult {
  const result: ItemTaxCalcResult = {}

  const ipi = input.ipi
    ? calcIpi(input.ipi, input.merchandiseValue, input.freight, input.insurance, input.other)
    : undefined
  if (ipi) result.ipi = ipi
  const ipiValue = ipi?.value ?? 0

  if (input.icms) {
    const icms = input.icms.csosn
      ? calcIcmsCsosn(input.icms, input.merchandiseValue, ipiValue, input.freight, input.insurance, input.other)
      : calcIcms(input.icms, input.merchandiseValue, ipiValue, input.freight, input.insurance, input.other)
    result.icms = icms

    if (input.fcp) {
      const regimeCode = input.icms.csosn ?? input.icms.cst
      result.fcp = calcFcpProprio(regimeCode, input.merchandiseValue, input.fcp.aliqFcp)
      result.fcpSt = calcFcpSt(regimeCode, icms.baseSt, input.fcp.aliqFcpSt)
    }
  }

  if (input.ii) {
    result.ii = calcIi(input.ii, input.merchandiseValue)
  }

  if (input.pisCofins?.length) {
    result.pisCofins = input.pisCofins.map((piece) => calcPisCofins(piece, input.merchandiseValue))
  }

  if (input.kind === 'S' && input.issqn) {
    result.issqn = calcIssqn(input.issqn, input.merchandiseValue)
  }

  return result
}
