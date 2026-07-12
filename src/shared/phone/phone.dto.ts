import { z } from 'zod'

/** Schema Zod de FONE — peça independente (SRP/ISP). */
export const phoneBody = z.object({
  kind:    z.string().min(1).max(20),
  contact: z.string().max(100).nullable().optional(),
  number:  z.string().max(20).nullable().optional(),
})
