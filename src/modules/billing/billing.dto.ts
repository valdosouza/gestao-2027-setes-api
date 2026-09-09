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

/**
 * Cheque por parcela (D8/D9 — prompt_cheque_rastreabilidade.md): só
 * parcelas cuja forma resolve para kind='Q' exigem isto; a soma dos itens
 * precisa bater com o valor da parcela (422 CHECK_SUM_MISMATCH — validado
 * em billing.service, com os dois valores na mensagem).
 */
const checkDateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data em YYYY-MM-DD')
  .refine(v => {
    const [y, m, d] = v.split('-').map(Number)
    const t = new Date(Date.UTC(y, m - 1, d))
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
  }, 'Data inexistente')

const checkItemDto = z.object({
  bankId:  z.number().int().positive(),
  agency:  z.string().min(1).max(10),
  account: z.string().min(1).max(15),
  number:  z.string().min(1).max(20),
  issuer:  z.string().min(1).max(100),
  // Achado do gate adversarial (2026-09-04): sem o refine, 3 cheques de
  // 33.334 somavam 100.00 (round2) mas gravavam 33.33 cada (DECIMAL(10,2)),
  // divergindo 1 centavo do paid_value lançado no financeiro — a soma
  // "exata" da D9 só vale se cada cheque já chegar com no máx. 2 casas.
  value:   z.number().min(0.01).max(99999999.99)
    .refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, 'Máximo 2 casas decimais'),
  dtCheck: checkDateStr,
  kind:    z.enum(['P', 'T']).default('P'),
})
const checksByParcelDto = z.object({
  parcel: z.number().int().positive(),
  items:  z.array(checkItemDto).min(1),
})

/** Cancelamento da nota (prompt_cancelamento_nota.md D13): motivo obrigatório. */
export const cancelBodyDto = z.object({
  orderId: z.number().int().positive(),
  reason:  z.string().trim().min(1).max(255),
})
export type CancelBody = z.infer<typeof cancelBodyDto>

export const invoiceBodyDto = z.object({
  orderId: z.number().int().positive(),
  // P3.2 — decisão POR FATURAMENTO: false (default) = MVA ajustada pela
  // carga real; true = MVA original do cadastro.
  useMvaOriginal: z.boolean().optional().default(false),
  adjustment: adjustmentDto.nullish(),
  checks: z.array(checksByParcelDto).optional(),
})
export type InvoiceBodyDto = z.infer<typeof invoiceBodyDto>
