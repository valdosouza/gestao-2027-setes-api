/// <reference types="jest" />
// Fase IBS/CBS, IB-2 (prompt_fase_ibs_cbs.md §12.3/§12.6 — D-IB62…D-IB71): a DECLARAÇÃO IBS/CBS da nota.
// Regra pura na peça @shared/ibscbs-classification (catálogo simulado por SQL), presunção do serviço
// (@shared/service-ibscbs), enquadramento datado (@shared/entity-tax) e a composição dos dois produtores.
import {
  evaluateIbscbsDeclaration, assertIbscbsDeclarable, ibscbsObligationStart, ibscbsOutcomeOf,
  NFSE_IBSCBS_SIMPLES_OBLIGATION_START, NFSE_IBSCBS_REGULAR_OBLIGATION_START, ServicePresumption,
} from '../shared/ibscbs-classification'
import { readServicePresumptions } from '../shared/service-ibscbs'
import { emitterRegimeAt } from '../shared/entity-tax/entity-tax.repository'
import { declareServiceIbscbs, evaluateServiceIbscbs } from '../shared/service-ibscbs-declaration'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn() } }))

const BEFORE = '2026-12-20'   // competência antes da obrigação do Simples
const AFTER = '2027-01-05'    // depois
const START = NFSE_IBSCBS_SIMPLES_OBLIGATION_START

interface CatalogOpts {
  /** null = sem linha vigente; objeto = sobrescreve a linha aceita padrão. */
  classification?: Record<string, unknown> | null
  /** null = cIndOp inexistente; false = sem presença no modelo. */
  place?: null | false
  /** false = NBS fora da lista oficial. */
  nbs?: boolean
}

/** Catálogo central simulado: responde pela consulta (veredito do cClassTrib, cIndOp, NBS). */
function fakeCatalog(opts: CatalogOpts = {}) {
  return {
    query: jest.fn(async (sql: string, params: any = []) => {
      if (/tb_tax_ibscbs_classification_validity/.test(sql)) {
        if (opts.classification === null) return [[]]
        return [[{
          code: params[1][0], cst: '000', name: 'Tributação integral', validFrom: '2026-01-01', validUntil: null,
          requiresRegular: 'N', absentSince: null, applicable: 1, requiresGroup: 'S', ...(opts.classification ?? {}),
        }]]
      }
      if (/tb_ibscbs_place_indicator/.test(sql)) {
        if (opts.place === null) return [[]]
        return [[{ code: params[1], description: 'oneroso', applicable: opts.place === false ? 0 : 1 }]]
      }
      if (/tb_nbs/.test(sql)) return [opts.nbs === false ? [] : [{ ok: 1 }]]
      throw new Error(`SQL inesperado: ${sql}`)
    }),
  }
}

const sv = (over: Partial<ServicePresumption> = {}): ServicePresumption => ({
  productId: 40, description: 'Suporte mensal', field: 'product.40',
  nbs: '115021000', classificationCode: '000001', placeIndicatorCode: '100301', ...over,
})

describe('ibscbsObligationStart (D-IB66/D-IB67)', () => {
  it('MEI, ME/EPP e pendente = 01/01/2027; não optante = 01/10/2026; regime desconhecido = o do não optante (A-IB3)', () => {
    expect(ibscbsObligationStart('SE', { simplesRegime: '2' })).toBe(START)
    expect(ibscbsObligationStart('SE', { simplesRegime: '3' })).toBe(START)
    expect(ibscbsObligationStart('SE', { simplesRegime: '4' })).toBe(START)
    expect(ibscbsObligationStart('SE', { simplesRegime: '1' })).toBe(NFSE_IBSCBS_REGULAR_OBLIGATION_START)
    expect(ibscbsObligationStart('SE', { simplesRegime: null })).toBe(NFSE_IBSCBS_REGULAR_OBLIGATION_START)
    expect(START).toBe('2027-01-01')
    expect(NFSE_IBSCBS_REGULAR_OBLIGATION_START).toBe('2026-10-01')
  })
  it('NF-e não está decidida (F4) — falha alto, nunca uma data inventada', () => {
    expect(() => ibscbsObligationStart('55', { simplesRegime: '3' })).toThrow(/F4/)
  })
})

