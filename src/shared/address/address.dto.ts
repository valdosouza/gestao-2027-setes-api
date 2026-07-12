import { z } from 'zod'

/** Schema Zod de ENDEREÇO — peça independente (SRP/ISP). */
export const addressBody = z.object({
  kind:         z.string().min(1).max(100),
  street:       z.string().min(1).max(100),
  nmbr:         z.string().max(10).nullable().optional(),
  complement:   z.string().max(100).nullable().optional(),
  neighborhood: z.string().max(100).nullable().optional(),
  zipCode:      z.string().max(15).nullable().optional(),
  tbCountryId:  z.number().int().positive(),
  tbStateId:    z.number().int().positive(),
  tbCityId:     z.number().int().positive(),
  main:         z.enum(['S', 'N']).optional(),
})
