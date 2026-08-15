import { z } from 'zod'

/**
 * DTOs (Zod) do módulo modules — contrato de entrada da API.
 * A ORDEM do array interfaceIds é a ordem das telas no menu (D3).
 */

export const moduleBodyDto = z.object({
  description:  z.string().trim().min(1).max(100),
  // Teto = INT do MySQL (gate adversarial 2026-08-04: sem ele, 1e21 passava
  // no isInteger e estourava 500 técnico no INSERT).
  position:     z.number().int().min(0).max(2_147_483_647).nullable().optional(),
  // Nome de ícone Material renderizado pelo app (D4 — image_icon deixou de
  // ser INT do legado).
  imageIcon:    z.string().trim().max(50).nullable().optional(),
  // max(200): muito acima do catálogo real (~26 telas) e fecha o abuso de
  // IN() e fields[] gigantes (gate adversarial 2026-08-04).
  interfaceIds: z.array(z.number().int().positive()).max(200).default([])
                 .refine(ids => new Set(ids).size === ids.length,
                   'Interface repetida no vínculo'),
})

export type ModuleBodyDto = z.infer<typeof moduleBodyDto>
