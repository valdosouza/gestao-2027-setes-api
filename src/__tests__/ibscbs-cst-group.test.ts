/// <reference types="jest" />
// Fase IBS/CBS, D-IB113 (Valdo 2026-11-01 — prompt_fase_ibs_cbs.md §13.8, fim): classificação de CST que NÃO leva o grupo IBS/CBS
// (ind_gIBSCBS = 0 na aba CST do IT 2025.002 — no leiaute da NT 009 o fisco PROÍBE `cIndOp` e `gIBSCBS` com ele: E0859/E0961) é
// RECUSADA no ERP ("ainda não suportado na NFS-e") pelo MESMO veredito da peça @shared/ibscbs-classification. A nfse-api nunca
// consulta o indicador: grupo declarado ⇒ `cIndOp` + `gIBSCBS`, por construção. Indicador DESCONHECIDO (NULL — CST gravado antes
// do script 73) = recusado (falha fechada) até a carga.
import { CatalogSourceError, ItCatalog, pairKey, parseItCatalog, reconcileWithCalculator } from '@shared/ibscbs-catalog'
import {
  ClassificationAt, IBSCBS_OMISSIONS, Queryable, assertServiceClassification, classificationAcceptance, groupRefusalText,
  listClassificationsLookup, verdictOf,
} from '@shared/ibscbs-classification'
import { HttpError } from '@shared/errors/http-error'

const TODAY = '2026-11-01'

describe('D-IB113 — leitura do ind_gIBSCBS na aba CST do IT (o que valida é o que grava)', () => {
  const classSheet = {
    name: 'cClass 2026-09-01',
    rows: [
      ['CST-IBS/CBS', 'Descrição CST-IBS/CBS', 'cClassTrib', 'Nome cClassTrib', 'Descrição cClassTrib', 'ind_gTribRegular',
        'dIniVig', 'dFimVig', 'DataAtualização', 'indNFe', 'indNFCe', 'indNFSe'],
      ['000', 'x', '000001', 'n', 'd', 0, '2026-01-01', null, '2026-01-01', 1, 1, 1],
      ['410', 'x', '410014', 'n', 'd', 0, '2026-01-01', null, '2026-01-01', 1, 1, 1],
    ],
  }
  const cstSheet = (rows: unknown[][]) => ({
    name: 'CST 2026-09-01',
    rows: [['CST-IBS/CBS', 'Descrição CST-IBS/CBS', 'ind_gIBSCBS', 'ind_gIBSCBSMono'], ...rows,
      // a legenda oficial (CST vazio) fica de fora
      [null, 'Legenda:'], [null, '0 = Não é permitido'], [null, '1 = Exige']],
  })

  it('1 = o CST leva o grupo; 0 = não leva — número ou texto, com espaço', () => {
    const it = parseItCatalog([classSheet, cstSheet([['000', 'Tributação integral', 1, 0], ['410', 'Imunidade', ' 0 ', 0]])] as any)
    expect(it.csts).toEqual([
      { id: '000', description: 'Tributação integral', requiresGroup: true },
      { id: '410', description: 'Imunidade', requiresGroup: false },
    ])
  })

  it.each([['vazio', null], ['2', 2], ['S', 'S'], ['1.0', '1.0'], ['sim', 'sim']])('ind_gIBSCBS %s → fonte RECUSADA (nunca vira 0)', (_n, v) => {
    expect(() => parseItCatalog([classSheet, cstSheet([['000', 'Tributação integral', 1], ['410', 'Imunidade', v]])] as any))
      .toThrow(CatalogSourceError)
    try { parseItCatalog([classSheet, cstSheet([['000', 'Tributação integral', 1], ['410', 'Imunidade', v]])] as any) } catch (e) {
      expect((e as CatalogSourceError).problems).toEqual([expect.stringMatching(/CST linha 3 \(410\): ind_gIBSCBS ".*" não é 0\/1/)])
    }
  })
})

describe('D-IB113 — conferência IT × Calculadora do grupo (exigeGrupoIbsCbs — D-IB28 (a))', () => {
  const D = '2026-11-01'
  const cat = (group410: boolean): ItCatalog => ({
    csts: [{ id: '000', description: 't', requiresGroup: true }, { id: '410', description: 'i', requiresGroup: group410 }],
    classifications: [
      { code: '000001', cst: '000', name: 'n', description: 'd', validFrom: '2026-01-01', validUntil: null,
        requiresRegularTaxation: false, updatedAt: '2026-01-01', models: ['SE'] },
      { code: '410014', cst: '410', name: 'n', description: 'd', validFrom: '2026-01-01', validUntil: null,
        requiresRegularTaxation: false, updatedAt: '2026-01-01', models: ['SE'] },
    ],
  })
  const entries = new Map([[D, [{ code: '000001', nfse: true }, { code: '410014', nfse: true }]]])
  const codes = new Map([[D, ['000001', '410014']]])
  const run = (group410: boolean, calc: Record<string, boolean>) => reconcileWithCalculator(cat(group410), codes, D, {
    entries,
    pairs: new Map(Object.entries(calc).map(([code, g]) => [pairKey(D, code), { valid: true, requiresRegular: false, requiresGroup: g }])),
  })

  it('IT e Calculadora concordam (000 leva, 410 não leva) → nada bloqueado (a recusa do 410 é da peça, não da conferência)', () => {
    expect(run(false, { '000001': true, '410014': false }).blocked).toEqual([])
  })

  it('divergência nos dois sentidos → a linha perde a aplicabilidade na NFS-e, com o motivo', () => {
    expect(run(false, { '000001': false, '410014': true }).blocked.map(b => [b.code, b.model, b.reason])).toEqual([
      ['000001', 'SE', 'grupo IBS/CBS diverge (IT: CST 000 exige × Calculadora não leva)'],
      ['410014', 'SE', 'grupo IBS/CBS diverge (IT: CST 410 não leva × Calculadora exige)'],
    ])
  })
})

