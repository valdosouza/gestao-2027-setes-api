/// <reference types="jest" />
// Módulo service-list (prompt_regra_tributacao_servico.md D10, 2026-09-02):
// Lista de Serviços LC 116 — catálogo central Super; id = o próprio item
// ('1.01', código externo: 409 mesmo excluído, imutável na edição);
// local_incidence P/E; lista paginada com ordem NUMÉRICA do item.
import pool from '../shared/db/connection'
import { serviceListCreateDto, serviceListUpdateDto } from '../modules/service-list/service-list.dto'
import * as repo from '../modules/service-list/service-list.repository'
import { createServiceListItem, editServiceListItem } from '../modules/service-list/service-list.service'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
const mockQuery = (pool as any).query as jest.Mock

beforeEach(() => jest.clearAllMocks())

describe('service-list dto', () => {
  it("id aceita 'N.NN' (1.01, 40.01); rejeita '101', '1.1', 'a.01'", () => {
    const ok = (id: string) =>
      serviceListCreateDto.safeParse({ id, description: 'x' }).success
    expect(ok('1.01')).toBe(true)
    expect(ok('40.01')).toBe(true)
    expect(ok('101')).toBe(false)
    expect(ok('1.1')).toBe(false)
    expect(ok('a.01')).toBe(false)
  })

  it('defaults: localIncidence P, active S; localIncidence só P/E', () => {
    const p = serviceListCreateDto.safeParse({ id: '7.02', description: 'Obras' })
    expect(p.success).toBe(true)
    if (p.success) {
      expect(p.data.localIncidence).toBe('P')
      expect(p.data.active).toBe('S')
    }
    expect(serviceListCreateDto.safeParse(
      { id: '7.02', description: 'Obras', localIncidence: 'X' }).success).toBe(false)
  })

  it('update NÃO aceita id (imutável — strip silencioso)', () => {
    const p = serviceListUpdateDto.safeParse({ id: '9.99', description: 'x' })
    expect(p.success).toBe(true)
    if (p.success) expect(p.data).not.toHaveProperty('id')
  })
})

describe('service-list repository', () => {
  it('lista paginada: página + COUNT com a MESMA where; ORDER numérico pelo item', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ total: 190 }]])
    const r = await repo.listServiceList(
      { filter: 'soft', page: 1, pageSize: 25, offset: 0 } as any)
    expect(r.total).toBe(190)
    const pageSql = mockQuery.mock.calls[0][0] as string
    expect(pageSql).toContain("CAST(SUBSTRING_INDEX(s.id, '.', 1) AS UNSIGNED)")
    expect(pageSql).toContain('LIMIT ? OFFSET ?')
    expect(mockQuery.mock.calls[0][1]).toEqual(['%soft%', '%soft%', '%soft%', 25, 0])
    expect(mockQuery.mock.calls[1][1]).toEqual(['%soft%', '%soft%', '%soft%'])
  })

  it("codeExists NÃO filtra deleted (código externo nunca é reaproveitado)", async () => {
    mockQuery.mockResolvedValueOnce([[{ id: '1.01' }]])
    expect(await repo.serviceListCodeExists('1.01')).toBe(true)
    expect(mockQuery.mock.calls[0][0] as string).not.toContain('deleted')
  })
})

describe('service-list service', () => {
  it('create com item já existente (mesmo excluído) -> 409 com fields[id]', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: '1.01' }]])
    await expect(createServiceListItem('1.01', { description: 'x' }))
      .rejects.toMatchObject({ statusCode: 409, fields: [{ field: 'id', message: 'Item já utilizado' }] })
  })

  it('create novo grava e devolve o id', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])   // não existe
      .mockResolvedValueOnce([{}])   // insert
    expect(await createServiceListItem('1.05', { description: 'Licenciamento', localIncidence: 'P' }))
      .toEqual({ id: '1.05' })
    expect(mockQuery.mock.calls[1][1]).toEqual(['1.05', 'Licenciamento', 'P', 'S'])
  })

  it('edit de item inexistente -> 404', async () => {
    mockQuery.mockResolvedValueOnce([[]])
    await expect(editServiceListItem('9.99', { description: 'x' }))
      .rejects.toMatchObject({ statusCode: 404 })
  })
})