describe('evaluateIbscbsDeclaration — o TRIO (D-IB62, E0322)', () => {
  it('trio aceito: o grupo e a NBS vão — antes da obrigação (envio voluntário) e depois', async () => {
    for (const date of [BEFORE, AFTER]) {
      const ev = await evaluateIbscbsDeclaration(fakeCatalog(), [sv()], date, START)
      expect(ev.declaration.group).toEqual({ classificationCode: '000001', placeIndicatorCode: '100301' })
      expect(ev.declaration.nbs).toBe('115021000')
      expect(ev.declaration.omitted).toEqual([])
      expect(ev.refusal).toBeNull()
      expect(ev.obligatory).toBe(date >= START)
      expect(ibscbsOutcomeOf(ev.declaration)).toEqual({ declared: true, omitted: [] })
    }
  })

  it('a data da COMPETÊNCIA decide: o veredito do cClassTrib é pedido NESSA data e SEMPRE pelo modelo SE (a conjugada da venda é 55)', async () => {
    const q = fakeCatalog()
    await evaluateIbscbsDeclaration(q, [sv()], AFTER, START)
    const cls = q.query.mock.calls.find(c => /classification_validity/.test(String(c[0])))!
    expect(cls[1]).toEqual(['SE', ['000001'], AFTER, AFTER])
    const place = q.query.mock.calls.find(c => /place_indicator/.test(String(c[0])))!
    expect(place[1]).toEqual(['SE', '100301'])
  })

  it('no dia da obrigação já é obrigatória (limite inclusivo)', async () => {
    const ev = await evaluateIbscbsDeclaration(fakeCatalog(), [sv({ nbs: null })], START, START)
    expect(ev.obligatory).toBe(true)
    expect(ev.refusal?.code).toBe('INVOICE_SERVICE_IBSCBS_REQUIRED')
  })

  it('serviço SEM classificação antes da obrigação: grupo omitido, NBS aceita vai SOZINHA (cNBS), nunca 422', async () => {
    const ev = await evaluateIbscbsDeclaration(fakeCatalog(),
      [sv({ classificationCode: null, placeIndicatorCode: null })], BEFORE, START)
    expect(ev.declaration.group).toBeNull()
    expect(ev.declaration.nbs).toBe('115021000')
    expect(ev.declaration.omitted).toEqual(['not-classified'])
    expect(ev.refusal).toBeNull()
    expect(ibscbsOutcomeOf(ev.declaration)).toEqual({ declared: false, omitted: ['not-classified'] })
  })

  it('serviço SEM classificação depois da obrigação: 422 legível que NOMEIA o serviço (o lote descarta fields[] — D-IB65)', async () => {
    const ev = await evaluateIbscbsDeclaration(fakeCatalog(),
      [sv({ classificationCode: null, placeIndicatorCode: null })], AFTER, START)
    expect(ev.refusal).toMatchObject({ code: 'INVOICE_SERVICE_IBSCBS_REQUIRED' })
    expect(ev.refusal!.message).toMatch(/obrigatória desde 2027-01-01/)
    expect(ev.refusal!.message).toMatch(/Suporte mensal/)
    expect(ev.refusal!.fields).toEqual([{ field: 'product.40', message: expect.stringMatching(/^Suporte mensal: sem classificação/) }])
    expect(() => assertIbscbsDeclarable(ev)).toThrow(expect.objectContaining({
      statusCode: 422, code: 'INVOICE_SERVICE_IBSCBS_REQUIRED',
    }))
  })

  it('E0322: classificação aceita SEM NBS nunca leva o grupo — antes omite (nbs-missing), depois 422 (caso que a D-IB42 não nomeava)', async () => {
    const before = await evaluateIbscbsDeclaration(fakeCatalog(), [sv({ nbs: null })], BEFORE, START)
    expect(before.declaration.group).toBeNull()
    expect(before.declaration.nbs).toBeNull()
    expect(before.declaration.omitted).toEqual(['nbs-missing'])
    expect(before.refusal).toBeNull()
    const after = await evaluateIbscbsDeclaration(fakeCatalog(), [sv({ nbs: null })], AFTER, START)
    expect(after.refusal!.fields[0].message).toMatch(/sem NBS/)
  })

  it('NBS fora da lista oficial: sem grupo e sem cNBS (D-IB42); depois, 422', async () => {
    const ev = await evaluateIbscbsDeclaration(fakeCatalog({ nbs: false }), [sv()], BEFORE, START)
    expect(ev.declaration).toMatchObject({ group: null, nbs: null, omitted: ['nbs-not-accepted'] })
    const after = await evaluateIbscbsDeclaration(fakeCatalog({ nbs: false }), [sv()], AFTER, START)
    expect(after.refusal!.message).toMatch(/NBS 115021000 fora da lista oficial/)
  })

  it.each([
    ['sem linha vigente na data', { classification: null }, 'no-line', /inexistente ou fora de vigência em 2027-01-05/],
    ['sem presença na NFS-e', { classification: { applicable: 0 } }, 'not-applicable', /não aceito na NFS-e/],
    ['exige tributação regular', { classification: { requiresRegular: 'S' } }, 'requires-regular', /tributação regular/],
    // D-IB113: CST que não leva o grupo IBS/CBS (ind_gIBSCBS = 0) e indicador DESCONHECIDO (carga anterior ao script 73) — o MESMO motivo
    ['CST sem o grupo IBS/CBS', { classification: { cst: '410', requiresGroup: 'N' } }, 'cst-without-group',
      /CST 410\) não leva o grupo IBS\/CBS na NFS-e — ainda não suportado/],
    ['indicador do grupo desconhecido', { classification: { cst: '410', requiresGroup: null } }, 'cst-without-group',
      /indicador do grupo IBS\/CBS do CST 410 ainda não foi carregado/],
    ['cIndOp sem presença', { place: false }, 'place-indicator', /cIndOp 100301 inexistente ou não aceito/],
    ['cIndOp inexistente', { place: null }, 'place-indicator', /cIndOp 100301/],
  ] as const)('%s → motivo %s (o veredito da peça — D-IB47; nunca re-derivado)', async (_n, opts, reason, msg) => {
    const before = await evaluateIbscbsDeclaration(fakeCatalog(opts as CatalogOpts), [sv()], BEFORE, START)
    expect(before.declaration.group).toBeNull()
    expect(before.declaration.omitted).toEqual([reason])
    expect(before.declaration.nbs).toBe('115021000')   // a NBS aceita ainda vai sozinha
    const after = await evaluateIbscbsDeclaration(fakeCatalog(opts as CatalogOpts), [sv()], AFTER, START)
    expect(after.refusal!.code).toBe('INVOICE_SERVICE_IBSCBS_REQUIRED')
    expect(after.refusal!.message).toMatch(msg)
  })
})

