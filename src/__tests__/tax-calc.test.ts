/// <reference types="jest" />
// Motor de CÁLCULO por item (Onda 1 do W2 — prompt_fase_faturamento_financeiro.md).
// Funções puras, sem banco — a prova é bater com os números de tributacao.md
// (P2–P9, T1–T3). Onde a web DIVERGE do legado de propósito (decisões 2/5/7/8
// do prompt de fase), o teste documenta a divergência esperada.
import {
  calcMerchandiseValue, prorateWithResidue,
  icmsIpiIntegratesBase, calcBaseIcms, calcBaseIcmsSt, calcIcms,
  calcFcpProprio, calcFcpSt,
  calcIpi, calcPisCofins, calcIi, calcIssqn,
  calculateItemTaxes,
} from '../shared/tax-rule'

describe('calcMerchandiseValue (T3 raiz)', () => {
  it('unit × qtde − desconto incondicional', () => {
    expect(calcMerchandiseValue(10, 3, 2)).toBe(28)
  })
})

describe('prorateWithResidue (T2 — rateio com resíduo no último)', () => {
  it('fecha o total exato mesmo com dízima', () => {
    // 3 itens de valor igual (100 cada) ratear 10 -> proporção 0.3333 cada,
    // 1º e 2º ficam com 3.33, o 3º fecha com o resíduo (3.34).
    const shares = prorateWithResidue([100, 100, 100], 10)
    expect(shares).toEqual([3.33, 3.33, 3.34])
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 2)
  })

  it('proporcional a valores diferentes', () => {
    const shares = prorateWithResidue([300, 100], 40)
    // proporções: 0.75 / 0.25 -> 30 / (resíduo) 10
    expect(shares).toEqual([30, 10])
  })

  it('total zero devolve tudo zerado', () => {
    expect(prorateWithResidue([100, 200], 0)).toEqual([0, 0])
  })
})

describe('icmsIpiIntegratesBase (P2.4 — exceção art. 155 §2º XI)', () => {
  it('IPI integra a base por padrão', () => {
    expect(icmsIpiIntegratesBase({ destinationIsContributor: false, purpose: '1', ipiValue: 10 })).toBe(true)
  })
  it('IPI fica FORA só com os 3 requisitos juntos', () => {
    expect(icmsIpiIntegratesBase({ destinationIsContributor: true, purpose: '2', ipiValue: 10 })).toBe(false)
    expect(icmsIpiIntegratesBase({ destinationIsContributor: true, purpose: '4', ipiValue: 10 })).toBe(false)
  })
  it('falta qualquer um dos 3 -> integra', () => {
    expect(icmsIpiIntegratesBase({ destinationIsContributor: true, purpose: '1', ipiValue: 10 })).toBe(true)
    expect(icmsIpiIntegratesBase({ destinationIsContributor: true, purpose: '2', ipiValue: 0 })).toBe(true)
    expect(icmsIpiIntegratesBase({ destinationIsContributor: false, purpose: '2', ipiValue: 10 })).toBe(true)
  })
})

describe('calcBaseIcms / calcBaseIcmsSt (P2.4)', () => {
  it('base cheia sem frete/IPI', () => {
    expect(calcBaseIcms({
      merchandiseValue: 1000, ipiValue: 0, includeIpi: true,
      freight: 0, includeFreight: false, baseReductionPct: 0,
    })).toBe(1000)
  })
  it('base reduzida', () => {
    expect(calcBaseIcms({
      merchandiseValue: 1000, ipiValue: 0, includeIpi: true,
      freight: 0, includeFreight: false, baseReductionPct: 10,
    })).toBe(900)
  })
  it('ICMS-ST: (mercadoria+IPI+frete+seguro+outras) × (1-red%) × (1+MVA%)', () => {
    // (1000 + 50 + 20 + 10 + 5) = 1085; sem redução; MVA 40% -> 1085*1.4 = 1519
    expect(calcBaseIcmsSt({
      merchandiseValue: 1000, ipiValue: 50, freight: 20, insurance: 10, other: 5,
      baseReductionPct: 0, mvaPct: 40,
    })).toBe(1519)
  })
})

