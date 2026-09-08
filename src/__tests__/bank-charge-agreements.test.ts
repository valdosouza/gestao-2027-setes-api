/// <reference types="jest" />
// Módulo bank-charge-agreements (Carteiras de Cobrança — tela de cadastro
// que faltava na Onda 2 do boleto). id MAX+1 por institution, conta
// bancária validada na transação, protest='S' exige dayProtest.
import pool from '../shared/db/connection'
import {
  insertChargeAgreement, updateChargeAgreement, softDeleteChargeAgreement,
} from '../modules/bank-charge-agreements/bank-charge-agreements.repository'
import {
  fetchChargeAgreement, removeChargeAgreement,
} from '../modules/bank-charge-agreements/bank-charge-agreements.service'
import { chargeAgreementDto } from '../modules/bank-charge-agreements/bank-charge-agreements.dto'

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
const input = { agreement: 'CONV-1', bankAccountId: 1, active: 'S' as const, accept: 'N' as const, protest: 'N' as const }

beforeEach(() => jest.clearAllMocks())

describe('DTO', () => {
  it('exige agreement e bankAccountId', () => {
    expect(chargeAgreementDto.safeParse({}).success).toBe(false)
    expect(chargeAgreementDto.safeParse({ agreement: 'X', bankAccountId: 1 }).success).toBe(true)
  })
  it('protest=S sem dayProtest -> inválido; com dayProtest -> ok', () => {
    const base = { agreement: 'X', bankAccountId: 1, protest: 'S' as const }
    expect(chargeAgreementDto.safeParse(base).success).toBe(false)
    expect(chargeAgreementDto.safeParse({ ...base, dayProtest: 5 }).success).toBe(true)
    const r = chargeAgreementDto.safeParse({ ...base, dayProtest: 0 })
    expect(r.success).toBe(false)
  })
  it('taxas fora de 0-100 são recusadas', () => {
    expect(chargeAgreementDto.safeParse({ agreement: 'X', bankAccountId: 1, aliqInterest: 101 }).success).toBe(false)
    expect(chargeAgreementDto.safeParse({ agreement: 'X', bankAccountId: 1, aliqInterest: -1 }).success).toBe(false)
  })
})

describe('insertChargeAgreement', () => {
  it('conta inexistente -> 400 BANK_NOT_FOUND', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]])
    await expect(insertChargeAgreement(input, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 400, code: 'BANK_NOT_FOUND' })
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('cria com id MAX+1, kind/ticket 0 (sem catálogo), dayProtest NULL quando protest=N', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])       // conta existe
      .mockResolvedValueOnce([[{ nextId: 3 }]])  // MAX+1
      .mockResolvedValueOnce([{}])               // insert
    const id = await insertChargeAgreement({ ...input, dayProtest: 9 }, 'setes_setes', 1)
    expect(id).toBe(3)
    const params = conn.query.mock.calls[2][1]
    expect(params).toContain(3)
    expect(params[params.length - 6]).toBeNull() // dayProtest ignorado (protest='N')
    expect(conn.commit).toHaveBeenCalled()
  })

  it('protest=S grava dayProtest', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[{ nextId: 4 }]])
      .mockResolvedValueOnce([{}])
    await insertChargeAgreement({ ...input, protest: 'S', dayProtest: 7 }, 'setes_setes', 1)
    const params = conn.query.mock.calls[2][1]
    expect(params).toContain(7)
  })
})

describe('updateChargeAgreement / softDelete / service 404', () => {
  it('update de carteira inexistente -> false', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]])
    expect(await updateChargeAgreement(9, input, 'setes_setes', 1)).toBe(false)
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('update valida a conta nova na transação', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]]) // existe
      .mockResolvedValueOnce([[]])         // conta não existe
    await expect(updateChargeAgreement(9, input, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 400, code: 'BANK_NOT_FOUND' })
  })

  it('softDelete devolve false quando não há carteira viva', async () => {
    mockQuery.mockResolvedValueOnce([{ affectedRows: 0 }])
    expect(await softDeleteChargeAgreement(9, 'setes_setes', 1)).toBe(false)
  })

  it('service: 404 em get/remove inexistentes', async () => {
    mockQuery.mockResolvedValueOnce([[]])
    await expect(fetchChargeAgreement(9, scope)).rejects.toMatchObject({ statusCode: 404 })
    mockQuery.mockResolvedValueOnce([{ affectedRows: 0 }])
    await expect(removeChargeAgreement(9, scope)).rejects.toMatchObject({ statusCode: 404 })
  })
})
