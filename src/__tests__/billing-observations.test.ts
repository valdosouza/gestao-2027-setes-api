/// <reference types="jest" />
// Motor de observações fiscais (T6/P11 — rodada Observações 2026-08-22).
// Funções puras, prova = bater com Pc_Obs_NotaFiscal/Pc_Obs_CSTxx/CSOSNxxx
// (tributacao.pas:4185-5432). 3 bugs comprovados do legado CORRIGIDOS por
// decisão do Valdo (CST80 fora do domínio, CSOSN400 bind, CSOSN201
// placeholder) — os testes provam o comportamento CORRIGIDO, não o bug.
import {
  buildRegimeObservations, buildIssqnObservation, buildApproxTaxObservation,
  calcApproxTaxAliq, ObsRegimeItem,
} from '../modules/billing/billing.observations'

const item = (over: Partial<ObsRegimeItem> = {}): ObsRegimeItem => ({
  cst: '00', observationNote: null, ...over,
})

describe('buildRegimeObservations — grupos sem placeholder (distinct)', () => {
  it('CST 00: 1 item com observação -> devolve o texto puro', () => {
    const texts = buildRegimeObservations(
      [item({ cst: '00', observationNote: 'Texto legal CST00' })], 0)
    expect(texts).toEqual(['Texto legal CST00'])
  })

  it('item sem observação vinculada não gera texto', () => {
    const texts = buildRegimeObservations([item({ cst: '00', observationNote: null })], 0)
    expect(texts).toEqual([])
  })

  it('grupo fora da tabela (ex.: CST 80, fora do domínio) não gera texto', () => {
    const texts = buildRegimeObservations(
      [item({ cst: '80', observationNote: 'Nunca deveria aparecer' })], 0)
    expect(texts).toEqual([])
  })

  it('paridade: só a 1ª observação distinta por grupo (decisão do Valdo)', () => {
    const texts = buildRegimeObservations([
      item({ cst: '00', observationNote: 'Primeira' }),
      item({ cst: '00', observationNote: 'Segunda — nunca aparece' }),
    ], 0)
    expect(texts).toEqual(['Primeira'])
  })

  it('grupos diferentes geram textos independentes', () => {
    const texts = buildRegimeObservations([
      item({ cst: '00', observationNote: 'CST00' }),
      item({ cst: '90', observationNote: 'CST90' }),
    ], 0)
    expect(texts.sort()).toEqual(['CST00', 'CST90'])
  })
})

describe('buildRegimeObservations — CST 10/30 (agregação de ST)', () => {
  it('soma base/valor ST de TODOS os itens do grupo', () => {
    const texts = buildRegimeObservations([
      item({ cst: '10', observationNote: 'Base R$ 1&v Valor R$ 2&v', baseSt: 100, valueSt: 25 }),
      item({ cst: '10', observationNote: 'Base R$ 1&v Valor R$ 2&v', baseSt: 200, valueSt: 50 }),
    ], 0)
    expect(texts).toEqual(['Base R$ 300,00 Valor R$ 75,00'])
  })

  it('só soma itens que compartilham o MESMO texto (paridade GROUP BY OBS_DETALHES)', () => {
    const texts = buildRegimeObservations([
      item({ cst: '30', observationNote: 'Texto A: 1&v/2&v', baseSt: 100, valueSt: 10 }),
      item({ cst: '30', observationNote: 'Texto B: 1&v/2&v', baseSt: 999, valueSt: 999 }),
    ], 0)
    // "Texto A" é o 1º encontrado -> só o item com Texto A entra na soma
    expect(texts).toEqual(['Texto A: 100,00/10,00'])
  })
})

describe('buildRegimeObservations — CST 20 (placeholder RAW, não somado)', () => {
  it('usa o valor bruto do PRIMEIRO item do grupo (sem SUM)', () => {
    const texts = buildRegimeObservations([
      item({ cst: '20', observationNote: 'Redução: 1&v%', baseReduction: 15 }),
      item({ cst: '20', observationNote: 'Redução: 1&v%', baseReduction: 999 }),
    ], 0)
    expect(texts).toEqual(['Redução: 15,00%'])
  })
})

