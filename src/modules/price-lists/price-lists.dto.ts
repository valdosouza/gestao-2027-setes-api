import { z } from 'zod'
import { isValidIsoDate } from '@shared/validation'

/**
 * DTO (Zod) do módulo price-lists. Tamanhos espelham o DDL
 * (description 45, modality 1); validity 'YYYY-MM-DD'.
 */

// Formato E existencia no calendario (gate socratico da Onda 1, fase Primeiro
// Cliente): regex de formato aceita '2026-13-45' e o MariaDB sem strict mode
// grava '0000-00-00' — inclusive em artefato IMUTAVEL (boleto, cheque).
// Regra da casa: o que valida e o que grava (setes-api/02-VALIDACAO.md).
const dateStr = z.string().refine(isValidIsoDate, 'Data invalida (use YYYY-MM-DD)')

export const priceListDto = z.object({
  description: z.string().min(1).max(45),
  validity:    dateStr.nullable().optional(),
  modality:    z.string().max(1).nullable().optional(),
  published:   z.enum(['S', 'N']).optional().default('S'),
})

export type PriceListDto = z.infer<typeof priceListDto>
