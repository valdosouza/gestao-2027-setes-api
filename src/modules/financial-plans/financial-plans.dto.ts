import { z } from 'zod'

/**
 * DTOs (Zod) do módulo financial-plans — Plano de Contas em ÁRVORE.
 * O id é gerado MAX+1 por institution no backend. Domínios fechados
 * (semântica do legado — ControllerPlanoContas.pas): source = Natureza C/D,
 * kind = Tipo C/R, cluster = Nível S/A; defaults do Delphi (C/C/S) entram
 * no repository quando omitidos.
 */

const flag = z.enum(['S', 'N'])

export const financialPlanDto = z.object({
  description: z.string().min(1).max(100),
  source:      z.enum(['C', 'D']).optional(),
  kind:        z.enum(['C', 'R']).optional(),
  cluster:     z.enum(['S', 'A']).optional(),
  parentId:    z.number().int().positive().nullable().optional(),
  active:      flag.optional(),
})

export type FinancialPlanDto = z.infer<typeof financialPlanDto>
