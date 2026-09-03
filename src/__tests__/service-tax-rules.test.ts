/// <reference types="jest" />
// Módulo service-tax-rules + vínculo no services (Onda 2 da Regra de
// Tributação de Serviço — D1 FK literal, D3 tb_service, D4/D12/D13):
// validações na transação (cidade central, item ativo, fato único 409),
// DELETE 409 em uso, e o services gravando tb_service na mesma transação.
import pool from '../shared/db/connection'
import { serviceTaxRuleDto } from '../modules/service-tax-rules/service-tax-rules.dto'
import * as repo from '../modules/service-tax-rules/service-tax-rules.repository'
import * as svcRepo from '../modules/services/services.repository'
import { serviceDto } from '../modules/services/services.dto'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
const mockQuery = (pool as any).query as jest.Mock
const mockGetConnection = (pool as any).getConnection as jest.Mock

function fakeConn() {
  const conn: any = {
    query: jest.fn(), beginTransaction: jest.fn(), commit: jest.fn(),
    rollback: jest.fn(), release: jest.fn(),
  }
  mockGetConnection.mockResolvedValue(conn)
  return conn
}
beforeEach(() => jest.clearAllMocks())

describe('service-tax-rules dto', () => {
  it('cityId/serviceListId/aliq obrigatórios; aliq 0–100; item N.NN; active default S', () => {
    const ok = serviceTaxRuleDto.safeParse({ cityId: 4004, serviceListId: '1.02', aliq: 5 })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.active).toBe('S')
    expect(serviceTaxRuleDto.safeParse({ cityId: 4004, serviceListId: '102', aliq: 5 }).success).toBe(false)
    expect(serviceTaxRuleDto.safeParse({ cityId: 4004, serviceListId: '1.02', aliq: 101 }).success).toBe(false)
    expect(serviceTaxRuleDto.safeParse({ cityId: 4004, serviceListId: '1.02' }).success).toBe(false)
  })
})

describe('service-tax-rules repository', () => {
  const input = { cityId: 4004, serviceListId: '1.02', aliq: 5, municipalCode: '0102' }

  it('insert: cidade central + item ATIVO + fato único, MAX+1 FOR UPDATE, commit', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])       // cidade
      .mockResolvedValueOnce([[{ 1: 1 }]])       // item ativo
      .mockResolvedValueOnce([[]])               // sem duplicata
      .mockResolvedValueOnce([[{ nextId: 3 }]])  // MAX+1
      .mockResolvedValueOnce([{}])               // INSERT
    const id = await repo.insertServiceTaxRule(input, 'setes_setes', 1)
    expect(id).toBe(3)
    expect(conn.query.mock.calls[1][0] as string).toContain("active = 'S'")
    expect(conn.query.mock.calls[3][0] as string).toContain('FOR UPDATE')
    expect(conn.query.mock.calls[4][1]).toEqual([3, 1, 4004, '1.02', 5, '0102', 'S'])
    expect(conn.commit).toHaveBeenCalled()
  })

  it('insert com cidade × item já coberto -> 409 SERVICE_TAX_RULE_DUPLICATE + rollback', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[{ id: 7 }]])      // duplicata viva
    await expect(repo.insertServiceTaxRule(input, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'SERVICE_TAX_RULE_DUPLICATE' })
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('insert com item inativo/inexistente -> 400 fields[serviceListId]', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[]])               // item não achado
    await expect(repo.insertServiceTaxRule(input, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 400, fields: [{ field: 'serviceListId', message: 'Item não encontrado no catálogo' }] })
  })

  it('update: duplicata EXCLUI o próprio id (id <> ?)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])       // SELECT FOR UPDATE (existe)
      .mockResolvedValueOnce([[{ 1: 1 }]])       // cidade
      .mockResolvedValueOnce([[{ 1: 1 }]])       // item
      .mockResolvedValueOnce([[]])               // dup (excluindo id)
      .mockResolvedValueOnce([{}])               // UPDATE
    expect(await repo.updateServiceTaxRule(3, input, 'setes_setes', 1)).toBe(true)
    const dupSql = conn.query.mock.calls[3][0] as string
    expect(dupSql).toContain('AND id <> ?')
    expect(conn.query.mock.calls[3][1]).toEqual([1, 4004, '1.02', 3])
  })

  it('softDelete: regra apontada por serviço vivo -> 409 SERVICE_TAX_RULE_IN_USE', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 6 }]])  // tb_service em uso
    await expect(repo.softDeleteServiceTaxRule(3, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'SERVICE_TAX_RULE_IN_USE' })
  })

  it('softDelete livre quando nenhum serviço aponta', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
    expect(await repo.softDeleteServiceTaxRule(3, 'setes_setes', 1)).toBe(true)
  })

  it('lista paginada: página + COUNT com a MESMA where (cidade/item/descrição)', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 2 }]])
    const r = await repo.listServiceTaxRules(
      { filter: 'curit', page: 1, pageSize: 25, offset: 0 } as any, 'setes_setes', 1)
    expect(r.total).toBe(2)
    expect(mockQuery.mock.calls[0][0] as string).toContain('c.name LIKE ?')
    expect(mockQuery.mock.calls[1][1]).toEqual([1, '%curit%', '%curit%', '%curit%', '%curit%'])
  })
})

