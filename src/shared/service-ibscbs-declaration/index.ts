import { readServicePresumptions, PresumptionRequest, Queryable } from '@shared/service-ibscbs'
import { emitterRegimeAt } from '@shared/entity-tax/entity-tax.repository'
import {
  MODEL_NFSE, ibscbsObligationStart, evaluateIbscbsDeclaration, assertIbscbsDeclarable,
  IbscbsDeclaration, IbscbsEvaluation,
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
