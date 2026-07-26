import {
  liquidValue, openBalance, addDays, partnerShare,
} from '../modules/settlements/settlements.calc'

/**
 * Aritmética pura da apuração da baixa (Fase 6.1 — P5: valores
 * informados; aqui só a conta do líquido e do saldo derivado).
 */

describe('liquidValue', () => {
  it('sem acréscimos nem desconto = tag', () => {
    expect(liquidValue(100, 0, 0, 0)).toBe(100)
  })

  it('juros e multa somam', () => {
    expect(liquidValue(100, 2.5, 1.5, 0)).toBe(104)
  })

  it('desconto percentual sobre o tag', () => {
    expect(liquidValue(200, 0, 0, 10)).toBe(180)
  })

  it('combinado com arredondamento de 2 casas', () => {
    // 100 + 1.11 + 2.22 − 3.33% de 100 (=3.33) = 100
    expect(liquidValue(100, 1.11, 2.22, 3.33)).toBe(100)
  })
})

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

describe('openBalance', () => {
  it('parcial deixa saldo', () => {
    expect(openBalance(170, 100)).toBe(70)
  })

  it('quitado zera', () => {
    expect(openBalance(170, 170)).toBe(0)
  })

  it('pago a maior não fica negativo', () => {
    expect(openBalance(170, 200)).toBe(0)
  })
})
