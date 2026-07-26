import { z } from 'zod'

/**
 * DTO (Zod) do módulo interface-configs — valor de UMA configuração.
 * content null = volta a herdar (institution → default); a validação do
 * conteúdo contra o kind do catálogo acontece no service (decisão 6).
 */
export const configValueDto = z.object({
  content: z.string().max(100).nullable(),
  target:  z.enum(['I', 'U']),
})

export type ConfigValueDto = z.infer<typeof configValueDto>
