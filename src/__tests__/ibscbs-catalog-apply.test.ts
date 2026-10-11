/// <reference types="jest" />
// IB-1 da fase IBS/CBS — gravação do catálogo (applyCatalog) e datas da fonte. Gate socrático
// da IB-1: desativação, revive e ensaio só tinham sido provados AO VIVO; a NBS extinta nunca
// saía; a linha de vigência não confirmada era filtrada pelo CÓDIGO inteiro.
import { applyCatalog, isCalendarDate, ItCatalog, shrinkLine } from '@shared/ibscbs-catalog'

type Row = Record<string, any>

/** Conexão falsa: responde os SELECTs pelo nome da tabela e grava o resto como chamada. */
function fakeConn(tables: Record<string, Row[] | ((sql: string, params: unknown[]) => Row[])>) {
  const writes: Array<{ sql: string; params: unknown[] }> = []
  const conn = {
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim()
      if (/^SET SESSION/.test(s)) return [[]]
      if (/^SELECT/.test(s)) {
        // tabela de cliente `schema`.tabela → chave "schema.tabela" (impacto — D-IB28 (b))
        const client = /FROM `(\w+)`\.(\w+)/.exec(s)
        const central = /FROM setes_central\.`?(\w+)`?/.exec(s)?.[1] ?? ''
        // "o que segue vivo" no estado pós-carga (lostAfterLoad) → chave "__alive.<tabela>"
        const t = client ? `${client[1]}.${client[2]}` : /^SELECT DISTINCT (v.)?code/.test(s) ? `__alive.${central}` : central
        const v = tables[t]
        return [typeof v === 'function' ? v(s, params) : v ?? []]
      }
      writes.push({ sql: s, params })
      return [{ affectedRows: 1 }]
    }),
  }
  return { conn: conn as any, writes, raw: conn }
}

const catalog = (): ItCatalog => ({
  csts: [{ id: '000', description: 'Tributação integral' }],
  classifications: [
    { code: '000001', cst: '000', name: 'n1', description: 'd1', validFrom: '2026-01-01', validUntil: null,
      requiresRegularTaxation: false, updatedAt: '2026-01-01', models: ['SE', '55'] },
    { code: '000006', cst: '000', name: 'n6', description: 'd6', validFrom: '2026-01-01', validUntil: null,
      requiresRegularTaxation: false, updatedAt: '2026-01-01', models: ['SE'] },
  ],
})

const baseTables = () => ({
  tb_tax_ibscbs: [{ id: '000', description: 'Tributação integral' }],
  tb_tax_ibscbs_classification: [{ code: '000001', cst: '000' }, { code: '000006', cst: '000' }],
  tb_tax_ibscbs_classification_validity: [
    { code: '000001', valid_from: '2026-01-01', valid_until: null, name: 'n1', description: 'd1', requires_regular_taxation: 'N', source_updated_at: '2026-01-01' },
    { code: '000006', valid_from: '2026-01-01', valid_until: null, name: 'n6', description: 'd6', requires_regular_taxation: 'N', source_updated_at: '2026-01-01' },
  ] as Row[],
  tb_tax_ibscbs_classification_applicability: [
    { code: '000001', valid_from: '2026-01-01', model: 'SE', deleted: 'N' },
  ] as Row[],
  tb_nbs: [
    { code: '115021000', description: 'Desenvolvimento', deleted: 'N' },
    { code: '199999999', description: 'Extinta', deleted: 'N' },
    { code: '115080000', description: 'Manutenção', deleted: 'S' },
  ],
})

