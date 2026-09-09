import { HttpError } from '@shared/errors/http-error'
import {
  findTaxRule, loadPieces, calculateItemTaxes, prorateWithResidue,
  calcMerchandiseValue, TaxRuleMatchCriteria, TaxRulePieces,
  ItemTaxCalcInput, icmsMissingCodeForCrt,
} from '@shared/tax-rule'
import { getEntityTax } from '@shared/entity-tax/entity-tax.repository'
import {
  resolveServiceTaxRule, getServiceTaxRuleById, checkServiceRule,
  serviceRuleProblemMessage, ServiceTaxRuleResolved,
} from '@shared/service-tax-rule'
import { getConfigContent } from '@shared/interface-config'
import { InstitutionPayload } from '@shared/types/express'
import { resolveMvaAliq, resolveFcpAliq } from '@modules/state-tax-rates/state-tax-rates.repository'
import pool from '@shared/db/connection'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { cancelInvoice, CancelInvoiceResult } from '@shared/invoice'
import { CancelBody } from './billing.dto'
import { resolveOrderParcels, MaterializedParcel as ResolvedParcel } from '@shared/order-installment'
import { hasServiceOrderCycle } from '@shared/service-order'
import { Queryable } from '@shared/order'
import {
  parseCrt, adjustMva, resolveFinancialPolarity,
} from './billing.context'
import {
  getOrderStatus, getOrderBranch, listBillingItems, getItemRuleLinks,
  upsertItemRuleAuto, clearAutoRuleLink, findDeadRuleIds,
  getItemServiceRuleLinks, upsertItemServiceRuleAuto, clearAutoServiceRuleLink,
  getFreightAndExpenses,
  getEntityLocation, persistInvoice, ComputedItem,
  OrderBranchInfo,
  getGeneralObservations, getRuleObservationNotes, getNcmApproxRates,
  getPaymentTypeKinds,
  hasOrderBilling,
} from './billing.repository'
import {
  buildRegimeObservations, buildIssqnObservation, buildApproxTaxObservation,
  calcApproxTaxAliq, ObsRegimeItem,
} from './billing.observations'
import {
  buildReturnPlan, getSaleOrderInfo, getAnchor, ReturnPlan,
} from '@shared/order-return'
import {
  resolveCommissionAliq, getPostedItemCommissions, CommissionEntryInput,
} from '@shared/commission'
import {
  ValidationReport, ValidationIssue, InvoiceResult, BillingOrderItem,
} from './billing.interface'
import { ValidateBodyDto, InvoiceBodyDto } from './billing.dto'

/**
 * Orquestração do faturamento (W2 Onda 3, rodada R4):
 * - validateOrder: valida TUDO em lote (lista completa, nunca para na 1ª) e
 *   grava a regra achada por item (origin 'A'; 'M' nunca é sobrescrito).
 * - invoiceOrder: fatura consumindo as regras GRAVADAS (sem rebuscar — item
 *   sem linha = 422 REQUIRES_VALIDATION), calcula por item (@shared/tax-rule),
 *   grava impostos + nota + financeiro em UMA transação.
 */

const MERCHANDISE_KINDS = ['Sale', 'Purchase', 'Adjust']

interface BillingContext {
  branch: OrderBranchInfo
  emitterCrt: string | null
  emitterStateId: number | null
  recipientCityId: number | null
  recipientStateId: number | null
  recipientConsumer: 'S' | 'N'
  recipientSimples: 'S' | 'N'
  recipientContributor: boolean
  recipientByPassSt: 'S' | 'N'
  recipientIssRetido: boolean
}

async function loadContext(
  schemaName: string, institutionId: number, branch: OrderBranchInfo
): Promise<{ ctx: BillingContext; issues: ValidationIssue[] }> {
  const issues: ValidationIssue[] = []

  // Convenção confirmada (R4): tb_institution.id = tb_entity.id
  const emitterTax = await getEntityTax(schemaName, institutionId, institutionId)
  const emitterLoc = await getEntityLocation(institutionId)
  const crt = parseCrt(emitterTax?.taxRegime)

  if (!emitterTax) {
    issues.push({ scope: 'emitter', field: 'taxRegime',
      message: 'Emitente sem tributação configurada (aba Tributação do cadastro)' })
  } else if (crt === null) {
    issues.push({ scope: 'emitter', field: 'taxRegime',
      message: 'Regime tributário do emitente inválido — informe o regime (1/2/3)' })
  }
  if (!emitterLoc || !emitterLoc.stateId) {
    issues.push({ scope: 'emitter', field: 'address',
      message: 'Emitente sem endereço principal com UF' })
  }

  const recipientTax = await getEntityTax(schemaName, institutionId, branch.recipientEntityId)
  const recipientLoc = await getEntityLocation(branch.recipientEntityId)
  if (!recipientLoc || !recipientLoc.stateId) {
    issues.push({ scope: 'recipient', field: 'address',
      message: 'Destinatário sem endereço principal com UF' })
  }
  if (!recipientTax) {
    // sem a aba Tributação o match roda com defaults silenciosos
    // (não consumidor/não Simples/não contribuinte) — pode casar regra errada
    issues.push({ scope: 'recipient', field: 'taxRegime',
      message: 'Destinatário sem tributação configurada (aba Tributação do cadastro)' })
  }

  const ctx: BillingContext = {
    branch,
    emitterCrt: crt,
    emitterStateId: emitterLoc?.stateId ?? null,
    recipientCityId: recipientLoc?.cityId ?? null,
    recipientStateId: recipientLoc?.stateId ?? null,
    recipientConsumer: recipientTax?.consumer === 'S' ? 'S' : 'N',
    // Simples do DESTINATÁRIO no seletor da regra (T5) — regime 1 = optante
    recipientSimples: parseCrt(recipientTax?.taxRegime) === '1' ? 'S' : 'N',
    recipientContributor: recipientTax?.indIeDest === '1',
    recipientByPassSt: recipientTax?.byPassSt === 'S' ? 'S' : 'N',
    recipientIssRetido: recipientTax?.issRetido === 'S',
  }
  return { ctx, issues }
}

