import { z } from 'zod'

/**
 * DTOs (Zod) do módulo contracts. Datas em 'YYYY-MM-DD'; itens com
 * produto ÚNICO por contrato (PK composta) e valor mensal >= 0;
 * dt_end (quando presente) não pode anteceder dt_start.
 */

import { isValidIsoDate } from '@shared/validation'

// Formato E existência (gate adversarial da Onda 1): '2026-13-45' passava
// pelo regex e o MariaDB sem strict mode gravava '0000-00-00'.
const dateStr = z.string().refine(isValidIsoDate, 'Data inválida (use YYYY-MM-DD)')

export const contractDto = z.object({
  customerId: z.number().int().positive(),
  dtStart:    dateStr,
  dtEnd:      dateStr.nullable().optional(),
  paymentDay: z.number().int().min(1).max(28).default(5),
  /**
   * D14 (Valdo 2026-09-13): a forma combinada com o cliente. A PRESENÇA decide —
   * null = "informar no faturamento", que é o comportamento de antes.
   */
  paymentTypeId: z.number().int().positive().nullable().optional(),
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
