import { z } from 'zod'

/**
 * DTO (Zod) do módulo price-lists. Tamanhos espelham o DDL
 * (description 45, modality 1); validity 'YYYY-MM-DD'.
 */

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data em YYYY-MM-DD')

export const priceListDto = z.object({
  description: z.string().min(1).max(45),
  validity:    dateStr.nullable().optional(),
  modality:    z.string().max(1).nullable().optional(),
  published:   z.enum(['S', 'N']).optional().default('S'),
})

export type PriceListDto = z.infer<typeof priceListDto>
