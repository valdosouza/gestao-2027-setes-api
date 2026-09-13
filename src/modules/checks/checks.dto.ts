import { z } from 'zod'
import { isValidIsoDate } from '@shared/validation'

/** 'YYYY-MM-DD' de calendário real (mesma guarda do contrato/boleto). */
// Formato E existencia no calendario (gate socratico da Onda 1, fase Primeiro
// Cliente): regex de formato aceita '2026-13-45' e o MariaDB sem strict mode
// grava '0000-00-00' — inclusive em artefato IMUTAVEL (boleto, cheque).
// Regra da casa: o que valida e o que grava (setes-api/02-VALIDACAO.md).
const dateStr = z.string().refine(isValidIsoDate, 'Data invalida (use YYYY-MM-DD)')
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
