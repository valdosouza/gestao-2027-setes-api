import { z } from 'zod'
import { isValidCpf, isValidCnpj, normalizeCpf, normalizeCnpj } from '../validation'

/**
 * Schemas Zod FISCAIS (PF/PJ) — peça independente (SRP/ISP).
 * CPF/CNPJ chegam SEM máscara (decisão 19) e com dígito verificador
 * validado (decisão do Valdo, Rodada 3 — Fase 2 campos configuráveis).
 */

const dateRe = /^\d{4}-\d{2}-\d{2}$/

/**
 * D-CJ3 (frente do CNPJ alfanumérico, onda 1): a porta de ESCRITA aceita só a forma CANÔNICA da inscrição federal (sem máscara; CNPJ com letras
 * MAIÚSCULAS) — o que valida é o que grava (decisão 19). Recusa com o motivo certo: fora da forma mas canonicalizável → diz a forma esperada em
 * `fields[].expected` (o cliente corrige sem fazer parse da prosa); forma certa e DV errado → "dígito verificador não confere".
 */
function federalIdIssue(kind: 'cpf' | 'cnpj', v: string, ctx: z.RefinementCtx): void {
  const valid = kind === 'cnpj' ? isValidCnpj(v) : isValidCpf(v)
  if (valid) return
  const canonical = kind === 'cnpj' ? normalizeCnpj(v) : normalizeCpf(v)
  const label = kind === 'cnpj' ? 'CNPJ' : 'CPF'
  if (canonical !== null && canonical !== v && (kind === 'cnpj' ? isValidCnpj(canonical) : isValidCpf(canonical))) {
    ctx.addIssue({ code: 'custom', message: `${label} fora da forma canônica — envie sem máscara${kind === 'cnpj' ? ' e com letras maiúsculas' : ''}`,
      params: { expected: canonical } })
  } else if (canonical === null) {
    ctx.addIssue({ code: 'custom', message: kind === 'cnpj'
      ? 'CNPJ deve ter 12 letras ou números e 2 dígitos verificadores, sem máscara'
      : 'CPF deve ter 11 dígitos numéricos, sem máscara' })
  } else {
    ctx.addIssue({ code: 'custom', message: `${label} inválido (dígito verificador não confere)` })
  }
}

export const personBody = z.object({
  cpf:      z.string().superRefine((v, ctx) => federalIdIssue('cpf', v, ctx)),
  rg:       z.string().max(20).nullable().optional(),
  birthday: z.string().regex(dateRe, 'Data deve estar no formato AAAA-MM-DD')
             .nullable().optional(),
})

export const companyBody = z.object({
  // D-CJ8 (onda 1 da frente do CNPJ alfanumérico): a PORTA ABRIU — CNPJ alfanumérico (12 [0-9A-Z] + 2 DV, ASCII − 48) pela peça do núcleo; todo
  // consumidor que mutilava o valor já lê certo ou recusa legível (onda 0). O CHECK de forma no banco vem depois do acordo com o grupo do sync (D-CJ4).
  cnpj:         z.string().superRefine((v, ctx) => federalIdIssue('cnpj', v, ctx)),
  ie:           z.string().max(45).nullable().optional(),
  im:           z.string().max(45).nullable().optional(),
  dtFoundation: z.string().regex(dateRe, 'Data deve estar no formato AAAA-MM-DD')
                 .nullable().optional(),
})
