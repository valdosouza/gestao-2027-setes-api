/// <reference types="jest" />
// Onda 2 salesman/carrier (prompt_onda2_salesman_carrier.md, D1–D5):
// promoção de colaborador a vendedor (D1 — precedência por construção),
// 409 DUP_ROLE com id, revive de papel soft-deletado, exclusão livre (D4)
// e refino "vendedor ATIVO" no session-context (D3).
import pool from '../shared/db/connection'
import {
  insertSalesman, deleteSalesman,
} from '../modules/salesmen/salesmen.repository'
import { existsSalesman } from '../shared/session-context/session-context.repository'
import * as carriersRepo from '../modules/carriers/carriers.repository'
import { createCarrier, fetchCarrier, CarrierScope } from '../modules/carriers/carriers.service'
import { HttpError } from '../shared/errors/http-error'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
jest.mock('../modules/carriers/carriers.repository')

const mockPoolQuery = (pool as any).query as jest.Mock
const mockGetConn   = (pool as any).getConnection as jest.Mock

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
// Salesmen — promoção de colaborador (D1)
// ---------------------------------------------------------------------

describe('insertSalesman — promoção (D1)', () => {
  it('colaborador vivo sem papel: INSERT do papel e commit', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]]) // colaborador existe
      .mockResolvedValueOnce([[]])         // sem papel salesman
      .mockResolvedValueOnce([{}])         // INSERT

    const result = await insertSalesman(5, { flexValue: 10 }, 'setes_acme', 7)

    expect(result).toEqual({ id: 5 })
    expect(conn.commit).toHaveBeenCalled()
    const insertSql = conn.query.mock.calls[2][0] as string
    expect(insertSql).toContain('INSERT INTO')
  })

  it('colaborador inexistente: 404 — vendedor só nasce de colaborador', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]]) // colaborador NÃO existe

    await expect(insertSalesman(99, {}, 'setes_acme', 7))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('colaborador que já é vendedor: 409 DUP_ROLE com o id no payload', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])            // colaborador existe
      .mockResolvedValueOnce([[{ deleted: 'N' }]])    // papel VIVO

    await expect(insertSalesman(5, {}, 'setes_acme', 7))
      .rejects.toMatchObject({
        statusCode: 409, code: 'DUP_ROLE',
        fields: [{ field: 'id', message: '5' }],
      })
  })

  it('papel soft-deletado REVIVE com os dados novos (padrão da casa)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])            // colaborador existe
      .mockResolvedValueOnce([[{ deleted: 'S' }]])    // papel deletado
      .mockResolvedValueOnce([{}])                    // UPDATE (revive)

    const result = await insertSalesman(5, { active: 'S' }, 'setes_acme', 7)

    expect(result).toEqual({ id: 5 })
    const reviveSql = conn.query.mock.calls[2][0] as string
    expect(reviveSql).toContain(`deleted = 'N'`)
  })
})

describe('deleteSalesman — exclusão livre (D4)', () => {
  it('sempre soft delete (nunca DELETE físico), sem checagem de carteira', async () => {
    mockPoolQuery.mockResolvedValue([{}])

    await deleteSalesman(5, 'setes_acme', 7)

    const sql = mockPoolQuery.mock.calls[0][0] as string
    expect(sql).toContain(`SET deleted = 'S'`)
    expect(sql).not.toContain('DELETE FROM')
  })
})

// ---------------------------------------------------------------------
// Session-context — refino "vendedor ATIVO" (D3)
// ---------------------------------------------------------------------

describe('existsSalesman — refino ATIVO (D3)', () => {
  it('exige deleted=N E active=S na consulta', async () => {
    mockPoolQuery.mockResolvedValue([[]])

    await existsSalesman('setes_acme', 7, 42)

    const sql = mockPoolQuery.mock.calls[0][0] as string
    expect(sql).toContain(`deleted = 'N'`)
    expect(sql).toContain(`active = 'S'`)
  })
})

// ---------------------------------------------------------------------
// Carriers — service (molde collaborators + tributação D2)
// ---------------------------------------------------------------------

const carrierScope: CarrierScope = {
  schemaName: 'setes_acme', institutionId: 7, userId: 42,
}

describe('carriers service', () => {
  it('create repassa o cascade (cadeia + papel + tax na mesma transação)', async () => {
    ;(carriersRepo.insertCarrierCascade as jest.Mock)
      .mockResolvedValue({ id: 30, reused: true })

    const result = await createCarrier({ entity: {} } as any, carrierScope)

    expect(result).toEqual({ id: 30, reused: true })
    expect(carriersRepo.insertCarrierCascade)
      .toHaveBeenCalledWith(expect.anything(), 'setes_acme', 7, 42)
  })

  it('corrida ER_DUP_ENTRY vira 409 CONFLICT_RETRY', async () => {
    ;(carriersRepo.insertCarrierCascade as jest.Mock)
      .mockRejectedValue({ code: 'ER_DUP_ENTRY' })

    await expect(createCarrier({ entity: {} } as any, carrierScope))
      .rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT_RETRY' })
  })

  it('409 DUP_ROLE do repositório passa intacto (fields[0] = id)', async () => {
    ;(carriersRepo.insertCarrierCascade as jest.Mock).mockRejectedValue(
      new HttpError(409, 'dup', [{ field: 'id', message: '30' }], 'DUP_ROLE'))

    await expect(createCarrier({ entity: {} } as any, carrierScope))
      .rejects.toMatchObject({ statusCode: 409, code: 'DUP_ROLE' })
  })

  it('GET :id inexistente → 404', async () => {
    ;(carriersRepo.getCarrier as jest.Mock).mockResolvedValue(null)

    await expect(fetchCarrier(99, carrierScope))
      .rejects.toMatchObject({ statusCode: 404 })
  })
})
