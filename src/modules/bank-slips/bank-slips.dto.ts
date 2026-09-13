import { z } from 'zod'
import { isValidIsoDate } from '@shared/validation'

/** 'YYYY-MM-DD' de calendário real (lição do regra de recebimento). */
// Formato E existencia no calendario (gate socratico da Onda 1, fase Primeiro
// Cliente): regex de formato aceita '2026-13-45' e o MariaDB sem strict mode
// grava '0000-00-00' — inclusive em artefato IMUTAVEL (boleto, cheque).
// Regra da casa: o que valida e o que grava (setes-api/02-VALIDACAO.md).
const dateStr = z.string().refine(isValidIsoDate, 'Data invalida (use YYYY-MM-DD)')
  .refine(v => {
    const [y, m, d] = v.split('-').map(Number)
    const t = new Date(Date.UTC(y, m - 1, d))
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
  }, 'Data inexistente')

const titleRef = z.object({
  orderId: z.number().int().positive(),
  parcel:  z.number().int().positive(),
})

/** Emissão: 1 título (individual) ou N do mesmo cliente (agrupado — vencimento obrigatório). */
export const issueBankSlipDto = z.object({
  agreementId:  z.number().int().positive(),
  titles:       z.array(titleRef).min(1).max(200),
  dtExpiration: dateStr.nullable().optional(),
  /**
   * D15: emitir boleto DESTINA o título (regra BOL-02 do legado) — a forma de
   * cobrança do título passa a ser a de boleto. Só é preciso informar quando a
   * institution tem 2+ formas kind='B' habilitadas; com uma só, a peça resolve.
   */
  paymentTypeId: z.number().int().positive().optional(),
})

/** Liquidação manual (extrato do cliente — D5/D7). */
export const settleBankSlipDto = z.object({
  // gate adversarial 2026-09-04: 0.004 passava em positive() e liquidava com
  // zero; 1e12 estourava o DECIMAL(10,2) — o banco truncava em silêncio
  paidValue: z.number().min(0.01).max(99999999.99),
  dtPayment: dateStr,
})

export const cancelBankSlipDto = z.object({
  note: z.string().max(255).nullable().optional(),
})

export const reverseBankSlipDto = z.object({
  reason: z.string().min(1).max(100),
})

export type IssueBankSlipDto = z.infer<typeof issueBankSlipDto>
export type SettleBankSlipDto = z.infer<typeof settleBankSlipDto>
export type CancelBankSlipDto = z.infer<typeof cancelBankSlipDto>
export type ReverseBankSlipDto = z.infer<typeof reverseBankSlipDto>
