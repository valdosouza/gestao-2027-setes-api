import { z } from 'zod'

/**
 * DTO (Zod) do módulo interfaces — mesmo shape para POST e PUT (o id é
 * gerado MAX+1 no backend e nunca muda; kind e position texto livre —
 * decisões do Valdo, 2026-07-11).
 */
export const interfaceDto = z.object({
  groupDefault: z.string().max(100).nullable().optional(),
  i18nKey:      z.string().max(100).nullable().optional(),
  description:  z.string().min(1).max(100),
  kind:         z.string().max(26).nullable().optional(),
  position:     z.string().max(10).nullable().optional(),
  privilegeIds: z.array(z.number().int().positive()).optional(),
})

export type InterfaceDto = z.infer<typeof interfaceDto>
