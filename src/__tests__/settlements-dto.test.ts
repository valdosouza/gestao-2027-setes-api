/// <reference types="jest" />
// Q-A16 (3ª adversarial do cancelamento): juros + multa acima do valor pago
// deixariam principal negativo e inflariam o teto D-A7.
import { settleBatchDto } from '../modules/settlements/settlements.dto'

const base = { bankAccountId: 0, dtPayment: '2026-09-09' }
describe('settleBatchDto — juros + multa ≤ pago', () => {
  it('juros 10 sobre pago 5 → inválido; juros 5 sobre pago 45 → válido', () => {
    expect(settleBatchDto.safeParse({ ...base, titles: [{ orderId: 1, parcel: 1, paidValue: 5, interestValue: 10 }] }).success).toBe(false)
    expect(settleBatchDto.safeParse({ ...base, titles: [{ orderId: 1, parcel: 1, paidValue: 45, interestValue: 5 }] }).success).toBe(true)
  })
  it('Q-A19: principal ZERO (juros + multa = pago) → inválido; arredondamento em 2 casas (10,005 sobre 10 não passa)', () => {
    expect(settleBatchDto.safeParse({ ...base, titles: [{ orderId: 1, parcel: 1, paidValue: 5, interestValue: 3, lateValue: 2 }] }).success).toBe(false)
    expect(settleBatchDto.safeParse({ ...base, titles: [{ orderId: 1, parcel: 1, paidValue: 10, interestValue: 10.005 }] }).success).toBe(false)
    expect(settleBatchDto.safeParse({ ...base, titles: [{ orderId: 1, parcel: 1, paidValue: 10, interestValue: 9.99 }] }).success).toBe(true)
  })
  it('D-G35: desconto de 100 % não existe (máximo 99,99 %) — "desativar a cobrança" é outro ato', () => {
    expect(settleBatchDto.safeParse({ ...base, titles: [{ orderId: 1, parcel: 1, paidValue: 0.01, discountAliquot: 100 }] }).success).toBe(false)
    expect(settleBatchDto.safeParse({ ...base, titles: [{ orderId: 1, parcel: 1, paidValue: 0.01, discountAliquot: 99.99 }] }).success).toBe(true)
  })
  it('Q-A27: compara em CENTAVOS pela regra do DECIMAL — 9,995 e 4,999 + 5 sobre 10 não passam (o banco gravaria 10,00)', () => {
    expect(settleBatchDto.safeParse({ ...base, titles: [{ orderId: 1, parcel: 1, paidValue: 10, interestValue: 9.995 }] }).success).toBe(false)
    expect(settleBatchDto.safeParse({ ...base, titles: [{ orderId: 1, parcel: 1, paidValue: 10, interestValue: 4.999, lateValue: 5 }] }).success).toBe(false)
    expect(settleBatchDto.safeParse({ ...base, titles: [{ orderId: 1, parcel: 1, paidValue: 10, interestValue: 9.994 }] }).success).toBe(true)
  })
})
