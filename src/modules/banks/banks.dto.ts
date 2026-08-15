import { z } from 'zod'

/**
 * DTOs (Zod) do módulo banks — contrato de entrada da API.
 * O contrato de saída é BankRow (banks.interface.ts), camelCase,
 * o mesmo shape que o fromJson do app consome.
 */

// O número FEBRABAN (3 dígitos) é o código externo do banco, digitado pelo
// usuário; o id é interno MAX+1 (o seed 17 já nasceu assim). Diferente do
// código de país, o number PODE ser corrigido na edição — ele não é a PK e
// as contas correntes apontam para o id (JOIN só para exibição).
export const bankCreateDto = z.object({
  // '000' não existe na tabela FEBRABAN (o menor é 001) — e como o número
  // não se reaproveita após exclusão, erro de digitação viraria lixo
  // permanente no catálogo (gate adversarial 2026-08-04).
  number:      z.string().regex(/^\d{3}$/, 'Número FEBRABAN deve ter 3 dígitos')
                 .refine(v => v !== '000', 'Número FEBRABAN inválido'),
  description: z.string().trim().min(1).max(100),
})

export const bankUpdateDto = bankCreateDto

export type BankCreateDto = z.infer<typeof bankCreateDto>
export type BankUpdateDto = z.infer<typeof bankUpdateDto>
