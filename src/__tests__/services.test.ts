/// <reference types="jest" />
// Módulos services + price-lists (prompt_modulo_services.md, D1–D7
// 2026-09-01): serviço = tb_product kind='S' FIXO (D5 — o módulo nunca
// enxerga mercadoria), identifier em branco vira o id (D1), grade de
// preços tb_price na MESMA transação (D4/D7, presença = sincroniza).
import pool from '../shared/db/connection'
import { serviceDto } from '../modules/services/services.dto'
import { priceListDto } from '../modules/price-lists/price-lists.dto'
import * as svcRepo from '../modules/services/services.repository'
import * as plRepo from '../modules/price-lists/price-lists.repository'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockQuery = (pool as any).query as jest.Mock
const mockGetConnection = (pool as any).getConnection as jest.Mock

function fakeConn() {
  const conn: any = {
    query: jest.fn(),
    beginTransaction: jest.fn(),
    commit: jest.fn(),
    rollback: jest.fn(),
    release: jest.fn(),
  }
  mockGetConnection.mockResolvedValue(conn)
  return conn
}

beforeEach(() => jest.clearAllMocks())

// ---------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------

describe('services dto', () => {
  const base = { description: 'Instalação', categoryId: 1 }

  it('mínimo válido; defaults N/N/N/S e prices []', () => {
    const parsed = serviceDto.safeParse(base)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.promotion).toBe('N')
      expect(parsed.data.published).toBe('N')
      expect(parsed.data.active).toBe('S')
      expect(parsed.data.prices).toEqual([])
    }
  })

  it('grade com tabela DUPLICADA é rejeitada', () => {
    expect(serviceDto.safeParse({
      ...base,
      prices: [
        { priceListId: 1, priceTag: 10 },
        { priceListId: 1, priceTag: 20 },
      ],
    }).success).toBe(false)
  })

  it('priceTag null é aceito (remove o preço da tabela)', () => {
    expect(serviceDto.safeParse({
      ...base, prices: [{ priceListId: 1, priceTag: null }],
    }).success).toBe(true)
  })

  it('description vazia / categoryId ausente rejeitados', () => {
    expect(serviceDto.safeParse({ ...base, description: '' }).success).toBe(false)
    expect(serviceDto.safeParse({ description: 'X' }).success).toBe(false)
  })
})

