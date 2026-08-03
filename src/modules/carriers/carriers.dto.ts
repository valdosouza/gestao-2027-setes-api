import { z } from 'zod'
import { entityFiscalBody, withFiscalRefinements } from '@shared/entity'
import { entityTaxBody } from '@shared/entity-tax/entity-tax.dto'

/**
 * DTOs (Zod) do módulo carriers — o bloco da cadeia de entidade fiscal vem
 * COMPONÍVEL de @shared/entity; aqui entram só os campos do concreto + a
 * aba Tributação (D2). withFiscalRefinements SEMPRE por último (.extend não
 * existe em ZodEffects).
 */

const flag = z.enum(['S', 'N'])

const carrierBase = entityFiscalBody.extend({
  active: flag.optional(),
  tax:    entityTaxBody.nullable().optional(),
})

export const carrierCreateDto = withFiscalRefinements(carrierBase)
export const carrierUpdateDto = withFiscalRefinements(carrierBase)

export type CarrierCreateDto = z.infer<typeof carrierCreateDto>
export type CarrierUpdateDto = z.infer<typeof carrierUpdateDto>
