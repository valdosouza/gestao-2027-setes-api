/// <reference types="jest" />
// Peça compartilhada do movimento financeiro (W3.2). bankAccountId=0 =
// sentinela de CAIXA (mesma convenção de settlements.settleBatch); cashierId
// amarra o movimento à sessão (migration 033).
import pool from '../shared/db/connection'
import {
  settleOneTitle, tryAutoSettleCash, writeManualCashierMovement, findOpenCashierId,
} from '../shared/financial-settlement'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockQuery = (pool as any).query as jest.Mock

function fakeConn() {
  return { query: jest.fn() }
}

beforeEach(() => jest.clearAllMocks())

describe('settleOneTitle', () => {
  it('grava payment + statement com bankAccountId=0 (caixa) e cashierId', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ paymentTypeId: 5, operation: 'C' }]]) // título
      .mockResolvedValueOnce([[{ nextCode: 3 }]])                      // settled_code
      .mockResolvedValueOnce([[{ nextEvent: 1 }]])                     // event
      .mockResolvedValueOnce([{}])                                     // insert payment
      .mockResolvedValueOnce([{}])                                     // update bills stage
      .mockResolvedValueOnce([[{ nextId: 9 }]])                        // statement id
      .mockResolvedValueOnce([{}])                                     // insert statement

    const result = await settleOneTitle(conn as any, 'setes_setes', 1, 7, {
      orderId: 10, parcel: 1, paidValue: 50, dtPayment: '2026-08-22',
      bankAccountId: 0, cashierId: 5,
    })

    expect(result).toEqual({ settledCode: 3, statementId: 9, event: 1 })
    const stageCall = conn.query.mock.calls[4]
    expect(stageCall[1]).toContain('C') // stage='C' — caixa (bankAccountId=0)
    const statementCall = conn.query.mock.calls[6]
    expect(statementCall[1]).toContain(5) // cashierId gravado
  })

  it('stage B quando bankAccountId > 0 (conta corrente real)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ paymentTypeId: 5, operation: 'C' }]])
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ nextEvent: 1 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextId: 1 }]])
      .mockResolvedValueOnce([{}])

    await settleOneTitle(conn as any, 'setes_setes', 1, 7, {
      orderId: 10, parcel: 1, paidValue: 50, dtPayment: '2026-08-22',
      bankAccountId: 8, cashierId: null,
    })

    const stageCall = conn.query.mock.calls[4]
    expect(stageCall[1]).toContain('B')
  })

  it('título inexistente -> 404 TITLE_NOT_FOUND', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]])

    await expect(settleOneTitle(conn as any, 'setes_setes', 1, 7, {
      orderId: 10, parcel: 1, paidValue: 50, dtPayment: '2026-08-22', bankAccountId: 0,
    })).rejects.toMatchObject({ statusCode: 404, code: 'TITLE_NOT_FOUND' })
  })

  it('operation D vira débito (compra/PA) no statement', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ paymentTypeId: 5, operation: 'D' }]])
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ nextEvent: 1 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextId: 1 }]])
      .mockResolvedValueOnce([{}])

    await settleOneTitle(conn as any, 'setes_setes', 1, 7, {
      orderId: 10, parcel: 1, paidValue: 50, dtPayment: '2026-08-22', bankAccountId: 0,
    })
    const statementCall = conn.query.mock.calls[6]
    // credit=0, debit=50 -> kind 'D'
    expect(statementCall[1]).toContain('D')
  })
})

describe('findOpenCashierId', () => {
  it('devolve o id da sessão aberta (hr_end IS NULL)', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 5 }]])
    expect(await findOpenCashierId('setes_setes', 1, 7)).toBe(5)
  })
  it('sem sessão aberta -> null', async () => {
    mockQuery.mockResolvedValueOnce([[]])
    expect(await findOpenCashierId('setes_setes', 1, 7)).toBeNull()
  })
})