describe('calcIcms — despacho por CST (P2.5)', () => {
  const baseCtx = {
    aliqReduction: 0, baseReduction: 0, deferredAliqPct: 0,
    destinationIsResale: false, destinationIsContributor: false, purpose: '1',
    stAliq: null as number | null, mvaPct: null as number | null, stBaseReduction: 0,
  }

  it('CST 00 — base cheia, aliq líquida da redução', () => {
    const r = calcIcms({ ...baseCtx, cst: '00', aliq: 18, aliqReduction: 2 }, 1000, 0, 0)
    expect(r).toEqual({ base: 1000, aliq: 16, value: 160 })
  })

  it('CST 10 — ICMS normal; ST só se destinatário Revenda', () => {
    const semRevenda = calcIcms({ ...baseCtx, cst: '10', aliq: 18, stAliq: 25, mvaPct: 40 }, 1000, 0, 0)
    expect(semRevenda.baseSt).toBeUndefined()

    const comRevenda = calcIcms(
      { ...baseCtx, cst: '10', aliq: 18, stAliq: 25, mvaPct: 40, destinationIsResale: true },
      1000, 0, 0,
    )
    expect(comRevenda.value).toBe(180)
    expect(comRevenda.baseSt).toBe(1400) // 1000*1.4
    expect(comRevenda.valueSt).toBe(350) // 1400*0.25
  })

  it('CST 20 — base reduzida', () => {
    const r = calcIcms({ ...baseCtx, cst: '20', aliq: 18, baseReduction: 20 }, 1000, 0, 0)
    expect(r.base).toBe(800)
    expect(r.value).toBe(144)
  })

  it('CST 30 — isento do próprio, calcula ST temporário', () => {
    const r = calcIcms(
      { ...baseCtx, cst: '30', aliq: 18, stAliq: 25, mvaPct: 40 },
      1000, 0, 0,
    )
    expect(r.value).toBe(0)
    expect(r.baseSt).toBe(1400)
    expect(r.valueSt).toBe(350)
  })

  it('CST 40/41/50 — sai sem calcular', () => {
    for (const cst of ['40', '41', '50']) {
      expect(calcIcms({ ...baseCtx, cst, aliq: 18 }, 1000, 0, 0)).toEqual({ base: 0, aliq: 0, value: 0 })
    }
  })

  it('CST 51 — diferimento inclui frete na base (decisão 8: manual segue a regra)', () => {
    const r = calcIcms({ ...baseCtx, cst: '51', aliq: 18, deferredAliqPct: 50 }, 1000, 0, 100)
    expect(r.base).toBe(1100) // única que passa frete
    expect(r.operationValue).toBe(198) // 1100*0.18
    expect(r.deferredValue).toBe(99)   // 198*0.5
    expect(r.value).toBe(99)           // operação - diferido
  })

  it('CST 60 — ST já retido, zera (rastreio é frente própria, fora desta onda)', () => {
    expect(calcIcms({ ...baseCtx, cst: '60', aliq: 18 }, 1000, 0, 0)).toEqual({ base: 0, aliq: 0, value: 0 })
  })

  it('CST 70 — base reduzida + ST só p/ Revenda', () => {
    const r = calcIcms(
      { ...baseCtx, cst: '70', aliq: 18, baseReduction: 10, stAliq: 25, mvaPct: 40, stBaseReduction: 10, destinationIsResale: true },
      1000, 0, 0,
    )
    expect(r.base).toBe(900)
    expect(r.baseSt).toBe(1260) // (1000*0.9)*1.4
  })

  it('CST 90 — base reduzida + alíq reduzida', () => {
    const r = calcIcms({ ...baseCtx, cst: '90', aliq: 18, aliqReduction: 3, baseReduction: 10 }, 1000, 0, 0)
    expect(r.base).toBe(900)
    expect(r.aliq).toBe(15)
    expect(r.value).toBe(135)
  })
})

describe('FCP (P7.3 — decisão 7/Q30: FCP-ST usa a MESMA base do ICMS-ST)', () => {
  it('FCP próprio: base = mercadoria', () => {
    expect(calcFcpProprio('00', 1000, 2)).toEqual({ base: 1000, value: 20 })
  })
  it('FCP próprio não roda fora dos CSTs do P7.3', () => {
    expect(calcFcpProprio('40', 1000, 2)).toBeUndefined()
  })
  it('FCP-ST reusa a base ST recebida (unificada, sem divergência)', () => {
    expect(calcFcpSt('70', 1400, 2)).toEqual({ base: 1400, value: 28 })
  })
  it('sem alíquota ou sem base ST -> undefined', () => {
    expect(calcFcpSt('70', undefined, 2)).toBeUndefined()
    expect(calcFcpSt('70', 1400, null)).toBeUndefined()
  })
})

describe('calcIpi (P4 — decisão 5/Q25: mercadoria + frete + seguro + outras)', () => {
  it('CST 00 calcula com todos os encargos acessórios', () => {
    const r = calcIpi({ cst: '00', aliq: 10 }, 1000, 20, 10, 5)
    expect(r.base).toBe(1035)
    expect(r.value).toBe(103.5)
  })
  it('CSTs fora de 00/49/50/99 não calculam valor', () => {
    expect(calcIpi({ cst: '02', aliq: 10 }, 1000, 20, 10, 5)).toEqual({ base: 0, aliq: 0, value: 0 })
  })
})

