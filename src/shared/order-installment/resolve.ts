import { PoolConnection } from 'mysql2/promise'
import { HttpError } from '@shared/errors/http-error'
import { getOrderBilling, parseDeadline } from '@shared/order-billing'
import { getOrderFinancialBase } from '@shared/order'
import { getInstallments, materializeParcels, MaterializedParcel } from './order-installment'
import { assertPaymentTypesEnabled, EnabledPaymentType } from '@shared/payment-types'

/**
 * COMPOSIÇÃO (única — parecer 2026-09-06): "quais parcelas este pedido
 * gera". Importa as peças (order-billing, order-installment, order) — as
 * peças não importam umas às outras (precedente @shared/entity/entity-fiscal).
 *
 * Decisão 25 (materialização única): PRESENÇA de installment = elaborado
 * (usa cada parcela como negociada); AUSÊNCIA = o prazo do billing gera.
 * D7 (Valdo 2026-09-06): no elaborado, a soma é validada contra a base do
 * PEDIDO (itens + frete, como ValidaParcelamento do legado) e a diferença
 * até a base da NOTA (ST + IPI + despesas + frete da nota) entra INTEIRA na
 * 1ª parcela — reflexo do legado para "extras" (FIN-02/FIN-04). A via
 * gerada rateia a base da NOTA (parcelQuotas, resíduo na última). O
 * faturamento NUNCA regrava tb_order_installment (decisão 29: o
 * materializado vive em tb_financial).
 */

type Queryable = Pick<PoolConnection, 'query'>
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * Q-N1 (Rodada 2, Valdo 2026-09-07 — recomendações): REGRAS DAS FORMAS da
 * negociação numa implementação só, consumida pelas TRÊS portas (PUT da
 * negociação, passo 5 da OS, faturamento): (1) toda forma — cabeçalho e por
 * parcela — vinculada/habilitada (400 PAYMENT_TYPE_UNAVAILABLE); (2) nº total
 * de parcelas ≤ max_parcels da forma do CABEÇALHO; (3) parcelas com forma
 * PRÓPRIA contam contra o max_parcels DELA (fecha a burla do gate
 * adversarial); (4) max_parcels ≤ 0 vale 1 (o DTO já exige ≥ 1; zero só chega
 * por SQL/sync). `expected` no fields[] = limite (Q-N3).
 */
export async function assertPaymentRules(
  db: Queryable, schemaName: string, institutionId: number,
  input: {
    headerPaymentTypeId: number
    parcels: { paymentTypeId: number | null }[]
    nParcels: number
    /** Campo apontado no 422 do limite do cabeçalho ('deadline' | 'installments' | 'parcels'). */
    limitField: string
  }
): Promise<Map<number, EnabledPaymentType>> {
  const ownIds = input.parcels.map(p => p.paymentTypeId).filter((v): v is number => v != null)
  const types = await assertPaymentTypesEnabled(db, schemaName, institutionId,
    [input.headerPaymentTypeId, ...ownIds])
  const limitOf = (t: EnabledPaymentType): number => (t.maxParcels > 0 ? t.maxParcels : 1)
  const header = types.get(input.headerPaymentTypeId)!
  if (input.nParcels > limitOf(header)) {
    throw new HttpError(422, 'Número de parcelas passa do limite da forma de pagamento',
      [{ field: input.limitField, expected: limitOf(header),
        message: `${input.nParcels} parcelas; a forma "${header.description}" permite ${limitOf(header)}` }],
      'MAX_PARCELS_EXCEEDED')
  }
  const perForm = new Map<number, number>()
  for (const id of ownIds) {
    if (id === input.headerPaymentTypeId) continue
    perForm.set(id, (perForm.get(id) ?? 0) + 1)
  }
  for (const [id, n] of perForm) {
    const t = types.get(id)!
    if (n > limitOf(t)) {
      throw new HttpError(422, 'Número de parcelas passa do limite da forma de pagamento',
        [{ field: 'installments', expected: limitOf(t),
          message: `${n} parcelas na forma "${t.description}"; ela permite ${limitOf(t)}` }],
        'MAX_PARCELS_EXCEEDED')
    }
  }
  return types
}

