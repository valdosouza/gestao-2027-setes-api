import { z } from 'zod'

/**
 * DTOs (Zod) do módulo institutions — contrato de entrada da cadeia de
 * entidade fiscal (skill cadastro-entidade-fiscal.md):
 * entity + personType + person XOR company + 3 listas por kind + concreto.
 * Saída: InstitutionListRow / InstitutionFull (institutions.interface.ts).
 */

const dateRe = /^\d{4}-\d{2}-\d{2}$/

const entityDto = z.object({
  nameCompany: z.string().min(1).max(100),
  nickTrade:   z.string().min(1).max(100),
  aniversary:  z.string().regex(dateRe).nullable().optional(),
})

const personDto = z.object({
  cpf:      z.string().regex(/^\d{11}$/, 'CPF deve ter 11 dígitos numéricos'),
  rg:       z.string().max(20).nullable().optional(),
  birthday: z.string().regex(dateRe).nullable().optional(),
})

const companyDto = z.object({
  cnpj:         z.string().regex(/^\d{14}$/, 'CNPJ deve ter 14 dígitos numéricos'),
  ie:           z.string().max(45).nullable().optional(),
  im:           z.string().max(45).nullable().optional(),
  dtFoundation: z.string().regex(dateRe).nullable().optional(),
})

const addressDto = z.object({
  kind:         z.string().min(1).max(100),
  street:       z.string().min(1).max(100),
  nmbr:         z.string().max(10).nullable().optional(),
  complement:   z.string().max(100).nullable().optional(),
  neighborhood: z.string().max(100).nullable().optional(),
  zipCode:      z.string().max(15).nullable().optional(),
  tbCountryId:  z.number().int().positive(),
  tbStateId:    z.number().int().positive(),
  tbCityId:     z.number().int().positive(),
  main:         z.enum(['S', 'N']).optional(),
})

const phoneDto = z.object({
  kind:    z.string().min(1).max(20),
  contact: z.string().max(100).nullable().optional(),
  number:  z.string().max(20).nullable().optional(),
})

const socialMediaDto = z.object({
  kind: z.string().min(1).max(50),
  link: z.string().max(100).nullable().optional(),
})

const baseDto = z.object({
  entity:      entityDto,
  personType:  z.enum(['F', 'J']),
  person:      personDto.nullable().optional(),
  company:     companyDto.nullable().optional(),
  addresses:   z.array(addressDto).default([]),
  phones:      z.array(phoneDto).default([]),
  socialMedia: z.array(socialMediaDto).default([]),
  active:      z.enum(['S', 'N']).optional(),
})

/** personType='F' exige person (sem company) e 'J' exige company (sem person). */
function checkFiscalToggle(data: z.infer<typeof baseDto>, ctx: z.RefinementCtx): void {
  if (data.personType === 'F') {
    if (!data.person) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['person'],
        message: "personType='F' exige o objeto person (CPF)" })
    }
    if (data.company) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['company'],
        message: "personType='F' não aceita o objeto company" })
    }
  } else {
    if (!data.company) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['company'],
        message: "personType='J' exige o objeto company (CNPJ)" })
    }
    if (data.person) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['person'],
        message: "personType='J' não aceita o objeto person" })
    }
  }
}

/** Kind é PK junto com o id (tb_address/tb_phone/tb_social_media) — único por lista. */
function checkUniqueKinds(data: z.infer<typeof baseDto>, ctx: z.RefinementCtx): void {
  const lists: Array<[string, Array<{ kind: string }>]> = [
    ['addresses', data.addresses],
    ['phones', data.phones],
    ['socialMedia', data.socialMedia],
  ]
  for (const [name, list] of lists) {
    const seen = new Set<string>()
    for (const item of list) {
      if (seen.has(item.kind)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name],
          message: `kind duplicado em ${name}: "${item.kind}"` })
      }
      seen.add(item.kind)
    }
  }
}

// schema_name: padrão setes_<nome>, informado na inclusão e IMUTÁVEL na
// edição (decisão do Valdo, 2026-07-11) — por isso só existe no create.
export const institutionCreateDto = baseDto
  .extend({
    schemaName: z.string().max(100)
      .regex(/^setes_[a-z0-9_]+$/,
        'schemaName deve começar com "setes_" e conter apenas letras minúsculas, números e underscores'),
  })
  .superRefine(checkFiscalToggle)
  .superRefine(checkUniqueKinds)

export const institutionUpdateDto = baseDto
  .superRefine(checkFiscalToggle)
  .superRefine(checkUniqueKinds)

export type InstitutionCreateDto = z.infer<typeof institutionCreateDto>
export type InstitutionUpdateDto = z.infer<typeof institutionUpdateDto>
