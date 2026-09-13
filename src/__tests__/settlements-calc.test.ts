import { addDays, partnerShare } from '../modules/settlements/settlements.calc'

/**
 * Aritmética pura da apuração da baixa (Fase 6.1 — P5: valores
 * informados; aqui só a conta do líquido e do saldo derivado).
 */

describe('addDays (DP12 — vencimento PA = baixa + 12 dias)', () => {
  it('soma simples', () => {
    expect(addDays('2026-08-07', 12)).toBe('2026-08-19')
  })

  it('vira o mês', () => {
    expect(addDays('2026-07-25', 12)).toBe('2026-08-06')
  })

  it('vira o ano', () => {
    expect(addDays('2026-12-25', 12)).toBe('2027-01-06')
  })
})

describe('partnerShare (4.3 — % sobre o pago)', () => {
  it('percentual direto', () => {
    expect(partnerShare(70, 30)).toBe(21)
  })

  it('arredonda 2 casas', () => {
    expect(partnerShare(100, 33.33)).toBe(33.33)
    expect(partnerShare(0.10, 33.33)).toBe(0.03)
  })
})

