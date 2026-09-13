import { z } from 'zod'
import { isValidIsoDate } from '@shared/validation'

/**
 * DTOs (Zod) do módulo bank-accounts. Tamanhos espelham o DDL
 * (agency 8+2, number 10+2, phone 10, manager 25); datas 'YYYY-MM-DD'.
 */

// Formato E existencia no calendario (gate socratico da Onda 1, fase Primeiro
// Cliente): regex de formato aceita '2026-13-45' e o MariaDB sem strict mode
// grava '0000-00-00' — inclusive em artefato IMUTAVEL (boleto, cheque).
// Regra da casa: o que valida e o que grava (setes-api/02-VALIDACAO.md).
const dateStr = z.string().refine(isValidIsoDate, 'Data invalida (use YYYY-MM-DD)')

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
