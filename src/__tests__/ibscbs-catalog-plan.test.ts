/// <reference types="jest" />
// IB-1 da fase IBS/CBS — o ATO da carga tem PLANO (gate socrático): o ensaio mostra o hash do
// que será gravado e o --vai só grava esse plano. Re-score: a guarda só tinha prova à mão.
import { assertActDate, catalogPlan, assertPlanArgs, assertPlanMatches, PlanInput } from '@shared/ibscbs-catalog'

const base = (): PlanInput => ({
  date: '2026-10-10', itFile: 'a'.repeat(64), itVersion: 'IT 2025.002 v1.70',
  it: {
    csts: [{ id: '000', description: 'Tributação integral', requiresGroup: true }],
    classifications: [{ code: '000001', cst: '000', name: 'n', description: 'd', validFrom: '2026-01-01', validUntil: null,
      requiresRegularTaxation: false, updatedAt: '2026-01-01', models: ['SE'] }],
  },
  indopFile: 'b'.repeat(64), indopVersion: 'Anexo VII v1.03.00',
  indop: [{ code: '100301', description: 'Demais serviços — Execução — Domicílio do adquirente', models: ['SE'] }],
  unconfirmed: [],
  calculator: new Map([['2026-10-10', ['000001']], ['2026-01-01', ['000001']]]),
  nbs: [{ code: '115021000', description: 'Desenvolvimento' }, { code: '115022000', description: 'Personalizado' }],
})

describe('catalogPlan — hash do que a carga vai gravar', () => {
  it('determinístico: a ordem das datas e das NBS não muda o plano', () => {
    const a = base()
    const b = base()
    b.calculator = new Map([['2026-01-01', ['000001']], ['2026-10-10', ['000001']]])
    b.nbs = [...b.nbs].reverse()
    expect(catalogPlan(a)).toBe(catalogPlan(b))
    expect(catalogPlan(a)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('sensível ao que será gravado: fonte, leitura, conferência, não confirmados, NBS e data', () => {
    const p0 = catalogPlan(base())
    const variants: Array<(p: PlanInput) => void> = [
      p => { p.itFile = 'c'.repeat(64) },
      p => { p.indop[0].description = 'outra leitura do parse' },
      p => { p.calculator = new Map([['2026-10-10', ['000001', '000006']]]) },
      p => { p.unconfirmed = [{ code: '000001', validFrom: '2026-01-01', conferredAt: '2026-10-10' }] },
      p => { p.nbs[0].description = 'descrição nova' },
      p => { p.date = '2026-10-11' },
    ]
    for (const change of variants) {
      const p = base()
      change(p)
      expect(catalogPlan(p)).not.toBe(p0)
    }
  })
})

describe('assertPlanArgs / assertPlanMatches — o ato só grava o plano do ensaio', () => {
  it('--vai sem --plano e --plano sem --vai são recusados antes de qualquer leitura', () => {
    expect(() => assertPlanArgs(true, undefined)).toThrow(/--vai exige --plano/)
    expect(() => assertPlanArgs(false, 'abc')).toThrow(/--plano só vale junto com --vai/)
    expect(() => assertPlanArgs(false, undefined)).not.toThrow()
    expect(() => assertPlanArgs(true, 'abc')).not.toThrow()
  })

  it('plano divergente = nada gravado, com a data na mensagem (virada da meia-noite também muda o plano)', () => {
    expect(() => assertPlanMatches(true, '0000000000000000', '1192023064a0a70b', '2026-10-11'))
      .toThrow(/lido agora 1192023064a0a70b para a data 2026-10-11 ≠ --plano 0000000000000000/)
    expect(() => assertPlanMatches(true, '1192023064a0a70b', '1192023064a0a70b', '2026-10-10')).not.toThrow()
    expect(() => assertPlanMatches(false, undefined, '1192023064a0a70b', '2026-10-10')).not.toThrow()
  })
})

// D-IB48 (Rodada 7) — o ato só grava com a data de hoje; o ensaio aceita qualquer data
describe('assertActDate (D-IB48)', () => {
  it('ato com data diferente de hoje é recusado; com a de hoje, passa; ensaio passa sempre', () => {
    expect(() => assertActDate(true, '2026-10-10', '2026-10-11')).toThrow(/D-IB48/)
    expect(() => assertActDate(true, '2026-10-11', '2026-10-11')).not.toThrow()
    expect(() => assertActDate(false, '2026-10-01', '2026-10-11')).not.toThrow()
  })
})

