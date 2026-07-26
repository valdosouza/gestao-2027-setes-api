import {
  prorataValue, parcelQuotas, fifthBusinessDaySuggestion,
  firstDayOfMonth, lastDayOfMonth,
} from '../modules/service-orders/service-orders.calc'

/**
 * Funções puras do ciclo mensal (Fase 3 do 05-ORDEM-SERVICO):
 * pró-rata 30 dias corridos (D2/D3), quotas de parcela com resíduo na
 * última e a SUGESTÃO do 5º dia útil (DP1 — o usuário decide na tela).
 */

describe('prorataValue (pró-rata 30 dias corridos)', () => {
  it('mês inteiro devolve o valor cheio', () => {
    expect(prorataValue(300, '2026-01-15', null, 2026, 7)).toBe(300)
  })

  it('cliente novo no dia 16 (jul: 16..31 = 16 dias)', () => {
    expect(prorataValue(300, '2026-07-16', null, 2026, 7)).toBe(160)
  })

  it('cancelado no dia 10 (1..10 = 10 dias) — faturamento parcial D3', () => {
    expect(prorataValue(300, '2026-01-01', '2026-07-10', 2026, 7)).toBe(100)
  })

  it('início E fim dentro do mês', () => {
    // 10..19 = 10 dias
    expect(prorataValue(300, '2026-07-10', '2026-07-19', 2026, 7)).toBe(100)
  })

  it('contrato fora da competência devolve 0', () => {
    expect(prorataValue(300, '2026-08-01', null, 2026, 7)).toBe(0)
    expect(prorataValue(300, '2026-01-01', '2026-06-30', 2026, 7)).toBe(0)
  })

  it('31 dias ativos limita em 30/30 (valor cheio, não mais)', () => {
    expect(prorataValue(300, '2026-07-01', '2026-07-31', 2026, 7)).toBe(300)
  })
})

describe('parcelQuotas (resíduo de centavos na última)', () => {
  it('divisão exata', () => {
    expect(parcelQuotas(300, 3)).toEqual([100, 100, 100])
  })

  it('resíduo vai para a última parcela', () => {
    expect(parcelQuotas(100, 3)).toEqual([33.33, 33.33, 33.34])
  })

  it('parcela única', () => {
    expect(parcelQuotas(350.5, 1)).toEqual([350.5])
  })
})

describe('fifthBusinessDaySuggestion (default da tela — DP1)', () => {
  it('competência jul/2026 → 5º útil de agosto = 07/08 (sáb 01, dom 02)', () => {
    expect(fifthBusinessDaySuggestion(2026, 7)).toBe('2026-08-07')
  })

  it('vira o ano: competência dez/2026 → janeiro/2027', () => {
    // jan/2027: sex 01, sáb 02, dom 03 → úteis 01,04,05,06,07 → 5º = 07/01
    expect(fifthBusinessDaySuggestion(2026, 12)).toBe('2027-01-07')
  })
})

describe('limites do mês', () => {
  it('fevereiro bissexto', () => {
    expect(firstDayOfMonth(2028, 2)).toBe('2028-02-01')
    expect(lastDayOfMonth(2028, 2)).toBe('2028-02-29')
  })
})
