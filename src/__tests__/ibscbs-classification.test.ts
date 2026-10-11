import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import {
  assertServiceClassification, findClassificationAt, deriveCst, Queryable,
  findClassificationForRegistration, classificationForDisplay, listClassificationsLookup, NFSE_IBSCBS_SIMPLES_OBLIGATION_START,
  pickForRegistration,
} from '@shared/ibscbs-classification'

/**
 * IB-1 da fase IBS/CBS — peça @shared/ibscbs-classification (D-IB6/D-IB22/D-IB23 + A-IB1):
 * classificação do serviço conferida no catálogo central na DATA, para a NFS-e (modelo SE).
 */

interface Validity { code: string; cst: string; name: string; from: string; until: string | null; regular: 'S' | 'N'; models: string[] }

function fakeCatalog(opts: { validity: Validity[]; places: Record<string, string[]>; nbs: string[] }): Queryable {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const row = (hit: Validity, model: string) => ({
        code: hit.code, cst: hit.cst, name: hit.name, validFrom: hit.from, validUntil: hit.until,
        requiresRegular: hit.regular, applicable: hit.models.includes(model) ? 1 : 0,
      })
      // CADASTRO / EXIBIÇÃO (rowsOfCode): todas as linhas do código, com a presença do modelo
      if (sql.includes('tb_tax_ibscbs_classification_validity v') && /WHERE v\.code = \? AND v\.deleted = 'N'\s+ORDER BY v\.valid_from\s*$/.test(sql)) {
        const [model, code] = params as string[]
        return [opts.validity.filter(v => v.code === code).sort((a, b) => a.from.localeCompare(b.from)).map(v => row(v, model))]
      }
      // lista de apoio (listClassificationsLookup): candidatas da janela, COM a presença (a peça escolhe)
      if (sql.includes('LIMIT 400')) {
        const [model, date, , , endW] = params as string[]
        return [opts.validity
          .filter(v => (v.from <= date && (v.until === null || v.until >= date)) || (v.from > date && v.from <= endW))
          .sort((a, b) => a.code.localeCompare(b.code) || a.from.localeCompare(b.from))
          .map(v => row(v, model))]
      }
      if (sql.includes('tb_tax_ibscbs_classification_validity v') && sql.includes('LIMIT 1')) {
        const [model, code, date] = params as string[]
        const hit = opts.validity
          .filter(v => v.code === code && v.from <= date && (v.until === null || v.until >= date))
          .sort((a, b) => (a.from < b.from ? 1 : -1))[0]
        return [hit ? [{
          code: hit.code, cst: hit.cst, name: hit.name, validFrom: hit.from, validUntil: hit.until,
          requiresRegular: hit.regular, applicable: hit.models.includes(model) ? 1 : 0,
        }] : []]
      }
      if (sql.includes('tb_ibscbs_place_indicator p')) {
        const [model, code] = params as string[]
        const models = opts.places[code]
        return [models ? [{ code, description: 'x', applicable: models.includes(model) ? 1 : 0 }] : []]
      }
      if (sql.includes('tb_nbs')) {
        return [opts.nbs.includes(String(params[0])) ? [{ 1: 1 }] : []]
      }
      throw new Error(`SQL inesperado no teste: ${sql.slice(0, 80)}`)
    },
  }
}

const catalog = () => fakeCatalog({
  validity: [
    { code: '000001', cst: '000', name: 'Tributação integral', from: '2026-01-01', until: null, regular: 'N', models: ['SE', '55', '65'] },
    { code: '000006', cst: '000', name: 'Novo da v1.70', from: '2026-01-01', until: null, regular: 'N', models: [] }, // A-IB1: sem presença
    { code: '200052', cst: '200', name: 'Saúde', from: '2026-01-01', until: '2026-10-01', regular: 'N', models: ['SE'] },
    { code: '550020', cst: '550', name: 'Exige regular', from: '2026-01-01', until: null, regular: 'S', models: ['SE'] },
    // D-IB29: começa NA obrigação (aceito no cadastro antes dela) · começa DEPOIS da obrigação (nunca antes de valer)
    { code: '000009', cst: '000', name: 'Começa em 2027', from: '2027-01-01', until: null, regular: 'N', models: ['SE'] },
    { code: '000010', cst: '000', name: 'Começa em junho', from: '2027-06-01', until: null, regular: 'N', models: ['SE'] },
    // vigente hoje E com linha futura: a vigente ganha
    { code: '000001', cst: '000', name: 'Tributação integral v2', from: '2026-12-01', until: null, regular: 'N', models: ['SE'] },
    // re-score socrático da Rodada 3: vigente SEM presença + futura COM presença (correção de dIniVig) —
    // lista e salvar têm de concordar (regra única pickForRegistration)
    { code: '000011', cst: '000', name: 'Órfã sem presença', from: '2026-01-01', until: null, regular: 'N', models: [] },
    { code: '000011', cst: '000', name: 'Corrigida', from: '2026-12-01', until: null, regular: 'N', models: ['SE'] },
  ],
  places: { '100301': ['SE', '55'], '010101': ['55'] },
  nbs: ['115022000'],
})

