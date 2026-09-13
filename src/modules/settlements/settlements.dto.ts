import { z } from 'zod'
import { isValidIsoDate } from '@shared/validation'
import { toCents } from '@shared/money'

/**
 * DTOs (Zod) do módulo settlements. Valores da apuração INFORMADOS (P5);
 * paid_value > 0 (parcial permitido — o saldo é derivado); conta 0 =
 * Caixa; estorno exige motivo (5.5.4).
 */

// Formato E existencia no calendario (gate socratico da Onda 1, fase Primeiro
// Cliente): regex de formato aceita '2026-13-45' e o MariaDB sem strict mode
// grava '0000-00-00' — inclusive em artefato IMUTAVEL (boleto, cheque).
// Regra da casa: o que valida e o que grava (setes-api/02-VALIDACAO.md).
const dateStr = z.string().refine(isValidIsoDate, 'Data invalida (use YYYY-MM-DD)')

export const settleBatchDto = z.object({
  titles: z.array(z.object({
    orderId:         z.number().int().positive(),
    parcel:          z.number().int().positive(),
    interestValue:   z.number().min(0).default(0),
    lateValue:       z.number().min(0).default(0),
    // D-G35 (Q-G35/Q-A22, Valdo 2026-09-13): não existe desconto de 100 % — "desativar
    // a cobrança" é ato PRÓPRIO (B09/BX-04 do legado, onda futura), não baixa.
    discountAliquot: z.number().min(0).max(99.99, 'Desconto não pode cobrir o saldo inteiro (máximo 99,99 %)').default(0),
    paidValue:       z.number().gt(0),
  })).min(1, 'Selecione ao menos um título'),
  bankAccountId: z.number().int().min(0),
  dtPayment:     dateStr,
  dtRealPayment: dateStr.nullable().optional(),
  financialPlanCreId: z.number().int().min(0).nullable().optional(),
  financialPlanDebId: z.number().int().min(0).nullable().optional(),
}).refine(
  body => new Set(body.titles.map(t => `${t.orderId}-${t.parcel}`)).size
          === body.titles.length,
  { message: 'Título repetido no lote', path: ['titles'] },
).refine(
  // Q-A16/Q-A19 (3ª adversarial do cancelamento): juros + multa acima do pago
  // deixariam principal NEGATIVO (inflando o teto D-A7) e IGUAL ao pago deixa
  // principal ZERO ("recebimento só de encargos" não existe na casa — Valdo
  // rec.). Comparação em CENTAVOS pela regra do DECIMAL (Q-A27: 9,995 de
  // juros sobre 10 pagos vira 10,00 no banco — não passa; 10,005 idem).
  body => body.titles.every(t => toCents(t.interestValue) + toCents(t.lateValue) < toCents(t.paidValue)),
  { message: 'Juros + multa precisam ser menores que o valor pago (principal > 0)', path: ['titles'] },
)

export const reversalDto = z.object({
  orderId: z.number().int().positive(),
  parcel:  z.number().int().positive(),
  event:   z.number().int().positive(),
  reason:  z.string().min(1).max(100),
})

export type SettleBatchDto = z.infer<typeof settleBatchDto>
export type ReversalDto    = z.infer<typeof reversalDto>

/**
 * REDIRECIONAR A COBRANÇA de um título (D17/D19): forma que passa a valer e,
 * opcionalmente, novo vencimento. A tela desta onda manda só a forma — a peça
 * já aceita a condição inteira para o vencimento não exigir rota nova depois.
 */
export const retargetChargeDto = z.object({
  paymentTypeId: z.number().int().positive(),
  dtExpiration:  dateStr.nullable().optional(),
})

export type RetargetChargeDto = z.infer<typeof retargetChargeDto>
