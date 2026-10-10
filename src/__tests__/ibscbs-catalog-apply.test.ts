/// <reference types="jest" />
// IB-1 da fase IBS/CBS — gravação do catálogo (applyCatalog) e datas da fonte. Gate socrático
// da IB-1: desativação, revive e ensaio só tinham sido provados AO VIVO; a NBS extinta nunca
// saía; a linha de vigência não confirmada era filtrada pelo CÓDIGO inteiro.
import { applyCatalog, isCalendarDate, ItCatalog } from '@shared/ibscbs-catalog'

type Row = Record<string, any>

/** Conexão falsa: responde os SELECTs pelo nome da tabela e grava o resto como chamada. */
function fakeConn(tables: Record<string, Row[]>) {
  const writes: Array<{ sql: string; params: unknown[] }> = []
  const conn = {
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim()
      if (/^SET SESSION/.test(s)) return [[]]
      if (/^SELECT/.test(s)) {
        const t = /FROM setes_central\.`?(\w+)`?/.exec(s)?.[1] ?? ''
        return [tables[t] ?? []]
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

describe('isCalendarDate — datas da fonte e do --date', () => {
  it('só AAAA-MM-DD que existe no calendário', () => {
    expect(isCalendarDate('2026-10-10')).toBe(true)
    expect(isCalendarDate('2028-02-29')).toBe(true)
    for (const bad of ['2026-02-30', '2026-13-45', '2026-1-1', '2026-01-01 lixo', '']) expect(isCalendarDate(bad)).toBe(false)
  })
})
