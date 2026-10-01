import { walletSalesmanId } from '@shared/customer-wallet'
import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import logger from '@shared/logger/logger'
import { contentionToHttpError } from '@shared/db/contention'
import { getServiceFiscalSummaries } from '@shared/invoice-transmission'
import {
  ServiceOrderListRow, ServiceOrderFull, OpenOrderInput, OrderItemInput,
  MonthlyRunInput, MonthlyRunReport, InvoiceInput, InvoiceResult,
  ServiceProductLookupRow, ServiceOrderCustomerLookupRow, BatchInvoiceInput, BatchInvoiceEntry,
  BatchInvoiceReport,
} from './service-orders.interface'
import {
  listOrders, getOrder, openOrder, addItem, updateItem, removeItem,
  cancelOrder, monthlyRun, generateInvoice, listProductsLookup, contractPaymentDay,
  contractBillingReference, orderExists,
  SERVICE_ORDER_SEARCH_CRITERIA, listCustomerLookup,
} from './service-orders.repository'

export { SERVICE_ORDER_SEARCH_CRITERIA }
import {
  ORDER_NO_CONTRACT_DUE_DAY_MSG, ORDER_NO_CONTRACT_PAYMENT_TYPE_MSG,
  ORDER_STANDALONE_DUE_DAY_MSG, ORDER_STANDALONE_PAYMENT_TYPE_MSG,
} from './service-orders.messages'
import { fifthBusinessDaySuggestion, contractDaySuggestion } from './service-orders.calc'

/**
 * Regras do módulo service-orders: escopo SEMPRE da institution do JWT
 * (userId do JWT vai na tb_order); a máquina de estados vive no
 * repositório (lock A/F); a SUGESTÃO de vencimento é serviço puro (DP1 —
 * quem decide é o usuário).
 */

export interface ServiceOrderScope {
  schemaName:    string
  institutionId: number
  userId:        number
  role?:         string
}

export async function fetchOrders(
  status: 'A' | 'F' | '', query: ListQuery, scope: ServiceOrderScope
): Promise<PagedRows<ServiceOrderListRow>> {
  const page = await listOrders(status, query, scope.schemaName, scope.institutionId)
  // Selo fiscal: só nota emitida pela web (evento E) — a sincronizada transmite-se na origem
  const ids = page.rows.filter((r: any) => (r.status === 'F' || r.status === 'C') && Number(r.webIssued) === 1).map(r => Number(r.id))
  const fiscal = await getServiceFiscalSummaries(scope.schemaName, scope.institutionId, ids)
  const rows = page.rows.map(({ webIssued: _w, ...r }: any) => {
    const f = fiscal.get(Number(r.id))
    return {
      ...r,
      invoiceNumber:     r.invoiceNumber == null ? null : String(r.invoiceNumber),
      fiscalState:       f?.state ?? null,
      fiscalEnvironment: f?.environment ?? null,
      nfseNumber:        f?.nfseNumber ?? null,
    }
  })
  return { rows, total: page.total }
}

export async function fetchOrder(
  id: number, scope: ServiceOrderScope
): Promise<ServiceOrderFull> {
  const order = await getOrder(id, scope.schemaName, scope.institutionId)
  if (!order) throw new HttpError(404, `Ordem de serviço ${id} não encontrada`)
  return order
}

export async function createOrder(
  input: OpenOrderInput, scope: ServiceOrderScope
): Promise<number> {
  return openOrder(input, scope.schemaName, scope.institutionId, scope.userId)
}

export async function createItem(
  orderId: number, input: OrderItemInput, scope: ServiceOrderScope
): Promise<number> {
  return addItem(orderId, input, scope.schemaName, scope.institutionId)
}

export async function editItem(
  orderId: number, itemId: number, input: OrderItemInput,
  scope: ServiceOrderScope
): Promise<void> {
  await updateItem(orderId, itemId, input, scope.schemaName, scope.institutionId)
}

export async function deleteItem(
  orderId: number, itemId: number, scope: ServiceOrderScope
): Promise<void> {
  await removeItem(orderId, itemId, scope.schemaName, scope.institutionId)
}

export async function removeOrder(
  orderId: number, scope: ServiceOrderScope
): Promise<void> {
  await cancelOrder(orderId, scope.schemaName, scope.institutionId)
}

export async function runMonthly(
  input: MonthlyRunInput, scope: ServiceOrderScope
): Promise<MonthlyRunReport> {
  return monthlyRun(input, scope.schemaName, scope.institutionId, scope.userId)
}

export async function invoiceOrder(
  orderId: number, input: InvoiceInput, scope: ServiceOrderScope
): Promise<InvoiceResult> {
  return generateInvoice(orderId, input, scope.schemaName, scope.institutionId, scope.userId)
}

