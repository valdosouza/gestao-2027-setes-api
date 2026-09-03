import { z } from 'zod'

/**
 * DTOs (Zod) do módulo service-list. O item (id) é informado pelo usuário
 * SÓ no POST (imutável na edição — padrão de código externo, precedente
 * cfop): "N.NN" com 1–2 dígitos antes do ponto e 2 depois.
 */

export const SERVICE_LIST_CODE_RE = /^\d{1,2}\.\d{2}$/

const base = z.object({
  description:    z.string().min(1).max(255),
  localIncidence: z.enum(['P', 'E']).optional().default('P'),
  active:         z.enum(['S', 'N']).optional().default('S'),
})

export const serviceListCreateDto = base.extend({
  id: z.string().regex(SERVICE_LIST_CODE_RE, 'Item da lista inválido (ex.: 1.01)'),
})

export const serviceListUpdateDto = base

export type ServiceListCreateDto = z.infer<typeof serviceListCreateDto>
export type ServiceListUpdateDto = z.infer<typeof serviceListUpdateDto>
