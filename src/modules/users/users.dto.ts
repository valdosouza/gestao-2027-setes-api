import { z } from 'zod'
import { newPasswordSchema } from '@shared/auth/password'

/** Perfis do vínculo tb_institution_has_user.kind (vira o role do JWT) — D-BA23: domínio
 *  TIPADO (a tela user_institutions_section já só oferecia estes três; roles.ts reconhece
 *  'admin'/'super'). Reusado pelo critério `kind` da pesquisa avançada. */
export const USER_KINDS = ['user', 'admin', 'super'] as const
export type UserKind = typeof USER_KINDS[number]

/**
 * DTOs (Zod) do módulo users — contrato de entrada da API.
 * Senha: mínimo 5 (padrão do seed), hash MD5 aplicado no SERVICE
 * (@shared/auth/password — nunca na query, decisão 2 da Fase 2).
 */

const base = {
  nameCompany: z.string().min(1).max(100),
  nickTrade:   z.string().min(1).max(100),
  email:       z.string().min(1).max(100).email('E-mail inválido'),
  active:      z.enum(['S', 'N']).default('S'),
}

// POST: senha obrigatória (id é MAX+1 da tb_entity, gerado no backend).
// institutionId/kind: vínculo criado na MESMA transação (workflow 2026-07-12
// — aba Usuários do Estabelecimento manda o alvo; admin do cliente tem o
// alvo FORÇADO para a institution do JWT no service).
export const userCreateDto = z.object({
  ...base,
  password:      newPasswordSchema,                  // D-EA13: nunca só espaços
  institutionId: z.number().int().positive().nullable().optional(),
  kind:          z.enum(USER_KINDS).nullable().optional(),
})

// PUT: senha opcional — null/ausente mantém a atual. D-PV19 (2026-10-20): `active` é do VÍNCULO (ausente = não mexe) e o
// alvo é `institutionId` (só o super informa; o admin tem o alvo forçado ao JWT); o e-mail tem de ser o atual (imutável — D-UC1).
export const userUpdateDto = z.object({
  nameCompany: base.nameCompany,
  nickTrade:   base.nickTrade,
  email:       base.email,
  password:      newPasswordSchema.nullable().optional(),   // D-EA13: nunca só espaços
  active:        z.enum(['S', 'N']).optional(),
  institutionId: z.number().int().positive().nullable().optional(),
})

// PUT /:id/institutions — vínculos com kind (perfil por institution).
export const userInstitutionsDto = z.object({
  links: z.array(z.object({
    institutionId: z.number().int().positive(),
    kind:          z.enum(USER_KINDS),
  })),
})

// PUT /:id/privileges/:interfaceId — sincroniza a concessão de UMA interface.
// institutionId: obrigatório para o super (alvo explícito); o admin do
// cliente tem o alvo forçado ao JWT.
export const userPrivilegesDto = z.object({
  institutionId: z.number().int().positive().nullable().optional(),
  privilegeIds:  z.array(z.number().int().positive()),
})

export type UserCreateDto = z.infer<typeof userCreateDto>
export type UserUpdateDto = z.infer<typeof userUpdateDto>
export type UserInstitutionsDto = z.infer<typeof userInstitutionsDto>