describe('tryAutoSettleCash', () => {
  const baseInput = {
    orderId: 10, parcel: 1, paidValue: 50, dtPayment: '2026-08-22', paymentTypeId: 5,
  }

  it('forma NÃO é espécie -> NOT_CASH, sem consultar mais nada', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{ kind: 'B' }]]) // boleto

    const result = await tryAutoSettleCash(conn as any, 'setes_setes', 1, 7, baseInput)
    expect(result).toEqual({ settled: false, reason: 'NOT_CASH' })
    expect(conn.query).toHaveBeenCalledTimes(1)
  })

  it('preferência de uso = banco (B) -> BANK_PREFERRED, não tenta caixa', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ kind: 'E' }]])
      .mockResolvedValueOnce([[{ usagePreference: 'B' }]])

    const result = await tryAutoSettleCash(conn as any, 'setes_setes', 1, 7, baseInput)
    expect(result).toEqual({ settled: false, reason: 'BANK_PREFERRED' })
  })

  it('espécie sem caixa aberto -> NO_OPEN_CASHIER, NÃO lança erro (decisão do Valdo)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ kind: 'E' }]])
      .mockResolvedValueOnce([[]]) // sem vínculo -> usagePreference undefined (não é 'B')
    mockQuery.mockResolvedValueOnce([[]]) // findOpenCashierId: nenhuma sessão

    const result = await tryAutoSettleCash(conn as any, 'setes_setes', 1, 7, baseInput)
    expect(result).toEqual({ settled: false, reason: 'NO_OPEN_CASHIER' })
  })

  it('espécie com caixa aberto -> baixa automática (settleOneTitle chamado com bankAccountId=0)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ kind: 'E' }]])
      .mockResolvedValueOnce([[{ usagePreference: 'C' }]])
      // settleOneTitle:
      .mockResolvedValueOnce([[{ paymentTypeId: 5, operation: 'C' }]])
      .mockResolvedValueOnce([[{ nextCode: 1 }]])
      .mockResolvedValueOnce([[{ nextEvent: 1 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextId: 1 }]])
      .mockResolvedValueOnce([{}])
    mockQuery.mockResolvedValueOnce([[{ id: 42 }]]) // findOpenCashierId

    const result = await tryAutoSettleCash(conn as any, 'setes_setes', 1, 7, baseInput)
    expect(result).toMatchObject({ settled: true, cashierId: 42, settledCode: 1, statementId: 1 })
  })
})

describe('writeManualCashierMovement', () => {
  it('retirada simples: só débito no caixa, sem destino', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{ nextId: 1 }]]).mockResolvedValueOnce([{}])

    const result = await writeManualCashierMovement(conn as any, 'setes_setes', 1, 7, {
      cashierId: 5, value: 30, history: 'Sangria', dtRecord: '2026-08-22',
    })
    expect(result).toEqual({ statementId: 1, destinationStatementId: null })
    expect(conn.query).toHaveBeenCalledTimes(2)
  })

  it('transferência: débito no caixa + crédito espelhado na conta destino', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ nextId: 1 }]])   // statementId
      .mockResolvedValueOnce([{}])                // insert débito caixa
      .mockResolvedValueOnce([[{ id: 8 }]])       // conta existe
      .mockResolvedValueOnce([[{ nextId: 2 }]])   // destinationStatementId
      .mockResolvedValueOnce([{}])                // insert crédito conta

    const result = await writeManualCashierMovement(conn as any, 'setes_setes', 1, 7, {
      cashierId: 5, value: 100, history: 'Depósito', dtRecord: '2026-08-22',
      destinationBankAccountId: 8,
    })
    expect(result).toEqual({ statementId: 1, destinationStatementId: 2 })
  })

  it('conta de destino inexistente -> 400 BANK_NOT_FOUND', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ nextId: 1 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[]]) // conta não existe

    await expect(writeManualCashierMovement(conn as any, 'setes_setes', 1, 7, {
      cashierId: 5, value: 100, history: 'Depósito', dtRecord: '2026-08-22',
      destinationBankAccountId: 999,
    })).rejects.toMatchObject({ statusCode: 400, code: 'BANK_NOT_FOUND' })
  })
})