const line = (over: Partial<ClassificationAt> = {}): ClassificationAt => ({
  code: '000001', cst: '000', name: 'n', validFrom: '2026-01-01', validUntil: null,
  requiresRegularTaxation: false, applicable: true, superseded: false, cstRequiresGroup: true, ...over,
})

describe('D-IB113 — o VEREDITO (um só, com motivo — D-IB47)', () => {
  it('CST que leva o grupo = aceito; não leva ou desconhecido = cst-without-group', () => {
    expect(verdictOf(line())).toMatchObject({ accepted: true, reason: null })
    expect(verdictOf(line({ cstRequiresGroup: false }))).toMatchObject({ accepted: false, reason: 'cst-without-group' })
    expect(verdictOf(line({ cstRequiresGroup: null }))).toMatchObject({ accepted: false, reason: 'cst-without-group' })
  })

  it('o motivo novo vem por ÚLTIMO: todo veredito anterior fica idêntico', () => {
    expect(verdictOf(null).reason).toBe('no-line')
    expect(verdictOf(line({ applicable: false, cstRequiresGroup: false })).reason).toBe('not-applicable')
    expect(verdictOf(line({ requiresRegularTaxation: true, cstRequiresGroup: false })).reason).toBe('requires-regular')
  })

  it('a frase do motivo — a MESMA no cadastro e no faturamento; o desconhecido diz o que fazer', () => {
    expect(groupRefusalText('410014', { cst: '410', cstRequiresGroup: false }))
      .toBe('cClassTrib 410014 (CST 410) não leva o grupo IBS/CBS na NFS-e — ainda não suportado')
    expect(groupRefusalText('410014', { cst: '410', cstRequiresGroup: null }))
      .toMatch(/indicador do grupo IBS\/CBS do CST 410 ainda não foi carregado no catálogo — recusado até a próxima carga/)
  })

  it('a omissão nova entra na lista FECHADA publicada (D-IB91 — o app tem o espelho)', () => {
    expect(IBSCBS_OMISSIONS).toContain('cst-without-group')
  })
})

/** Catálogo central simulado: 000001 (CST 000 leva o grupo), 410014 (CST 410 não leva), 811001 (CST 811 desconhecido). */
function fakeCatalog(): Queryable {
  const rows = [
    { code: '000001', cst: '000', requiresGroup: 'S' },
    { code: '410014', cst: '410', requiresGroup: 'N' },
    { code: '811001', cst: '811', requiresGroup: null },
  ].map(r => ({ ...r, name: `nome ${r.code}`, validFrom: '2026-01-01', validUntil: null, requiresRegular: 'N', absentSince: null, applicable: 1 }))
  return {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('tb_tax_ibscbs_classification_validity v')) {
        if (!sql.includes('JOIN setes_central.tb_tax_ibscbs t ON t.id = c.tb_tax_ibscbs_id')) throw new Error('sem o indicador do CST')
        if (sql.includes('LIMIT 400')) return [rows]
        return [rows.filter(r => r.code === params[1])]
      }
      if (sql.includes('tb_ibscbs_place_indicator p')) return [[{ code: params[1], description: 'x', applicable: 1 }]]
      if (sql.includes('tb_nbs')) return [[{ 1: 1 }]]
      throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`)
    },
  }
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try { await p } catch (e) { return e as HttpError }
  throw new Error('esperava 422')
}

describe('D-IB113 — cadastro do serviço: salvar, lista de apoio e selo pelo MESMO veredito', () => {
  const pair = (classificationCode: string) => ({ ibscbs: { classificationCode, placeIndicatorCode: '100301' } })

  it('salvar 410014 = 422 com código próprio, no campo do cClassTrib', async () => {
    const e = await refusal(assertServiceClassification(fakeCatalog(), pair('410014'), TODAY))
    expect(e.statusCode).toBe(422)
    expect(e.code).toBe('IBSCBS_CLASSIFICATION_GROUP_UNSUPPORTED')
    expect(e.fields).toEqual([{ field: 'ibscbs.classificationCode',
      message: 'cClassTrib 410014 (CST 410) não leva o grupo IBS/CBS na NFS-e — ainda não suportado — escolha outra classificação' }])
  })

  it('salvar com o indicador DESCONHECIDO também recusa (falha fechada) e diz o que fazer; 000001 passa', async () => {
    const e = await refusal(assertServiceClassification(fakeCatalog(), pair('811001'), TODAY))
    expect(e.code).toBe('IBSCBS_CLASSIFICATION_GROUP_UNSUPPORTED')
    expect(e.fields![0].message).toMatch(/CST 811 ainda não foi carregado/)
    await expect(assertServiceClassification(fakeCatalog(), pair('000001'), TODAY)).resolves.toBeUndefined()
  })

  it('a lista de apoio só oferece o que o salvar aceita', async () => {
    expect((await listClassificationsLookup('', TODAY, 'SE', fakeCatalog())).map(r => r.code)).toEqual(['000001'])
  })

  it('o selo do GET aponta o cClassTrib (o cIndOp segue aceito)', async () => {
    expect(await classificationAcceptance(fakeCatalog(), '410014', '100301', TODAY)).toEqual({ classification: false, placeIndicator: true })
    expect(await classificationAcceptance(fakeCatalog(), '000001', '100301', TODAY)).toEqual({ classification: true, placeIndicator: true })
  })
})
