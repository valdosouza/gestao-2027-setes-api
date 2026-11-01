import { z } from 'zod'

/** PUT /:id/interfaces/:interfaceId — UMA marca (D-PV34): concede (`linked: true`) ou revoga (`linked: false`). */
export const institutionInterfaceLinkDto = z.object({
  linked: z.boolean(),
})

export type InstitutionInterfaceLinkDto = z.infer<typeof institutionInterfaceLinkDto>