describe('applyCatalog — presença e ensaio', () => {
  it('NBS fora da lista oficial perde presença; a que volta revive; o relatório lista as chaves', async () => {
    const { conn, writes } = fakeConn(baseTables())
    const r = await applyCatalog(conn, {
      it: catalog(), itVersion: 'IT t', unconfirmed: [], models: ['SE'], apply: true,
      nbs: [{ code: '115021000', description: 'Desenvolvimento' }, { code: '115080000', description: 'Manutenção' }],
      nbsVersion: 'Calculadora t',
      allowShrink: true,   // conjunto mínimo (1 de 2 vivas sai) — aqui o alvo é a presença, não o limite D-IB28 (c)
    })
    expect(r.nbs).toMatchObject({ unchanged: 1, revived: 1, deactivated: 1, deactivatedKeys: ['199999999'] })
    expect(writes.some(w => /UPDATE setes_central\.tb_nbs SET deleted = 'S'/.test(w.sql) && w.params[0] === '199999999')).toBe(true)
  })

  it('linha NÃO confirmada pela Calculadora fica sem aplicabilidade (pela LINHA de vigência), as demais ganham', async () => {
    const { conn, writes } = fakeConn(baseTables())
    const r = await applyCatalog(conn, {
      it: catalog(), itVersion: 'IT t', models: ['SE'], apply: true,
      unconfirmed: [{ code: '000006', validFrom: '2026-01-01' }],
    })
    expect(r.applicability).toMatchObject({ unchanged: 1, inserted: 0 })
    expect(writes.some(w => /INSERT INTO setes_central\.`tb_tax_ibscbs_classification_applicability`/.test(w.sql))).toBe(false)

    const t2 = baseTables()
    const { conn: conn2, writes: w2 } = fakeConn(t2)
    const r2 = await applyCatalog(conn2, { it: catalog(), itVersion: 'IT t', models: ['SE'], apply: true, unconfirmed: [] })
    expect(r2.applicability.inserted).toBe(1)
    expect(w2.find(w => /INSERT INTO setes_central\.`tb_tax_ibscbs_classification_applicability`/.test(w.sql))?.params)
      .toEqual(['000006', '2026-01-01', 'SE'])
  })

  it('código que perde a confirmação numa recarga perde a aplicabilidade (deactivatedKeys mostra no ensaio)', async () => {
    const t = baseTables()
    t.tb_tax_ibscbs_classification_applicability.push({ code: '000006', valid_from: '2026-01-01', model: 'SE', deleted: 'N' })
    const { conn } = fakeConn(t)
    const r = await applyCatalog(conn, {
      it: catalog(), itVersion: 'IT t', models: ['SE'], apply: false,
      unconfirmed: [{ code: '000006', validFrom: '2026-01-01' }],
    })
    expect(r.applicability).toMatchObject({ deactivated: 1, deactivatedKeys: ['000006|2026-01-01|SE'] })
  })

  it('ENSAIO executa tudo e DESFAZ (rollback, nunca commit); --vai faz commit', async () => {
    const ensaio = fakeConn(baseTables())
    const r = await applyCatalog(ensaio.conn, { it: catalog(), itVersion: 'IT t', models: ['SE'], apply: false, unconfirmed: [] })
    expect(r.applied).toBe(false)
    expect(ensaio.raw.rollback).toHaveBeenCalledTimes(1)
    expect(ensaio.raw.commit).not.toHaveBeenCalled()

    const vai = fakeConn(baseTables())
    const r2 = await applyCatalog(vai.conn, { it: catalog(), itVersion: 'IT t', models: ['SE'], apply: true, unconfirmed: [] })
    expect(r2.applied).toBe(true)
    expect(vai.raw.commit).toHaveBeenCalledTimes(1)
  })

  it('identidade não muda: CST diferente para o mesmo código = erro alto e rollback', async () => {
    const t = baseTables()
    t.tb_tax_ibscbs_classification = [{ code: '000001', cst: '200' }, { code: '000006', cst: '000' }]
    const { conn, raw } = fakeConn(t)
    await expect(applyCatalog(conn, { it: catalog(), itVersion: 'IT t', models: ['SE'], apply: true, unconfirmed: [] }))
      .rejects.toThrow(/identidade não muda/)
    expect(raw.rollback).toHaveBeenCalled()
    expect(raw.commit).not.toHaveBeenCalled()
  })
})

