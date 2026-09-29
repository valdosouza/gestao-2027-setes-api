import { z } from 'zod'
import { addressBody, phoneBody, socialMediaBody } from '@shared/entity'
import { TAX_REGIMES, SIMPLES_REGIME_CODES, SPECIAL_TAX_REGIME_CODES } from '@shared/entity-tax/entity-tax.types'

/**
 * DTO (Zod) do módulo establishment — SÓ os campos editáveis do próprio
 * estabelecimento. `document`/`personType` (e qualquer outro campo) que o
 * cliente mande no body são ignorados SILENCIOSAMENTE: z.object() por
 * padrão faz strip de chaves desconhecidas — não é erro, é DTO mais
 * estreito (skill novo-modulo.md).
 */

function checkUniqueKinds(
  data: { addresses: Array<{ kind: string }>; phones: Array<{ kind: string }>; socials: Array<{ kind: string }> },
  ctx: z.RefinementCtx
): void {
  const lists: Array<[string, Array<{ kind: string }>]> = [
    ['addresses', data.addresses],
    ['phones', data.phones],
    ['socials', data.socials],
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

export const establishmentUpdateDto = z.object({
  nameCompany: z.string().min(1).max(100),
  nickTrade:   z.string().max(100).nullable(),
  ie:          z.string().max(45).nullable().optional(),
  im:          z.string().max(45).nullable().optional(),
  // D39.2: campo avulso — o resto da tributação continua com os defaults
  // da peça @shared/entity-tax (D39.4: NÃO obrigatório; o enforcement fica
  // na issue bloqueante do billing/validate).
  taxRegime:   z.enum(TAX_REGIMES).nullable().optional(),
  // Onda 3 (D-E3/D-E23): opSimpNac, regEspTrib e CNAE do EMITENTE — na aba
  // Tributação do Meu Estabelecimento, nunca na habilitação do emissor.
  simplesRegime:    z.enum(SIMPLES_REGIME_CODES).nullable().optional(),
  specialTaxRegime: z.enum(SPECIAL_TAX_REGIME_CODES).nullable().optional(),
  cnae:             z.string().regex(/^\d{7}$/, 'CNAE com 7 dígitos').nullable().optional(),
  addresses:   z.array(addressBody),
  phones:      z.array(phoneBody),
  socials:     z.array(socialMediaBody),
}).superRefine(checkUniqueKinds)

export type EstablishmentUpdateDto = z.infer<typeof establishmentUpdateDto>
