import { z } from 'zod'
import { entityFiscalBody, withFiscalRefinements } from '@shared/entity'
import { entityTaxBody } from '@shared/entity-tax/entity-tax.dto'

/**
 * DTOs (Zod) do módulo customers — o bloco da cadeia de entidade fiscal vem
 * COMPONÍVEL de @shared/entity (skill cadastro-entidade-fiscal.md); aqui
 * entram só os campos do concreto. withFiscalRefinements SEMPRE por último
 * (.extend não existe em ZodEffects).
 */

const flag = z.enum(['S', 'N'])

// Rodada 4: consumer/byPassSt saíram para `tax` (aba Tributação — undefined
// = não tocar); wallet = intenção Sim/Não (API resolve tb_payment_types_id);
// creditStatus L(iberado)/B(loqueado); multiplier default 1 no banco.
const customerBase = entityFiscalBody.extend({
  tbSalesmanId: z.number().int().positive().nullable().optional(),
  tbCarrierId:  z.number().int().positive().nullable().optional(),
  creditStatus: z.enum(['L', 'B']).nullable().optional(),
  creditValue:  z.number().nullable().optional(),
  wallet:       flag.nullable().optional(),
  multiplier:   z.number().nullable().optional(),
  active:       flag.optional(),
  tax:          entityTaxBody.nullable().optional(),
})

export const customerCreateDto = withFiscalRefinements(customerBase)
export const customerUpdateDto = withFiscalRefinements(customerBase)

export type CustomerCreateDto = z.infer<typeof customerCreateDto>
export type CustomerUpdateDto = z.infer<typeof customerUpdateDto>

/** Aba Parceria (v2): lista COMPLETA (sync por colaborador; vazia = sem
 *  parceria); Σ rate das ATIVAS ≤ 90 (os 10% da Setes são fixos). */
export const customerPartnershipDto = z.object({
  partners: z.array(z.object({
    collaboratorId: z.number().int().positive(),
    rate:           z.number().gt(0).max(90),
    active:         z.enum(['S', 'N']).default('S'),
  })),
}).refine(
  body => new Set(body.partners.map(p => p.collaboratorId)).size
          === body.partners.length,
  { message: 'Colaborador repetido na parceria', path: ['partners'] },
).refine(
  body => body.partners.filter(p => p.active === 'S')
            .reduce((sum, p) => sum + p.rate, 0) <= 90,
  { message: 'A soma dos percentuais ativos não pode passar de 90% (10% são da Setes)',
    path: ['partners'] },
)

export type CustomerPartnershipDto = z.infer<typeof customerPartnershipDto>
