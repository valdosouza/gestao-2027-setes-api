/// <reference types="jest" />
// Q-A27 (re-prova adversarial final do cancelamento de nota): dinheiro em 2 casas
// pela regra do DECIMAL do banco (half-up sobre o decimal ESCRITO).
import { toCents, round2 } from '../shared/money'

describe('@shared/money', () => {
  it('9,995 → 10,00 e 1,005 → 1,01 (JS puro daria 9,99 / 1,00; o banco grava 10,00 / 1,01)', () => {
    expect(round2(9.995)).toBe(10)
    expect(round2(1.005)).toBe(1.01)
    expect(toCents(9.995)).toBe(1000)
  })
  it('valores já em 2 casas ficam iguais; 3ª casa abaixo de 5 cai; ruído binário (0,1 + 0,2) some', () => {
    expect(round2(33.33)).toBe(33.33)
    expect(round2(10.004)).toBe(10)
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(toCents('12.345')).toBe(1235)
  })
  it('nulo, indefinido e não numérico valem 0', () => {
    expect(round2(null)).toBe(0)
    expect(round2(undefined)).toBe(0)
    expect(toCents('abc')).toBe(0)
  })
})