describe('services × regra de serviço (D1 FK literal, D3 tb_service)', () => {
  it('dto aceita serviceTaxRuleId nullable', () => {
    expect(serviceDto.safeParse({ description: 'X', categoryId: 1, serviceTaxRuleId: 3 }).success).toBe(true)
    expect(serviceDto.safeParse({ description: 'X', categoryId: 1, serviceTaxRuleId: null }).success).toBe(true)
    expect(serviceDto.safeParse({ description: 'X', categoryId: 1, serviceTaxRuleId: 0 }).success).toBe(false)
  })

  it('insert do serviço valida a regra e grava tb_service na MESMA transação', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])       // categoria
      .mockResolvedValueOnce([[{ 1: 1 }]])       // regra existe (assertRefs)
      .mockResolvedValueOnce([[{ nextId: 9 }]])  // MAX+1
      .mockResolvedValueOnce([{}])               // INSERT tb_product
      .mockResolvedValueOnce([{}])               // syncPrices soft-delete
      .mockResolvedValueOnce([{}])               // upsert tb_service
    const id = await svcRepo.insertService(
      { description: 'Programação', categoryId: 1, serviceTaxRuleId: 3 }, 'setes_setes', 1)
    expect(id).toBe(9)
    const upsert = conn.query.mock.calls.find((c: any[]) =>
      (c[0] as string).includes('tb_service\n') || (c[0] as string).includes('.tb_service ') ||
      (c[0] as string).includes('tb_service_tax_rule_id = VALUES'))
    expect(upsert).toBeDefined()
    expect(upsert[1]).toEqual([9, 1, 3])
    expect(conn.commit).toHaveBeenCalled()
  })

  it('serviceTaxRuleId inexistente -> 400 fields[serviceTaxRuleId] + rollback', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])       // categoria
      .mockResolvedValueOnce([[]])               // regra não achada
    await expect(svcRepo.insertService(
      { description: 'X', categoryId: 1, serviceTaxRuleId: 99 }, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 400, fields: [{ field: 'serviceTaxRuleId', message: 'Regra de tributação de serviço não encontrada' }] })
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('GET do serviço traz serviceTaxRuleId/Label via JOIN tb_service → regra', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 9, identifier: '9', description: 'Programação',
        serviceTaxRuleId: 3, serviceTaxRuleLabel: '1.02 · Curitiba/PR · 5.00%' }]])
      .mockResolvedValueOnce([[]])   // prices
    const s = await svcRepo.getService(9, 'setes_setes', 1)
    expect(s?.serviceTaxRuleId).toBe(3)
    expect(mockQuery.mock.calls[0][0] as string).toContain('tb_service sv')
    expect(mockQuery.mock.calls[0][0] as string).toContain('tb_service_tax_rule r')
  })
})
