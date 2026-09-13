import { z } from 'zod'
import { isValidIsoDate } from '@shared/validation'
import { entityFiscalBody, withFiscalRefinements } from '@shared/entity'

/**
 * DTOs (Zod) do módulo collaborators — o bloco da cadeia de entidade fiscal
 * vem COMPONÍVEL de @shared/entity (skill cadastro-entidade-fiscal.md);
 * aqui entram só os campos do concreto. withFiscalRefinements SEMPRE por
 * último (.extend não existe em ZodEffects).
 */

const flag    = z.enum(['S', 'N'])
// Formato E existencia no calendario (gate socratico da Onda 1, fase Primeiro
// Cliente): regex de formato aceita '2026-13-45' e o MariaDB sem strict mode
// grava '0000-00-00' — inclusive em artefato IMUTAVEL (boleto, cheque).
// Regra da casa: o que valida e o que grava (setes-api/02-VALIDACAO.md).
const isoDate = z.string().refine(isValidIsoDate, 'Data invalida (use YYYY-MM-DD)')

const collaboratorBase = entityFiscalBody.extend({
  dtAdmission:         isoDate.nullable().optional(),
  dtResignation:       isoDate.nullable().optional(),
  salary:              z.number().nullable().optional(),
  fathersName:         z.string().max(100).nullable().optional(),
  mothersName:         z.string().max(100).nullable().optional(),
  voteNumber:          z.string().max(20).nullable().optional(),
  voteZone:            z.string().max(10).nullable().optional(),
  voteSection:         z.string().max(10).nullable().optional(),
  militaryCertificate: z.string().max(30).nullable().optional(),
  pis:                 z.string().max(20).nullable().optional(),
  active:              flag.optional(),
})

export const collaboratorCreateDto = withFiscalRefinements(collaboratorBase)
export const collaboratorUpdateDto = withFiscalRefinements(collaboratorBase)

export type CollaboratorCreateDto = z.infer<typeof collaboratorCreateDto>
export type CollaboratorUpdateDto = z.infer<typeof collaboratorUpdateDto>
