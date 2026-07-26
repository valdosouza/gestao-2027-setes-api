import { z } from 'zod'

/**
 * DTOs (Zod) do módulo cities — contrato de entrada da API.
 * Saída: CityRow (cities.interface.ts), camelCase, com stateName do JOIN.
 */

export const cityUpdateDto = z.object({
  tbStateId:  z.number().int().nonnegative(),
  ibge:       z.string().max(20).nullable().optional(),
  name:       z.string().min(1).max(100),
  aliqIss:    z.number().min(0).optional(),
  population: z.number().int().min(0).optional(),
  density:    z.number().min(0).optional(),
  area:       z.number().min(0).optional(),
})

// Código da cidade é o código IBGE do município (ex.: Curitiba 4004),
// informado pelo usuário na inclusão; NÃO é sequencial (decisão do Valdo, 2026-07-11).
export const cityCreateDto = cityUpdateDto.extend({
  id: z.number().int().positive(),
})

export type CityUpdateDto = z.infer<typeof cityUpdateDto>
export type CityCreateDto = z.infer<typeof cityCreateDto>
