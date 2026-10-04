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

describe('D-BA37 — a fórmula do saldo existe UMA vez (parecer do guardião)', () => {
  const { PRINCIPAL_PAID_JOIN_SQL, PRINCIPAL_PAID_OF, OPEN_BALANCE_OF } = require('../shared/financial-settlement/title-balance')
  const PRINCIPAL = /p\.paid_value - COALESCE\(p\.interest_value, 0\) - COALESCE\(p\.late_value, 0\)\s+\+ COALESCE\(p\.discount_value, 0\)/
  const LIVE = /p\.status = 'N' AND p\.deleted = 'N'/

  it('correlacionada e de lista usam a MESMA expressão do principal e o MESMO predicado de baixa viva', () => {
    for (const sql of [PRINCIPAL_PAID_SQL('setes_setes'), PRINCIPAL_PAID_JOIN_SQL('setes_setes')]) {
      expect(sql).toMatch(PRINCIPAL)
      expect(sql).toMatch(LIVE)
    }
  })

  it('GROUP BY e ON da derived table usam as MESMAS quatro colunas da chave do título (sem fan-out)', () => {
    const sql: string = PRINCIPAL_PAID_JOIN_SQL('setes_setes', 'f', 'pp')
    expect(sql).toMatch(/GROUP BY p\.tb_institution_id, p\.tb_order_id, p\.terminal, p\.parcel\) pp/)
    for (const col of ['tb_institution_id', 'tb_order_id', 'terminal', 'parcel']) {
      expect(sql).toMatch(new RegExp(`pp\\.${col} = f\\.${col}`))
    }
    expect((sql.match(/\?/g) ?? []).length).toBe(1)   // um `?` = institution
  })

  it('o saldo sobre o alias é a MESMA conta do correlacionado (balanceOver)', () => {
    expect(OPEN_BALANCE_OF('f', 'pp')).toBe(`GREATEST(ROUND(f.tag_value - ${PRINCIPAL_PAID_OF('pp')}, 2), 0)`)
    expect(OPEN_BALANCE_SQL('setes_setes')).toMatch(/^GREATEST\(ROUND\(f\.tag_value - \s*\(SELECT COALESCE\(SUM\(/)
    expect(OPEN_BALANCE_OF()).not.toMatch(/setes_|\?/)   // cabe em lista branca const (regra da Onda 2)
  })
})
