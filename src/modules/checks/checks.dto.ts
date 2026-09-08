import { z } from 'zod'

/** 'YYYY-MM-DD' de calendário real (mesma guarda do contrato/boleto). */
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data em YYYY-MM-DD')
  .refine(v => {
    const [y, m, d] = v.split('-').map(Number)
    const t = new Date(Date.UTC(y, m - 1, d))
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
  }, 'Data inexistente')

export const depositCheckDto = z.object({
  dtRecord:      dateStr,
  bankAccountId: z.number().int().positive(),
})

export const discountCheckDto = z.object({
  dtRecord:          dateStr,
  factoringEntityId: z.number().int().positive(),
  bankAccountId:     z.number().int().min(0),
  feeValue:          z.number().min(0).max(99999999.99).default(0),
})

export const returnCheckRefundDto = z.object({
  dtRecord:      dateStr,
  bankAccountId: z.number().int().min(0),
})

export const returnCheckGoodDto = z.object({
  note: z.string().max(255).nullable().optional(),
})

export const useCheckInPaymentDto = z.object({
  dtRecord: dateStr,
  orderId:  z.number().int().positive(),
  parcel:   z.number().int().positive(),
})

export const returnCheckDto = z.object({
  dtRecord: dateStr,
  note:     z.string().max(255).nullable().optional(),
})

export const reverseCheckDto = z.object({
  event:  z.number().int().positive(),
  reason: z.string().min(1).max(100),
})

export type DepositCheckDto = z.infer<typeof depositCheckDto>
export type DiscountCheckDto = z.infer<typeof discountCheckDto>
export type ReturnCheckRefundDto = z.infer<typeof returnCheckRefundDto>
export type ReturnCheckGoodDto = z.infer<typeof returnCheckGoodDto>
export type UseCheckInPaymentDto = z.infer<typeof useCheckInPaymentDto>
export type ReturnCheckDto = z.infer<typeof returnCheckDto>
export type ReverseCheckDto = z.infer<typeof reverseCheckDto>
