import { z } from 'zod'
import { DPS_SERIE_MIN, DPS_SERIE_MAX } from '@shared/tax-authority/dps-builder'

/**
 * Sub-recurso EMISSOR FISCAL do próprio estabelecimento (Onda 3 — conceito A):
 * o que é DADO da habilitação (ambiente + série, por modelo). O certificado entra
 * por outro DTO, write-only (.pfx + senha), e nunca volta.
 */

/** Modelo na URL — domínio de tb_invoice.model. '65' existe no domínio mas ainda não é suportado (422 no service). */
export const issuerModelParam = z.enum(['SE', '55', '65'])
export const issuerEnvironmentParam = z.enum(['H', 'P'])

export const issuerDto = z.object({
  environment: z.enum(['H', 'P']),
  // série é CONTADOR do emissor por modelo (D-E2): só dígitos, até 5 (VARCHAR(5)), normalizada
  // sem zeros à esquerda no service. ACHADO 3 do gate adversarial: a PORTA já recusa 0/00000/50000+
  // (séries do aplicativo próprio = 1–49999; 50000+ são do emissor nacional — §1 do prompt).
  // NF-e admite série 0 no SEFAZ: quando a onda 55 executar, a faixa passa a depender do modelo (Q-E).
  serie: z.string().trim().min(1).max(5).regex(/^\d{1,5}$/, 'Série com 1 a 5 dígitos')
    .refine(s => Number(s) >= DPS_SERIE_MIN && Number(s) <= DPS_SERIE_MAX, `Série entre ${DPS_SERIE_MIN} e ${DPS_SERIE_MAX}`),
})

/**
 * Upload WRITE-ONLY do A1 (D-N5): o .pfx em base64 e a senha que o abre. Os dois
 * existem só nesta requisição — a peça converte para PEM e grava apenas o par.
 * 64k de base64 ≈ 48 KB de .pfx (um A1 real tem 3–8 KB).
 */
export const issuerCertificateDto = z.object({
  pfxBase64: z.string().min(1).max(64_000),
  password:  z.string().max(200),
})

export type IssuerDto = z.infer<typeof issuerDto>
export type IssuerCertificateDto = z.infer<typeof issuerCertificateDto>
