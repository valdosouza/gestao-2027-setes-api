import { z } from 'zod'

/**
 * DTOs (Zod) do módulo contracts. Datas em 'YYYY-MM-DD'; itens com
 * produto ÚNICO por contrato (PK composta) e valor mensal >= 0;
 * dt_end (quando presente) não pode anteceder dt_start.
 */

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data em YYYY-MM-DD')

export const contractDto = z.object({
  customerId: z.number().int().positive(),
  dtStart:    dateStr,
  dtEnd:      dateStr.nullable().optional(),
  paymentDay: z.number().int().min(1).max(28).default(5),
  active:     z.enum(['S', 'N']).default('S'),
  items:      z.array(z.object({
                productId: z.number().int().positive(),
                value:     z.number().min(0),
              })).min(1, 'Contrato precisa de ao menos um produto'),
}).refine(
  body => body.dtEnd == null || body.dtEnd >= body.dtStart,
  { message: 'Data final não pode anteceder a inicial', path: ['dtEnd'] },
).refine(
  body => new Set(body.items.map(i => i.productId)).size === body.items.length,
  { message: 'Produto repetido nos itens do contrato', path: ['items'] },
)

export type ContractDto = z.infer<typeof contractDto>
