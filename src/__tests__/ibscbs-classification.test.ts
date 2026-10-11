import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import {
  assertServiceClassification, findClassificationAt, deriveCst, Queryable,
  findClassificationForRegistration, classificationForDisplay, listClassificationsLookup, NFSE_IBSCBS_SIMPLES_OBLIGATION_START,
  pickForRegistration, classificationAcceptedToday, classificationAcceptance, assertIbscbsCatalogSchema,
  nbsAcceptedSql, nbsExists,
  verdictOf, classificationVerdictsAt, classificationRegistrationVerdicts, classificationAcceptedAt,
} from '@shared/ibscbs-classification'

/**
 * IB-1 da fase IBS/CBS — peça @shared/ibscbs-classification (D-IB6/D-IB22/D-IB23 + A-IB1):
 * classificação do serviço conferida no catálogo central na DATA, para a NFS-e (modelo SE).
 */

interface Validity { code: string; cst: string; name: string; from: string; until: string | null; regular: 'S' | 'N'; models: string[]; absent?: string }

function fakeCatalog(opts: { validity: Validity[]; places: Record<string, string[]>; nbs: string[] }): Queryable {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const row = (hit: Validity, model: string) => ({
        code: hit.code, cst: hit.cst, name: hit.name, validFrom: hit.from, validUntil: hit.until,
        requiresRegular: hit.regular, applicable: hit.models.includes(model) ? 1 : 0, absentSince: hit.absent ?? null,
      })
      // CADASTRO / EXIBIÇÃO (rowsOfCode): todas as linhas do código, com a presença do modelo
      if (sql.includes('tb_tax_ibscbs_classification_validity v') && /WHERE v\.code = \? AND v\.deleted = 'N'\s+ORDER BY v\.valid_from\s*$/.test(sql)) {
        const [model, code] = params as string[]
        return [opts.validity.filter(v => v.code === code).sort((a, b) => a.from.localeCompare(b.from)).map(v => row(v, model))]
      }
      // lista de apoio (listClassificationsLookup): candidatas da janela, COM a presença (a peça escolhe)
      if (sql.includes('LIMIT 400')) {
        if (!sql.includes('absent_since_version IS NULL')) throw new Error('lista sem o filtro da linha superada (D-IB36)')
        const [model, date, , , endW] = params as string[]
        return [opts.validity
          .filter(v => !v.absent && ((v.from <= date && (v.until === null || v.until >= date)) || (v.from > date && v.from <= endW)))
          .sort((a, b) => a.code.localeCompare(b.code) || a.from.localeCompare(b.from))
          .map(v => row(v, model))]
      }
      if (sql.includes('tb_tax_ibscbs_classification_validity v') && sql.includes('LIMIT 1')) {
        if (!sql.includes('absent_since_version IS NULL')) throw new Error('data do fato sem o filtro da linha superada (D-IB36)')
        const [model, code, date] = params as string[]
        const hit = opts.validity
          .filter(v => v.code === code && !v.absent && v.from <= date && (v.until === null || v.until >= date))
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
    // D-IB36: 000012 corrigido de 2026-09-01 para 2026-03-01 — a linha antiga sumiu da fonte (superada)
    { code: '000012', cst: '000', name: 'Correta', from: '2026-03-01', until: null, regular: 'N', models: ['SE'] },
    { code: '000012', cst: '000', name: 'Órfã superada', from: '2026-09-01', until: null, regular: 'N', models: ['SE'], absent: 'IT v1.80' },
    // exibição fiel à D-IB36: linha NÃO superada vencida + superada aberta — mostra a não superada
    { code: '000013', cst: '000', name: 'Vencida (não superada)', from: '2025-01-01', until: '2026-06-30', regular: 'N', models: ['SE'] },
    { code: '000013', cst: '000', name: 'Superada aberta', from: '2026-09-01', until: null, regular: 'N', models: ['SE'], absent: 'IT v1.80' },
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
    expect(rows.map(r => r.code)).toEqual(['000001', '000009', '000011', '000012'])
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
      ({ code: 'x', cst: '000', name: validFrom, validFrom, validUntil, requiresRegularTaxation: false, applicable, superseded: false })
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

// D-IB36 (Rodada 4, Valdo 2026-10-10): linha que sumiu da fonte é IGNORADA em toda resolução
describe('@shared/ibscbs-classification — linha superada (D-IB36)', () => {
  it('data do fato, cadastro, lista e exibição ignoram a linha superada (a correta, mais antiga, vale)', async () => {
    expect(await findClassificationAt(catalog(), '000012', 'SE', '2026-10-10')).toMatchObject({ validFrom: '2026-03-01', name: 'Correta' })
    expect(await findClassificationForRegistration(catalog(), '000012', 'SE', '2026-10-10')).toMatchObject({ validFrom: '2026-03-01' })
    const rows = await listClassificationsLookup('', '2026-10-10', 'SE', catalog())
    expect(rows.find(r => r.code === '000012')).toMatchObject({ validFrom: '2026-03-01', description: '000 · 000012 — Correta' })
    expect(await classificationForDisplay(catalog(), '000012', '2026-10-10')).toMatchObject({ name: 'Correta' })
  })

  it('pickForRegistration nunca escolhe a superada, nem como último recurso', () => {
    const r = (validFrom: string, superseded: boolean) =>
      ({ code: 'x', cst: '000', name: validFrom, validFrom, validUntil: null, requiresRegularTaxation: false, applicable: true, superseded })
    expect(pickForRegistration([r('2026-01-01', false), r('2026-09-01', true)], '2026-10-10')?.validFrom).toBe('2026-01-01')
    expect(pickForRegistration([r('2026-09-01', true)], '2026-10-10')).toBeNull()
  })
})

// D-IB37: o GET diz se a classificação GRAVADA é aceita hoje (o selo da tela)
describe('classificationAcceptedToday (D-IB37)', () => {
  it('aceita: linha com presença, sem regular, e cIndOp aceito; qualquer falha = false', async () => {
    expect(await classificationAcceptedToday(catalog(), '000001', '100301', '2026-10-10')).toBe(true)
    expect(await classificationAcceptedToday(catalog(), '000006', '100301', '2026-10-10')).toBe(false)   // sem presença (A-IB1)
    expect(await classificationAcceptedToday(catalog(), '550020', '100301', '2026-10-10')).toBe(false)   // exige regular
    expect(await classificationAcceptedToday(catalog(), '200052', '100301', '2026-10-10')).toBe(false)   // venceu em 2026-10-01
    expect(await classificationAcceptedToday(catalog(), '000001', '010101', '2026-10-10')).toBe(false)   // cIndOp só NF-e
    expect(await classificationAcceptedToday(catalog(), '000009', '100301', '2026-10-10')).toBe(true)    // futura na janela (D-IB29)
  })
})

// Delta socrático da Rodada 4: exibição só cai na superada se não houver outra; selo por componente;
// o boot confere a coluna do script 63.
describe('@shared/ibscbs-classification — correções do gate da Rodada 4', () => {
  it('exibição: a linha superada só aparece se NÃO houver outra (mesmo vencida, a não superada ganha)', async () => {
    expect(await classificationForDisplay(catalog(), '000013', '2026-10-10')).toMatchObject({ name: 'Vencida (não superada)' })
    expect(await classificationForDisplay(catalog(), '000013', null)).toMatchObject({ name: 'Vencida (não superada)' })
  })

  it('aceite por componente: diz qual código do par deixou de ser aceito', async () => {
    expect(await classificationAcceptance(catalog(), '000001', '010101', '2026-10-10')).toEqual({ classification: true, placeIndicator: false })
    expect(await classificationAcceptance(catalog(), '000006', '100301', '2026-10-10')).toEqual({ classification: false, placeIndicator: true })
  })

  it('boot: sem a coluna do script 63 a API não sobe e diz qual script aplicar; outro erro sobe como está', async () => {
    const ok = { query: async () => [[]] }
    await expect(assertIbscbsCatalogSchema(ok)).resolves.toBe('ok')
    const missing = { query: async () => { throw Object.assign(new Error("Unknown column 'absent_since_version'"), { errno: 1054 }) } }
    await expect(assertIbscbsCatalogSchema(missing)).rejects.toThrow(/sql\/63_ibscbs_validity_absent_since\.sql/)
    const other = { query: async () => { throw Object.assign(new Error('denied'), { errno: 1142 }) } }
    await expect(assertIbscbsCatalogSchema(other)).rejects.toMatchObject({ errno: 1142 })
  })
})

// Delta socrático da Rodada 5: "NBS aceita" tem UM dono — a peça; cadastro e GET leem por ela.
describe('@shared/ibscbs-classification — regra única da NBS aceita (D-IB40)', () => {
  it('predicado: presença no catálogo + deleted = N, no alias de quem consulta; alias fora do formato é recusado', () => {
    expect(nbsAcceptedSql('nb')).toBe("(nb.code IS NOT NULL AND nb.deleted = 'N')")
    expect(() => nbsAcceptedSql("nb; DROP TABLE x")).toThrow(/alias inválido/)
  })

  it('nbsExists usa o MESMO predicado: NBS que saiu da lista (deleted = S) não é aceita', async () => {
    const catalogNbs = [{ code: '115021000', deleted: 'N' }, { code: '199999999', deleted: 'S' }]
    const q = { query: async (sql: string, params: unknown[]) => {
      expect(sql).toContain(nbsAcceptedSql('nb'))
      return [catalogNbs.filter(r => r.code === params[0] && r.deleted === 'N')]
    } }
    expect(await nbsExists(q as any, '115021000')).toBe(true)
    expect(await nbsExists(q as any, '199999999')).toBe(false)
    expect(await nbsExists(q as any, '000000000')).toBe(false)
  })

  // gate adversarial do delta R5 (LOW 2): o 422 diz o mesmo que o selo — "não está na lista oficial"
  it('422 da NBS fora da lista fala a língua do selo (vale para inexistente e para retirada)', async () => {
    const q = { query: async () => [[]] }
    const e = await assertServiceClassification(q as any, { nbs: '199999999' }, '2026-10-10').catch(x => x)
    expect(e.code).toBe(ErrorCodes.IBSCBS_NBS_NOT_FOUND)
    expect(e.fields).toEqual([{ field: 'nbs', message: 'NBS 199999999 não está na lista oficial' }])
  })
})

// Gate socrático do delta R7: "aceito" é UM veredito com motivo (R7-S3) e tem porta em LOTE (R7-S5)
describe('@shared/ibscbs-classification — veredito e lotes (D-IB47)', () => {
  const line = (over: Record<string, unknown> = {}) => ({ code: '000001', cst: '000', name: 'n', validFrom: '2026-01-01', validUntil: null,
    requiresRegularTaxation: false, applicable: true, superseded: false, ...over }) as any
  it('verdictOf: sem linha · sem presença · exige tributação regular · aceito', () => {
    expect(verdictOf(null)).toMatchObject({ accepted: false, reason: 'no-line' })
    expect(verdictOf(line({ applicable: false }))).toMatchObject({ accepted: false, reason: 'not-applicable' })
    expect(verdictOf(line({ requiresRegularTaxation: true }))).toMatchObject({ accepted: false, reason: 'requires-regular' })
    expect(verdictOf(line())).toMatchObject({ accepted: true, reason: null })
  })

  const row = (code: string, from: string, over: Record<string, unknown> = {}) => ({ code, cst: '000', name: 'n', validFrom: from, validUntil: null,
    requiresRegular: 'N', absentSince: null, applicable: 1, ...over })

  it('em lote na data: a linha vigente MAIS NOVA de cada código (como findClassificationAt); código ausente = sem linha', async () => {
    const calls: unknown[][] = []
    const q = { query: async (raw: string, params: unknown[]) => {
      const sql = raw.replace(/\s+/g, ' ')
      calls.push(params)
      expect(sql).toContain('v.code IN (?)')
      expect(sql).toContain('v.absent_since_version IS NULL AND v.valid_from <= ? AND (v.valid_until IS NULL OR v.valid_until >= ?)')
      expect(sql).toContain('ORDER BY v.code, v.valid_from DESC')
      return [[row('000001', '2026-10-05', { applicable: 0 }), row('000001', '2026-01-01'), row('000006', '2026-01-01')]]
    } }
    const v = await classificationVerdictsAt(q as any, ['000006', '000001', '000099', '000001'], 'SE', '2026-10-10')
    expect(calls).toEqual([['SE', ['000006', '000001', '000099'], '2026-10-10', '2026-10-10']])
    expect([v.get('000001')?.reason, v.get('000006')?.accepted, v.get('000099')?.reason]).toEqual(['not-applicable', true, 'no-line'])
  })

  it('em lote: blocos de 500 códigos', async () => {
    let n = 0
    const q = { query: async () => { n++; return [[]] } }
    const codes = Array.from({ length: 1001 }, (_, i) => String(100000 + i))
    const v = await classificationVerdictsAt(q as any, codes, 'SE', '2026-10-10')
    expect([n, v.size]).toEqual([3, 1001])
  })

  it('cadastro em lote: pickForRegistration por código (linha futura na janela aceita; vigente com presença ganha da sem)', async () => {
    const q = { query: async (sql: string) => {
      expect(sql).not.toContain('v.valid_from <= ?')
      return [[row('000001', '2026-01-01'), row('000001', '2026-10-05', { applicable: 0 }), row('000006', '2026-11-01'), row('000007', '2026-01-01', { applicable: 0 })]]
    } }
    const v = await classificationRegistrationVerdicts(q as any, ['000001', '000006', '000007'], 'SE', '2026-10-10')
    expect([v.get('000001')?.accepted, v.get('000006')?.accepted, v.get('000007')?.reason]).toEqual([true, true, 'not-applicable'])
  })

  it('classificationAcceptedAt = veredito da data do fato', async () => {
    const q = { query: async () => [[row('000001', '2026-01-01', { requiresRegular: 'S' })]] }
    expect(await classificationAcceptedAt(q as any, '000001', 'SE', '2026-10-10')).toBe(false)
  })
})

