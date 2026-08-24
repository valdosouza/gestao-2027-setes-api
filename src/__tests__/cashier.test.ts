/// <reference types="jest" />
// Caixa (W3.2, parecer setes-conceito 2026-08-22): sessão por dia+usuário
// (terminal web fixo 0 — Q-Caixa 5); saldo DERIVADO; fechamento replica o
// legado (conferência é auditoria, não bloqueia — Q-Caixa 3).
import pool from '../shared/db/connection'
import * as repo from '../modules/cashier/cashier.repository'
import { open, fetchCurrent, fetchBalance, withdraw, close } from '../modules/cashier/cashier.service'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockQuery = (pool as any).query as jest.Mock
const scope = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }

beforeEach(() => jest.clearAllMocks())

function fakeConn() {
  return {
    beginTransaction: jest.fn(), query: jest.fn(),
    commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
}

describe('open', () => {
  it('abre sessão nova quando não há caixa aberto', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[]])              // sem caixa aberto (FOR UPDATE)
      .mockResolvedValueOnce([[{ nextId: 3 }]]) // MAX+1
      .mockResolvedValueOnce([{}])              // insert
    mockQuery.mockResolvedValueOnce([[{         // getCashier (fora da tx)
      id: 3, dtRecord: '2026-08-22', userId: 7, hrBegin: '2026-08-22 09:00:00', hrEnd: null,
    }]])

    const result = await open(scope)
    expect(result.id).toBe(3)
    expect(conn.commit).toHaveBeenCalled()
  })

  it('já existe caixa aberto -> 409 CASHIER_ALREADY_OPEN, rollback', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ id: 1 }]]) // já aberto

    await expect(open(scope)).rejects.toMatchObject({
      statusCode: 409, code: 'CASHIER_ALREADY_OPEN',
    })
    expect(conn.rollback).toHaveBeenCalled()
  })
})

describe('fetchCurrent', () => {
  it('devolve a sessão aberta do usuário', async () => {
    mockQuery.mockResolvedValueOnce([[{
      id: 5, dtRecord: '2026-08-22', userId: 7, hrBegin: '2026-08-22 08:00:00', hrEnd: null,
    }]])
    const result = await fetchCurrent(scope)
    expect(result?.id).toBe(5)
  })
  it('sem sessão aberta -> null', async () => {
    mockQuery.mockResolvedValueOnce([[]])
    expect(await fetchCurrent(scope)).toBeNull()
  })
})

describe('fetchBalance', () => {
  it('caixa inexistente -> 404', async () => {
    mockQuery.mockResolvedValueOnce([[]]) // getCashier
    await expect(fetchBalance(scope, 99)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('saldo derivado = créditos - débitos dos movimentos do caixa', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 5, dtRecord: '2026-08-22', userId: 7, hrBegin: '2026-08-22 08:00:00', hrEnd: null }]]) // getCashier
      .mockResolvedValueOnce([[{ credit: 150, debit: 30 }]]) // getCashierBalance
      .mockResolvedValueOnce([[{ paymentTypeId: 5, paymentTypeDescription: 'Dinheiro', value: 120 }]]) // registered

    const result = await fetchBalance(scope, 5)
    expect(result.balance).toBe(120)
    expect(result.registeredByPaymentType[0].value).toBe(120)
  })
})

describe('withdraw', () => {
  it('caixa fechado -> 409 CASHIER_NOT_OPEN', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ hr_end: '2026-08-22 18:00:00' }]])

    await expect(withdraw(scope, 5, { value: 50, history: 'Sangria' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CASHIER_NOT_OPEN' })
  })

  it('caixa aberto: grava a retirada', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[{ hr_end: null }]]) // caixa aberto
      .mockResolvedValueOnce([[{ nextId: 1 }]])    // statement id
      .mockResolvedValueOnce([{}])                 // insert

    const result = await withdraw(scope, 5, { value: 50, history: 'Sangria' })
    expect(result).toEqual({ statementId: 1, destinationStatementId: null })
    expect(conn.commit).toHaveBeenCalled()
  })

  it('QA adversarial 2026-08-22: filtra pelo DONO da sessão (tb_user_id) — caixa de outro usuário -> 404', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    // caixa 5 existe mas pertence a outro usuário — a query com
    // tb_user_id = scope.userId não acha nenhuma linha (0 rows, não vaza)
    conn.query.mockResolvedValueOnce([[]])

    await expect(withdraw(scope, 5, { value: 50, history: 'Sangria' }))
      .rejects.toMatchObject({ statusCode: 404 })

    const [sql, params] = conn.query.mock.calls[0]
    expect(sql as string).toContain('tb_user_id')
    expect(params).toContain(scope.userId)
  })
})

describe('close', () => {
  it('grava a conferência (registrado x digitado) e fecha, sem transferência', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 5, dtRecord: '2026-08-22', userId: 7, hrBegin: '2026-08-22 08:00:00', hrEnd: null }]]) // requireCashier

    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ hr_end: null }]]) // caixa aberto, FOR UPDATE

    // getRegisteredByPaymentType (fora da tx)
    mockQuery.mockResolvedValueOnce([[{ paymentTypeId: 5, paymentTypeDescription: 'Dinheiro', value: 100 }]])
    conn.query.mockResolvedValueOnce([{}]) // insert tb_cashier_items
    conn.query.mockResolvedValueOnce([{}]) // update hr_end
    conn.query.mockResolvedValueOnce([[{ hrEnd: '2026-08-22 18:00:00' }]]) // select hr_end

    const result = await close(scope, 5, {
      items: [{ paymentTypeId: 5, countedValue: 95 }],
    })

    expect(result.items[0]).toMatchObject({
      paymentTypeId: 5, registeredValue: 100, countedValue: 95, difference: -5,
    })
    expect(result.transfer).toBeNull()
    expect(conn.commit).toHaveBeenCalled()
  })

  it('caixa já fechado -> 409 CASHIER_ALREADY_CLOSED', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 5, dtRecord: '2026-08-22', userId: 7, hrBegin: '2026-08-22 08:00:00', hrEnd: '2026-08-22 18:00:00' }]])
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ hr_end: '2026-08-22 18:00:00' }]])

    await expect(close(scope, 5, { items: [] }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CASHIER_ALREADY_CLOSED' })
  })

  it('QA adversarial 2026-08-22: fechar caixa de OUTRO usuário -> 404 (não vaza)', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 5, dtRecord: '2026-08-22', userId: 7, hrBegin: '2026-08-22 08:00:00', hrEnd: null }]]) // requireCashier (read, sem dono)
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[]]) // 0 linhas — caixa não é do userId do scope

    await expect(close(scope, 5, { items: [] }))
      .rejects.toMatchObject({ statusCode: 404 })

    const [sql, params] = conn.query.mock.calls[0]
    expect(sql as string).toContain('tb_user_id')
    expect(params).toContain(scope.userId)
  })
})