async function rejection(p: Promise<unknown>): Promise<HttpError> {
  try { await p } catch (e) { return e as HttpError }
  throw new Error('esperava 422')
}

describe('@shared/ibscbs-classification', () => {
  it('CST é derivado do prefixo (E0959) — nunca guardado', () => {
    expect(deriveCst('000001')).toBe('000')
    expect(deriveCst('200052')).toBe('200')
  })

  it('aceita a classificação da Setes: 000001 + cIndOp 100301 + NBS 115022000', async () => {
    await expect(assertServiceClassification(catalog(),
      { nbs: '115022000', ibscbs: { classificationCode: '000001', placeIndicatorCode: '100301' } }, '2027-01-01'))
      .resolves.toBeUndefined()
  })

  it('nada a conferir (campos ausentes ou null) não consulta o banco', async () => {
    const q: Queryable = { query: async () => { throw new Error('não deveria consultar') } }
    await expect(assertServiceClassification(q, {}, '2027-01-01')).resolves.toBeUndefined()
    await expect(assertServiceClassification(q, { nbs: null, ibscbs: null }, '2027-01-01')).resolves.toBeUndefined()
  })

  it('NBS fora do catálogo → 422 IBSCBS_NBS_NOT_FOUND no campo nbs', async () => {
    const e = await rejection(assertServiceClassification(catalog(), { nbs: '999999999' }, '2027-01-01'))
    expect(e.statusCode).toBe(422)
    expect(e.code).toBe(ErrorCodes.IBSCBS_NBS_NOT_FOUND)
    expect(e.fields?.[0].field).toBe('nbs')
  })

  it('cClassTrib fora de vigência na data → IBSCBS_CLASSIFICATION_NOT_FOUND', async () => {
    const e = await rejection(assertServiceClassification(catalog(),
      { ibscbs: { classificationCode: '200052', placeIndicatorCode: '100301' } }, '2026-10-02'))
    expect(e.code).toBe(ErrorCodes.IBSCBS_CLASSIFICATION_NOT_FOUND)
    expect(e.fields?.[0].field).toBe('ibscbs.classificationCode')
  })

  it('cClassTrib sem presença na NFS-e (ainda não confirmado pela Calculadora — A-IB1) → NOT_APPLICABLE', async () => {
    const e = await rejection(assertServiceClassification(catalog(),
      { ibscbs: { classificationCode: '000006', placeIndicatorCode: '100301' } }, '2027-01-01'))
    expect(e.code).toBe(ErrorCodes.IBSCBS_CLASSIFICATION_NOT_APPLICABLE)
  })

  it('cClassTrib que exige tributação regular → REQUIRES_REGULAR (builder não emite gTribRegular)', async () => {
    const e = await rejection(assertServiceClassification(catalog(),
      { ibscbs: { classificationCode: '550020', placeIndicatorCode: '100301' } }, '2027-01-01'))
    expect(e.code).toBe(ErrorCodes.IBSCBS_CLASSIFICATION_REQUIRES_REGULAR)
  })

  it('cIndOp não aceito na NFS-e → IBSCBS_PLACE_INDICATOR_INVALID; todas as pendências vêm juntas', async () => {
    const e = await rejection(assertServiceClassification(catalog(),
      { nbs: '999999999', ibscbs: { classificationCode: '000006', placeIndicatorCode: '010101' } }, '2027-01-01'))
    expect(e.fields?.map(f => f.field)).toEqual(['nbs', 'ibscbs.classificationCode', 'ibscbs.placeIndicatorCode'])
    expect(e.code).toBe(ErrorCodes.IBSCBS_NBS_NOT_FOUND) // o 1º problema dá o código
  })

  it('findClassificationAt devolve a linha vigente com a presença do modelo', async () => {
    const c = await findClassificationAt(catalog(), '000001', 'SE', '2027-01-01')
    expect(c).toMatchObject({ code: '000001', cst: '000', applicable: true, requiresRegularTaxation: false, validUntil: null })
    expect(await findClassificationAt(catalog(), '000001', 'SE', '2025-12-31')).toBeNull()
  })
})

