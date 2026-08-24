import { z } from 'zod'

export const withdrawDto = z.object({
  value: z.number().gt(0),
  history: z.string().min(1).max(100),
  destinationBankAccountId: z.number().int().positive().nullable().optional(),
})

export const closeCashierDto = z.object({
  items: z.array(z.object({
    paymentTypeId: z.number().int().positive(),
    countedValue: z.number().min(0),
  })).default([]),
  transferBankAccountId: z.number().int().positive().nullable().optional(),
}).refine(
  body => new Set(body.items.map(i => i.paymentTypeId)).size === body.items.length,
  { message: 'Forma de pagamento repetida na conferência', path: ['items'] },
)

export type WithdrawDto = z.infer<typeof withdrawDto>
export type CloseCashierDto = z.infer<typeof closeCashierDto>