// Rodada 3 (Valdo 2026-10-10, "siga as recomendações"): D-IB28 (a) linha com atributo divergente
// sai só do modelo · (c) encolhimento > 10 % = recusa sem --aceita-encolher · (b) impacto por schema.
describe('applyCatalog — D-IB28', () => {
  it('(a) linha BLOQUEADA por atributo não ganha a aplicabilidade naquele modelo', async () => {
    const { conn, writes } = fakeConn(baseTables())
    const r = await applyCatalog(conn, {
      it: catalog(), itVersion: 'IT t', models: ['SE'], apply: true, unconfirmed: [],
      blocked: [{ code: '000006', validFrom: '2026-01-01', model: 'SE' }],
    })
    expect(r.applicability).toMatchObject({ inserted: 0, unchanged: 1 })
    expect(writes.some(w => /INSERT INTO setes_central\.`tb_tax_ibscbs_classification_applicability`/.test(w.sql))).toBe(false)
  })

  // 10 NBS vivas; a fonte traz só 8 → 2 desativadas = 20 % > 10 %
  const tenNbs = () => {
    const t = baseTables()
    t.tb_nbs = Array.from({ length: 10 }, (_, i) => ({ code: `11502${String(i).padStart(4, '0')}`, description: `n${i}`, deleted: 'N' }))
    return t
  }
  const eightNbs = () => Array.from({ length: 8 }, (_, i) => ({ code: `11502${String(i).padStart(4, '0')}`, description: `n${i}` }))

  it('(c) ENSAIO que encolhe > 10 %: avisa no relatório e desfaz (não lança)', async () => {
    const { conn, raw } = fakeConn(tenNbs())
    const r = await applyCatalog(conn, { it: catalog(), itVersion: 'IT t', models: ['SE'], apply: false, unconfirmed: [], nbs: eightNbs() })
    expect(r.shrink).toEqual([{ list: 'nbs', aliveBefore: 10, deactivated: 2 }])
    expect(raw.rollback).toHaveBeenCalledTimes(1)
    expect(raw.commit).not.toHaveBeenCalled()
  })

  it('(c) ATO que encolhe > 10 % sem --aceita-encolher = recusa (rollback); com o argumento, grava', async () => {
    const recusa = fakeConn(tenNbs())
    await expect(applyCatalog(recusa.conn, { it: catalog(), itVersion: 'IT t', models: ['SE'], apply: true, unconfirmed: [], nbs: eightNbs() }))
      .rejects.toThrow(/mais de 10 % das linhas vivas[\s\S]*NBS da lista oficial \[nbs\]: 2 de 10/)
    expect(recusa.raw.commit).not.toHaveBeenCalled()
    expect(recusa.raw.rollback).toHaveBeenCalled()

    const aceita = fakeConn(tenNbs())
    const r = await applyCatalog(aceita.conn, {
      it: catalog(), itVersion: 'IT t', models: ['SE'], apply: true, unconfirmed: [], nbs: eightNbs(), allowShrink: true,
    })
    expect(r.applied).toBe(true)
    expect(aceita.raw.commit).toHaveBeenCalledTimes(1)
  })

  it('(c) encolhimento até 10 % passa sem argumento (1 de 10)', async () => {
    const { conn, raw } = fakeConn(tenNbs())
    const nine = Array.from({ length: 9 }, (_, i) => ({ code: `11502${String(i).padStart(4, '0')}`, description: `n${i}` }))
    const r = await applyCatalog(conn, { it: catalog(), itVersion: 'IT t', models: ['SE'], apply: true, unconfirmed: [], nbs: nine })
    expect(r.shrink).toEqual([])
    expect(raw.commit).toHaveBeenCalledTimes(1)
  })

  it('(b) impacto: serviços vivos por schema que usam cClassTrib/cIndOp/NBS que ficam sem aplicabilidade; schema ilegível vira problema listado', async () => {
    const t: Record<string, Row[] | ((sql: string, params: unknown[]) => Row[])> = { ...baseTables() }
    ;(t.tb_tax_ibscbs_classification_applicability as Row[]).push({ code: '000006', valid_from: '2026-01-01', model: 'SE', deleted: 'N' })
    t.tb_ibscbs_place_indicator = [{ code: '100301', description: 'x' }, { code: '100302', description: 'y' }]
    t.tb_ibscbs_place_indicator_applicability = [{ code: '100301', model: 'SE', deleted: 'N' }, { code: '100302', model: 'SE', deleted: 'N' }]
    // estado pós-carga: 000001 e 100301 seguem aceitos; 000006 e 100302 ficam sem nenhuma aplicabilidade
    t['__alive.tb_tax_ibscbs_classification_applicability'] = [{ code: '000001' }]
    t['__alive.tb_ibscbs_place_indicator_applicability'] = [{ code: '100301' }]
    t.tb_institution = [{ schema_name: 'setes_a', active: 'S' }, { schema_name: 'setes_b', active: 'S' }, { schema_name: 'Setes-Ruim', active: 'N' }]
    t['setes_a.tb_service_ibscbs'] = (sql: string) => sql.includes('place_indicator_code IN')
      ? [{ code: '100302', n: 2, ids: '7,9' }] : [{ code: '000006', n: 3, ids: '3,4,5' }]
    t['setes_a.tb_service'] = [{ code: '199999999', n: 1, ids: '11' }]
    t['setes_b.tb_service_ibscbs'] = () => { throw Object.assign(new Error('denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' }) }
    const { conn, raw } = fakeConn(t)
    const r = await applyCatalog(conn, {
      it: catalog(), itVersion: 'IT t', models: ['SE'], apply: false, reportImpact: true, allowShrink: true,
      unconfirmed: [{ code: '000006', validFrom: '2026-01-01' }],
      placeIndicators: [{ code: '100301', description: 'x', models: ['SE'] }, { code: '100302', description: 'y', models: [] }],
      nbs: [{ code: '115021000', description: 'Desenvolvimento' }, { code: '115080000', description: 'Manutenção' }],
    })
    expect(r.impact).toEqual([
      { schema: 'setes_a', institutionActive: true, kind: 'cClassTrib', code: '000006', services: 3, serviceIds: [3, 4, 5] },
      { schema: 'setes_a', institutionActive: true, kind: 'cIndOp', code: '100302', services: 2, serviceIds: [7, 9] },
      { schema: 'setes_a', institutionActive: true, kind: 'NBS', code: '199999999', services: 1, serviceIds: [11] },
    ])
    expect(r.impactProblems).toEqual([
      expect.stringMatching(/^setes_b: ER_TABLEACCESS_DENIED_ERROR/),
      expect.stringMatching(/^Setes-Ruim: nome de schema fora do padrão/),
    ])
    // a leitura dos clientes acontece DEPOIS do rollback do ensaio (nenhuma trava central segura N schemas)
    const sqls = raw.query.mock.calls.map((c: any[]) => String(c[0]))
    const firstClientRead = sqls.findIndex((x: string) => /FROM `setes_a`/.test(x))
    expect(raw.rollback.mock.invocationCallOrder[0]).toBeLessThan(raw.query.mock.invocationCallOrder[firstClientRead])
  })

  // gate adversarial do delta (MEDIUM 1): dIniVig corrigida para o FUTURO — a linha de hoje perde a
  // aplicabilidade, a futura ganha; com a data da carga, o código conta como PERDIDO hoje (antes: impact [])
  it('(b) com a data da carga, cClassTrib vivo só por linha FUTURA conta como perdido', async () => {
    const t: Record<string, Row[] | ((sql: string, params: unknown[]) => Row[])> = { ...baseTables() }
    ;(t.tb_tax_ibscbs_classification_applicability as Row[]).push({ code: '000006', valid_from: '2026-01-01', model: 'SE', deleted: 'N' })
    t['__alive.tb_tax_ibscbs_classification_applicability'] = [{ code: '000006' }]   // viva por QUALQUER linha (a futura)
    t['__alive.tb_tax_ibscbs_classification_validity'] = []                           // nenhuma VIGENTE na data com aplicabilidade
    t.tb_institution = [{ schema_name: 'setes_a', active: 'S' }]
    t['setes_a.tb_service_ibscbs'] = [{ code: '000006', n: 1, ids: '65' }]
    const { conn } = fakeConn(t)
    const input = { it: catalog(), itVersion: 'IT t', models: ['SE'] as Array<'SE'>, apply: false, reportImpact: true, allowShrink: true,
      unconfirmed: [{ code: '000006', validFrom: '2026-01-01' }] }
    expect((await applyCatalog(conn, input)).impact).toEqual([])   // sem data: qualquer linha viva (comportamento antigo)
    const r = await applyCatalog(fakeConn(t).conn, { ...input, date: '2026-10-10' })
    expect(r.impact).toEqual([{ schema: 'setes_a', institutionActive: true, kind: 'cClassTrib', code: '000006', services: 1, serviceIds: [65] }])
  })

  it('(b) o ATO não lê os clientes (o plano já bateu com o ensaio)', async () => {
    const t: Record<string, Row[] | ((sql: string, params: unknown[]) => Row[])> = { ...baseTables() }
    t.tb_institution = () => { throw new Error('o ato não deveria listar clientes') }
    const { conn } = fakeConn(t)
    const r = await applyCatalog(conn, {
      it: catalog(), itVersion: 'IT t', models: ['SE'], apply: true, reportImpact: true, allowShrink: true,
      unconfirmed: [{ code: '000006', validFrom: '2026-01-01' }],
    })
    expect(r.applied).toBe(true)
    expect(r.impact).toEqual([])
  })
})