export type ParcelsMode = 'none' | 'simple' | 'elaborated'

export interface ResolvedParcels {
  mode: ParcelsMode
  parcels: MaterializedParcel[]
  /** Forma do cabeçalho (null quando não há billing/financeiro). */
  paymentTypeId: number | null
}

export async function resolveOrderParcels(
  db: Queryable, schemaName: string, institutionId: number, orderId: number,
  input: { noteBase: number; baseDate: Date }
): Promise<ResolvedParcels> {
  const billing = await getOrderBilling(db, schemaName, institutionId, orderId)
  if (input.noteBase > 0 && !billing) {
    throw new HttpError(422, 'Ordem sem condições de cobrança (forma/prazo)',
      [{ field: 'billing', message: 'Informe a negociação da ordem' }], 'ORDER_NO_BILLING')
  }
  if (input.noteBase <= 0 || !billing) return { mode: 'none', parcels: [], paymentTypeId: billing?.paymentTypeId ?? null }

  const installments = await getInstallments(db, schemaName, institutionId, orderId)
  if (installments.length > 0) {
    const { base: orderBase } = await getOrderFinancialBase(db, schemaName, institutionId, orderId)
    const sum = round2(installments.reduce((acc, i) => acc + i.amount, 0))
    if (sum !== orderBase) {
      // R5-Q2 (ValidaParcelamento): elaborado que diverge do valor ATUAL do
      // pedido bloqueia — itens editados depois da negociação não faturam.
      throw new HttpError(422, 'Valor do parcelamento não confere com o valor da ordem',
        [{ field: 'installments', expected: orderBase,
          message: `Parcelamento ${sum} difere do valor atual da ordem ${orderBase}` }],
        'INSTALLMENT_MISMATCH')
    }
    // Q-N1(b): o faturamento REVALIDA formas habilitadas e limites — forma
    // desabilitada depois da negociação não fatura.
    await assertPaymentRules(db, schemaName, institutionId, {
      headerPaymentTypeId: billing.paymentTypeId,
      parcels: installments.map(i => ({ paymentTypeId: i.paymentTypeId })),
      nParcels: installments.length, limitField: 'installments',
    })
    const parcels: MaterializedParcel[] = installments.map(i => ({
      parcel: i.parcel, dueDate: i.dueDate, amount: i.amount,
      paymentTypeId: i.paymentTypeId ?? billing.paymentTypeId,
    }))
    const diff = round2(input.noteBase - orderBase) // D7: ST + IPI + despesas (+ frete da nota)
    if (diff !== 0) {
      parcels[0].amount = round2(parcels[0].amount + diff)
      if (parcels[0].amount <= 0) {
        throw new HttpError(422, 'Diferença da nota anula a 1ª parcela — renegocie o parcelamento',
          [{ field: 'installments', message: `Diferença ${diff} sobre a 1ª parcela` }],
          'INSTALLMENT_MISMATCH')
      }
    }
    return { mode: 'elaborated', parcels, paymentTypeId: billing.paymentTypeId }
  }

  const days = parseDeadline(billing.deadline)
  if (days === null) {
    throw new HttpError(422, 'Prazo da negociação inválido',
      [{ field: 'deadline', message: `Prazo "${billing.deadline}" fora do limite` }],
      'INVALID_DEADLINE')
  }
  const parcels = materializeParcels({
    days, base: input.noteBase, baseDate: input.baseDate, paymentTypeId: billing.paymentTypeId,
  })
  await assertPaymentRules(db, schemaName, institutionId, {
    headerPaymentTypeId: billing.paymentTypeId, parcels: [], nParcels: parcels.length,
    limitField: 'deadline',
  })
  return { mode: 'simple', parcels, paymentTypeId: billing.paymentTypeId }
}
