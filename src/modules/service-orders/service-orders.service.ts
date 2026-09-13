import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import logger from '@shared/logger/logger'
import { contentionToHttpError } from '@shared/db/contention'
import {
  ServiceOrderListRow, ServiceOrderFull, OpenOrderInput, OrderItemInput,
  MonthlyRunInput, MonthlyRunReport, InvoiceInput, InvoiceResult,
  ServiceProductLookupRow, BatchInvoiceInput, BatchInvoiceEntry,
  BatchInvoiceReport,
} from './service-orders.interface'
import {
  listOrders, getOrder, openOrder, addItem, updateItem, removeItem,
  cancelOrder, monthlyRun, generateInvoice, listProductsLookup, contractPaymentDay,
  contractBillingReference, orderExists,
} from './service-orders.repository'
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
}

export async function fetchOrders(
  status: 'A' | 'F' | '', query: ListQuery, scope: ServiceOrderScope
): Promise<PagedRows<ServiceOrderListRow>> {
  return listOrders(status, query, scope.schemaName, scope.institutionId)
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
    let dtExpiration  = input.dtExpiration
    let paymentTypeId = input.paymentTypeId
    // A consulta do contrato roda ANTES do faturamento, então uma ordem que nem
    // existe saía com "acerte o contrato do cliente" quando o corpo não trazia
    // as condições, e com "ordem não encontrada" quando trazia (gate
    // adversarial). O motivo tem que ser o mesmo nos dois caminhos.
    const existe = await orderExists(orderId, scope.schemaName, scope.institutionId)
    if (!existe) {
      results.push({
        orderId, ok: false,
        error: `Ordem de serviço ${orderId} não encontrada`,
        code:  'ORDER_NOT_FOUND',
      })
      continue
    }

    // O contrato é consultado UMA vez por ordem e só quando falta alguma
    // condição — informar as duas no corpo é override total (D13/D14).
    if (!dtExpiration || !paymentTypeId) {
      const ref = await contractBillingReference(orderId, scope.schemaName, scope.institutionId)

      if (!dtExpiration) {
        if (!ref?.paymentDay) {
          results.push({
            orderId, ok: false,
            error: 'Ordem sem dia de vencimento de contrato — informe o vencimento do lote ou acerte o contrato do cliente',
            code:  'ORDER_NO_CONTRACT_DUE_DAY',
          })
          continue
        }
        const [ano, mes] = ref.competence.split('-').map(Number)
        dtExpiration = contractDaySuggestion(ano, mes, ref.paymentDay)
      }

      if (!paymentTypeId) {
        if (!ref?.paymentTypeId) {
          results.push({
            orderId, ok: false, dtExpiration,
            error: 'Ordem sem forma de pagamento de contrato — informe a forma do lote ou combine a forma no contrato do cliente',
            code:  'ORDER_NO_CONTRACT_PAYMENT_TYPE',
          })
          continue
        }
        paymentTypeId = ref.paymentTypeId
      }
    }

    try {
      const r = await invoiceOrder(orderId, { ...input, dtExpiration, paymentTypeId }, scope)
      results.push({
        orderId, ok: true, dtExpiration, paymentTypeId,
        invoiceNumber: r.invoiceNumber, totalValue: r.totalValue,
        autoSettled: r.autoSettled, bankSlipsIssued: r.bankSlipsIssued,
      })
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
      results.push({
        orderId, ok: false, dtExpiration, paymentTypeId,
        error: negocio ? e.message : 'Falha inesperada ao faturar esta ordem',
        code:  negocio ? e.code : 'INTERNAL_ERROR',
      })
    }
  }

  const faturadas = results.filter(r => r.ok)
  return {
    requested: ids.length,
    invoiced: faturadas.length,
    failed: results.length - faturadas.length,
    uncharged: faturadas.filter(
      r => (r.autoSettled ?? 0) === 0 && (r.bankSlipsIssued ?? 0) === 0).length,
    results,
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

export async function fetchProductsLookup(
  filter: string, scope: ServiceOrderScope
): Promise<ServiceProductLookupRow[]> {
  return listProductsLookup(filter, scope.schemaName, scope.institutionId)
}