// D-IB36 (Rodada 4, Valdo 2026-10-10): linha de vigência que SOME da fonte ganha o fato "ausente desde a
// versão X" (nunca é apagada); volta na fonte = o fato é limpo.
describe('applyCatalog — fato "ausente da fonte" na história (D-IB36)', () => {
  it('linha que não veio nesta versão é marcada com a versão; a que voltou é limpa', async () => {
    const t = baseTables()
    // 000001 tinha uma linha antiga (dIniVig corrigida pelo IT) e 000006 estava marcada como ausente desde a v1.60
    t.tb_tax_ibscbs_classification_validity = [
      ...t.tb_tax_ibscbs_classification_validity.map(r => (r.code === '000006' ? { ...r, absent_since_version: 'IT v1.60' } : r)),
      { code: '000001', valid_from: '2025-06-01', valid_until: null, name: 'antiga', description: 'd', requires_regular_taxation: 'N', source_updated_at: '2025-06-01' },
    ]
    const { conn, writes } = fakeConn(t)
    const r = await applyCatalog(conn, { it: catalog(), itVersion: 'IT v1.70', models: ['SE'], apply: false, unconfirmed: [] })
    expect(r.validity).toMatchObject({ deactivated: 1, revived: 1, deactivatedKeys: ['000001|2025-06-01'] })
    const marked = writes.find(w => /SET absent_since_version = \?/.test(w.sql))
    expect(marked?.params).toEqual(['IT v1.70', '000001', '2025-06-01'])
    expect(writes.some(w => /absent_since_version = NULL/.test(w.sql) && w.params.includes('000006'))).toBe(true)
    // nada é apagado
    expect(writes.some(w => /^DELETE/.test(w.sql) || /tb_tax_ibscbs_classification_validity\s+SET deleted = 'S'/.test(w.sql))).toBe(false)
  })

  it('linha já marcada que segue ausente não é regravada', async () => {
    const t = baseTables()
    t.tb_tax_ibscbs_classification_validity.push(
      { code: '000001', valid_from: '2025-06-01', valid_until: null, name: 'antiga', description: 'd', requires_regular_taxation: 'N', source_updated_at: '2025-06-01', absent_since_version: 'IT v1.60' })
    const { conn, writes } = fakeConn(t)
    const r = await applyCatalog(conn, { it: catalog(), itVersion: 'IT v1.70', models: ['SE'], apply: false, unconfirmed: [] })
    expect(r.validity.deactivated).toBe(0)
    expect(writes.some(w => /SET absent_since_version = \?/.test(w.sql))).toBe(false)
  })

  // D-IB39 (Rodada 5, Valdo 2026-10-10): as marcações entram no limite de encolhimento (bruto)
  it('marcações > 10 % da história: ensaio avisa, ato recusa sem --aceita-encolher e grava com ele', async () => {
    const withOld = () => {
      const t = baseTables()
      t.tb_tax_ibscbs_classification_validity.push(   // 1 de 3 presentes some = 33 %
        { code: '000001', valid_from: '2025-06-01', valid_until: null, name: 'antiga', description: 'd', requires_regular_taxation: 'N', source_updated_at: '2025-06-01' })
      return t
    }
    const ensaio = await applyCatalog(fakeConn(withOld()).conn, { it: catalog(), itVersion: 'IT v1.70', models: ['SE'], apply: false, unconfirmed: [] })
    // 000001 segue na fonte com outra vigência = código que segue na fonte (não é código que sumiu)
    expect(ensaio.shrink).toEqual([{ list: 'validity', aliveBefore: 3, deactivated: 1, codeInSource: 1, codeVanished: 0, endedBeforeDate: 0 }])

    const recusa = fakeConn(withOld())
    await expect(applyCatalog(recusa.conn, { it: catalog(), itVersion: 'IT v1.70', models: ['SE'], apply: true, unconfirmed: [] }))
      .rejects.toThrow(/mais de 10 %[\s\S]*história do cClassTrib \(linhas ausentes da fonte ou com a vigência encerrada antes da data da carga\) \[validity\]: 1 de 3 — 1 de código que segue na fonte \(ex\.: vigência corrigida\), 0 de código que sumiu da fonte/)
    expect(recusa.raw.commit).not.toHaveBeenCalled()

    const aceita = fakeConn(withOld())
    const r = await applyCatalog(aceita.conn, { it: catalog(), itVersion: 'IT v1.70', models: ['SE'], apply: true, unconfirmed: [], allowShrink: true })
    expect(r.applied).toBe(true)
  })

  // gate socrático do delta R5: a base do limite é o que estava PRESENTE na fonte — a linha já marcada
  // ausente (carga anterior) não entra na base nem conta de novo; código que sumiu aparece como tal
  it('linha já marcada ausente: fora da base (aliveBefore 2) e sem nova marcação — shrink vazio', async () => {
    const t = baseTables()
    t.tb_tax_ibscbs_classification_validity.push(
      { code: '000001', valid_from: '2025-06-01', valid_until: null, name: 'antiga', description: 'd', requires_regular_taxation: 'N', source_updated_at: '2025-06-01', absent_since_version: 'IT v1.60' })
    const r = await applyCatalog(fakeConn(t).conn, { it: catalog(), itVersion: 'IT v1.70', models: ['SE'], apply: false, unconfirmed: [] })
    expect(r.validity.aliveBefore).toBe(2)
    expect(r.validity.deactivated).toBe(0)
    expect(r.shrink).toEqual([])
  })

  it('código que sumiu da fonte aparece como "sumiu", não como código que segue na fonte', async () => {
    const t = baseTables()
    t.tb_tax_ibscbs_classification_validity.push(
      { code: '999999', valid_from: '2025-06-01', valid_until: null, name: 'sumiu', description: 'd', requires_regular_taxation: 'N', source_updated_at: '2025-06-01' })
    const r = await applyCatalog(fakeConn(t).conn, { it: catalog(), itVersion: 'IT v1.70', models: ['SE'], apply: false, unconfirmed: [] })
    expect(r.shrink).toEqual([{ list: 'validity', aliveBefore: 3, deactivated: 1, codeInSource: 0, codeVanished: 1, endedBeforeDate: 0 }])
    expect(shrinkLine(r.shrink[0])).toMatch(/0 de código que segue na fonte.*1 de código que sumiu da fonte/)
  })

  // gate adversarial do delta R5 (caso não testado): fronteira exata do limite na história, no ATO
  it('fronteira da história: 18 de 180 (10 % exatos) grava; 19 de 180 recusa sem --aceita-encolher', async () => {
    const build = (dropped: number) => {
      const t = baseTables()
      const extras = Array.from({ length: 178 }, (_, i) => String(900000 + i))
      for (const code of extras) {
        t.tb_tax_ibscbs_classification_validity.push({ code, valid_from: '2026-01-01', valid_until: null, name: 'x', description: 'x', requires_regular_taxation: 'N', source_updated_at: '2026-01-01' })
        t.tb_tax_ibscbs_classification.push({ code, cst: '000' })
      }
      const it = catalog()
      it.classifications.push(...extras.slice(dropped).map(code => ({
        code, cst: '000', name: 'x', description: 'x', validFrom: '2026-01-01', validUntil: null,
        requiresRegularTaxation: false, updatedAt: '2026-01-01', models: [] as any[] })))
      return { conn: fakeConn(t), it }
    }
    const ok = build(18)
    const r = await applyCatalog(ok.conn.conn, { it: ok.it, itVersion: 'IT t', models: ['SE'], apply: true, unconfirmed: [] })
    expect(r.validity).toMatchObject({ aliveBefore: 180, deactivated: 18 })
    expect(r.shrink).toEqual([])
    expect(ok.conn.raw.commit).toHaveBeenCalledTimes(1)

    const no = build(19)
    await expect(applyCatalog(no.conn.conn, { it: no.it, itVersion: 'IT t', models: ['SE'], apply: true, unconfirmed: [] }))
      .rejects.toThrow(/\[validity\]: 19 de 180 — 0 de código que segue na fonte \(ex\.: vigência corrigida\), 19 de código que sumiu da fonte/)
    expect(no.conn.raw.commit).not.toHaveBeenCalled()
  })
})

