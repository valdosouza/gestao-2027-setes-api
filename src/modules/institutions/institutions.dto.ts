import { z } from 'zod'
import { entityFiscalBody, withFiscalRefinements } from '@shared/entity'

/**
 * DTOs (Zod) do módulo institutions — o bloco da cadeia de entidade fiscal
 * vem COMPONÍVEL de @shared/entity/entity.dto (skill
 * cadastro-entidade-fiscal.md); aqui entram só os campos do concreto.
 * withFiscalRefinements (toggle XOR + kinds únicos) SEMPRE por último —
 * .extend não existe em ZodEffects.
 * Saída: InstitutionListRow / InstitutionFull (institutions.interface.ts).
 */

const institutionBase = entityFiscalBody.extend({
  active: z.enum(['S', 'N']).optional(),
})

// Primeiro admin do cliente (A2, 2026-08-15): OBRIGATÓRIO no create e
// inexistente no update — o estabelecimento nunca nasce sem dono, mas a
// manutenção dos usuários é do cadastro de Usuários, não daqui.
// Regras espelham users.dto (senha mín. 5, hash MD5 no service).
const institutionAdminDto = z.object({
  nameCompany: z.string().min(1).max(100),
  nickTrade:   z.string().min(1).max(100),
  email:       z.string().min(1).max(100).email('E-mail inválido'),
  password:    z.string().min(5).max(100),
})

// schema_name: padrão setes_<nome>, informado na inclusão e IMUTÁVEL na
// edição (decisão do Valdo, 2026-07-11) — por isso só existe no create.
export const institutionCreateDto = withFiscalRefinements(
  institutionBase.extend({
    schemaName: z.string().max(100)
      .regex(/^setes_[a-z0-9_]+$/,
        'schemaName deve começar com "setes_" e conter apenas letras minúsculas, números e underscores'),
    admin: institutionAdminDto,
  })
)

export const institutionUpdateDto = withFiscalRefinements(institutionBase)

export type InstitutionCreateDto = z.infer<typeof institutionCreateDto>
export type InstitutionUpdateDto = z.infer<typeof institutionUpdateDto>
