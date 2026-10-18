import { z } from 'zod'

/** PUT /:id — a lista COMPLETA das interfaces do estabelecimento (concede a lista, revoga as demais). */
export const institutionInterfacesDto = z.object({
  interfaceIds: z.array(z.number().int().positive()).max(1000),
})

export type InstitutionInterfacesDto = z.infer<typeof institutionInterfacesDto>