describe('evaluateIbscbsDeclaration — N serviços → UMA declaração (D-IB63)', () => {
  const licenca = sv({ productId: 41, description: 'Licença de uso', field: 'product.41', placeIndicatorCode: '100501' })

  it('cIndOp diferente entre os serviços (licença 100501 × suporte 100301): antes omite (divergent) e a NBS comum aceita vai sozinha', async () => {
    const ev = await evaluateIbscbsDeclaration(fakeCatalog(), [sv(), licenca], BEFORE, START)
    expect(ev.declaration.group).toBeNull()
    expect(ev.declaration.omitted).toEqual(['divergent'])
    expect(ev.declaration.nbs).toBe('115021000')
    expect(ev.refusal).toBeNull()
  })

  it('depois da obrigação: 422 INVOICE_SERVICE_MULTI_DECLARATION com o campo POR serviço — nunca "o maior valor decide"', async () => {
    const ev = await evaluateIbscbsDeclaration(fakeCatalog(), [sv(), licenca], AFTER, START)
    expect(ev.refusal!.code).toBe('INVOICE_SERVICE_MULTI_DECLARATION')
    expect(ev.refusal!.message).toMatch(/Suporte mensal, Licença de uso/)
    expect(ev.refusal!.fields.map(f => f.field)).toEqual(['product.40', 'product.41'])
    expect(ev.refusal!.fields[1].message).toMatch(/cIndOp 100501/)
  })

  it('NBS diferente: divergente e SEM cNBS (nenhuma das duas representa a nota)', async () => {
    const ev = await evaluateIbscbsDeclaration(fakeCatalog(),
      [sv(), sv({ productId: 42, field: 'product.42', nbs: '115080000' })], BEFORE, START)
    expect(ev.declaration).toMatchObject({ group: null, nbs: null, omitted: ['divergent'] })
  })

  it('o mesmo serviço em dois itens NÃO é divergência (a presunção é por produto)', async () => {
    const ev = await evaluateIbscbsDeclaration(fakeCatalog(), [sv({ field: 'item.1' }), sv({ field: 'item.2' })], AFTER, START)
    expect(ev.declaration.group).not.toBeNull()
  })

  it('um classificado e outro não: falta (not-classified), nunca divergência', async () => {
    const ev = await evaluateIbscbsDeclaration(fakeCatalog(),
      [sv(), sv({ productId: 43, field: 'product.43', description: 'Implantação', classificationCode: null, placeIndicatorCode: null })],
      AFTER, START)
    expect(ev.declaration.omitted).toEqual(['not-classified'])
    expect(ev.refusal!.fields.map(f => f.field)).toEqual(['product.43'])
  })

  it('sem serviço nenhum é erro de programação (o ramo exige ao menos um)', async () => {
    await expect(evaluateIbscbsDeclaration(fakeCatalog(), [], AFTER, START)).rejects.toThrow(/sem serviço/)
  })
})

