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

/** 'YYYY-MM-DD' de calendário real (mesma guarda do contrato/boleto/cheque). */
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data em YYYY-MM-DD')
  .refine(v => {
    const [y, m, d] = v.split('-').map(Number)
    const t = new Date(Date.UTC(y, m - 1, d))
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
  }, 'Data inexistente')

/** Parcela ELABORADA (tb_order_installment): forma NULL = herda a do cabeçalho. */
const installmentDto = z.object({
  parcel:        z.number().int().positive(),
  dueDate:       dateStr,
  amount:        z.number().min(0.01).max(99999999.99)
    .refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, 'Máximo 2 casas decimais'),
  paymentTypeId: z.number().int().positive().nullable().optional(),
})

/**
 * Negociação do pedido (prompt_negociacao_pedido.md D2/D3): cabeçalho =
 * via SIMPLES (tb_order_billing: forma + prazo string livre, decisão 31);
 * `installments` presente e não vazio = via ELABORADA (substitui o
 * parcelamento); ausente/vazio = "voltar ao prazo" (apaga o elaborado).
 */
export const negotiationDto = z.object({
  paymentTypeId: z.number().int().positive(),
  deadline:      z.string().max(255).nullable().optional(),
  installments:  z.array(installmentDto).max(120).optional(),
})

export type OpenOrderDto = z.infer<typeof openOrderDto>
export type OrderItemDto = z.infer<typeof orderItemDto>
export type NegotiationDto = z.infer<typeof negotiationDto>
