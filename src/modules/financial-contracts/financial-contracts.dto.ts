import { z } from 'zod'

/**
 * DTOs (Zod) do módulo financial-contracts. bankAccountId 0 = caixa (D1);
 * feeRate em % (DECIMAL(5,2)); paymentTerm em dias; expirationDate
 * 'YYYY-MM-DD' informativa (D2/D11); note texto livre.
 */

/** 'YYYY-MM-DD' E data de calendário real (2026-02-30 é recusada — gate
 *  adversarial 2026-09-03: o MariaDB sem STRICT gravava 0000-00-00 e o
 *  contrato "válido" nunca baixava). */
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data em YYYY-MM-DD')
  .refine(v => {
    const [y, m, d] = v.split('-').map(Number)
    const t = new Date(Date.UTC(y, m - 1, d))
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
  }, 'Data inexistente')

/** Taxa em % com no máximo 2 casas (DECIMAL(5,2) — sem arredondamento silencioso). */
const feeRate = z.number().min(0).max(100)
  .refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, 'Máximo 2 casas decimais')

const contractFields = {
  bankAccountId:  z.number().int().min(0).default(0),
  feeRate:        feeRate.default(0),
  paymentTerm:    z.number().int().min(0).max(3650).default(0),
  expirationDate: dateStr.nullable().optional(),
  note:           z.string().max(2000).nullable().optional(),
}

export const financialContractCreateDto = z.object({
  paymentTypeId: z.number().int().positive(),
  ...contractFields,
})

export const financialContractUpdateDto = z.object(contractFields)

export type FinancialContractCreateDto = z.infer<typeof financialContractCreateDto>
export type FinancialContractUpdateDto = z.infer<typeof financialContractUpdateDto>
