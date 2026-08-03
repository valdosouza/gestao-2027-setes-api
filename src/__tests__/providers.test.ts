/// <reference types="jest" />
// Onda 3 provider (prompt_onda3_provider.md, D1–D3): fornecedor = papel
// completo da cadeia fiscal (molde carriers) + aba Tributação na MESMA
// transação (D1); 409 DUP_ROLE com id; revive de papel soft-deletado
// (inclusive linha nascida do sync); active default 'S' no cadastro (D3).
import pool from '../shared/db/connection'
import { saveEntityFiscalChain } from '../shared/entity'
import { upsertEntityTax } from '../shared/entity-tax/entity-tax.repository'
import { insertProviderCascade } from '../modules/providers/providers.repository'
import * as providersRepo from '../modules/providers/providers.repository'
import { createProvider, fetchProvider, ProviderScope } from '../modules/providers/providers.service'
import { HttpError } from '../shared/errors/http-error'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
jest.mock('../shared/entity', () => ({
  saveEntityFiscalChain: jest.fn(),
  getEntityFiscalFull:   jest.fn(),
}))
jest.mock('../shared/entity-tax/entity-tax.repository', () => ({
  upsertEntityTax: jest.fn(),
  getEntityTax:    jest.fn(),
}))

const mockGetConn = (pool as any).getConnection as jest.Mock
const mockChain   = saveEntityFiscalChain as jest.Mock
const mockTax     = upsertEntityTax as jest.Mock

/** Conexão transacional fake: cada teste programa a sequência de resultados. */
function fakeConn() {
  const conn = {
    beginTransaction: jest.fn(),
    query:            jest.fn(),
    commit:           jest.fn(),
    rollback:         jest.fn(),
    release:          jest.fn(),
  }
  mockGetConn.mockResolvedValue(conn)
  return conn
}

beforeEach(() => jest.clearAllMocks())

// ---------------------------------------------------------------------
// Repositório — cascade do POST (cadeia + papel + tax na MESMA transação)
// ---------------------------------------------------------------------

describe('insertProviderCascade (D1/D3)', () => {
  it('entidade nova: INSERT do papel com active default S e tax na transação', async () => {
    const conn = fakeConn()
    mockChain.mockResolvedValue({ id: 40, reused: false })
    conn.query
      .mockResolvedValueOnce([[]]) // sem papel
      .mockResolvedValueOnce([{}]) // INSERT

    const result = await insertProviderCascade(
      { tax: { taxRegime: '1' } } as any, 'setes_acme', 7, 42)

    expect(result).toEqual({ id: 40, reused: false })
    const insertParams = conn.query.mock.calls[1][1] as any[]
    expect(insertParams).toContain('S') // D3 — default do cadastro manual
    expect(mockTax).toHaveBeenCalledWith(conn, 'setes_acme', 7, 40,
      expect.objectContaining({ taxRegime: '1' }))
    expect(conn.commit).toHaveBeenCalled()
  })

  it('tax omitido (undefined) NÃO toca a tributação', async () => {
    const conn = fakeConn()
    mockChain.mockResolvedValue({ id: 40, reused: true })
    conn.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{}])

    await insertProviderCascade({} as any, 'setes_acme', 7, 42)

    expect(mockTax).not.toHaveBeenCalled()
  })

  it('papel VIVO nesta institution: 409 DUP_ROLE com o id no payload', async () => {
    const conn = fakeConn()
    mockChain.mockResolvedValue({ id: 40, reused: true })
    conn.query.mockResolvedValueOnce([[{ deleted: 'N' }]])

    await expect(insertProviderCascade({} as any, 'setes_acme', 7, 42))
      .rejects.toMatchObject({
        statusCode: 409, code: 'DUP_ROLE',
        fields: [{ field: 'id', message: '40' }],
      })
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('papel soft-deletado (ex.: nascido do sync) REVIVE com os dados novos', async () => {
    const conn = fakeConn()
    mockChain.mockResolvedValue({ id: 40, reused: true })
    conn.query
      .mockResolvedValueOnce([[{ deleted: 'S' }]]) // papel deletado
      .mockResolvedValueOnce([{}])                 // UPDATE (revive)

    const result = await insertProviderCascade({ active: 'N' } as any, 'setes_acme', 7, 42)

    expect(result).toEqual({ id: 40, reused: true })
    const reviveSql = conn.query.mock.calls[1][0] as string
    expect(reviveSql).toContain(`deleted = 'N'`)
  })
})

// ---------------------------------------------------------------------
// Service (molde carriers)
// ---------------------------------------------------------------------

const scope: ProviderScope = { schemaName: 'setes_acme', institutionId: 7, userId: 42 }

describe('providers service', () => {
  it('corrida ER_DUP_ENTRY vira 409 CONFLICT_RETRY', async () => {
    const spy = jest.spyOn(providersRepo, 'insertProviderCascade')
      .mockRejectedValue({ code: 'ER_DUP_ENTRY' })

    await expect(createProvider({ entity: {} } as any, scope))
      .rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT_RETRY' })
    spy.mockRestore()
  })

  it('409 DUP_ROLE do repositório passa intacto (fields[0] = id)', async () => {
    const spy = jest.spyOn(providersRepo, 'insertProviderCascade')
      .mockRejectedValue(
        new HttpError(409, 'dup', [{ field: 'id', message: '40' }], 'DUP_ROLE'))

    await expect(createProvider({ entity: {} } as any, scope))
      .rejects.toMatchObject({ statusCode: 409, code: 'DUP_ROLE' })
    spy.mockRestore()
  })

  it('GET :id inexistente → 404', async () => {
    const spy = jest.spyOn(providersRepo, 'getProvider').mockResolvedValue(null)

    await expect(fetchProvider(99, scope))
      .rejects.toMatchObject({ statusCode: 404 })
    spy.mockRestore()
  })
})
