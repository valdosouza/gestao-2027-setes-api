import { z } from 'zod'

/**
 * DTOs (Zod) do módulo payment-types. POST em DOIS modos (workflow do
 * Valdo): paymentTypeId = vincular forma existente do catálogo; sem
 * paymentTypeId = criar/reusar pela description (a API deduplica por
 * descrição DENTRO da transação). id_nfce = 2 dígitos da lista fiscal
 * (combobox no app). Atributos do vínculo com DEFAULTS — o form sempre
 * manda todos, mas payload parcial não quebra.
 */

const flag = z.enum(['S', 'N'])

/** Atributos do vínculo (migration 012) — compartilhados por POST e PUT. */
const linkAttrs = {
  enable:                  flag.default('S'),
  appMobile:               flag.default('N'),
  blockForCustomerBlocked: flag.default('N'),
  blockForCustomerNoLimit: flag.default('N'),
  maxParcels:              z.number().int().min(1).max(999).default(1),
  tef:                     flag.default('N'),
  financialPlansIdCre:     z.number().int().min(0).default(0),
  financialPlansIdDeb:     z.number().int().min(0).default(0),
  // usagePreference APOSENTADA (migration 038 — D17 do contrato financeiro):
  // destino caixa × banco vem do tb_financial_contract. Payload antigo com o
  // campo é ignorado (strip padrão do Zod).
}

export const paymentTypeLinkDto = z.object({
  paymentTypeId: z.number().int().positive().nullable().optional(),
  description:   z.string().min(1).max(45).nullable().optional(),
  idNfce:        z.string().regex(/^\d{2}$/, 'Código NF-e deve ter 2 dígitos')
                   .nullable().optional(),
  ...linkAttrs,
}).refine(
  body => body.paymentTypeId != null ||
          (body.description != null && body.description.trim().length > 0),
  { message: 'Informe paymentTypeId (vincular) ou description (criar)',
    path: ['description'] },
)

/** PUT: atributos do vínculo + código NF-e (editável na tela — atualiza a
 *  linha do catálogo CENTRAL; null = sem código). */
export const paymentTypeLinkUpdateDto = z.object({
  ...linkAttrs,
  idNfce: z.string().regex(/^\d{2}$/, 'Código NF-e deve ter 2 dígitos')
            .nullable().optional(),
})

export type PaymentTypeLinkDto = z.infer<typeof paymentTypeLinkDto>
export type PaymentTypeLinkUpdateDto = z.infer<typeof paymentTypeLinkUpdateDto>
