/// <reference types="jest" />
// IB-1 da fase IBS/CBS — gravação do catálogo (applyCatalog) e datas da fonte. Gate socrático
// da IB-1: desativação, revive e ensaio só tinham sido provados AO VIVO; a NBS extinta nunca
// saía; a linha de vigência não confirmada era filtrada pelo CÓDIGO inteiro.
import { applyCatalog, isCalendarDate, ItCatalog } from '@shared/ibscbs-catalog'

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
  ],
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
      .rejects.toThrow(/mais de 10 % das linhas vivas[\s\S]*nbs: 2 de 10/)
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

describe('isCalendarDate — datas da fonte e do --date', () => {
  it('só AAAA-MM-DD que existe no calendário', () => {
    expect(isCalendarDate('2026-10-10')).toBe(true)
    expect(isCalendarDate('2028-02-29')).toBe(true)
    for (const bad of ['2026-02-30', '2026-13-45', '2026-1-1', '2026-01-01 lixo', '']) expect(isCalendarDate(bad)).toBe(false)
  })
})