function buildCriteria(
  item: BillingOrderItem, ctx: BillingContext, institutionId: number,
  adjustment: { cfopId: string } | null | undefined,
  manualRuleId: number | null
): TaxRuleMatchCriteria {
  const isAdjust = ctx.branch.branch === 'adjust'
  return {
    institutionId,
    productId: item.productId,
    productNcm: item.ncm,
    productOrigin: item.origin ?? '0',
    productSt: item.merchandiseSt,
    purpose: isAdjust ? '0' : (item.purpose ?? '0'),
    entityId: ctx.branch.recipientEntityId,
    customerIgnoreSt: ctx.recipientByPassSt,
    finalConsumer: ctx.recipientConsumer,
    simples: ctx.recipientSimples,
    // direção sempre do RAMO (fonte única — a do ajuste é gravada na
    // abertura pelo order-returns; parecer 2026-08-24)
    direction: ctx.branch.direction,
    destinationStateId: ctx.recipientStateId ?? 0,
    emitterStateId: ctx.emitterStateId ?? 0,
    cfopId: isAdjust ? adjustment?.cfopId ?? null : null,
    directRuleId: manualRuleId,
  }
}

export async function validateOrder(
  institution: InstitutionPayload, input: ValidateBodyDto
): Promise<ValidationReport> {
  const { schemaName, institutionId } = institution
  const issues: ValidationIssue[] = []

  const status = await getOrderStatus(schemaName, institutionId, input.orderId)
  if (status === null) throw new HttpError(404, `Ordem ${input.orderId} não encontrada`)
  if (status === 'F') {
    throw new HttpError(409, 'Ordem já faturada', undefined, 'ORDER_INVOICED')
  }

  const branch = await getOrderBranch(schemaName, institutionId, input.orderId)
  if (!branch) {
    throw new HttpError(422, 'Ordem sem ramo (venda/compra/ajuste/serviço)',
      [{ field: 'orderId', message: 'Ramo da ordem não identificado' }], 'ORDER_NO_BRANCH')
  }
  if (branch.branch === 'service' && await hasServiceOrderCycle(schemaName, institutionId, input.orderId)) {
    // Q-A11: ordem de SERVIÇO (ciclo vivo) fatura pelo próprio módulo
    throw new HttpError(409, 'Ordem de serviço fatura pelo módulo de OS (POST /api/service-orders/:id/invoice)',
      undefined, 'SERVICE_ORDER_OWN_ENDPOINT')
  }
  if (branch.branch === 'adjust' && !input.adjustment) {
    issues.push({ scope: 'order', field: 'adjustment',
      message: 'Ordem de ajuste exige CFOP no faturamento' })
  }

  const { ctx, issues: ctxIssues } = await loadContext(schemaName, institutionId, branch)
  issues.push(...ctxIssues)

  const items = await listBillingItems(schemaName, institutionId, input.orderId)
  if (items.length === 0) {
    issues.push({ scope: 'order', field: 'items', message: 'Ordem sem itens vivos' })
  }

  // Devolução de mercadoria (rodada 2026-08-24): a ÂNCORA gravada na
  // abertura identifica a devolução (fonte única — nada viaja no payload);
  // mesmas regras do legado, em lote — origem faturada/mesmo cliente,
  // itens ⊆ origem, qtde ≤ saldo devolvível (acumulado), valor ≤ origem.
  if (branch.branch === 'adjust') {
    const anchor = await getAnchor(schemaName, institutionId, input.orderId)
    if (anchor && branch.direction !== 'E') {
      issues.push({ scope: 'order', field: 'adjustment',
        message: 'Devolução de mercadoria exige ajuste de ENTRADA' })
    } else if (anchor) {
      // devolução de MERCADORIA — item de serviço fica fora do plano
      // (achado LOW do gate adversarial 2026-08-24)
      const { issues: retIssues } = await buildReturnPlan(
        schemaName, institutionId, anchor.orderIdOri,
        branch.recipientEntityId,
        items.filter(i => i.productKind !== 'S')
          .map(i => ({ id: i.id, kind: i.kind, productId: i.productId,
            quantity: i.quantity, unitValue: i.unitValue })))
      issues.push(...retIssues.map(ri => ({
        scope: (ri.itemId !== undefined ? 'item' : 'order') as 'item' | 'order',
        itemId: ri.itemId, field: ri.field, message: ri.message,
      })))
    }
  }

  const links = await getItemRuleLinks(schemaName, institutionId, input.orderId)
  const manualByItem = new Map(
    links.filter(l => l.origin === 'M').map(l => [`${l.orderItemId}|${l.kind}`, l]))
  // Onda 3 (regra de serviço — D6/D12/D14): vínculo irmão por item; só
  // consultado quando a ordem tem serviço (ordens só-mercadoria não pagam).
  const hasService = items.some(i => i.productKind === 'S')
  const serviceLinks = hasService
    ? await getItemServiceRuleLinks(schemaName, institutionId, input.orderId) : []
  const serviceManualByItem = new Map(
    serviceLinks.filter(l => l.origin === 'M').map(l => [`${l.orderItemId}|${l.kind}`, l]))

  let rulesResolved = 0
  let rulesManual = 0

  // D42 — regra casada precisa do código do regime VIGENTE do emitente
  // (Simples = CSOSN, Normal = CST): a troca de regime no cadastro do
  // estabelecimento zera o código antigo e a regra fica pendente até a
  // revisão. Sem o check, o cálculo despacharia pelo código restante e a
  // nota sairia no regime errado em silêncio.
  const validatePiecesCache = new Map<number, TaxRulePieces>()
  const ruleMissingCode = async (ruleId: number): Promise<'csosn' | 'cst' | null> => {
    let pieces = validatePiecesCache.get(ruleId)
    if (!pieces) {
      pieces = (await loadPieces(schemaName, ruleId)) ?? {}
      validatePiecesCache.set(ruleId, pieces)
    }
    return icmsMissingCodeForCrt(pieces, ctx.emitterCrt)
  }
  const missingCodeMessage = (itemId: number, ruleId: number, code: 'csosn' | 'cst') =>
    `Item ${itemId}: regra de tributação ${ruleId} sem ${code === 'csosn'
      ? 'CSOSN (emitente no Simples Nacional)'
      : 'CST (emitente no Regime Normal)'} — revise as regras de tributação para o regime atual`

  for (const item of items) {
    if (item.productKind === 'S') {
      // Serviço: regra APONTADA pelo cadastro (D1) ou RegraDireta 'M' (D14);
      // sem regra / inativa / cidade ≠ tomador = pendência (D6/D12). Vínculo
      // 'A' só sobrevive quando a regra passa — sem link o /invoice devolve
      // 422 REQUIRES_VALIDATION (a "interrupção do faturamento").
      const svcManual = serviceManualByItem.get(`${item.id}|${item.kind}`)
      const rule = svcManual
        ? await getServiceTaxRuleById(schemaName, institutionId, svcManual.serviceTaxRuleId)
        : await resolveServiceTaxRule(schemaName, institutionId, item.productId)
      const problem = checkServiceRule(rule, ctx.recipientCityId)
      if (problem) {
        if (!svcManual) {
          await clearAutoServiceRuleLink(
            schemaName, institutionId, input.orderId, item.id, item.kind)
        }
        issues.push({ scope: 'item', itemId: item.id, field: 'serviceTaxRule',
          message: serviceRuleProblemMessage(item.id, problem, rule) })
        continue
      }
      if (svcManual) {
        rulesManual++
      } else {
        await upsertItemServiceRuleAuto(
          schemaName, institutionId, input.orderId, item.id, item.kind, rule!.id)
        rulesResolved++
      }
      continue
    }
    if (!MERCHANDISE_KINDS.includes(item.kind)) continue

    if (item.ncm === null || item.ncm === '') {
      issues.push({ scope: 'item', itemId: item.id, field: 'ncm',
        message: `Item ${item.id}: produto sem NCM no cadastro` })
    }

    const manual = manualByItem.get(`${item.id}|${item.kind}`)
    if (manual) {
      // RegraDireta — escolha do cliente: o vínculo 'M' é intocável, mas a
      // incoerência com o regime vira pendência do mesmo jeito (D42).
      const missing = await ruleMissingCode(manual.taxRuleId)
      if (missing) {
        issues.push({ scope: 'item', itemId: item.id, field: 'taxRule',
          message: missingCodeMessage(item.id, manual.taxRuleId, missing) })
      }
      rulesManual++
      continue
    }

    if (ctx.recipientStateId === null || ctx.emitterStateId === null) continue

    const criteria = buildCriteria(item, ctx, institutionId, input.adjustment, null)
    const rule = await findTaxRule(schemaName, criteria)
    if (rule) {
      // D42: regra incompleta para o regime NÃO grava o link 'A' — sem
      // link o /invoice devolve 422 REQUIRES_VALIDATION (é a "interrupção
      // do faturamento" prometida no aviso do cadastro).
      const missing = await ruleMissingCode(rule.id)
      if (missing) {
        await clearAutoRuleLink(
          schemaName, institutionId, input.orderId, item.id, item.kind)
        issues.push({ scope: 'item', itemId: item.id, field: 'taxRule',
          message: missingCodeMessage(item.id, rule.id, missing) })
        continue
      }
      await upsertItemRuleAuto(
        schemaName, institutionId, input.orderId, item.id, item.kind,
        rule.id, rule.cfopId)
      rulesResolved++
    } else {
      // link 'A' de validação anterior NÃO sobrevive a um match que falhou
      // (senão o /invoice faturaria com a regra velha — issue e fatura
      // passando juntas). 'M' é intocável.
      await clearAutoRuleLink(
        schemaName, institutionId, input.orderId, item.id, item.kind)
      // conteúdo do alerta do legado (§3): produto + critérios do destinatário
      issues.push({ scope: 'item', itemId: item.id, field: 'taxRule',
        message: `Item ${item.id} (produto ${item.productId}): nenhuma regra de tributação encontrada — ` +
          `NCM ${item.ncm ?? '—'}, origem ${criteria.productOrigin}, ST ${criteria.productSt}, ` +
          `finalidade ${criteria.purpose}, sentido ${criteria.direction}, ` +
          `consumidor final ${criteria.finalConsumer}, Simples ${criteria.simples}, ` +
          `UF destino ${criteria.destinationStateId}` })
    }
  }

  // Q-A8: condições de cobrança são pré-requisito do faturamento — a tela
  // descobre AQUI, não no 422 do invoice.
  if (!(await hasOrderBilling(schemaName, institutionId, input.orderId))) {
    issues.push({ scope: 'order', field: 'billing',
      message: 'Ordem sem condições de cobrança (forma de pagamento/prazo) — negocie antes de faturar' })
  }

  return { orderId: input.orderId, branch: branch.branch, issues, rulesResolved, rulesManual }
}

