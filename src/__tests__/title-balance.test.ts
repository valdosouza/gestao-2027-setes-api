/// <reference types="jest" />
// Q-G21 — saldo em aberto como peça ÚNICA: uma fórmula para lista, cheque e teto.
import { OPEN_BALANCE_SQL, PRINCIPAL_PAID_SQL, settlementCeiling } from '../shared/financial-settlement/title-balance'

describe('title-balance', () => {
  it('fragmento SQL: principal coberto subtrai juros/multa e SOMA o desconto (tag × aliq/100), só baixas vivas', () => {
    const sql = PRINCIPAL_PAID_SQL('setes_setes', 't')
    expect(sql).toMatch(/p\.paid_value - COALESCE\(p\.interest_value, 0\) - COALESCE\(p\.late_value, 0\)[\s\S]*\+ t\.tag_value \* COALESCE\(p\.discount_aliquot, 0\) \/ 100/)
    expect(sql).toMatch(/p\.status = 'N' AND p\.deleted = 'N'/)
    expect(OPEN_BALANCE_SQL('setes_setes')).toMatch(/^GREATEST\(ROUND\(f\.tag_value - /)
  })
  it('teto = saldo − desconto desta baixa + juros/multa informados; nunca negativo', () => {
    expect(settlementCeiling(100, 0, { discountAliquot: 10 })).toEqual({ openBalance: 100, ceiling: 90 })
    expect(settlementCeiling(100, 60, { interestValue: 5, lateValue: 2 })).toEqual({ openBalance: 40, ceiling: 47 })
    expect(settlementCeiling(100, 100, {})).toEqual({ openBalance: 0, ceiling: 0 })
    expect(settlementCeiling(100, 120, {}).openBalance).toBe(0)
  })
})