describe('isCalendarDate — datas da fonte e do --date', () => {
  it('só AAAA-MM-DD que existe no calendário', () => {
    expect(isCalendarDate('2026-10-10')).toBe(true)
    expect(isCalendarDate('2028-02-29')).toBe(true)
    for (const bad of ['2026-02-30', '2026-13-45', '2026-1-1', '2026-01-01 lixo', '']) expect(isCalendarDate(bad)).toBe(false)
  })
})

// D-IB44 (Rodada 6, Valdo 2026-10-11 — gate adversarial do delta R5, LOW 1): encerrar a vigência de linhas
// VIGENTES na data da carga (dFimVig antes dela) conta no limite da história e põe o código no impacto
describe('applyCatalog — D-IB44 vigência encerrada antes da data da carga', () => {
  const endedCatalog = (validUntil: string | null) => {
    const it = catalog()
    it.classifications[1] = { ...it.classifications[1], validUntil }   // 000006 (vigente desde 2026-01-01)
    return it
  }
  const base = { itVersion: 'IT t', models: ['SE'] as Array<'SE'>, unconfirmed: [] }

  it('linha vigente na data com a vigência encerrada antes dela conta no limite (bruto); o ato recusa sem --aceita-encolher', async () => {
    const ensaio = await applyCatalog(fakeConn(baseTables()).conn, { ...base, it: endedCatalog('2026-10-09'), apply: false, date: '2026-10-10' })
    expect(ensaio.validityEnded).toEqual(['000006|2026-01-01'])
    expect(ensaio.shrink).toEqual([{ list: 'validity', aliveBefore: 2, deactivated: 1, codeInSource: 0, codeVanished: 0, endedBeforeDate: 1,
      endedWithSuccessor: 0, endedNoSuccessor: 1, beforeDate: '2026-10-10' }])

    const recusa = fakeConn(baseTables())
    await expect(applyCatalog(recusa.conn, { ...base, it: endedCatalog('2026-10-09'), apply: true, date: '2026-10-10' }))
      .rejects.toThrow(/\[validity\]: 1 de 2 — 0 de código que segue na fonte \(ex\.: vigência corrigida\), 0 de código que sumiu da fonte, 1 com a vigência encerrada antes de 2026-10-10 \(0 de código com outra linha vigente nessa data, 1 de código sem linha vigente nessa data\)/)
    expect(recusa.raw.commit).not.toHaveBeenCalled()

    const aceita = fakeConn(baseTables())
    const r = await applyCatalog(aceita.conn, { ...base, it: endedCatalog('2026-10-09'), apply: true, date: '2026-10-10', allowShrink: true })
    expect(r.applied).toBe(true)
  })

  it('não conta: fim no futuro, fim na própria data, linha que já não valia, linha superada, carga sem data', async () => {
    for (const until of ['2026-12-31', '2026-10-10']) {
      const r = await applyCatalog(fakeConn(baseTables()).conn, { ...base, it: endedCatalog(until), apply: false, date: '2026-10-10' })
      expect(r.validityEnded).toEqual([])
      expect(r.shrink).toEqual([])
    }
    const expired = baseTables()
    expired.tb_tax_ibscbs_classification_validity[1].valid_until = '2026-05-01'   // já não valia na data
    expect((await applyCatalog(fakeConn(expired).conn, { ...base, it: endedCatalog('2026-04-01'), apply: false, date: '2026-10-10' })).validityEnded).toEqual([])
    const superseded = baseTables()
    superseded.tb_tax_ibscbs_classification_validity[1].absent_since_version = 'IT v1.60'   // revive: não é "deixa de valer"
    expect((await applyCatalog(fakeConn(superseded).conn, { ...base, it: endedCatalog('2026-10-09'), apply: false, date: '2026-10-10' })).validityEnded).toEqual([])
    expect((await applyCatalog(fakeConn(baseTables()).conn, { ...base, it: endedCatalog('2026-10-09'), apply: false })).validityEnded).toEqual([])
  })

  it('impacto: o código encerrado sem outra linha vigente na data entra; com outra linha vigente, não', async () => {
    const tables = (aliveToday: Row[]) => {
      const t: Record<string, Row[] | ((sql: string, params: unknown[]) => Row[])> = { ...baseTables() }
      t['__alive.tb_tax_ibscbs_classification_validity'] = aliveToday
      t.tb_institution = [{ schema_name: 'setes_a', active: 'S' }]
      t['setes_a.tb_service_ibscbs'] = [{ code: '000006', n: 2, ids: '40,41' }]
      return t
    }
    const input = { ...base, it: endedCatalog('2026-10-09'), apply: false, date: '2026-10-10', reportImpact: true }
    const r = await applyCatalog(fakeConn(tables([])).conn, input)
    expect(r.impact).toEqual([{ schema: 'setes_a', institutionActive: true, kind: 'cClassTrib', code: '000006', services: 2, serviceIds: [40, 41] }])
    expect((await applyCatalog(fakeConn(tables([{ code: '000006' }])).conn, input)).impact).toEqual([])
  })

  // gate socrático do delta R6 (achado 7): fim já marcado no futuro ou na própria data, encurtado para antes dela, conta
  it('fronteiras: vigência que acabava no futuro ou na própria data, encurtada para antes dela, conta', async () => {
    for (const before of ['2026-12-31', '2026-10-10']) {
      const t = baseTables()
      t.tb_tax_ibscbs_classification_validity[1].valid_until = before
      const r = await applyCatalog(fakeConn(t).conn, { ...base, it: endedCatalog('2026-10-09'), apply: false, date: '2026-10-10' })
      expect(r.validityEnded).toEqual(['000006|2026-01-01'])
    }
  })

  // achado 2: o desdobramento separa substituição (código com outra linha vigente na data) de código que deixa de valer
  it('desdobramento: encerrada com sucessora vigente na data × sem', async () => {
    const t: Record<string, Row[] | ((sql: string, params: unknown[]) => Row[])> = { ...baseTables() }
    t['__alive.tb_tax_ibscbs_classification_validity'] = [{ code: '000006' }]
    const r = await applyCatalog(fakeConn(t).conn, { ...base, it: endedCatalog('2026-10-09'), apply: false, date: '2026-10-10' })
    expect(r.shrink[0]).toMatchObject({ endedBeforeDate: 1, endedWithSuccessor: 1, endedNoSuccessor: 0, beforeDate: '2026-10-10' })
  })

  // achado 1: o impacto lê o estado PÓS-carga (antes do rollback) pela linha VIGENTE na data — o fake confere SQL e parâmetros
  it('impacto: a consulta central roda ANTES do rollback, pela linha vigente na data, com a data nos dois lados', async () => {
    const t: Record<string, Row[] | ((sql: string, params: unknown[]) => Row[])> = { ...baseTables() }
    const seen: Array<{ sql: string; params: unknown[] }> = []
    t['__alive.tb_tax_ibscbs_classification_validity'] = (sql: string, params: unknown[]) => { seen.push({ sql, params }); return [] }
    t.tb_institution = [{ schema_name: 'setes_a', active: 'S' }]
    t['setes_a.tb_service_ibscbs'] = [{ code: '000006', n: 1, ids: '40' }]
    const { conn, raw } = fakeConn(t)
    const r = await applyCatalog(conn, { ...base, it: endedCatalog('2026-10-09'), apply: false, date: '2026-10-10', reportImpact: true })
    expect(r.impact).toHaveLength(1)
    const impactSql = seen.find(x => /JOIN setes_central\.tb_tax_ibscbs_classification_applicability a/.test(x.sql))
    expect(impactSql?.sql).toContain("a.model = 'SE' AND a.deleted = 'N'")
    expect(impactSql?.sql).toContain('v.valid_from <= ? AND (v.valid_until IS NULL OR v.valid_until >= ?)')
    expect(impactSql?.params).toEqual([['000006'], '2026-10-10', '2026-10-10'])
    const sqls = raw.query.mock.calls.map((c: any[]) => String(c[0]).replace(/\s+/g, ' '))
    const at = sqls.findIndex((x: string) => /JOIN setes_central\.tb_tax_ibscbs_classification_applicability a/.test(x))
    expect(raw.query.mock.invocationCallOrder[at]).toBeLessThan(raw.rollback.mock.invocationCallOrder[0])
  })

  // gate adversarial do delta R6 (casos não testados): as DUAS causas somam no limite, sem dupla contagem
  it('limite: marcadas ausentes + encerradas somam (9 + 9 = 18 de 180 grava; 9 + 10 = 19 recusa); mesmo código conta as 2 linhas', async () => {
    const build = (ended: number) => {
      const t = baseTables()
      const extras = Array.from({ length: 178 }, (_, i) => String(900000 + i))
      for (const code of extras) {
        t.tb_tax_ibscbs_classification_validity.push({ code, valid_from: '2026-01-01', valid_until: null, name: 'x', description: 'x', requires_regular_taxation: 'N', source_updated_at: '2026-01-01' })
        t.tb_tax_ibscbs_classification.push({ code, cst: '000' })
      }
      const it = catalog()
      // 9 primeiros somem da fonte (marcados); os 'ended' seguintes vêm com dFimVig antes da data
      it.classifications.push(...extras.slice(9).map((code, i) => ({
        code, cst: '000', name: 'x', description: 'x', validFrom: '2026-01-01', validUntil: i < ended ? '2026-10-09' : null,
        requiresRegularTaxation: false, updatedAt: '2026-01-01', models: [] as any[] })))
      return { c: fakeConn(t), it }
    }
    const ok = build(9)
    const r = await applyCatalog(ok.c.conn, { ...base, it: ok.it, apply: true, date: '2026-10-10' })
    expect([r.validity.deactivated, r.validityEnded.length, r.shrink]).toEqual([9, 9, []])
    expect(ok.c.raw.commit).toHaveBeenCalledTimes(1)
    const no = build(10)
    await expect(applyCatalog(no.c.conn, { ...base, it: no.it, apply: true, date: '2026-10-10' }))
      .rejects.toThrow(/\[validity\]: 19 de 180 — 0 de código que segue na fonte \(ex\.: vigência corrigida\), 9 de código que sumiu da fonte, 10 com a vigência encerrada antes de 2026-10-10/)
    expect(no.c.raw.commit).not.toHaveBeenCalled()

    // mesmo código: a linha antiga some da fonte (marcada) e a outra é encerrada — 2 linhas distintas
    const same = baseTables()
    same.tb_tax_ibscbs_classification_validity.push(
      { code: '000006', valid_from: '2025-01-01', valid_until: null, name: 'antiga', description: 'd', requires_regular_taxation: 'N', source_updated_at: '2025-01-01' })
    const r2 = await applyCatalog(fakeConn(same).conn, { ...base, it: endedCatalog('2026-10-09'), apply: false, date: '2026-10-10' })
    expect(r2.validity.deactivatedKeys).toEqual(['000006|2025-01-01'])
    expect(r2.validityEnded).toEqual(['000006|2026-01-01'])
    expect(r2.shrink[0]).toMatchObject({ aliveBefore: 3, deactivated: 2, codeInSource: 1, endedBeforeDate: 1, endedNoSuccessor: 1 })
  })
})
