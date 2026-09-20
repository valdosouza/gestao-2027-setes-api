import { z } from 'zod'

/**
 * DTOs (Zod) do módulo service-orders. Datas 'YYYY-MM-DD'; o vencimento do
 * faturamento vem SEMPRE do usuário (DP1 — a API não impõe regra de data,
 * só exige formato válido e não-passado em relação à emissão? NÃO:
 * imprevistos acontecem — data livre, decisão do Valdo).
 */

import { isValidIsoDate } from '@shared/validation'

// Formato E existência (gate adversarial da Onda 1): '2026-13-45' passava
// pelo regex e o MariaDB sem strict mode gravava '0000-00-00'.
const dateStr = z.string().refine(isValidIsoDate, 'Data inválida (use YYYY-MM-DD)')

export const openOrderDto = z.object({
  customerId: z.number().int().positive(),
})

/**
 * Tetos do DECIMAL do baseline (gate adversarial da Onda 1, MEDIUM-2): sem
 * eles, `unitValue: 1e12` voltava 201 e o MariaDB gravava 9999.999999 — a API
 * dizia "gravei" para um valor que não guardou, e a nota nascia com total
 * diferente do enviado. tb_order_item: quantity DECIMAL(10,4), unit_value
 * DECIMAL(10,6). Regra da casa: o que valida é o que grava (02-VALIDACAO.md).
 */
export const orderItemDto = z.object({
  productId:     z.number().int().positive(),
  quantity:      z.number().gt(0).max(999999.9999, 'Quantidade acima do limite').default(1),
  unitValue:     z.number().min(0).max(9999.999999, 'Valor unitário acima do limite'),
  discountValue: z.number().min(0).max(9999.999999).nullable().optional(),
})

export const monthlyRunDto = z.object({
  year:  z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
})

export const invoiceDto = z.object({
  dtExpiration:  dateStr,
  paymentTypeId: z.number().int().positive(),
  parcels:       z.number().int().min(1).max(99).default(1),
})

export type OpenOrderDto  = z.infer<typeof openOrderDto>
export type OrderItemDto  = z.infer<typeof orderItemDto>
export type MonthlyRunDto = z.infer<typeof monthlyRunDto>
export type InvoiceDto    = z.infer<typeof invoiceDto>

/**
 * LOTE da cobrança mensal (D6/D7 da fase Primeiro Cliente, Valdo 2026-09-13):
 * o operador SELECIONA as ordens na tela e o lote segue mesmo que uma falhe.
 * As condições (vencimento, forma, parcelas) são as MESMAS para o lote — quem
 * precisa de forma diferente faz dois lotes (Q8).
 */
export const BATCH_INVOICE_MAX_ORDERS = 50

export const batchInvoiceDto = invoiceDto.extend({
  /**
   * D27 (Q-P6/A-8, Valdo 2026-09-19): teto 50 por REQUISIÇÃO. O lote é síncrono
   * e cada ordem sob contenção custa até ~11 s (`FOR UPDATE WAIT 10`) — e até
   * ~22 s com a passada extra da D25 (gate adversarial R5 mediu 22,4 s com a
   * linha da institution travada): 200 numa requisição passava de meia hora e,
   * se o cliente desistisse, o relatório — única prova do que foi cobrado — se
   * perdia. A tela fatia a seleção em blocos de 50 e agrega os relatórios; lote
   * assíncrono só se a Onda 4 provar necessidade. O pior caso (bloco inteiro
   * atrás do MESMO lock ≈ 18 min) é a Q-R5.1, aberta para o Valdo.
   */
  orderIds: z.array(z.number().int().positive())
             .min(1, 'Selecione ao menos uma ordem')
             .max(BATCH_INVOICE_MAX_ORDERS, `No máximo ${BATCH_INVOICE_MAX_ORDERS} ordens por lote`),
  /**
   * D13 (Valdo 2026-09-13): "cada ordem vencer no dia do seu contrato".
   * OMITIR o vencimento é o modo normal da cobrança mensal — cada ordem vence
   * no `payment_day` do SEU contrato. Informar o vencimento é o OVERRIDE
   * explícito do operador: vale para todas as ordens do lote.
   */
  dtExpiration: dateStr.optional(),
  /**
   * D14: omitir usa a forma combinada no contrato de cada ordem; informar é
   * override do operador para o lote inteiro.
   */
  paymentTypeId: z.number().int().positive().optional(),
  /**
   * D30 (Valdo 2026-09-19, resposta ao P0.1): "cobranças recorrentes não têm
   * parcelas" — o lote cobra o valor do contrato do mês em UMA parcela, sempre.
   * Parcelamento é do faturamento INDIVIDUAL da ordem (`POST /:id/invoice`),
   * onde `max_parcels` da forma governa. Aqui qualquer valor ≠ 1 é recusado
   * (não silenciado): quem manda 3 parcelas para um lote está na porta errada.
   */
  parcels: z.number().int().optional().default(1)
            .refine(v => v === 1, {
              message: 'Cobrança recorrente não tem parcelas — parcelamento só no faturamento individual da ordem',
            }),
})

export type BatchInvoiceDto = z.infer<typeof batchInvoiceDto>
