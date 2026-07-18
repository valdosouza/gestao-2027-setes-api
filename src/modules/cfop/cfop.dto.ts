import { z } from 'zod'

/**
 * DTOs (Zod) do módulo cfop. O código CFOP (id) é informado pelo usuário
 * SÓ no POST (imutável na edição — padrão de código externo, precedente
 * countries/BACEN): dígitos com pontos opcionais, até 10 chars.
 */

export const CFOP_CODE_RE = /^[0-9][0-9.]{0,9}$/

const cfopBase = z.object({
  description:  z.string().min(1).max(100),
  concise:      z.string().max(60).nullable().optional(),
  register:     z.number().int().nullable().optional(),
  way:          z.enum(['E', 'S']).nullable().optional(),
  jurisdiction: z.enum(['E', 'N', 'X']).nullable().optional(),
  note:         z.string().max(60000).nullable().optional(),
  active:       z.enum(['S', 'N']).optional(),
})

export const cfopCreateDto = cfopBase.extend({
  id: z.string().regex(CFOP_CODE_RE, 'Código CFOP inválido'),
})

export const cfopUpdateDto = cfopBase

export type CfopCreateDto = z.infer<typeof cfopCreateDto>
export type CfopUpdateDto = z.infer<typeof cfopUpdateDto>
