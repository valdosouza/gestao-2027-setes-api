/// <reference types="jest" />
// Q-G21 — saldo em aberto como peça ÚNICA: uma fórmula para lista, cheque e teto.
import { OPEN_BALANCE_SQL, PRINCIPAL_PAID_SQL, settlementCeiling } from '../shared/financial-settlement/title-balance'

describe('title-balance', () => {
  it('fragmento SQL: principal coberto subtrai juros/multa e SOMA o desconto GRAVADO (discount_value — D-G28), só baixas vivas', () => {
    const sql = PRINCIPAL_PAID_SQL('setes_setes', 't')
    expect(sql).toMatch(/p\.paid_value - COALESCE\(p\.interest_value, 0\) - COALESCE\(p\.late_value, 0\)[\s\S]*\+ COALESCE\(p\.discount_value, 0\)/)
    expect(sql).not.toMatch(/tag_value \*/)
    expect(sql).toMatch(/p\.parcel = t\.parcel/)
    expect(sql).toMatch(/p\.status = 'N' AND p\.deleted = 'N'/)
    expect(OPEN_BALANCE_SQL('setes_setes')).toMatch(/^GREATEST\(ROUND\(f\.tag_value - /)
  })
  it('teto = saldo − desconto desta baixa + juros/multa informados; nunca negativo', () => {
    expect(settlementCeiling(100, 0, { discountAliquot: 10 })).toMatchObject({ openBalance: 100, discount: 10, ceiling: 90 })
    expect(settlementCeiling(100, 60, { interestValue: 5, lateValue: 2 })).toMatchObject({ openBalance: 40, discount: 0, ceiling: 47 })
    expect(settlementCeiling(100, 100, {})).toMatchObject({ openBalance: 0, discount: 0, ceiling: 0 })
    expect(settlementCeiling(100, 120, {}).openBalance).toBe(0)
  })
  it('D-G28 (BX-10): o desconto incide sobre o SALDO em aberto — 2ª parcial de 40 a 10 % concede 4, não 10', () => {
    expect(settlementCeiling(100, 60, { discountAliquot: 10 })).toMatchObject({ openBalance: 40, discount: 4, ceiling: 36 })
    expect(settlementCeiling(100, 100, { discountAliquot: 10 })).toMatchObject({ openBalance: 0, discount: 0, ceiling: 0 })
  })
})
