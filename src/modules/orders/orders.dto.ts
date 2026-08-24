import { z } from 'zod'

export const openOrderDto = z.object({
  customerId: z.number().int().positive(),
  salesmanId: z.number().int().positive().nullable().optional(),
})

export const orderItemDto = z.object({
  productId:     z.number().int().positive(),
  quantity:      z.number().gt(0).default(1),
  unitValue:     z.number().min(0),
  discountValue: z.number().min(0).nullable().optional(),
})

export type OpenOrderDto = z.infer<typeof openOrderDto>
export type OrderItemDto = z.infer<typeof orderItemDto>