describe('readServicePresumptions (@shared/service-ibscbs — D-IB70)', () => {
  /** Responde as 3 leituras pela tabela: produto → serviço (NBS) → peça 1:1. */
  function erpConn(rows: { product?: any[]; service?: any[]; classified?: any[] }) {
    return {
      query: jest.fn(async (sql: string, _params?: unknown) => {
        if (/tb_service_ibscbs si/.test(sql)) return [rows.classified ?? []]
        if (/tb_service sv/.test(sql)) return [rows.service ?? []]
        if (/tb_product p/.test(sql)) return [rows.product ?? []]
        throw new Error(`SQL inesperado: ${sql}`)
      }),
    }
  }

  it('TRÊS leituras travantes na ORDEM do PUT do serviço (produto → serviço → 1:1) — nunca um JOIN travante (1213 provado)', async () => {
    const q = erpConn({
      product: [{ productId: 40, description: 'Suporte mensal' }],
      service: [{ id: 40, nbs: '115021000' }],
      classified: [{ id: 40, c: '000001', p: '100301' }],
    })
    const rows = await readServicePresumptions(q, 'setes_setes', 1,
      [{ productId: 40, field: 'item.1' }, { productId: 40, field: 'item.2' }, { productId: 99, field: 'item.3' }], { lock: true })
    const sqls = q.query.mock.calls.map(c => String(c[0]))
    expect(sqls).toHaveLength(3)
    expect(sqls[0]).toMatch(/FROM `setes_setes`\.tb_product p[\s\S]*p\.deleted = 'N'[\s\S]*ORDER BY p\.id\s+LOCK IN SHARE MODE/)
    expect(sqls[1]).toMatch(/FROM `setes_setes`\.tb_service sv[\s\S]*LOCK IN SHARE MODE/)
    expect(sqls[2]).toMatch(/FROM `setes_setes`\.tb_service_ibscbs si[\s\S]*si\.deleted = 'N'[\s\S]*LOCK IN SHARE MODE/)
    for (const sql of sqls) expect(sql).not.toMatch(/JOIN/)
    expect(q.query.mock.calls[0][1]).toEqual([1, [40, 99]])
    expect(q.query.mock.calls[1][1]).toEqual([1, [40]])   // só os produtos VIVOS seguem
    expect(rows).toEqual([
      { productId: 40, description: 'Suporte mensal', field: 'item.1', nbs: '115021000', classificationCode: '000001', placeIndicatorCode: '100301' },
      { productId: 99, description: 'Serviço 99', field: 'item.3', nbs: null, classificationCode: null, placeIndicatorCode: null },
    ])
  })

  it('produto excluído não consulta as outras tabelas (a 1:1 de serviço morto não vale — limite do §11.11)', async () => {
    const q = erpConn({})
    const rows = await readServicePresumptions(q, 'setes_setes', 1, [{ productId: 40, field: 'x' }], { lock: true })
    expect(q.query).toHaveBeenCalledTimes(1)
    expect(rows[0]).toMatchObject({ classificationCode: null, nbs: null, description: 'Serviço 40' })
  })

  it('o pré-voo lê SEM trava; schema inválido recusa antes do SQL', async () => {
    const q = erpConn({ product: [{ productId: 40, description: 'x' }] })
    await readServicePresumptions(q, 'setes_setes', 1, [{ productId: 40, field: 'x' }], { lock: false })
    for (const c of q.query.mock.calls) expect(String(c[0])).not.toMatch(/LOCK IN SHARE MODE/)
    await expect(readServicePresumptions(q, 'x`; DROP', 1, [{ productId: 1, field: 'x' }], { lock: false })).rejects.toThrow(/schema/)
  })
})

