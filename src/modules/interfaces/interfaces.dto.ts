import { z } from 'zod'

/**
 * DTO (Zod) do módulo interfaces — mesmo shape para POST e PUT (o id é
 * gerado MAX+1 no backend e nunca muda; position texto livre — decisões do
 * Valdo, 2026-07-11). kind deixou de ser texto livre no Framework de
 * Configurações (decisão 13): 'T' = tela (vai a menu), 'R' = recurso/aba
 * vendável (nunca vai a menu); omitido = 'T'.
 */
export const interfaceDto = z.object({
  groupDefault: z.string().max(100).nullable().optional(),
  i18nKey:      z.string().max(100).nullable().optional(),
  description:  z.string().min(1).max(100),
  kind:         z.enum(['T', 'R']).nullable().optional(),
  position:     z.string().max(10).nullable().optional(),
  privilegeIds: z.array(z.number().int().positive()).optional(),
})

export type InterfaceDto = z.infer<typeof interfaceDto>

/**
 * DTO do catálogo de CONFIGURAÇÕES da interface (seção "Configurações" da
 * tela de Interfaces — decisões 6 e 7 do Framework de Configurações).
 * O default é validado contra o kind no service.
 */
export const interfaceConfigDto = z.object({
  description:    z.string().min(1).max(255),
  kind:           z.enum(['String', 'Integer', 'Float', 'Boolean', 'Date', 'Options']),
  options:        z.string().max(255).nullable().optional(),
  defaultContent: z.string().min(1).max(100),
  scope:          z.enum(['I', 'U']),
})

export type InterfaceConfigDto = z.infer<typeof interfaceConfigDto>