/**
 * LOTE da cobrança mensal (D6/D7, Valdo 2026-09-13). Cada ordem fatura na
 * PRÓPRIA transação (a de `generateInvoice`) — o lote não é "tudo ou nada":
 * a que falha entra no relatório com o motivo e o lote segue, igual ao que a
 * rotina mensal já faz com `errors[]`. Ids repetidos na seleção contam UMA
 * vez (a 2ª passada receberia 409 de ordem já faturada e poluiria o
 * relatório com um erro que o operador não cometeu).
 *
 * CONDIÇÕES DO CONTRATO (D13/D14, Valdo 2026-09-13 — "cada ordem vencer no dia
 * do seu contrato" + a forma é do contrato): o mesmo desenho vale para o
 * vencimento e para a FORMA DE PAGAMENTO — ausente no corpo, vem do contrato da
 * ordem; presente, é override do operador para o lote inteiro; sem combinação no
 * contrato, a ordem é RECUSADA com motivo, nunca faturada com um palpite.
 *
 * VENCIMENTO: sem `dtExpiration` no corpo, cada ordem vence no `payment_day`
 * do SEU contrato, no mês seguinte à última competência injetada nela — é o
 * modo normal da cobrança mensal, porque o dia combinado é de cada cliente.
 * Com `dtExpiration`, o operador sobrepõe e a data vale para o lote inteiro.
 * Ordem sem contrato (OS avulsa) ou com contratos que DIVERGEM no dia não tem
 * "dia do contrato": é RECUSADA com motivo legível, nunca faturada com uma
 * data inventada pelo sistema.
 */
export async function invoiceOrderBatch(
  input: BatchInvoiceInput, scope: ServiceOrderScope
): Promise<BatchInvoiceReport> {
  const ids = [...new Set(input.orderIds)]
  const results: BatchInvoiceEntry[] = []

  for (const orderId of ids) {
    results.push(await invoiceOneInBatch(orderId, input, scope))
  }

  // D25 (Q-P3, Valdo 2026-09-19): ordem recusada por CONTENÇÃO ganha UMA passada
  // extra ao final do lote — quem a segurava (outro faturamento, a rotina mensal,
  // uma baixa) normalmente já soltou. Uma só: a 2ª derrota vira `retryable` e a
  // decisão de repetir é do operador (a tela mantém a ordem marcada). Sem
  // estado novo, sem fila: é o mesmo caminho, duas vezes.
  for (let i = 0; i < results.length; i++) {
    if (results[i].ok || results[i].code !== 'RESOURCE_BUSY') continue
    const again = await invoiceOneInBatch(results[i].orderId, input, scope)
    results[i] = again.ok || again.code !== 'RESOURCE_BUSY'
      ? again
      : { ...again, retryable: true }
  }

  const faturadas = results.filter(r => r.ok)
  return {
    requested: ids.length,
    invoiced: faturadas.length,
    failed: results.length - faturadas.length,
    // D26 (Q-P5): QUALQUER parcela sem cobrança conta — a parcial inclusive.
    uncharged: faturadas.filter(
      r => (r.chargedParcels ?? 0) < (r.chargeableParcels ?? 0)).length,
    partiallyCharged: faturadas.filter(
      r => (r.chargedParcels ?? 0) > 0
        && (r.chargedParcels ?? 0) < (r.chargeableParcels ?? 0)).length,
    retryable: results.filter(r => r.retryable === true).length,
    results,
  }
}