describe('emitterRegimeAt (@shared/entity-tax — D-IB66)', () => {
  it('lê a linha ATUAL do emitente (convenção "sem história") com trava compartilhada; fora do domínio = desconhecido', async () => {
    const q = { query: jest.fn().mockResolvedValueOnce([[{ simplesRegime: '3' }]]).mockResolvedValueOnce([[{ simplesRegime: 'x' }]]).mockResolvedValueOnce([[]]) }
    expect(await emitterRegimeAt(q, 'setes_setes', 1, AFTER, { lock: true })).toEqual({ simplesRegime: '3' })
    expect(q.query.mock.calls[0][0]).toMatch(/LOCK IN SHARE MODE/)
    expect(q.query.mock.calls[0][1]).toEqual(['setes_setes.tb_entity_tax', 1, 1])
    expect(await emitterRegimeAt(q, 'setes_setes', 1, AFTER, { lock: false })).toEqual({ simplesRegime: null })
    expect(q.query.mock.calls[1][0]).not.toMatch(/LOCK IN SHARE MODE/)
    expect(await emitterRegimeAt(q, 'setes_setes', 1, AFTER, { lock: false })).toEqual({ simplesRegime: null })
  })
})

describe('composição declareServiceIbscbs (D-IB71 — a ÚNICA porta dos dois produtores)', () => {
  /** Conexão que responde: presunção (3 leituras) → enquadramento → catálogo. */
  function txConn(presumption: { nbs?: string | null; classificationCode?: string; placeIndicatorCode?: string }, regime: string | null) {
    const catalog = fakeCatalog()
    return {
      query: jest.fn(async (sql: string, params: any = []) => {
        if (/tb_service_ibscbs si/.test(sql)) {
          return [presumption.classificationCode
            ? [{ id: 40, c: presumption.classificationCode, p: presumption.placeIndicatorCode }] : []]
        }
        if (/tb_service sv/.test(sql)) return [[{ id: 40, nbs: presumption.nbs ?? null }]]
        if (/tb_product p/.test(sql)) return [[{ productId: 40, description: 'Suporte mensal' }]]
        if (/simples_regime/.test(sql)) return [[{ simplesRegime: regime }]]
        return catalog.query(sql, params)
      }),
    }
  }
  const items = [{ productId: 40, field: 'product.40' }]

  it('ME/EPP (opSimpNac 3) sem classificação: dezembro sai sem o grupo; janeiro = 422 (a obrigação vem do enquadramento)', async () => {
    const dec = await declareServiceIbscbs(txConn({ nbs: '115021000' }, '3'), 'setes_setes', 1, { items, competenceDate: BEFORE })
    expect(dec).toMatchObject({ group: null, nbs: '115021000', omitted: ['not-classified'] })
    await expect(declareServiceIbscbs(txConn({ nbs: '115021000' }, '3'), 'setes_setes', 1, { items, competenceDate: AFTER }))
      .rejects.toMatchObject({ statusCode: 422, code: 'INVOICE_SERVICE_IBSCBS_REQUIRED' })
  })

  it('não optante (opSimpNac 1): a obrigação já vale em dezembro/2026 (D-IB67)', async () => {
    await expect(declareServiceIbscbs(txConn({ nbs: '115021000' }, '1'), 'setes_setes', 1, { items, competenceDate: BEFORE }))
      .rejects.toMatchObject({ statusCode: 422 })
  })

  it('D-IB74: regime NÃO informado vale a data do não optante e o 422 DIZ a causa e as duas saídas', async () => {
    const err = await declareServiceIbscbs(txConn({ nbs: '115021000' }, null), 'setes_setes', 1, { items, competenceDate: BEFORE })
      .catch(e => e)
    expect(err).toMatchObject({ statusCode: 422, code: 'INVOICE_SERVICE_IBSCBS_REQUIRED' })
    expect(err.message).toMatch(/regime do Simples NÃO informado no estabelecimento — vale a obrigação do não optante, 2026-10-01/)
    expect(err.message).toMatch(/informe o regime na aba Tributação do estabelecimento ou classifique os serviços/)
    // com o regime informado (ME/EPP) a mesma nota passa em dezembro, sem a frase
    const ok = await declareServiceIbscbs(txConn({ nbs: '115021000' }, '3'), 'setes_setes', 1, { items, competenceDate: BEFORE })
    expect(ok.group).toBeNull()
  })

  it('no faturamento as leituras do ERP TRAVAM (compartilhada); no pré-voo não', async () => {
    const conn = txConn({ nbs: '115021000', classificationCode: '000001', placeIndicatorCode: '100301' }, '3')
    const dec = await declareServiceIbscbs(conn, 'setes_setes', 1, { items, competenceDate: AFTER })
    expect(dec.group).toEqual({ classificationCode: '000001', placeIndicatorCode: '100301' })
    const erpSqls = conn.query.mock.calls.map(c => String(c[0])).filter(s => /tb_product p|tb_service sv|tb_service_ibscbs si|simples_regime/.test(s))
    expect(erpSqls).toHaveLength(4)
    for (const s of erpSqls) expect(s).toMatch(/LOCK IN SHARE MODE/)
    const pre = txConn({ nbs: '115021000' }, '3')
    const ev = await evaluateServiceIbscbs(pre, 'setes_setes', 1, { items, competenceDate: AFTER }, { lock: false })
    expect(ev.refusal?.code).toBe('INVOICE_SERVICE_IBSCBS_REQUIRED')   // só pergunta: devolve, não lança
    for (const s of pre.query.mock.calls.map(c => String(c[0]))) expect(s).not.toMatch(/LOCK IN SHARE MODE/)
  })
})