describe('buildRegimeObservations — CSOSN 101 (crédito, config não somada)', () => {
  it('1&v soma o valor do crédito; 2&v usa a config (não vem do item)', () => {
    const texts = buildRegimeObservations([
      item({ cst: '101', observationNote: 'Cred R$ 1&v Aliq 2&v%', creditValue: 15 }),
      item({ cst: '101', observationNote: 'Cred R$ 1&v Aliq 2&v%', creditValue: 30 }),
    ], 1.5)
    expect(texts).toEqual(['Cred R$ 45,00 Aliq 1,50%'])
  })
})

describe('buildRegimeObservations — CSOSN 201 (CORRIGIDO — bug do legado)', () => {
  it('usa os 4 placeholders: base ST, valor ST, alíquota crédito, valor crédito', () => {
    const texts = buildRegimeObservations([
      item({
        cst: '201', observationNote: 'BaseST 1&v ValorST 2&v Aliq 3&v% Cred 4&v',
        baseSt: 500, valueSt: 125, creditValue: 15,
      }),
    ], 1.5)
    expect(texts).toEqual(['BaseST 500,00 ValorST 125,00 Aliq 1,50% Cred 15,00'])
  })
})

describe('buildRegimeObservations — CSOSN 400 (CORRIGIDO — bug de bind do legado)', () => {
  it('dispara normalmente (o legado nunca disparava por falta de bind)', () => {
    const texts = buildRegimeObservations(
      [item({ cst: '400', observationNote: 'Texto CSOSN400' })], 0)
    expect(texts).toEqual(['Texto CSOSN400'])
  })
})

describe('buildIssqnObservation — Pc_Obs_ISSQN', () => {
  it('sem retenção -> null', () => {
    expect(buildIssqnObservation(0)).toBeNull()
  })
  it('com retenção -> texto fixo com o valor', () => {
    expect(buildIssqnObservation(123.456)).toBe(
      'Valor do ISSQN retido/Substituto Tributário: R$ 123,46')
  })
})

describe('calcApproxTaxAliq — ITF_IMP_APROX', () => {
  it('origem nacional usa aliqNac', () => {
    expect(calcApproxTaxAliq(false, { aliqNac: 5, aliqImp: 10, aliqEst: 2, aliqMun: 1 })).toBe(8)
  })
  it('origem importada usa aliqImp', () => {
    expect(calcApproxTaxAliq(true, { aliqNac: 5, aliqImp: 10, aliqEst: 2, aliqMun: 1 })).toBe(13)
  })
  it('sem taxa cadastrada -> 0', () => {
    expect(calcApproxTaxAliq(false, null)).toBe(0)
  })
})

describe('buildApproxTaxObservation — Fc_Obs_ImpostoAproximado', () => {
  it('sem base -> null', () => {
    expect(buildApproxTaxObservation([])).toBeNull()
  })

  it('monta os 3 blocos concatenados quando as 3 esferas > 0', () => {
    // 1000 * 5% = 50 (nac) / 1000 * 2% = 20 (est) / 1000 * 1% = 10 (mun)
    const text = buildApproxTaxObservation([
      { merchandiseValue: 1000, aliqNac: 5, aliqEst: 2, aliqMun: 1 },
    ])
    expect(text).toBe(
      'Valor aprox Imp. Nacional R$ 50,00 (5,00)%' +
      '| Imp. Estadual R$ 20,00 (2,00)%' +
      '| Imp. Municipal R$ 10,00 (1,00)%')
  })

  it('esfera com valor 0 não gera bloco (achado literal: sem separador se faltar o 1º)', () => {
    const text = buildApproxTaxObservation([
      { merchandiseValue: 1000, aliqNac: 0, aliqEst: 2, aliqMun: 0 },
    ])
    expect(text).toBe('| Imp. Estadual R$ 20,00 (2,00)%')
  })

  it('média ponderada por valor entre itens diferentes', () => {
    const text = buildApproxTaxObservation([
      { merchandiseValue: 1000, aliqNac: 10, aliqEst: 0, aliqMun: 0 },
      { merchandiseValue: 1000, aliqNac: 0, aliqEst: 0, aliqMun: 0 },
    ])
    // vNac = 1000*10% = 100; total base = 2000; pct = 100/2000*100 = 5%
    expect(text).toBe('Valor aprox Imp. Nacional R$ 100,00 (5,00)%')
  })
})
