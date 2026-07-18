import { z } from 'zod'
import { entityFiscalBody, withFiscalRefinements } from '@shared/entity'

/**
 * DTOs (Zod) do módulo collaborators — o bloco da cadeia de entidade fiscal
 * vem COMPONÍVEL de @shared/entity (skill cadastro-entidade-fiscal.md);
 * aqui entram só os campos do concreto. withFiscalRefinements SEMPRE por
 * último (.extend não existe em ZodEffects).
 */

const flag    = z.enum(['S', 'N'])
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve ser AAAA-MM-DD')

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
