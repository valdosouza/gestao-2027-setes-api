import { z } from 'zod'

/**
 * DTOs (Zod) do módulo countries — contrato de entrada da API.
 * O contrato de saída é CountryRow (countries.interface.ts), camelCase,
 * o mesmo shape que o fromJson do app consome.
 */

// Código do país é padrão mundial (BACEN — ex.: Brasil 1058), informado pelo
// usuário na inclusão; NÃO é sequencial (decisão do Valdo, 2026-07-10).
export const countryCreateDto = z.object({
  id:   z.number().int().positive(),
  name: z.string().min(1).max(100),
})

// PUT não altera o id — só o nome.
export const countryUpdateDto = z.object({
  name: z.string().min(1).max(100),
})

export type CountryCreateDto = z.infer<typeof countryCreateDto>
export type CountryUpdateDto = z.infer<typeof countryUpdateDto>
