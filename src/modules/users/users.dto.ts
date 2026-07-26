import { z } from 'zod'

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
  password:      z.string().min(5).max(100),
  institutionId: z.number().int().positive().nullable().optional(),
  kind:          z.string().min(1).max(20).nullable().optional(),
})

// PUT: senha opcional — null/ausente mantém a atual.
export const userUpdateDto = z.object({
  ...base,
  password: z.string().min(5).max(100).nullable().optional(),
})

// PUT /:id/institutions — vínculos com kind (perfil por institution).
export const userInstitutionsDto = z.object({
  links: z.array(z.object({
    institutionId: z.number().int().positive(),
    kind:          z.string().min(1).max(20),
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
