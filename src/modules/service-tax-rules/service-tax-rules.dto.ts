import { z } from 'zod'

/**
 * DTO (Zod) do módulo service-tax-rules. aliq em % (0–100 — teto/piso são
 * lei municipal, não se impõem aqui: o cliente cadastra a que informa,
 * D13); municipalCode até 20 (código de tributação do município — D4).
 */

export const serviceTaxRuleDto = z.object({
  cityId:        z.number().int().positive(),
  serviceListId: z.string().regex(/^\d{1,2}\.\d{2}$/, 'Item da lista inválido (ex.: 1.01)'),
  aliq:          z.number().min(0).max(100),
  municipalCode: z.string().max(20).nullable().optional(),
  active:        z.enum(['S', 'N']).optional().default('S'),
})

export type ServiceTaxRuleDto = z.infer<typeof serviceTaxRuleDto>
