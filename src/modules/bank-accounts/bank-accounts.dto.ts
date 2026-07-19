import { z } from 'zod'

/**
 * DTOs (Zod) do módulo bank-accounts. Tamanhos espelham o DDL
 * (agency 8+2, number 10+2, phone 10, manager 25); datas 'YYYY-MM-DD'.
 */

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data em YYYY-MM-DD')

export const bankAccountDto = z.object({
  bankId:     z.number().int().positive(),
  dtOpening:  dateStr.nullable().optional(),
  agency:     z.string().min(1).max(8),
  agencyDv:   z.string().max(2).nullable().optional(),
  number:     z.string().min(1).max(10),
  numberDv:   z.string().max(2).nullable().optional(),
  phone:      z.string().max(10).nullable().optional(),
  manager:    z.string().max(25).nullable().optional(),
  limitValue: z.number().min(0).nullable().optional(),
  dtContract: dateStr.nullable().optional(),
})

export type BankAccountDto = z.infer<typeof bankAccountDto>
