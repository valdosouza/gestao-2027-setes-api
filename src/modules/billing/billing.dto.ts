import { z } from 'zod'

/**
 * DTOs do faturamento (rodada R4): autoria vem do JWT (user_id NÃO viaja no
 * payload); institution vem do JWT. `adjustment` só é exigido quando a ordem
 * é de AJUSTE (Q23 — sentido + CFOP escolhidos no faturamento); a exigência
 * é validada no service (o DTO não conhece o tipo da ordem).
 */

// Contrato ENCOLHIDO (parecer order-returns 2026-08-24, aprovado pelo
// Valdo): direction vem do RAMO (tb_order_stock_adjust.direction, gravada
// na abertura) e o pedido original vem da ÂNCORA — fonte única por
// construção; só o CFOP pertence de fato à decisão do faturamento.
const adjustmentDto = z.object({
  cfopId: z.string().min(1).max(10),
})

export const validateBodyDto = z.object({
  orderId: z.number().int().positive(),
  adjustment: adjustmentDto.nullish(),
})
export type ValidateBodyDto = z.infer<typeof validateBodyDto>

export const invoiceBodyDto = z.object({
  orderId: z.number().int().positive(),
  // P3.2 — decisão POR FATURAMENTO: false (default) = MVA ajustada pela
  // carga real; true = MVA original do cadastro.
  useMvaOriginal: z.boolean().optional().default(false),
  adjustment: adjustmentDto.nullish(),
})
export type InvoiceBodyDto = z.infer<typeof invoiceBodyDto>
