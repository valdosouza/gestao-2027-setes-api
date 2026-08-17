import { z } from 'zod'

/**
 * DTOs do cadastro da Regra de Tributação. PRESENÇA = incidência: peça
 * omitida = tributo não definido pela regra; regra sem NENHUMA peça é 422
 * (não define nada — não existe no domínio). Decisões 1/23 da fase.
 */

const flagSN = z.enum(['S', 'N'])

const selectorDto = z.object({
  productId: z.number().int().positive().nullish(),   // null = coringa
  entityId:  z.number().int().positive().nullish(),   // null = coringa
  ncm:       z.string().regex(/^\d{2,8}$/).nullish(), // prefixos são regra do FCP; aqui NCM pleno ou parcial
  origin:    z.enum(['0', '1', '2', '3', '4', '5', '6', '7', '8']),
  finalConsumer: flagSN,
  simples:   flagSN,
  st:        flagSN,
  purpose:   z.enum(['0', '1', '2', '3', '4', '5', '6', '7']),
  direction: z.enum(['E', 'S']).nullish(),
  cfopId:    z.string().max(10).nullish(),
  stateId:   z.number().int().positive().nullish(),   // null = coringa interestadual
  observationId: z.number().int().positive().nullish(),
  taxesId:   z.number().int().positive().nullish(),
})

const icmsDto = z.object({
  cstNr:  z.string().length(2).nullish(),
  csosn:  z.string().length(3).nullish(),
  modBc:  z.string().max(2).nullish(),
  dischargeId: z.number().int().positive().nullish(),
  aliq:          z.number().min(0).max(100).nullish(),
  aliqReduction: z.number().min(0).max(100).nullish(),
  baseReduction: z.number().min(0).max(100).nullish(),
  deferred:      flagSN.optional().default('N'),
  deferredAliq:  z.number().min(0).max(100).nullish(),
  highlight:     flagSN.optional().default('N'),
}).refine(v => v.cstNr || v.csosn,
  { message: 'Informe o CST (regime normal) e/ou o CSOSN (Simples)', path: ['cstNr'] })

const icmsStDto = z.object({
  modBcSt: z.string().max(2).nullish(),
  propagateBaseReduction: flagSN.optional().default('N'),
})

const ipiDto = z.object({
  cst:  z.string().length(2),
  aliq: z.number().min(0).max(100).nullish(),
})

const pisCofinsDto = z.object({
  kind: z.enum(['P', 'C']),
  cst:  z.string().length(2),
  aliq: z.number().min(0).max(100).nullish(),
})

const iiDto = z.object({
  iiAliq:       z.number().min(0).max(100).nullish(),
  irpjAliq:     z.number().min(0).max(100).nullish(),
  csllAliq:     z.number().min(0).max(100).nullish(),
  afrmmAliq:    z.number().min(0).max(100).nullish(),
  siscomexAliq: z.number().min(0).max(100).nullish(),
})

export const taxRuleBodyDto = z.object({
  selector:  selectorDto,
  icms:      icmsDto.nullish(),
  icmsSt:    icmsStDto.nullish(),
  ipi:       ipiDto.nullish(),
  pisCofins: z.array(pisCofinsDto).max(2).nullish()
               .refine(arr => {
                 const kinds = (arr ?? []).map(p => p.kind)
                 return new Set(kinds).size === kinds.length
               }, { message: 'No máximo uma peça por kind (P/C)' }),
  ii:        iiDto.nullish(),
}).refine(
  b => b.icms || b.ipi || (b.pisCofins?.length ?? 0) > 0 || b.ii,
  { message: 'A regra precisa definir pelo menos um tributo (presença = incidência)',
    path: ['selector'] }
)

export type TaxRuleBodyDto = z.infer<typeof taxRuleBodyDto>
