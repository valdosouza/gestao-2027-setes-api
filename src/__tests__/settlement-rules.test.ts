/// <reference types="jest" />
// Módulo settlement-rules (migration 038 — D1–D22): 1 contrato por
// forma (PK compartilhada com o vínculo), conta 0 = caixa, conta > 0
// validada, 409 no duplicado, revive do soft-deletado.
import pool from '../shared/db/connection'
import {
  insertSettlementRule, updateSettlementRule, softDeleteSettlementRule,
} from '../modules/settlement-rules/settlement-rules.repository'
import {
  fetchSettlementRule, removeSettlementRule,
} from '../modules/settlement-rules/settlement-rules.service'
import { settlementRuleCreateDto, settlementRuleUpdateDto } from '../modules/settlement-rules/settlement-rules.dto'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockQuery = (pool as any).query as jest.Mock
const mockGetConnection = (pool as any).getConnection as jest.Mock

function fakeConn() {
  const conn = {
    query: jest.fn(), beginTransaction: jest.fn(), commit: jest.fn(),
    rollback: jest.fn(), release: jest.fn(),
  }
  mockGetConnection.mockResolvedValue(conn)
  return conn
}

const scope = { schemaName: 'setes_setes', institutionId: 1 }
const input = { paymentTypeId: 5, bankAccountId: 8, feeRate: 2.5, paymentTerm: 30 }

beforeEach(() => jest.clearAllMocks())

describe('DTOs', () => {
  it('create exige paymentTypeId; defaults 0 (caixa, sem taxa, sem prazo)', () => {
    const r = settlementRuleCreateDto.safeParse({ paymentTypeId: 5 })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toMatchObject({ bankAccountId: 0, feeRate: 0, paymentTerm: 0 })
    expect(settlementRuleCreateDto.safeParse({}).success).toBe(false)
    expect(settlementRuleCreateDto.safeParse({ paymentTypeId: 5, feeRate: 101 }).success).toBe(false)
    expect(settlementRuleCreateDto.safeParse({ paymentTypeId: 5, expirationDate: '03/09/2026' }).success).toBe(false)
  })
  it('gate adversarial: data de calendário inexistente e taxa com 3 casas são recusadas', () => {
    expect(settlementRuleCreateDto.safeParse({ paymentTypeId: 5, expirationDate: '2026-02-30' }).success).toBe(false)
    expect(settlementRuleCreateDto.safeParse({ paymentTypeId: 5, expirationDate: '2026-13-45' }).success).toBe(false)
    expect(settlementRuleCreateDto.safeParse({ paymentTypeId: 5, expirationDate: '2028-02-29' }).success).toBe(true)
    expect(settlementRuleCreateDto.safeParse({ paymentTypeId: 5, feeRate: 2.555 }).success).toBe(false)
    expect(settlementRuleCreateDto.safeParse({ paymentTypeId: 5, feeRate: 2.55 }).success).toBe(true)
  })
  it('update não aceita trocar a forma (é a PK) — campo ignorado', () => {
    const r = settlementRuleUpdateDto.safeParse({ paymentTypeId: 9, bankAccountId: 0 })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data as any).paymentTypeId).toBeUndefined()
  })
})

describe('insertSettlementRule', () => {
  it('forma não vinculada -> 400 PAYMENT_TYPE_NOT_LINKED', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]])
    await expect(insertSettlementRule(input, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 400, code: 'PAYMENT_TYPE_NOT_LINKED' })
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('conta > 0 inexistente -> 400 BANK_NOT_FOUND (regra 2)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]]) // vínculo
      .mockResolvedValueOnce([[]])         // conta
    await expect(insertSettlementRule(input, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 400, code: 'BANK_NOT_FOUND' })
  })

  it('conta 0 = caixa não consulta tb_bank_account (D1)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]]) // vínculo
      .mockResolvedValueOnce([[]])         // contrato inexistente
      .mockResolvedValueOnce([{}])         // insert
    const id = await insertSettlementRule({ ...input, bankAccountId: 0 }, 'setes_setes', 1)
    expect(id).toBe(5)
    expect(conn.query).toHaveBeenCalledTimes(3)
    expect(conn.query.mock.calls[2][0]).toContain('INSERT INTO')
    expect(conn.commit).toHaveBeenCalled()
  })

  it('contrato vivo já existe -> 409 SETTLEMENT_RULE_EXISTS (1 por forma — D2)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[{ 1: 1 }]])          // conta existe
      .mockResolvedValueOnce([[{ deleted: 'N' }]])  // contrato vivo
    await expect(insertSettlementRule(input, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'SETTLEMENT_RULE_EXISTS' })
  })

  it('contrato soft-deletado -> REVIVE com os dados novos (UPDATE, não INSERT)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[{ deleted: 'S' }]])
      .mockResolvedValueOnce([{}])
    await insertSettlementRule(input, 'setes_setes', 1)
    expect(conn.query.mock.calls[3][0]).toContain('UPDATE')
    expect(conn.query.mock.calls[3][0]).toContain("deleted = 'N'")
  })
})

describe('D-G1: contrato no caixa não aceita prazo nem taxa', () => {
  it('create com conta 0 + prazo/taxa -> 422 SETTLEMENT_RULE_CASH_NO_TERMS com fields', async () => {
    const { createSettlementRule, editSettlementRule } =
      await import('../modules/settlement-rules/settlement-rules.service')
    await expect(createSettlementRule(
      { paymentTypeId: 1, bankAccountId: 0, feeRate: 2.5, paymentTerm: 30 }, scope))
      .rejects.toMatchObject({
        statusCode: 422, code: 'SETTLEMENT_RULE_CASH_NO_TERMS',
        fields: [{ field: 'paymentTerm' }, { field: 'feeRate' }],
      })
    await expect(editSettlementRule(1,
      { bankAccountId: 0, feeRate: 0, paymentTerm: 1 }, scope))
      .rejects.toMatchObject({ statusCode: 422, fields: [{ field: 'paymentTerm' }] })
    expect(mockGetConnection).not.toHaveBeenCalled() // recusado ANTES do banco
  })
  it('conta > 0 com prazo/taxa segue normal (validação da conta no repositório)', async () => {
    const { createSettlementRule } =
      await import('../modules/settlement-rules/settlement-rules.service')
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]]) // vínculo não existe -> 400 (prova que passou do gate)
    await expect(createSettlementRule(input, scope))
      .rejects.toMatchObject({ statusCode: 400, code: 'PAYMENT_TYPE_NOT_LINKED' })
  })
})

describe('updateSettlementRule / softDelete / service 404', () => {
  it('update de contrato inexistente -> false (service vira 404)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]])
    expect(await updateSettlementRule(5, input, 'setes_setes', 1)).toBe(false)
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('update valida a conta nova na transação', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]]) // existe
      .mockResolvedValueOnce([[]])         // conta não existe
    await expect(updateSettlementRule(5, input, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 400, code: 'BANK_NOT_FOUND' })
  })

  it('softDelete devolve false quando não há contrato vivo', async () => {
    mockQuery.mockResolvedValueOnce([{ affectedRows: 0 }])
    expect(await softDeleteSettlementRule(5, 'setes_setes', 1)).toBe(false)
  })

  it('service: 404 em get/remove inexistentes', async () => {
    mockQuery.mockResolvedValueOnce([[]])
    await expect(fetchSettlementRule(5, scope)).rejects.toMatchObject({ statusCode: 404 })
    mockQuery.mockResolvedValueOnce([{ affectedRows: 0 }])
    await expect(removeSettlementRule(5, scope)).rejects.toMatchObject({ statusCode: 404 })
  })
})