export async function invoiceOrder(
  institution: InstitutionPayload, input: InvoiceBodyDto
): Promise<InvoiceResult> {
  const { schemaName, institutionId } = institution

  const status = await getOrderStatus(schemaName, institutionId, input.orderId)
  if (status === null) throw new HttpError(404, `Ordem ${input.orderId} não encontrada`)
  if (status === 'F') throw new HttpError(409, 'Ordem já faturada', undefined, 'ORDER_INVOICED')

  const branch = await getOrderBranch(schemaName, institutionId, input.orderId)
  if (!branch) {
    throw new HttpError(422, 'Ordem sem ramo identificado',
      [{ field: 'orderId', message: 'Ramo da ordem não identificado' }], 'ORDER_NO_BRANCH')
  }
  if (branch.branch === 'service' && await hasServiceOrderCycle(schemaName, institutionId, input.orderId)) {
    // Q-A11: ordem de SERVIÇO (ciclo vivo) fatura pelo próprio módulo
    throw new HttpError(409, 'Ordem de serviço fatura pelo módulo de OS (POST /api/service-orders/:id/invoice)',
      undefined, 'SERVICE_ORDER_OWN_ENDPOINT')
  }
  if (branch.branch === 'adjust' && !input.adjustment) {
    throw new HttpError(422, 'Ordem de ajuste exige CFOP',
      [{ field: 'adjustment', message: 'Informe o cfopId' }], 'ADJUST_PARAMS_REQUIRED')
  }

  const { ctx, issues: ctxIssues } = await loadContext(schemaName, institutionId, branch)
  if (ctxIssues.length > 0) {
    throw new HttpError(422, 'Pendências de cadastro impedem o faturamento',
      ctxIssues.map(i => ({ field: i.field ?? i.scope, message: i.message })),
      'REQUIRES_VALIDATION')
  }

  const items = await listBillingItems(schemaName, institutionId, input.orderId)
  if (items.length === 0) {
    throw new HttpError(422, 'Ordem sem itens — nada a faturar',
      [{ field: 'items', message: 'Inclua ao menos um item' }], 'ORDER_NO_ITEMS')
  }

  const links = await getItemRuleLinks(schemaName, institutionId, input.orderId)
  const linkByItem = new Map(links.map(l => [`${l.orderItemId}|${l.kind}`, l]))

  const merchandiseItems = items.filter(
    i => i.productKind !== 'S' && MERCHANDISE_KINDS.includes(i.kind))

  // Onda 3 — serviço exige vínculo gravado pelo /validate (D6) e a regra é
  // REVALIDADA aqui (viva, ativa, cidade = tomador — D12): paridade com o
  // gate duro de NCM/regra da mercadoria.
  const serviceItems = items.filter(i => i.productKind === 'S')
  const serviceRuleByItem = new Map<string, ServiceTaxRuleResolved>()
  if (serviceItems.length > 0) {
    const serviceLinks = await getItemServiceRuleLinks(schemaName, institutionId, input.orderId)
    const serviceLinkByItem = new Map(serviceLinks.map(l => [`${l.orderItemId}|${l.kind}`, l]))
    const missingService = serviceItems.filter(i => !serviceLinkByItem.has(`${i.id}|${i.kind}`))
    if (missingService.length > 0) {
      throw new HttpError(422, 'Serviço sem regra de tributação vinculada — valide a ordem',
        missingService.map(i => ({ field: `item.${i.id}`, message: 'Sem regra de tributação de serviço vinculada' })),
        'REQUIRES_VALIDATION')
    }
    const ruleCache = new Map<number, ServiceTaxRuleResolved | null>()
    for (const item of serviceItems) {
      const link = serviceLinkByItem.get(`${item.id}|${item.kind}`)!
      if (!ruleCache.has(link.serviceTaxRuleId)) {
        ruleCache.set(link.serviceTaxRuleId,
          await getServiceTaxRuleById(schemaName, institutionId, link.serviceTaxRuleId))
      }
      const rule = ruleCache.get(link.serviceTaxRuleId)!
      const problem = checkServiceRule(rule, ctx.recipientCityId)
      if (problem) {
        throw new HttpError(422, 'Regra de tributação de serviço inválida — valide a ordem',
          [{ field: `item.${item.id}`, message: serviceRuleProblemMessage(item.id, problem, rule) }],
          'REQUIRES_VALIDATION')
      }
      serviceRuleByItem.set(`${item.id}|${item.kind}`, rule!)
    }
  }

  // R5-Q3 (evidência Fc_Valida_Itens_Nota): NCM ausente é gate DURO no
  // legado, revalidado no momento de faturar (o /validate pode ter rodado
  // antes do produto ser corrigido/trocado) — não é só aviso.
  const missingNcm = merchandiseItems.filter(i => !i.ncm || i.ncm.trim() === '')
  if (missingNcm.length > 0) {
    throw new HttpError(422, 'Produto sem NCM — não é possível faturar',
      missingNcm.map(i => ({ field: `item.${i.id}`, message: 'NCM ausente no cadastro do produto' })),
      'MISSING_NCM')
  }

  const missing = merchandiseItems.filter(i => !linkByItem.has(`${i.id}|${i.kind}`))
  if (missing.length > 0) {
    throw new HttpError(422, 'Itens sem regra de tributação resolvida — execute a validação',
      missing.map(i => ({ field: `item.${i.id}`, message: 'Sem regra vinculada' })),
      'REQUIRES_VALIDATION')
  }

  // "sem rebuscar" ≠ confiar cegamente na referência: a regra gravada
  // precisa estar VIVA (soft-delete em cascata zeraria as peças e a nota
  // sairia SEM imposto, silenciosamente — achado HIGH dos gates)
  const deadRules = await findDeadRuleIds(
    schemaName, links.map(l => l.taxRuleId).filter(id => id > 0))
  if (deadRules.length > 0) {
    throw new HttpError(422,
      'Regra de tributação vinculada foi excluída — execute a validação novamente',
      deadRules.map(id => ({ field: 'taxRule', message: `Regra ${id} não existe mais` })),
      'REQUIRES_VALIDATION')
  }

  // guarda de sanidade: item com valor líquido negativo corrompe nota E financeiro
  const negative = items.filter(
    i => calcMerchandiseValue(i.unitValue, i.quantity, i.discountValue) < 0)
  if (negative.length > 0) {
    throw new HttpError(422, 'Item com desconto maior que o valor da mercadoria',
      negative.map(i => ({ field: `item.${i.id}`, message: 'Valor líquido negativo' })),
      'NEGATIVE_ITEM_VALUE')
  }

  // Devolução de mercadoria: identificada pela ÂNCORA (fonte única) e
  // gate DURO revalidado no faturamento (mesmo padrão R5-Q3 — não confia
  // só no /validate anterior). Issues = 422.
  let returnPlan: ReturnPlan | null = null
  if (branch.branch === 'adjust') {
    const anchor = await getAnchor(schemaName, institutionId, input.orderId)
    if (anchor) {
      if (branch.direction !== 'E') {
        throw new HttpError(422, 'Devolução de mercadoria exige ajuste de ENTRADA',
          [{ field: 'adjustment', message: 'Sentido do ajuste deve ser E' }],
          'RETURN_REQUIRES_ENTRY')
      }
      const { issues: retIssues, plan } = await buildReturnPlan(
        schemaName, institutionId, anchor.orderIdOri,
        branch.recipientEntityId,
        items.filter(i => i.productKind !== 'S')
          .map(i => ({ id: i.id, kind: i.kind, productId: i.productId,
            quantity: i.quantity, unitValue: i.unitValue })))
      if (retIssues.length > 0 || !plan) {
        throw new HttpError(422, 'Devolução inválida contra o pedido original',
          retIssues.map(ri => ({
            field: ri.itemId !== undefined ? `item.${ri.itemId}` : ri.field,
            message: ri.message,
          })), 'RETURN_INVALID')
      }
      returnPlan = plan
    }
  }

  // rateio T2 sobre TODOS os itens vivos (mercadoria líquida como base)
  const { freight, expenses } = await getFreightAndExpenses(schemaName, institutionId, input.orderId)
  const merchValues = items.map(i => calcMerchandiseValue(i.unitValue, i.quantity, i.discountValue))
  const freightShares = prorateWithResidue(merchValues, freight)
  const expensesShares = prorateWithResidue(merchValues, expenses)

  // P2.9 — alíquota do crédito SN (config única da institution, evidência
  // GRL_G_AQ_CRED_ICMS: o legado lê a MESMA config em venda/compra/ajuste,
  // não é campo da regra nem do produto).
  const creditAliqPct = Number(
    (await getConfigContent(institution, 'billing', 'sn_credit_aliq')) ?? '0')

  const computed: ComputedItem[] = []
  const piecesCache = new Map<number, TaxRulePieces>() // N itens, poucas regras
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx]
    const merchandiseValue = merchValues[idx]
    const isService = item.productKind === 'S'
    const link = linkByItem.get(`${item.id}|${item.kind}`)

    let pieces: TaxRulePieces = {}
    if (link) {
      const cached = piecesCache.get(link.taxRuleId)
      if (cached) {
        pieces = cached
      } else {
        pieces = await loadPieces(schemaName, link.taxRuleId)
        piecesCache.set(link.taxRuleId, pieces)
      }
    }

    // MVA/FCP por UF×NCM: ST pela UF do DESTINATÁRIO; NR (alíquota interna
    // do emitente) pela UF do EMITENTE (P2.7/P3.1)
    let stAliq: number | null = null
    let mvaPct: number | null = null
    let fcpAliq: number | null = null
    let fcpStAliq: number | null = null
    if (!isService && item.ncm && pieces.icmsSt) {
      const mvaDest = await resolveMvaAliq(
        schemaName, institutionId, ctx.recipientStateId!, item.ncm)
      if (mvaDest) {
        stAliq = mvaDest.internalAliq
        if (input.useMvaOriginal) {
          mvaPct = mvaDest.mvaOriginal
        } else {
          const mvaEmit = await resolveMvaAliq(
            schemaName, institutionId, ctx.emitterStateId!, item.ncm)
          const interAliq = pieces.icms?.aliq ?? mvaEmit?.internalAliq ?? 0
          mvaPct = adjustMva(mvaDest.mvaOriginal, interAliq, mvaDest.internalAliq)
        }
      }
    }
    if (!isService && item.ncm) {
      const fcp = await resolveFcpAliq(
        schemaName, institutionId, ctx.recipientStateId!, item.ncm)
      if (fcp) { fcpAliq = fcp.aliq; fcpStAliq = fcp.aliq }
    }

    const calcInput: ItemTaxCalcInput = {
      merchandiseValue,
      freight: freightShares[idx],
      insurance: 0,
      other: expensesShares[idx],
      kind: item.productKind,
      icms: pieces.icms ? {
        cst: pieces.icms.cstNr ?? '',
        csosn: pieces.icms.csosn ?? null,
        aliq: pieces.icms.aliq ?? 0,
        aliqReduction: pieces.icms.aliqReduction ?? 0,
        baseReduction: pieces.icms.baseReduction ?? 0,
        deferredAliqPct: pieces.icms.deferredAliq ?? 0,
        destinationIsResale: ctx.recipientConsumer === 'N',
        destinationIsContributor: ctx.recipientContributor,
        purpose: item.purpose ?? '0',
        stAliq, mvaPct,
        stBaseReduction: pieces.icmsSt?.propagateBaseReduction === 'S'
          ? (pieces.icms.baseReduction ?? 0) : 0,
        creditAliqPct,
      } : undefined,
      fcp: (fcpAliq || fcpStAliq) ? { aliqFcp: fcpAliq, aliqFcpSt: fcpStAliq } : undefined,
      ipi: pieces.ipi ? { cst: pieces.ipi.cst, aliq: pieces.ipi.aliq ?? 0 } : undefined,
      pisCofins: pieces.pisCofins?.map(pc => ({
        kind: pc.kind, cst: pc.cst, aliq: pc.aliq ?? 0,
        quantity: item.quantity, unitAliqValue: item.unitValue,
      })),
      issqn: isService ? {
        aliqPct: serviceRuleByItem.get(`${item.id}|${item.kind}`)!.aliq, // D13: alíquota da REGRA
        deductionValue: item.discountValue,
        withheld: ctx.recipientIssRetido,
      } : undefined,
    }
    const serviceRule = isService ? serviceRuleByItem.get(`${item.id}|${item.kind}`) ?? null : null

    computed.push({
      item,
      link: link ?? {
        orderItemId: item.id, kind: item.kind, taxRuleId: 0,
        cfopId: null, setFinancial: 'S', origin: 'A',
      },
      taxes: calculateItemTaxes(calcInput),
      merchandiseValue,
      freightShare: freightShares[idx],
      expensesShare: expensesShares[idx],
      ipiCst: pieces.ipi?.cst ?? null,
      pisCst: pieces.pisCofins?.find(p => p.kind === 'P')?.cst ?? null,
      cofinsCst: pieces.pisCofins?.find(p => p.kind === 'C')?.cst ?? null,
      icmsExtras: {
        cst: pieces.icms?.cstNr ?? pieces.icms?.csosn ?? null,
        origin: item.origin,
        modBc: pieces.icms?.modBc ?? null,
        modBcSt: pieces.icmsSt?.modBcSt ?? null,
        dischargeId: pieces.icms?.dischargeId ?? null,
        baseReduction: pieces.icms?.baseReduction ?? 0,
        aliqReduction: pieces.icms?.aliqReduction ?? 0,
        stBaseReduction: pieces.icmsSt?.propagateBaseReduction === 'S'
          ? (pieces.icms?.baseReduction ?? 0) : 0,
        mvaPct,
        stAliq,
      },
      issqnExtras: serviceRule
        ? { serviceListId: serviceRule.serviceListId, municipalCode: serviceRule.municipalCode }
        : null,
    })
  }

  // total da nota = mercadorias + frete + despesas + ST + IPI (itens com financeiro)
  const totalValue = round2(
    computed.reduce((sum, ci) => sum + ci.merchandiseValue + ci.freightShare
      + ci.expensesShare + (ci.taxes.icms?.valueSt ?? 0) + (ci.taxes.ipi?.value ?? 0), 0))

  // financeiro (decisão 25 — materialização única): installment elaborado
  // vence; senão o PRAZO gera as parcelas
  const financialBase = round2(computed
    .filter(ci => ci.link.setFinancial !== 'N')
    .reduce((sum, ci) => sum + ci.merchandiseValue + ci.freightShare
      + ci.expensesShare + (ci.taxes.icms?.valueSt ?? 0) + (ci.taxes.ipi?.value ?? 0), 0))

  // Parcelas do pedido — COMPOSIÇÃO única (@shared/order-installment,
  // prompt_negociacao_pedido.md D7, 2026-09-06): elaborado é validado contra
  // a base do PEDIDO (itens + frete — ValidaParcelamento do legado) e a
  // diferença até a base da NOTA (ST/IPI/despesas) entra na 1ª parcela; sem
  // elaborado, o prazo do billing gera sobre a base da NOTA. ORDER_NO_BILLING
  // e INVALID_DEADLINE nascem lá. A mesma função alimenta o preview da tela.
  // Gate socrático 2026-09-06 (TOCTOU): a resolução roda DENTRO da transação
  // do faturamento, depois do FOR UPDATE em tb_order — um PUT da negociação
  // concorrente não pode mais deixar tb_financial nascendo de uma grade que
  // já não existe; o retry em deadlock re-resolve junto com a transação.
  const baseDate = new Date()
  const resolveParcels = async (db: Queryable): Promise<ResolvedParcel[]> => {
    const resolved = await resolveOrderParcels(db, schemaName, institutionId, input.orderId,
      { noteBase: financialBase, baseDate })
    const parcels = resolved.parcels

    // Cheque (D8/D9 — prompt_cheque_rastreabilidade.md): parcela cuja forma
    // resolve para kind='Q' EXIGE cheques no payload cuja soma bata com o
    // valor da parcela; formas de qualquer outro kind não usam este bloco
    // (dados de cheque enviados por engano são ignorados, nunca aceitos).
    if (parcels.length > 0) {
      const typeIds = [...new Set(parcels.map(p => p.paymentTypeId))]
      const kindByType = await getPaymentTypeKinds(typeIds, db)
      for (const p of parcels) {
        if (kindByType.get(p.paymentTypeId) !== 'Q') continue
        const entry = input.checks?.find(c => c.parcel === p.parcel)
        if (!entry || entry.items.length === 0) {
          throw new HttpError(422, `Parcela ${p.parcel} é cheque — informe ao menos um cheque`,
            [{ field: `checks.${p.parcel}`, message: 'Obrigatório' }], 'CHECK_REQUIRED')
        }
        const sum = round2(entry.items.reduce((s, c) => s + c.value, 0))
        if (sum !== p.amount) {
          throw new HttpError(422, 'Soma dos cheques não confere com o valor da parcela',
            [{ field: `checks.${p.parcel}`, expected: p.amount, // Q-N3: a tela corrige sem parse
              message: `Soma dos cheques ${sum} difere do valor da parcela ${p.amount}` }],
            'CHECK_SUM_MISMATCH')
        }
      }
    }
    return parcels
  }

  // model por PRESENÇA de itens (natureza = ramo, D1–D11): mercadoria
  // presente → 55 (o ramo service da conjugada autoriza como NFS-e depois);
  // só serviço → SE (interna, como no Software House)
  const hasMerchandise = computed.some(ci => ci.item.productKind !== 'S')
  const model = hasMerchandise ? '55' : 'SE'
  const serie = (await getConfigContent(institution, 'billing', 'invoice_serie') ?? '1').slice(0, 10)

  // R5-Q1 atualizada pelo parecer 2026-08-24: a direção do ajuste vem do
  // RAMO (gravada na abertura pelo order-returns) — fonte única, o
  // payload não a carrega mais.
  const polarity = resolveFinancialPolarity(branch.branch,
    branch.branch === 'adjust' ? branch.direction : undefined)

  // Motor de observações fiscais (T6/P11) — construído com os itens JÁ
  // calculados; persistido na MESMA transação (padrão do financeiro).
  const ruleIds = [...new Set(computed.map(ci => ci.link.taxRuleId).filter(id => id > 0))]
  const ruleNotes = await getRuleObservationNotes(schemaName, ruleIds)
  const generalNotes = await getGeneralObservations(schemaName, institutionId)

  const regimeItems: ObsRegimeItem[] = computed
    .filter(ci => ci.item.productKind !== 'S')
    .map(ci => ({
      cst: ci.icmsExtras.cst,
      baseSt: ci.taxes.icms?.baseSt ?? null,
      valueSt: ci.taxes.icms?.valueSt ?? null,
      baseReduction: ci.icmsExtras.baseReduction ?? null,
      creditAliq: ci.taxes.icms?.creditAliq ?? null,
      creditValue: ci.taxes.icms?.creditValue ?? null,
      observationNote: ci.link.taxRuleId > 0 ? (ruleNotes.get(ci.link.taxRuleId) ?? null) : null,
    }))
  const regimeTexts = buildRegimeObservations(regimeItems, creditAliqPct)

  const totalWithheldIssqn = round2(computed.reduce(
    (sum, ci) => sum + (ci.taxes.issqn?.withheldValue ?? 0), 0))
  const issqnText = buildIssqnObservation(totalWithheldIssqn)

  // Imposto aproximado (Lei 12.741/2012): percentual PERSISTIDO por item
  // sempre (mesmo padrão do ITF_IMP_APROX do legado — não depende da
  // config); a OBSERVAÇÃO agregada na nota é que é gated por config + só
  // ordem de venda ("natureza contém VENDA" do legado).
  const merchNcmCodes = computed
    .filter(ci => ci.item.productKind !== 'S' && ci.item.ncm)
    .map(ci => ci.item.ncm!)
  const ncmRates = await getNcmApproxRates(merchNcmCodes)
  const approxTaxByItem = new Map<string, number>()
  for (const ci of computed) {
    if (ci.item.productKind === 'S' || !ci.item.ncm) continue
    const rate = ncmRates.get(ci.item.ncm) ?? null
    approxTaxByItem.set(`${ci.item.id}|${ci.item.kind}`,
      calcApproxTaxAliq(ci.item.origin !== '0', rate))
  }

  const approxTaxEnabled = (await getConfigContent(
    institution, 'billing', 'approx_tax_enabled')) === 'S'
  let approxTaxText: string | null = null
  if (approxTaxEnabled && branch.branch === 'sale') {
    const approxItems = computed.filter(ci => ci.item.ncm).map((ci) => {
      const rate = ncmRates.get(ci.item.ncm!) ?? { aliqNac: 0, aliqImp: 0, aliqEst: 0, aliqMun: 0 }
      return {
        merchandiseValue: ci.merchandiseValue,
        aliqNac: ci.item.origin !== '0' ? rate.aliqImp : rate.aliqNac,
        aliqEst: rate.aliqEst, aliqMun: rate.aliqMun,
      }
    })
    approxTaxText = buildApproxTaxObservation(approxItems)
  }

  const noteText = [...generalNotes, ...regimeTexts, issqnText, approxTaxText]
    .filter((t): t is string => !!t).join('\n')

  // ── Comissão por item (Q1/Q2 da rodada 2026-08-24) ──────────────────────
  // Venda: lançamento POSITIVO por item (kind 'F' — faturamento; o modo
  // 'R' fica para a peça completa, Q5). Base = valor líquido do item
  // (qtde × unit − desconto), sem frete/ST/IPI. Alíquota resolvida na hora
  // (vendedor ou produto — semântica do VEN_PROPORCAO); aliq 0 = sem linha.
  const commissions: CommissionEntryInput[] = []
  if (branch.branch === 'sale') {
    const sale = await getSaleOrderInfo(schemaName, institutionId, input.orderId)
    if (sale) {
      // cache por produto×lista — sem ele a nota de N itens relê o mesmo
      // vendedor N vezes (R6 do gate socrático)
      const aliqCache = new Map<string, number>()
      for (const ci of computed) {
        if (ci.merchandiseValue <= 0) continue
        const cacheKey = `${ci.item.productId}|${ci.item.priceListId ?? ''}`
        let aliq = aliqCache.get(cacheKey)
        if (aliq === undefined) {
          aliq = await resolveCommissionAliq(
            schemaName, institutionId, sale.salesmanId, ci.item.productId, ci.item.priceListId)
          aliqCache.set(cacheKey, aliq)
        }
        if (aliq <= 0) continue
        commissions.push({
          kind: 'F', orderId: input.orderId,
          orderItemId: ci.item.id, orderItemKind: ci.item.kind,
          customerId: sale.customerId, salesmanId: sale.salesmanId,
          baseValue: ci.merchandiseValue, aliq,
          value: round2(ci.merchandiseValue * aliq / 100),
        })
      }
    }
  }
  // Devolução: lançamento NEGATIVO por item devolvido, para o vendedor
  // DERIVADO do pedido original (D3). Alíquota = a do lançamento positivo
  // da venda quando existe (espelho fiel do que foi comissionado); venda
  // anterior à peça = resolve pela fonte atual. Corrige o achado literal
  // do legado (estorno da comissão INTEIRA em devolução parcial — Q2).
  if (returnPlan) {
    const posted = await getPostedItemCommissions(
      schemaName, institutionId, returnPlan.orderIdOri)
    const postedByItem = new Map(posted.map(p => [`${p.orderItemId}|${p.orderItemKind}`, p]))
    const computedByItem = new Map(computed.map(ci => [`${ci.item.id}|${ci.item.kind}`, ci]))
    for (const link of returnPlan.links) {
      const ci = computedByItem.get(`${link.itemId}|${link.itemKind}`)
      if (!ci || ci.merchandiseValue <= 0) continue
      const postedEntry = postedByItem.get(`${link.itemIdOri}|${link.kindOri}`)
      const aliq = postedEntry
        ? postedEntry.aliq
        : await resolveCommissionAliq(
            schemaName, institutionId, returnPlan.salesmanId, link.productId, link.priceListIdOri)
      if (aliq <= 0) continue
      commissions.push({
        kind: 'F', orderId: input.orderId,
        orderItemId: link.itemId, orderItemKind: link.itemKind,
        customerId: returnPlan.customerId, salesmanId: returnPlan.salesmanId,
        baseValue: ci.merchandiseValue, aliq,
        value: -round2(ci.merchandiseValue * aliq / 100),
      })
    }
  }

  // D18 (contrato financeiro) / D9 (boleto): "gerar boleto automaticamente
  // no faturamento" é config da interface billing (Framework de Configurações)
  const autoBankSlip =
    (await getConfigContent(institution, 'billing', 'auto_bank_slip')) === 'S'

  return persistInvoice(schemaName, institutionId, {
    orderId: input.orderId,
    autoBankSlip,
    recipientEntityId: branch.recipientEntityId,
    model, serie,
    items: computed,
    totalValue,
    resolveParcels,
    checks: input.checks ?? [],
    financialKind: polarity.kind,
    financialOperation: polarity.operation,
    noteText,
    approxTaxByItem,
    userId: institution.userId,
    commissions,
    returnPlan,
  })
}

/**
 * Cancelamento da nota (prompt_cancelamento_nota.md, Onda 1 — nota NÃO
 * transmitida): a composição @shared/invoice.cancelInvoice faz tudo dentro
 * de UMA transação; deadlock reexecuta do zero (D-G4).
 */
export async function cancelOrderInvoice(
  institution: InstitutionPayload, input: CancelBody
): Promise<CancelInvoiceResult> {
  const { schemaName, institutionId, userId } = institution
  return withDeadlockRetry('cancelamento da nota', { institutionId, orderId: input.orderId }, 3,
    async () => {
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const result = await cancelInvoice(conn, schemaName, institutionId, userId, input)
        await conn.commit()
        return result
      } catch (err: any) {
        await conn.rollback()
        // lock wait → 409 RESOURCE_BUSY é TRANSVERSAL (Q-A3: @shared/db/contention
        // no handleError); aqui só propaga — deadlock reexecuta pelo retry.
        throw err
      } finally {
        conn.release()
      }
    })
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}
