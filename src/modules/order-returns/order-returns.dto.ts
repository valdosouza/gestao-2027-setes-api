import { z } from 'zod'

export const openReturnDto = z.object({
  /** pedido de VENDA faturado contra o qual a devolução corre */
  saleOrderId: z.number().int().positive(),
})

export const returnItemQuantityDto = z.object({
  quantity: z.number().gt(0),
})

export type OpenReturnDto = z.infer<typeof openReturnDto>
export type ReturnItemQuantityDto = z.infer<typeof returnItemQuantityDto>
