/// <reference types="jest" />
// Contrato de paginação das listas (prompt_paginacao_telas_pesquisa.md):
// parse+clamp de page/pageSize (D5), default vindo da config page_size do
// módulo (D4) e envelope { ok, data, page, pageSize, total } (D3).
import { Request } from 'express'
import { getConfigContent } from '../shared/interface-config'
import {
  parseListQuery, pagedEnvelope, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_PAGE,
  escapeLike,
} from '../shared/list'

jest.mock('../shared/interface-config', () => ({
  getConfigContent: jest.fn(),
}))

const mockGetConfig = getConfigContent as jest.Mock

function reqWith(query: Record<string, string>, institution = true): Request {
  return {
    query,
    institution: institution
      ? { schemaName: 'setes_acme', institutionId: 7, userId: 42, role: 'user' }
      : undefined,
  } as unknown as Request
}

beforeEach(() => jest.clearAllMocks())

describe('parseListQuery (D3/D5)', () => {
  it('sem params: página 1 com default', async () => {
    const q = await parseListQuery(reqWith({}))
    expect(q).toEqual({ filter: '', page: 1, pageSize: DEFAULT_PAGE_SIZE, offset: 0 })
  })

  it('page/pageSize válidos derivam o offset', async () => {
    const q = await parseListQuery(reqWith({ filter: 'jo', page: '3', pageSize: '50' }))
    expect(q).toEqual({ filter: 'jo', page: 3, pageSize: 50, offset: 100 })
  })

  it('valores inválidos caem no default (clamp, nunca rejeita)', async () => {
    const q = await parseListQuery(reqWith({ page: 'abc', pageSize: '-5' }))
    expect(q.page).toBe(1)
    expect(q.pageSize).toBe(DEFAULT_PAGE_SIZE)
  })

  it('pageSize acima do teto é clampado em MAX_PAGE_SIZE', async () => {
    const q = await parseListQuery(reqWith({ pageSize: '9999' }))
    expect(q.pageSize).toBe(MAX_PAGE_SIZE)
  })

  it('page gigante (1e21) é clampado em MAX_PAGE — offset nunca vira exponencial no SQL (gate 2026-08-04)', async () => {
    const q = await parseListQuery(reqWith({ page: '1e21' }))
    expect(q.page).toBe(MAX_PAGE)
    expect(Number.isSafeInteger(q.offset)).toBe(true)
  })

  it('escapeLike neutraliza %, _ e \\ do filtro do usuário (Q3 do gate banks — decisão Valdo 2026-08-04)', () => {
    expect(escapeLike('50%_a\\b')).toBe('50\\%\\_a\\\\b')
    expect(escapeLike('0_1')).toBe('0\\_1')   // não casa mais 001/011/021
    expect(escapeLike('bra')).toBe('bra')     // filtro comum passa intacto
  })
})

describe('default pela config page_size do módulo (D4)', () => {
  it('sem pageSize na query, usa a config resolvida do módulo', async () => {
    mockGetConfig.mockResolvedValue('100')
    const q = await parseListQuery(reqWith({}), 'customers')
    expect(mockGetConfig).toHaveBeenCalledWith(
      expect.objectContaining({ institutionId: 7, userId: 42 }), 'customers', 'page_size')
    expect(q.pageSize).toBe(100)
  })

  it('pageSize explícito NÃO consulta a config', async () => {
    const q = await parseListQuery(reqWith({ pageSize: '10' }), 'customers')
    expect(mockGetConfig).not.toHaveBeenCalled()
    expect(q.pageSize).toBe(10)
  })

  it('módulo sem catálogo (config null) cai no default', async () => {
    mockGetConfig.mockResolvedValue(null)
    const q = await parseListQuery(reqWith({}), 'countries')
    expect(q.pageSize).toBe(DEFAULT_PAGE_SIZE)
  })

  it('request sem JWT não consulta a config', async () => {
    const q = await parseListQuery(reqWith({}, false), 'customers')
    expect(mockGetConfig).not.toHaveBeenCalled()
    expect(q.pageSize).toBe(DEFAULT_PAGE_SIZE)
  })
})

describe('pagedEnvelope (D3)', () => {
  it('metadados no topo, data segue sendo o array', async () => {
    const query = await parseListQuery(reqWith({ page: '2', pageSize: '10' }))
    const body = pagedEnvelope(query, { rows: [{ id: 1 }], total: 31 })
    expect(body).toEqual({
      ok: true, data: [{ id: 1 }], page: 2, pageSize: 10, total: 31,
    })
  })
})
