import { z } from 'zod'

/**
 * DTO (Zod) do módulo interface-fields — configuração de UM campo
 * (decisão 3: escopo v1 = caption + required + mask).
 * required null = volta a herdar o catálogo; campos omitidos não mudam? NÃO:
 * o PUT é o estado COMPLETO da config do campo (mesmo padrão dos cadastros).
 */
export const fieldConfigDto = z.object({
  fieldCaption: z.string().min(1).max(100).nullable().optional(),
  required:     z.enum(['S', 'N']).nullable().optional(),
  mask:         z.string().min(1).max(50).nullable().optional(),
})

export type FieldConfigDto = z.infer<typeof fieldConfigDto>
