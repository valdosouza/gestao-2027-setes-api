import { z } from 'zod'

/**
 * DTOs (Zod) do módulo settlements. Valores da apuração INFORMADOS (P5);
 * paid_value > 0 (parcial permitido — o saldo é derivado); conta 0 =
 * Caixa; estorno exige motivo (5.5.4).
 */

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data em YYYY-MM-DD')

export const settleBatchDto = z.object({
  titles: z.array(z.object({
    orderId:         z.number().int().positive(),
    parcel:          z.number().int().positive(),
    interestValue:   z.number().min(0).default(0),
    lateValue:       z.number().min(0).default(0),
    discountAliquot: z.number().min(0).max(100).default(0),
    paidValue:       z.number().gt(0),
  })).min(1, 'Selecione ao menos um título'),
  bankAccountId: z.number().int().min(0),
  dtPayment:     dateStr,
  dtRealPayment: dateStr.nullable().optional(),
  financialPlanCreId: z.number().int().min(0).nullable().optional(),
  financialPlanDebId: z.number().int().min(0).nullable().optional(),
}).refine(
  body => new Set(body.titles.map(t => `${t.orderId}-${t.parcel}`)).size
          === body.titles.length,
  { message: 'Título repetido no lote', path: ['titles'] },
)

export const reversalDto = z.object({
  orderId: z.number().int().positive(),
  parcel:  z.number().int().positive(),
  event:   z.number().int().positive(),
  reason:  z.string().min(1).max(100),
})

export type SettleBatchDto = z.infer<typeof settleBatchDto>
export type ReversalDto    = z.infer<typeof reversalDto>
