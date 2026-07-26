import { z } from 'zod'

/**
 * DTOs (Zod) do módulo categories — cadastro em ÁRVORE (posit_level
 * materializado). O id é gerado MAX+1 por institution no backend.
 * kind: 'P' = produtos, 'S' = serviços — define a árvore e é IMUTÁVEL
 * (mover entre árvores não é permitido); por isso só existe no create.
 */

const flag = z.enum(['S', 'N'])

export const categoryCreateDto = z.object({
  description: z.string().min(1).max(100),
  kind:        z.enum(['P', 'S']),
  parentId:    z.number().int().positive().nullable().optional(),
  active:      flag.optional(),
})

export const categoryUpdateDto = z.object({
  description: z.string().min(1).max(100),
  parentId:    z.number().int().positive().nullable().optional(),
  active:      flag.optional(),
})

export type CategoryCreateDto = z.infer<typeof categoryCreateDto>
export type CategoryUpdateDto = z.infer<typeof categoryUpdateDto>
