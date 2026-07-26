import { z } from 'zod'

/**
 * DTOs (Zod) do módulo service-orders. Datas 'YYYY-MM-DD'; o vencimento do
 * faturamento vem SEMPRE do usuário (DP1 — a API não impõe regra de data,
 * só exige formato válido e não-passado em relação à emissão? NÃO:
 * imprevistos acontecem — data livre, decisão do Valdo).
 */

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data em YYYY-MM-DD')

export const openOrderDto = z.object({
  customerId: z.number().int().positive(),
})

export const orderItemDto = z.object({
  productId:     z.number().int().positive(),
  quantity:      z.number().gt(0).default(1),
  unitValue:     z.number().min(0),
  discountValue: z.number().min(0).nullable().optional(),
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