/** UMA ordem do lote: resolve as condições, fatura e traduz o desfecho em linha. */
async function invoiceOneInBatch(
  orderId: number, input: BatchInvoiceInput, scope: ServiceOrderScope
): Promise<BatchInvoiceEntry> {
  let dtExpiration  = input.dtExpiration
  let paymentTypeId = input.paymentTypeId
  // A consulta do contrato roda ANTES do faturamento, então uma ordem que nem
  // existe saía com "acerte o contrato do cliente" quando o corpo não trazia
  // as condições, e com "ordem não encontrada" quando trazia (gate
  // adversarial). O motivo tem que ser o mesmo nos dois caminhos.
  const existe = await orderExists(orderId, scope.schemaName, scope.institutionId)
  if (!existe) {
    return {
      orderId, ok: false,
      error: `Ordem de serviço ${orderId} não encontrada`,
      code:  'ORDER_NOT_FOUND',
    }
  }

  // O contrato é consultado UMA vez por ordem e só quando falta alguma
  // condição — informar as duas no corpo é override total (D13/D14). D23: o
  // que volta são as condições CONGELADAS no fato da competência, não as do
  // contrato vivo. Esta leitura (fora da transação) serve à recusa ANTECIPADA
  // com motivo e ao relatório; a que GRAVA é reconferida dentro da transação
  // de `generateInvoice`, sob o lock da ordem (M1 do gate socrático R5).
  const termsFromContract = { dtExpiration: !dtExpiration, paymentTypeId: !paymentTypeId }
  if (!dtExpiration || !paymentTypeId) {
    const ref = await contractBillingReference(orderId, scope.schemaName, scope.institutionId)

    if (!dtExpiration) {
      if (!ref?.paymentDay) {
        // achado 1 do gate adversarial R5: OS avulsa (nenhum fato) × fatos que
        // DIVERGEM (contrato editado entre dois meses não faturados) são becos
        // diferentes — "acerte o contrato" não resolve o segundo (D23)
        return {
          orderId, ok: false,
          error: ref ? ORDER_NO_CONTRACT_DUE_DAY_MSG : ORDER_STANDALONE_DUE_DAY_MSG,
          code:  'ORDER_NO_CONTRACT_DUE_DAY',
        }
      }
      const [ano, mes] = ref.competence.split('-').map(Number)
      dtExpiration = contractDaySuggestion(ano, mes, ref.paymentDay)
    }

    if (!paymentTypeId) {
      if (!ref?.paymentTypeId) {
        return {
          orderId, ok: false, dtExpiration,
          error: ref ? ORDER_NO_CONTRACT_PAYMENT_TYPE_MSG : ORDER_STANDALONE_PAYMENT_TYPE_MSG,
          code:  'ORDER_NO_CONTRACT_PAYMENT_TYPE',
        }
      }
      paymentTypeId = ref.paymentTypeId
    }
  }

  try {
    // D30: cobrança recorrente é UMA parcela — o DTO já recusa outro valor; aqui
    // é cinto para quem chamar o service por fora da rota.
    const r = await invoiceOrder(orderId,
      { ...input, parcels: 1, dtExpiration, paymentTypeId, termsFromContract }, scope)
    // D26: os dois desfechos da automação são disjuntos por `kind` (a auto-baixa
    // recusa 'B', o boleto só sai em 'B'), então somar não conta parcela em dobro;
    // o teto pelo denominador é cinto contra um produtor futuro que quebre isso.
    const chargeable = r.chargeableParcels ?? r.parcels
    const charged = Math.min((r.autoSettled ?? 0) + (r.bankSlipsIssued ?? 0), chargeable)
    return {
      // o que foi GRAVADO (reconferido na transação) — não o que a leitura de fora viu
      orderId, ok: true,
      dtExpiration: r.dtExpiration ?? dtExpiration, paymentTypeId: r.paymentTypeId ?? paymentTypeId,
      invoiceNumber: r.invoiceNumber, totalValue: r.totalValue,
      autoSettled: r.autoSettled, bankSlipsIssued: r.bankSlipsIssued,
      chargedParcels: charged, chargeableParcels: chargeable,
    }
  } catch (err) {
    // CONTENÇÃO não é erro técnico (D-A3, transversal): fora do lote ela
    // vira 409 RESOURCE_BUSY no handleError — aqui o catch é ANTES da
    // fronteira, então a tradução tem que ser feita à mão, senão a ordem que
    // só precisa ser reenviada chega ao operador como bug (gate adversarial,
    // achado 2).
    const contencao = contentionToHttpError(err)
    const e = contencao ?? (err as HttpError)
    const negocio = contencao !== null || err instanceof HttpError
    if (!negocio) {
      // Erro técnico de verdade: vai a log com o stack — o operador recebe
      // um motivo genérico, nunca detalhe interno.
      logger.error('Falha técnica no lote de faturamento', {
        institutionId: scope.institutionId, orderId, err,
      })
    }
    return {
      orderId, ok: false, dtExpiration, paymentTypeId,
      error: negocio ? e.message : 'Falha inesperada ao faturar esta ordem',
      code:  negocio ? e.code : 'INTERNAL_ERROR',
    }
  }
}

/**
 * SUGESTÃO de vencimento (DP1: quem decide é o usuário — isto é só o default).
 * D12 (Valdo 2026-09-13): quando a ordem veio de CONTRATO, o default é o dia
 * de vencimento do contrato; sem ordem, ou com contratos que divergem no dia,
 * cai no 5º dia útil genérico.
 */
export async function expirationSuggestion(
  year: number, month: number, scope: ServiceOrderScope, orderId?: number
): Promise<string> {
  if (orderId) {
    const dia = await contractPaymentDay(orderId, scope.schemaName, scope.institutionId)
    if (dia !== null) return contractDaySuggestion(year, month, dia)
  }
  return fifthBusinessDaySuggestion(year, month)
}

/** Critérios da pesquisa avançada da lista de OS (D-BA2 — sem expressão SQL). */
export function fetchServiceOrderSearchCriteria(): PublicSearchCriterion[] {
  return publicCriteria(SERVICE_ORDER_SEARCH_CRITERIA)
}

/** Q-BA13 (Valdo 2026-09-30): a carteira travada do vendedor vale aqui também
 *  (peça @shared/customer-wallet — a carteira é da PESSOA, não da tela). */
export async function fetchCustomerLookup(
  filter: string, scope: ServiceOrderScope
): Promise<ServiceOrderCustomerLookupRow[]> {
  const salesmanId = await walletSalesmanId({ ...scope, role: scope.role ?? '' })
  return listCustomerLookup(filter, scope.schemaName, scope.institutionId, salesmanId)
}

export async function fetchProductsLookup(
  filter: string, scope: ServiceOrderScope
): Promise<ServiceProductLookupRow[]> {
  return listProductsLookup(filter, scope.schemaName, scope.institutionId)
}
