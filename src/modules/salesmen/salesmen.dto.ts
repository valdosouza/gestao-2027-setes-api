import { z } from 'zod'

/**
 * DTOs (Zod) do módulo salesmen — SÓ os campos do papel (D1: a cadeia
 * fiscal não é editada aqui; a identificação vem do colaborador promovido).
 */

const flag = z.enum(['S', 'N'])

const salesmanBase = z.object({
  active:          flag.optional(),
  aliqKickback:    z.number().min(0, 'Percentual não pode ser negativo')
                    .max(100, 'Percentual máximo é 100').nullable().optional(),
  kickbackProduct: flag.nullable().optional(),
  flexValue:       z.number().min(0, 'Valor não pode ser negativo').optional(),
})

/** POST: id = colaborador promovido (vem do lookup — D1). */
export const salesmanCreateDto = salesmanBase.extend({
  id: z.number().int().positive(),
})

export const salesmanUpdateDto = salesmanBase

export type SalesmanCreateDto = z.infer<typeof salesmanCreateDto>
export type SalesmanUpdateDto = z.infer<typeof salesmanUpdateDto>
