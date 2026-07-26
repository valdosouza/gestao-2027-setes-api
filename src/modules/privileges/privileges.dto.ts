import { z } from 'zod'

/**
 * DTO (Zod) do módulo privileges — mesmo shape para POST e PUT (o id é
 * gerado MAX+1 no backend e nunca muda — decisão do Valdo, 2026-07-11).
 * description é varchar(100) na tb_privilege.
 */
export const privilegeDto = z.object({
  description: z.string().min(1).max(100),
})

export type PrivilegeDto = z.infer<typeof privilegeDto>
