import { HttpError } from '@shared/errors/http-error'
import {
  findTaxRule, loadPieces, calculateItemTaxes, prorateWithResidue,
  calcMerchandiseValue, TaxRuleMatchCriteria, TaxRulePieces,
  ItemTaxCalcInput,
} from '@shared/tax-rule'
import { getEntityTax } from '@shared/entity-tax/entity-tax.repository'
import { getConfigContent } from '@shared/interface-config'
import { InstitutionPayload } from '@shared/types/express'
import { resolveMvaAliq, resolveFcpAliq } from '@modules/state-tax-rates/state-tax-rates.repository'
import { parcelQuotas } from '@modules/service-orders/service-orders.calc'
import { parseCrt, parseDeadline, addDays, adjustMva } from './billing.context'
import {
  getOrderStatus, getOrderBranch, listBillingItems, getItemRuleLinks,
  upsertItemRuleAuto, clearAutoRuleLink, findDeadRuleIds,
  getFreightAndExpenses, getOrderBillingInfo,
  getInstallments, getEntityLocation, persistInvoice, ComputedItem,
  OrderBranchInfo,
} from './billing.repository'
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
  emitterCityIssAliq: number
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
  } else if (crt === '1') {
    issues.push({ scope: 'emitter', field: 'taxRegime',
      message: 'Emitente do Simples Nacional: cálculo por CSOSN ainda não disponível (aguarda a onda CSOSN)' })
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
    emitterCityIssAliq: emitterLoc?.cityIssAliq ?? 0,
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
  adjustment: { direction: 'E' | 'S'; cfopId: string } | null | undefined,
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
    direction: isAdjust && adjustment ? adjustment.direction : ctx.branch.direction,
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
  if (branch.branch === 'adjust' && !input.adjustment) {
    issues.push({ scope: 'order', field: 'adjustment',
      message: 'Ordem de ajuste exige sentido (E/S) e CFOP no faturamento' })
  }

  const { ctx, issues: ctxIssues } = await loadContext(schemaName, institutionId, branch)
  issues.push(...ctxIssues)

  const items = await listBillingItems(schemaName, institutionId, input.orderId)
  if (items.length === 0) {
    issues.push({ scope: 'order', field: 'items', message: 'Ordem sem itens vivos' })
  }

  const links = await getItemRuleLinks(schemaName, institutionId, input.orderId)
  const manualByItem = new Map(
    links.filter(l => l.origin === 'M').map(l => [`${l.orderItemId}|${l.kind}`, l]))

  let rulesResolved = 0
  let rulesManual = 0

  for (const item of items) {
    if (item.productKind === 'S') continue // serviço: sem regra de mercadoria
    if (!MERCHANDISE_KINDS.includes(item.kind)) continue

    if (item.ncm === null || item.ncm === '') {
      issues.push({ scope: 'item', itemId: item.id, field: 'ncm',
        message: `Item ${item.id}: produto sem NCM no cadastro` })
    }

    const manual = manualByItem.get(`${item.id}|${item.kind}`)
    if (manual) { rulesManual++; continue } // RegraDireta — escolha do cliente

    if (ctx.recipientStateId === null || ctx.emitterStateId === null) continue

    const criteria = buildCriteria(item, ctx, institutionId, input.adjustment, null)
    const rule = await findTaxRule(schemaName, criteria)
    if (rule) {
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
  if (branch.branch === 'adjust' && !input.adjustment) {
    throw new HttpError(422, 'Ordem de ajuste exige sentido e CFOP',
      [{ field: 'adjustment', message: 'Informe direction e cfopId' }], 'ADJUST_PARAMS_REQUIRED')
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

  // rateio T2 sobre TODOS os itens vivos (mercadoria líquida como base)
  const { freight, expenses } = await getFreightAndExpenses(schemaName, institutionId, input.orderId)
  const merchValues = items.map(i => calcMerchandiseValue(i.unitValue, i.quantity, i.discountValue))
  const freightShares = prorateWithResidue(merchValues, freight)
  const expensesShares = prorateWithResidue(merchValues, expenses)

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
      } : undefined,
      fcp: (fcpAliq || fcpStAliq) ? { aliqFcp: fcpAliq, aliqFcpSt: fcpStAliq } : undefined,
      ipi: pieces.ipi ? { cst: pieces.ipi.cst, aliq: pieces.ipi.aliq ?? 0 } : undefined,
      pisCofins: pieces.pisCofins?.map(pc => ({
        kind: pc.kind, cst: pc.cst, aliq: pc.aliq ?? 0,
        quantity: item.quantity, unitAliqValue: item.unitValue,
      })),
      issqn: isService ? {
        cityAliqPct: ctx.emitterCityIssAliq,     // decisão 3: município do PRESTADOR
        deductionValue: item.discountValue,
        withheld: ctx.recipientIssRetido,
      } : undefined,
    }

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
        cst: pieces.icms?.cstNr ?? null,
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

  const billing = await getOrderBillingInfo(schemaName, institutionId, input.orderId)
  if (financialBase > 0 && !billing) {
    throw new HttpError(422, 'Ordem sem condições de cobrança (forma/prazo)',
      [{ field: 'billing', message: 'Informe a negociação da ordem' }], 'ORDER_NO_BILLING')
  }

  let parcels: { parcel: number; dueDate: string; amount: number; paymentTypeId: number }[] = []
  if (financialBase > 0 && billing) {
    const installments = await getInstallments(schemaName, institutionId, input.orderId)
    if (installments.length > 0) {
      parcels = installments.map(i => ({
        parcel: i.parcel, dueDate: i.dueDate, amount: i.amount,
        paymentTypeId: i.paymentTypeId ?? billing.paymentTypeId,
      }))
    } else {
      const days = parseDeadline(billing.deadline)
      if (days === null) {
        throw new HttpError(422, 'Prazo da negociação inválido',
          [{ field: 'deadline', message: `Prazo "${billing.deadline}" fora do limite` }],
          'INVALID_DEADLINE')
      }
      const quotas = parcelQuotas(financialBase, days.length)
      const today = new Date()
      parcels = days.map((d, i) => ({
        parcel: i + 1, dueDate: addDays(today, d), amount: quotas[i],
        paymentTypeId: billing.paymentTypeId,
      }))
    }
  }

  // model por PRESENÇA de itens (natureza = ramo, D1–D11): mercadoria
  // presente → 55 (o ramo service da conjugada autoriza como NFS-e depois);
  // só serviço → SE (interna, como no Software House)
  const hasMerchandise = computed.some(ci => ci.item.productKind !== 'S')
  const model = hasMerchandise ? '55' : 'SE'
  const serie = (await getConfigContent(institution, 'billing', 'invoice_serie') ?? '1').slice(0, 10)

  return persistInvoice(schemaName, institutionId, {
    orderId: input.orderId,
    recipientEntityId: branch.recipientEntityId,
    model, serie,
    items: computed,
    totalValue,
    parcels,
    financialKind: branch.direction === 'E' ? 'PA' : 'RA',
  })
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}
