/// <reference types="jest" />
// Catálogo MVA/FCP por UF×NCM (W2 Onda 2 — prompt_fase_faturamento_financeiro.md
// Rodada 3). Fonte do ICMS-ST/FCP que o motor @shared/tax-rule/calc.ts consome.
import pool from '../shared/db/connection'
import * as repo from '../modules/state-tax-rates/state-tax-rates.repository'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockQuery = (pool as any).query as jest.Mock

beforeEach(() => jest.clearAllMocks())

function mockConn() {
  const conn = {
    beginTransaction: jest.fn(), query: jest.fn(),
    commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
  return conn
}

describe('state-tax-rates repository — MVA', () => {
  it('listMva pagina com a MESMA where no COUNT', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 1, stateId: 41, stateName: 'Paraná', ncm: '84713012', internalAliq: 18, mvaOriginal: 40, mvaAdjusted: null }]])
      .mockResolvedValueOnce([[{ total: 5 }]])

    const result = await repo.listMva('setes_setes', 1, { filter: null, page: 1, pageSize: 25, offset: 0 } as any)
    expect(result.total).toBe(5)
    expect(result.rows[0].mvaOriginal).toBe(40)
  })

  it('insertMva gera id MAX+1 em TRANSAÇÃO com FOR UPDATE', async () => {
    const conn = mockConn()
    conn.query.mockResolvedValueOnce([[{ nextId: 3 }]]).mockResolvedValueOnce([{}])

    const id = await repo.insertMva('setes_setes', 1, {
      stateId: 41, ncm: '84713012', internalAliq: 18, mvaOriginal: 40,
    })

    expect(id).toBe(3)
    expect(conn.query.mock.calls[0][0]).toContain('FOR UPDATE')
    expect(conn.commit).toHaveBeenCalled()
    expect(conn.release).toHaveBeenCalled()
  })

  it('insertMva com duplicidade (Estado+NCM) devolve 409 e faz rollback', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([[{ nextId: 3 }]])
      .mockRejectedValueOnce({ code: 'ER_DUP_ENTRY' })

    await expect(repo.insertMva('setes_setes', 1, {
      stateId: 41, ncm: '84713012', internalAliq: 18, mvaOriginal: 40,
    })).rejects.toMatchObject({ statusCode: 409 })
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('updateMva sem affectedRows -> 404', async () => {
    mockQuery.mockResolvedValueOnce([{ affectedRows: 0 }])
    await expect(repo.updateMva('setes_setes', 1, 99, {
      stateId: 41, ncm: '84713012', internalAliq: 18, mvaOriginal: 40,
    })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('resolveMvaAliq busca por IGUALDADE EXATA de NCM', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 1, stateId: 41, ncm: '84713012', internalAliq: 18, mvaOriginal: 40, mvaAdjusted: null }]])
    const row = await repo.resolveMvaAliq('setes_setes', 1, 41, '84713012')
    expect(row?.ncm).toBe('84713012')
    expect(mockQuery.mock.calls[0][0]).toContain('m.ncm = ?')
    expect(mockQuery.mock.calls[0][1]).toEqual([1, 41, '84713012'])
  })

  it('resolveMvaAliq sem linha -> null', async () => {
    mockQuery.mockResolvedValueOnce([[]])
    expect(await repo.resolveMvaAliq('setes_setes', 1, 41, '99999999')).toBeNull()
  })
})

describe('state-tax-rates repository — FCP', () => {
  it('insertFcp gera id MAX+1 em TRANSAÇÃO com FOR UPDATE', async () => {
    const conn = mockConn()
    conn.query.mockResolvedValueOnce([[{ nextId: 7 }]]).mockResolvedValueOnce([{}])

    const id = await repo.insertFcp('setes_setes', 1, { stateId: 41, ncm: '8471', aliq: 2 })

    expect(id).toBe(7)
    expect(conn.query.mock.calls[0][0]).toContain('FOR UPDATE')
    expect(conn.commit).toHaveBeenCalled()
  })

  it('deleteFcp sem affectedRows -> 404', async () => {
    mockQuery.mockResolvedValueOnce([{ affectedRows: 0 }])
    await expect(repo.deleteFcp('setes_setes', 1, 99)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('resolveFcpAliq busca por PREFIXO (P7.1)', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 2, stateId: 41, ncm: '8471', aliq: 2 }]])
    const row = await repo.resolveFcpAliq('setes_setes', 1, 41, '84713012')
    expect(row?.ncm).toBe('8471')
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('LIKE CONCAT(f.ncm')
    expect(sql).toContain('ORDER BY LENGTH(f.ncm) DESC')
    expect(mockQuery.mock.calls[0][1]).toEqual([1, 41, '84713012'])
  })

  it('resolveFcpAliq sem linha -> null (nenhum prefixo casou)', async () => {
    mockQuery.mockResolvedValueOnce([[]])
    expect(await repo.resolveFcpAliq('setes_setes', 1, 41, '84713012')).toBeNull()
  })
})
