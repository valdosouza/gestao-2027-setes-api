import { readServicePresumptions, PresumptionRequest, Queryable } from '@shared/service-ibscbs'
import { invoiceEmissionDateFor } from '@shared/invoice/emission-date'
import { emitterRegimeAt } from '@shared/entity-tax/entity-tax.repository'
import {
  MODEL_NFSE, ibscbsObligationStart, evaluateIbscbsDeclaration, assertIbscbsDeclarable,
  IbscbsDeclaration, IbscbsEvaluation, IbscbsOmission,
} from '@shared/ibscbs-classification'

/**
 * COMPOSIÇÃO @shared/service-ibscbs-declaration (fase IBS/CBS, IB-2 — prompt_fase_ibs_cbs.md §12.3; D-IB71): só
 * COMBINA as três peças — presunção do serviço (`@shared/service-ibscbs`), enquadramento do emitente na data
 * (`@shared/entity-tax`) e a REGRA da declaração (`@shared/ibscbs-classification`) — sem regra própria. É a ÚNICA
 * porta pela qual os DOIS produtores do ramo de serviço (billing da venda e faturamento da OS — a Setes fatura pela OS)
 * decidem o que congelar (D-IB9 — nunca regra copiada em cada produtor), e o pré-voo pergunta pela mesma (D-IB72).
 *
 * - `competenceDate` = a data de EMISSÃO que o produtor calculou UMA vez e passa também ao `issueInvoice` (D-IB64:
 *   `dCompet` = `dt_emission`; nunca a competência do CONTRATO).
 * - Modelo SEMPRE SE: o ramo de serviço vai ao fisco como NFS-e mesmo na conjugada da venda (model 55).
 * - D-IB68: vale para toda nota SE faturada pelo ERP — o setes-api não lê a habilitação do `fiscal_api`.
 */

export interface ServiceIbscbsInput {
  /** Serviços da nota (um pedido por item; a presunção é por produto). */
  items:          readonly PresumptionRequest[]
  /** Data da competência fiscal da nota (= `dt_emission`). */
  competenceDate: string
}

/** Avalia sem decidir (o pré-voo — D-IB72; sem trava quando `lock` = false). */
export async function evaluateServiceIbscbs(
  q: Queryable, schemaName: string, institutionId: number, input: ServiceIbscbsInput, opts: { lock: boolean },
): Promise<IbscbsEvaluation> {
  const presumptions = await readServicePresumptions(q, schemaName, institutionId, input.items, opts)
  const regime = await emitterRegimeAt(q, schemaName, institutionId, input.competenceDate, opts)
  return evaluateIbscbsDeclaration(
    q, presumptions, input.competenceDate, ibscbsObligationStart(MODEL_NFSE, regime),
    { regimeUnknown: regime.simplesRegime === null })   // D-IB74: a mensagem do 422 diz quando a data veio do regime não informado
}

/**
 * O FATURAMENTO: dentro da transação dele (conexão dela — nunca uma 2ª do pool), depois da trava do pedido e logo antes
 * do `issueInvoice`. Obrigatória e incompleta = 422 (D-IB8/D-IB62/D-IB63); senão, a declaração a congelar no ramo.
 */
export async function declareServiceIbscbs(
  conn: Queryable, schemaName: string, institutionId: number, input: ServiceIbscbsInput,
): Promise<IbscbsDeclaration> {
  return assertIbscbsDeclarable(
    await evaluateServiceIbscbs(conn, schemaName, institutionId, input, { lock: true }))
}

/**
 * IB-3 (D-IB76 — prompt_fase_ibs_cbs.md §13.3): a declaração PREVISTA antes de faturar — a MESMA composição só-pergunta (sem trava), na
 * data que o faturamento usaria (hoje do estabelecimento). O que volta é o que a tela mostra: antes da obrigação um AVISO (a nota sairia
 * sem o grupo — nunca bloqueia); depois, a recusa (o mesmo código e mensagem do 422 do faturamento). Nenhuma regra nova no app.
 */
export interface IbscbsVerdict {
  /** true = a nota sairia COM o grupo IBS/CBS. */
  declared: boolean
  omitted:  IbscbsOmission[]
  refusal:  { code: string; message: string } | null
}

export interface IbscbsPreview extends IbscbsVerdict {
  competenceDate:  string
  obligationStart: string
  obligatory:      boolean
  /**
   * D-IB89 (gates da IB-3): ANTES da obrigação, o veredito da MESMA composição na data da obrigação (o que o lote de janeiro vai encontrar
   * — "hoje sai sem o grupo; a partir de 01/01/2027 seria recusada"). null depois da obrigação (o veredito de hoje já é ele).
   */
  atObligation:    IbscbsVerdict | null
}

export async function previewServiceIbscbs(
  q: Queryable, schemaName: string, institutionId: number, productIds: readonly number[],
): Promise<IbscbsPreview | null> {
  const ids = [...new Set(productIds)]
  if (ids.length === 0) return null
  // a data que o faturamento usaria — pelo DONO ÚNICO da data de emissão (D-IB88; relógio da operação — Q-TZ8)
  const competenceDate = await invoiceEmissionDateFor(schemaName, institutionId, q)
  const items = ids.map(productId => ({ productId, field: `product.${productId}` }))
  const ev = await evaluateServiceIbscbs(q, schemaName, institutionId, { items, competenceDate }, { lock: false })
  const atObligation = ev.obligatory ? null
    : verdictOf(await evaluateServiceIbscbs(q, schemaName, institutionId, { items, competenceDate: ev.obligationStart }, { lock: false }))
  return { competenceDate, obligationStart: ev.obligationStart, obligatory: ev.obligatory, ...verdictOf(ev), atObligation }
}

const verdictOf = (ev: IbscbsEvaluation): IbscbsVerdict => ({
  declared: ev.declaration.group !== null, omitted: [...ev.declaration.omitted],
  refusal: ev.refusal ? { code: ev.refusal.code, message: ev.refusal.message } : null,
})
