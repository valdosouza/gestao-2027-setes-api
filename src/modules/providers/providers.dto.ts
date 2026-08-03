import { z } from 'zod'
import { entityFiscalBody, withFiscalRefinements } from '@shared/entity'
import { entityTaxBody } from '@shared/entity-tax/entity-tax.dto'

/**
 * DTOs (Zod) do módulo providers — o bloco da cadeia de entidade fiscal vem
 * COMPONÍVEL de @shared/entity; aqui entram só os campos do concreto + a
 * aba Tributação (D1). withFiscalRefinements SEMPRE por último (.extend não
 * existe em ZodEffects).
 */

const flag = z.enum(['S', 'N'])

const providerBase = entityFiscalBody.extend({
  active: flag.optional(),
  tax:    entityTaxBody.nullable().optional(),
})

export const providerCreateDto = withFiscalRefinements(providerBase)
export const providerUpdateDto = withFiscalRefinements(providerBase)

export type ProviderCreateDto = z.infer<typeof providerCreateDto>
export type ProviderUpdateDto = z.infer<typeof providerUpdateDto>