describe('calcPisCofins (P5 — decisão 2/Q24: PIS = COFINS, sem a assimetria do legado)', () => {
  it('CST 01 ad valorem', () => {
    const pis = calcPisCofins({ kind: 'P', cst: '01', aliq: 1.65 }, 1000)
    const cofins = calcPisCofins({ kind: 'C', cst: '01', aliq: 7.6 }, 1000)
    expect(pis.value).toBe(16.5)
    expect(cofins.value).toBe(76)
  })
  it('CST 03 por quantidade', () => {
    const r = calcPisCofins({ kind: 'P', cst: '03', aliq: 0, quantity: 10, unitAliqValue: 0.5 }, 1000)
    expect(r.value).toBe(5)
  })
  it('CST 99 com base > 0 -> ad valorem (PIS calcula igual ao COFINS — bug do legado NÃO reproduzido)', () => {
    const pis = calcPisCofins({ kind: 'P', cst: '99', aliq: 1.65 }, 1000)
    const cofins = calcPisCofins({ kind: 'C', cst: '99', aliq: 1.65 }, 1000)
    expect(pis.value).toBe(cofins.value)
    expect(pis.value).toBe(16.5)
  })
  it('CST 99 com base zero -> por quantidade', () => {
    const r = calcPisCofins({ kind: 'P', cst: '99', aliq: 0, quantity: 4, unitAliqValue: 1.2 }, 0)
    expect(r.value).toBe(4.8)
  })
})

describe('calcIi (P9 + decisão 11/Q32 — peça completa)', () => {
  it('calcula os cinco componentes sobre a mesma base', () => {
    const r = calcIi({ iiAliq: 10, irpjAliq: 1, csllAliq: 1, afrmmAliq: 25, siscomexAliq: 0.5 }, 1000)
    expect(r).toEqual({
      base: 1000, iiValue: 100, irpjValue: 10, csllValue: 10, afrmmValue: 250, siscomexValue: 5,
    })
  })
})

describe('calcIssqn (P6.1 — alíquota da CIDADE, nunca da regra)', () => {
  it('calcula sobre a mercadoria líquida', () => {
    const r = calcIssqn({ cityAliqPct: 5, deductionValue: 0, withheld: false }, 1000)
    expect(r).toEqual({ base: 1000, aliq: 5, value: 50, withheldValue: 0 })
  })
  it('retido -> withheldValue = valor inteiro', () => {
    const r = calcIssqn({ cityAliqPct: 5, deductionValue: 0, withheld: true }, 1000)
    expect(r.withheldValue).toBe(50)
  })
})

describe('calculateItemTaxes — orquestrador (T1, presença = incidência)', () => {
  it('peça ausente nunca é calculada', () => {
    const r = calculateItemTaxes({ merchandiseValue: 1000, freight: 0, insurance: 0, other: 0, kind: 'M' })
    expect(r).toEqual({})
  })

  it('IPI entra na base do ICMS quando a exceção do art.155 não vale (ordem T1)', () => {
    const r = calculateItemTaxes({
      merchandiseValue: 1000, freight: 0, insurance: 0, other: 0, kind: 'M',
      ipi: { cst: '00', aliq: 10 },
      icms: {
        cst: '00', aliq: 18, aliqReduction: 0, baseReduction: 0, deferredAliqPct: 0,
        destinationIsResale: false, destinationIsContributor: false, purpose: '1',
        stAliq: null, mvaPct: null, stBaseReduction: 0,
      },
    })
    expect(r.ipi!.value).toBe(100) // 1000*0.1
    expect(r.icms!.base).toBe(1100) // 1000 + 100 (IPI integra por padrão)
  })

  it('item de serviço (kind S) calcula ISSQN e ignora ICMS/IPI/II ausentes', () => {
    const r = calculateItemTaxes({
      merchandiseValue: 500, freight: 0, insurance: 0, other: 0, kind: 'S',
      issqn: { cityAliqPct: 3, deductionValue: 0, withheld: false },
    })
    expect(r.issqn!.value).toBe(15)
    expect(r.icms).toBeUndefined()
    expect(r.ipi).toBeUndefined()
  })

  it('FCP próprio e FCP-ST calculados a partir do resultado do ICMS', () => {
    const r = calculateItemTaxes({
      merchandiseValue: 1000, freight: 0, insurance: 0, other: 0, kind: 'M',
      icms: {
        cst: '70', aliq: 18, aliqReduction: 0, baseReduction: 0, deferredAliqPct: 0,
        destinationIsResale: true, destinationIsContributor: false, purpose: '1',
        stAliq: 25, mvaPct: 40, stBaseReduction: 0,
      },
      fcp: { aliqFcp: 2, aliqFcpSt: 2 },
    })
    expect(r.fcp!.base).toBe(1000)
    expect(r.fcpSt!.base).toBe(r.icms!.baseSt)
  })
})