describe('price-lists dto', () => {
  it('description obrigatória (max 45); published default S; validity YYYY-MM-DD', () => {
    const ok = priceListDto.safeParse({ description: 'Varejo' })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.published).toBe('S')
    expect(priceListDto.safeParse({ description: '' }).success).toBe(false)
    expect(priceListDto.safeParse(
      { description: 'X', validity: '31/12/2027' }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------
// services repository — invariante kind='S' e D1
// ---------------------------------------------------------------------

describe('services repository', () => {
  it("lista/COUNT usam a MESMA where com kind='S' e filtro em description+identifier", async () => {
    mockQuery
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ total: 2 }]])
    const result = await svcRepo.listServices(
      { filter: 'inst', page: 1, pageSize: 25, offset: 0 } as any,
      'setes_setes', 1)
    expect(result.total).toBe(2)
    const pageSql = mockQuery.mock.calls[0][0] as string
    const countSql = mockQuery.mock.calls[1][0] as string
    expect(pageSql).toContain("p.kind = 'S'")
    expect(countSql).toContain("p.kind = 'S'")
    expect(pageSql).toContain('p.identifier LIKE ?')
  })

  it("insert grava kind='S' FIXO e identifier em branco vira o id (D1)", async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ id: 1 }]])          // assertRefs categoria
      .mockResolvedValueOnce([[{ nextId: 7 }]])      // MAX+1
      .mockResolvedValueOnce([{}])                   // INSERT tb_product
      .mockResolvedValueOnce([{}])                   // syncPrices UPDATE

    const id = await svcRepo.insertService(
      { identifier: '  ', description: 'Instalação', categoryId: 1 },
      'setes_setes', 1)

    expect(id).toBe(7)
    const insertCall = conn.query.mock.calls.find(
      (c: any[]) => (c[0] as string).includes('INSERT INTO'))
    expect(insertCall[0]).toContain("'S'")
    expect(insertCall[1][1]).toBe('7') // identifier = id
    expect(conn.commit).toHaveBeenCalled()
  })

  it('insert com identifier informado PRESERVA o valor', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ id: 1 }]])
      .mockResolvedValueOnce([[{ nextId: 8 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])

    await svcRepo.insertService(
      { identifier: 'SRV-01', description: 'Consultoria', categoryId: 1 },
      'setes_setes', 1)

    const insertCall = conn.query.mock.calls.find(
      (c: any[]) => (c[0] as string).includes('INSERT INTO'))
    expect(insertCall[1][1]).toBe('SRV-01')
  })

  it('categoria inexistente -> 400 com fields[] e rollback', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]]) // categoria não achada

    await expect(svcRepo.insertService(
      { description: 'X', categoryId: 99 }, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(conn.rollback).toHaveBeenCalled()
  })

  it("update de id que é MERCADORIA devolve false (kind='S' no WHERE — D5)", async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]]) // SELECT ... kind='S' não acha

    const found = await svcRepo.updateService(
      5, { description: 'X', categoryId: 1 }, 'setes_setes', 1)

    expect(found).toBe(false)
    const selectSql = conn.query.mock.calls[0][0] as string
    expect(selectSql).toContain("kind = 'S'")
  })

  it('syncPrices: presença = sincroniza (soft-delete fora da grade; upsert com valor; null remove)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ identifier: 'SRV' }]]) // SELECT FOR UPDATE
      .mockResolvedValueOnce([[{ id: 1 }]])             // categoria
      .mockResolvedValueOnce([[{ id: 2 }]])             // price list 2
      .mockResolvedValueOnce([[{ id: 3 }]])             // price list 3
      .mockResolvedValue([{}])                          // demais

    await svcRepo.updateService(5, {
      description: 'X', categoryId: 1,
      prices: [
        { priceListId: 2, priceTag: 150.5 },
        { priceListId: 3, priceTag: null },   // remove
      ],
    }, 'setes_setes', 1)

    const calls = conn.query.mock.calls.map((c: any[]) => c[0] as string)
    // soft-delete de tudo que NÃO está na grade com valor (NOT IN (2))
    const softDelete = conn.query.mock.calls.find((c: any[]) =>
      (c[0] as string).includes("SET deleted = 'S'") &&
      (c[0] as string).includes('tb_price'))
    expect(softDelete).toBeDefined()
    expect(softDelete[1]).toEqual([1, 5, [2]])
    // upsert SÓ da tabela 2 (a 3 veio null)
    const upserts = calls.filter((sql: string) =>
      sql.includes('INSERT INTO') && sql.includes('tb_price'))
    expect(upserts.length).toBe(1)
  })

  it("softDelete exige kind='S' no WHERE", async () => {
    mockQuery.mockResolvedValueOnce([{ affectedRows: 1 }])
    await svcRepo.softDeleteService(5, 'setes_setes', 1)
    expect(mockQuery.mock.calls[0][0] as string).toContain("kind = 'S'")
  })
})

// ---------------------------------------------------------------------
// price-lists repository
// ---------------------------------------------------------------------

describe('price-lists repository', () => {
  it('lista paginada: página + COUNT com a MESMA where', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ total: 1 }]])
    const result = await plRepo.listPriceLists(
      { filter: 'var', page: 1, pageSize: 25, offset: 0 } as any,
      'setes_setes', 1)
    expect(result.total).toBe(1)
    expect(mockQuery.mock.calls[0][0] as string).toContain('LIMIT ? OFFSET ?')
    expect(mockQuery.mock.calls[1][0] as string).toContain('COUNT(*)')
  })

  it('insert usa MAX+1 FOR UPDATE por institution', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ nextId: 3 }]])
      .mockResolvedValueOnce([{}])
    const id = await plRepo.insertPriceList(
      { description: 'Atacado' }, 'setes_setes', 1)
    expect(id).toBe(3)
    expect(conn.query.mock.calls[0][0] as string).toContain('FOR UPDATE')
  })

  it('update/softDelete devolvem false quando não acham a linha', async () => {
    mockQuery.mockResolvedValueOnce([{ affectedRows: 0 }])
    expect(await plRepo.updatePriceList(
      9, { description: 'X' }, 'setes_setes', 1)).toBe(false)
    mockQuery.mockResolvedValueOnce([{ affectedRows: 0 }])
    expect(await plRepo.softDeletePriceList(9, 'setes_setes', 1)).toBe(false)
  })
})
