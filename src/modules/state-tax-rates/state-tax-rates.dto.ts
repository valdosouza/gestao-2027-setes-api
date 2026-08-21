import { z } from 'zod'

/**
 * DTOs do catálogo MVA/FCP por UF×NCM. NCM aceita 2–8 dígitos (mesma
 * tolerância do resto do domínio fiscal — decisão 36: o prefixo é regra
 * SÓ do FCP, o cadastro em si não distingue).
 */

const ncmSchema = z.string().regex(/^\d{2,8}$/, 'NCM deve ter 2 a 8 dígitos')
const aliqSchema = z.number().min(0).max(100)

export const stateMvaNcmBodyDto = z.object({
  stateId: z.number().int().positive(),
  ncm: ncmSchema,
  internalAliq: aliqSchema,
  mvaOriginal: z.number().min(0),
  mvaAdjusted: z.number().min(0).nullish(),
})
export type StateMvaNcmBodyDto = z.infer<typeof stateMvaNcmBodyDto>

export const stateFcpNcmBodyDto = z.object({
  stateId: z.number().int().positive(),
  ncm: ncmSchema,
  aliq: aliqSchema,
})
export type StateFcpNcmBodyDto = z.infer<typeof stateFcpNcmBodyDto>
