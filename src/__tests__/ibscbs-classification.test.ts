import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import {
  assertServiceClassification, findClassificationAt, deriveCst, Queryable,
} from '@shared/ibscbs-classification'

/**
 * IB-1 da fase IBS/CBS — peça @shared/ibscbs-classification (D-IB6/D-IB22/D-IB23 + A-IB1):
 * classificação do serviço conferida no catálogo central na DATA, para a NFS-e (modelo SE).
 */

interface Validity { code: string; cst: string; name: string; from: string; until: string | null; regular: 'S' | 'N'; models: string[] }

function fakeCatalog(opts: { validity: Validity[]; places: Record<string, string[]>; nbs: string[] }): Queryable {
  return {
    query: async (sql: string, params: unknown[] = []) => {
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
