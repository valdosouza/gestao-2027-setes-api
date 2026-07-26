import { z } from 'zod'

/**
 * DTOs (Zod) do módulo states — contrato de entrada da API.
 * Saída: StateRow (states.interface.ts), camelCase, com countryName do JOIN.
 */

// PUT não altera o id — só os demais campos.
export const stateUpdateDto = z.object({
  tbCountryId:  z.number().int().nonnegative(),
  abbreviation: z.string().min(1).max(2),
  name:         z.string().min(1).max(100),
  aliquota:     z.number().nullable().optional(),
})

// Código do estado é o código IBGE da UF (ex.: Paraná 41, São Paulo 35),
// informado pelo usuário na inclusão; NÃO é sequencial (decisão do Valdo, 2026-07-11).
export const stateCreateDto = stateUpdateDto.extend({
  id: z.number().int().positive(),
})

export type StateUpdateDto = z.infer<typeof stateUpdateDto>
export type StateCreateDto = z.infer<typeof stateCreateDto>