// D-IB29 (Rodada 3, Valdo 2026-10-10): o CADASTRO aceita a classificação vigente hoje OU com dIniVig
// futura até a data da obrigação da NFS-e (01/01/2027); depois dela, só a vigente. A tela mostra a vigência.
describe('@shared/ibscbs-classification — janela do cadastro (D-IB29)', () => {
  it('a obrigação da NFS-e do Simples é 01/01/2027 (Ato Conjunto nº 4/2026 § 1º)', () => {
    expect(NFSE_IBSCBS_SIMPLES_OBLIGATION_START).toBe('2027-01-01')
  })

  it('antes da obrigação aceita a linha que começa até ela; a que começa depois, não', async () => {
    await expect(assertServiceClassification(catalog(),
      { ibscbs: { classificationCode: '000009', placeIndicatorCode: '100301' } }, '2026-10-10')).resolves.toBeUndefined()
    const e = await rejection(assertServiceClassification(catalog(),
      { ibscbs: { classificationCode: '000010', placeIndicatorCode: '100301' } }, '2026-10-10'))
    expect(e.code).toBe(ErrorCodes.IBSCBS_CLASSIFICATION_NOT_FOUND)
    expect(e.fields?.[0].message).toMatch(/nem começa até 2027-01-01/)
  })

  it('depois da obrigação a janela futura fecha: só a vigente na data', async () => {
    expect(await findClassificationForRegistration(catalog(), '000010', 'SE', '2027-02-01')).toBeNull()
    expect(await findClassificationForRegistration(catalog(), '000009', 'SE', '2027-02-01'))
      .toMatchObject({ code: '000009', validFrom: '2027-01-01' })
  })

  it('a vigente HOJE ganha da futura do mesmo código', async () => {
    expect(await findClassificationForRegistration(catalog(), '000001', 'SE', '2026-10-10'))
      .toMatchObject({ validFrom: '2026-01-01', name: 'Tributação integral' })
  })

  it('exibição: vigente hoje → futura mais próxima → mais recente', async () => {
    expect(await classificationForDisplay(catalog(), '000001', '2026-10-10')).toMatchObject({ validFrom: '2026-01-01' })
    expect(await classificationForDisplay(catalog(), '000009', '2026-10-10')).toEqual({ name: 'Começa em 2027', validFrom: '2027-01-01', validUntil: null })
    expect(await classificationForDisplay(catalog(), '200052', '2026-10-10')).toMatchObject({ validUntil: '2026-10-01' })
  })

  it('lista de apoio: um código por linha, vigência em validFrom (o texto é da tela — i18n); sem os que exigem regular', async () => {
    const rows = await listClassificationsLookup('', '2026-10-10', 'SE', catalog())
    expect(rows.map(r => r.code)).toEqual(['000001', '000009', '000011'])
    expect(rows[0]).toMatchObject({ description: '000 · 000001 — Tributação integral', validFrom: '2026-01-01' })
    expect(rows[1]).toMatchObject({ description: '000 · 000009 — Começa em 2027', validFrom: '2027-01-01' })
  })

  it('regra ÚNICA: o que a lista oferece o salvar aceita (vigente sem presença + futura com presença)', async () => {
    const rows = await listClassificationsLookup('', '2026-10-10', 'SE', catalog())
    expect(rows.find(r => r.code === '000011')).toMatchObject({ validFrom: '2026-12-01', description: '000 · 000011 — Corrigida' })
    await expect(assertServiceClassification(catalog(),
      { ibscbs: { classificationCode: '000011', placeIndicatorCode: '100301' } }, '2026-10-10')).resolves.toBeUndefined()
    expect(await classificationForDisplay(catalog(), '000011', '2026-10-10')).toMatchObject({ validFrom: '2026-12-01' })
  })

  it('pickForRegistration: vigente com presença → futura com presença → vigente sem presença; nada na janela = null', () => {
    const r = (validFrom: string, applicable: boolean, validUntil: string | null = null) =>
      ({ code: 'x', cst: '000', name: validFrom, validFrom, validUntil, requiresRegularTaxation: false, applicable })
    expect(pickForRegistration([r('2026-01-01', true), r('2026-06-01', true)], '2026-10-10')?.validFrom).toBe('2026-06-01')
    expect(pickForRegistration([r('2026-01-01', false), r('2026-12-01', true)], '2026-10-10')?.validFrom).toBe('2026-12-01')
    expect(pickForRegistration([r('2026-01-01', false)], '2026-10-10')?.applicable).toBe(false)
    expect(pickForRegistration([r('2027-06-01', true)], '2026-10-10')).toBeNull()
    expect(pickForRegistration([r('2026-01-01', true, '2026-05-01')], '2026-10-10')).toBeNull()
  })
})

// D-IB30 por COMPONENTE (gate adversarial do delta da Rodada 3): o salvar diz qual código do par mudou
describe('assertServiceClassification — checks por componente (D-IB30)', () => {
  it('cClassTrib inalterado (mesmo vencido) não é reconferido quando só o cIndOp mudou', async () => {
    await expect(assertServiceClassification(catalog(),
      { ibscbs: { classificationCode: '000006', placeIndicatorCode: '100301' } }, '2026-10-10', 'SE',
      { classification: false, placeIndicator: true })).resolves.toBeUndefined()
    const e = await rejection(assertServiceClassification(catalog(),
      { ibscbs: { classificationCode: '000006', placeIndicatorCode: '010101' } }, '2026-10-10', 'SE',
      { classification: false, placeIndicator: true }))
    expect(e.fields?.map(f => f.field)).toEqual(['ibscbs.placeIndicatorCode'])
  })
})
