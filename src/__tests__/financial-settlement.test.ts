/// <reference types="jest" />
// Peça compartilhada do movimento financeiro (W3.2 + contrato financeiro —
// migration 038, D1–D22). bankAccountId=0 = sentinela de CAIXA (mesma
// convenção de settlements.settleBatch); cashierId amarra o movimento à
// sessão (migration 033).
import pool from '../shared/db/connection'
import {
  settleOneTitle, tryAutoSettleByContract, getFinancialContract, addDaysIso,
  writeManualCashierMovement, findOpenCashierId, nextSettledCode,
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

    expect(result).toEqual({
      settledCode: 3, statementId: 9, event: 1, operation: 'C', paymentTypeId: 5,
    })
    const stageCall = conn.query.mock.calls[4]
    expect(stageCall[1]).toContain('C') // stage='C' — caixa (bankAccountId=0)
    const statementCall = conn.query.mock.calls[6]
    expect(statementCall[1]).toContain(5) // cashierId gravado
    // sem dtRecord: dt_record = dt_original = dtPayment ("cai na hora")
    expect(statementCall[1].filter((v: any) => v === '2026-08-22')).toHaveLength(2)
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

  it('dtRecord/planos/histórico opcionais chegam ao statement (D5/D6/D12)', async () => {
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
      orderId: 10, parcel: 1, paidValue: 50, dtPayment: '2026-09-03',
      dtRecord: '2026-10-03', bankAccountId: 8, history: 'Cartão X',
      financialPlanCreId: 11, financialPlanDebId: 22,
    })
    const params = conn.query.mock.calls[6][1]
    expect(params).toContain('2026-10-03') // dt_record (disponível)
    expect(params).toContain('2026-09-03') // dt_original (fato gerador)
    expect(params).toContain('Cartão X')
    expect(params).toContain(11)
    expect(params).toContain(22)
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

    const result = await settleOneTitle(conn as any, 'setes_setes', 1, 7, {
      orderId: 10, parcel: 1, paidValue: 50, dtPayment: '2026-08-22', bankAccountId: 0,
    })
    expect(result.operation).toBe('D')
    const statementCall = conn.query.mock.calls[6]
    expect(statementCall[1]).toContain('D') // credit=0, debit=50 -> kind 'D'
  })
})

describe('nextSettledCode', () => {
  // Achado do smoke do cheque (2026-09-04): movimentos SEM título (desconto/
  // retorno de cheque na factoring) nunca gravam em tb_financial_payment —
  // um contador que lesse essa tabela mintava o MESMO código para dois
  // movimentos-sem-título seguidos, colidindo o agrupamento de reversão.
  // Fonte ÚNICA agora é tb_financial_statement (superset confirmado: todo
  // settleOneTitle/settleBatchTx grava as duas).
  it('lê o MAX+1 de tb_financial_statement, nunca de tb_financial_payment', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{ nextCode: 53 }]])

    const code = await nextSettledCode(conn as any, 'setes_setes', 1)

    expect(code).toBe(53)
    const [sql, params] = conn.query.mock.calls[0]
    expect(sql).toContain('tb_financial_statement')
    expect(sql).not.toContain('tb_financial_payment')
    expect(params).toEqual([1])
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

describe('addDaysIso', () => {
  it('soma dias sem depender do fuso', () => {
    expect(addDaysIso('2026-09-03', 0)).toBe('2026-09-03')
    expect(addDaysIso('2026-09-03', 30)).toBe('2026-10-03')
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('getFinancialContract', () => {
  it('sem contrato vivo -> null', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]])
    expect(await getFinancialContract(conn as any, 'setes_setes', 1, 5)).toBeNull()
  })
  it('normaliza números e planos do vínculo', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{
      paymentTypeId: 5, paymentTypeDescription: 'CARTÃO', paymentTypeKind: 'C',
      bankAccountId: 8, feeRate: '2.50', paymentTerm: 30, expirationDate: null,
      financialPlanCreId: 11, financialPlanDebId: null,
    }]])
    expect(await getFinancialContract(conn as any, 'setes_setes', 1, 5)).toEqual({
      paymentTypeId: 5, paymentTypeDescription: 'CARTÃO', paymentTypeKind: 'C',
      bankAccountId: 8, feeRate: 2.5, paymentTerm: 30, expirationDate: null,
      financialPlanCreId: 11, financialPlanDebId: 0,
    })
  })
})

describe('tryAutoSettleByContract', () => {
  const baseInput = {
    orderId: 10, parcel: 1, paidValue: 100, dtPayment: '2026-09-03', paymentTypeId: 5,
  }
  const contractRow = (over: Record<string, any> = {}) => [{
    paymentTypeId: 5, paymentTypeDescription: 'CARTÃO', paymentTypeKind: 'C',
    bankAccountId: 8, feeRate: 2.5, paymentTerm: 30, expirationDate: null,
    financialPlanCreId: 11, financialPlanDebId: 22, ...over,
  }]
  // settleOneTitle: título, code, event, insert payment, stage, st id, insert st
  const settleMocks = (conn: any, operation = 'C') => conn.query
    .mockResolvedValueOnce([[{ paymentTypeId: 5, operation }]])
    .mockResolvedValueOnce([[{ nextCode: 7 }]])
    .mockResolvedValueOnce([[{ nextEvent: 1 }]])
    .mockResolvedValueOnce([{}])
    .mockResolvedValueOnce([{}])
    .mockResolvedValueOnce([[{ nextId: 30 }]])
    .mockResolvedValueOnce([{}])

  it('cheque (Q) e boleto (B) são fixos por kind -> KIND_FIXED sem ler contrato (D18)', async () => {
    for (const kind of ['Q', 'B']) {
      const conn = fakeConn()
      conn.query.mockResolvedValueOnce([[{ kind }]])
      const result = await tryAutoSettleByContract(conn as any, 'setes_setes', 1, 7, baseInput)
      expect(result).toEqual({ settled: false, reason: 'KIND_FIXED' })
      expect(conn.query).toHaveBeenCalledTimes(1)
    }
  })

  it('forma sem contrato -> NO_CONTRACT (regra 4: título nasce aberto) — vale para espécie (D22)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ kind: 'E' }]])
      .mockResolvedValueOnce([[]]) // sem contrato
    const result = await tryAutoSettleByContract(conn as any, 'setes_setes', 1, 7, baseInput)
    expect(result).toEqual({ settled: false, reason: 'NO_CONTRACT' })
    expect(conn.query).toHaveBeenCalledTimes(2)
  })

  it('contrato vencido -> CONTRACT_EXPIRED, não baixa (D11)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ kind: 'C' }]])
      .mockResolvedValueOnce([contractRow({ expirationDate: '2026-09-02' })])
    const result = await tryAutoSettleByContract(conn as any, 'setes_setes', 1, 7, baseInput)
    expect(result).toEqual({ settled: false, reason: 'CONTRACT_EXPIRED' })
  })

  it('contrato no caixa (conta 0) sem caixa aberto -> NO_OPEN_CASHIER (regra 1) — sessão lida NA transação com FOR UPDATE', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ kind: 'E' }]])
      .mockResolvedValueOnce([contractRow({ bankAccountId: 0, feeRate: 0, paymentTerm: 0 })])
      .mockResolvedValueOnce([[]]) // findOpenCashierIdTx (conn): nenhuma sessão
    const result = await tryAutoSettleByContract(conn as any, 'setes_setes', 1, 7, baseInput)
    expect(result).toEqual({ settled: false, reason: 'NO_OPEN_CASHIER' })
    expect(conn.query.mock.calls[2][0]).toContain('FOR UPDATE')
    expect(mockQuery).not.toHaveBeenCalled() // nunca pelo pool (fora da transação)
  })

  it('conta do contrato excluída -> BANK_ACCOUNT_NOT_FOUND (regra 2)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ kind: 'X' }]])
      .mockResolvedValueOnce([contractRow({ bankAccountId: 9 })])
      .mockResolvedValueOnce([[]]) // conta não existe
    const result = await tryAutoSettleByContract(conn as any, 'setes_setes', 1, 7, baseInput)
    expect(result).toEqual({ settled: false, reason: 'BANK_ACCOUNT_NOT_FOUND' })
  })

  it('espécie com contrato conta 0 e caixa aberto -> baixa na hora no caixa, sem taxa (D4/D22)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ kind: 'E' }]])
      .mockResolvedValueOnce([contractRow({ bankAccountId: 0, feeRate: 0, paymentTerm: 0 })])
      .mockResolvedValueOnce([[{ id: 42 }]]) // findOpenCashierIdTx (conn)
    settleMocks(conn)

    const result = await tryAutoSettleByContract(conn as any, 'setes_setes', 1, 7, baseInput)
    expect(result).toMatchObject({
      settled: true, settledCode: 7, statementId: 30, feeStatementId: null,
      cashierId: 42, dtRecord: '2026-09-03',
    })
    // 3 + 7 chamadas: nenhuma linha de taxa
    expect(conn.query).toHaveBeenCalledTimes(10)
    const stCall = conn.query.mock.calls[9][1]
    expect(stCall).toContain(0)   // bankAccountId 0 = caixa
    expect(stCall).toContain(42)  // cashierId
  })

  it('cartão com taxa e prazo -> crédito futuro (faturamento + prazo × parcela) + DÉBITO da taxa no mesmo código (D3/D5/D12)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ kind: 'C' }]])
      .mockResolvedValueOnce([contractRow()])
      .mockResolvedValueOnce([[{ 1: 1 }]]) // conta existe
    settleMocks(conn)
    conn.query
      .mockResolvedValueOnce([[{ nextId: 31 }]]) // statement da taxa
      .mockResolvedValueOnce([{}])

    const result = await tryAutoSettleByContract(conn as any, 'setes_setes', 1, 7, {
      ...baseInput, parcel: 2,
    })
    expect(result).toMatchObject({
      settled: true, settledCode: 7, statementId: 30, feeStatementId: 31,
      cashierId: null, dtRecord: '2026-11-02', // 2026-09-03 + 30 × 2
    })
    // crédito da parcela: dt_record futuro, dt_original = faturamento, planos do vínculo
    const credit = conn.query.mock.calls[9][1]
    expect(credit).toContain('2026-11-02')
    expect(credit).toContain('2026-09-03')
    expect(credit).toContain(11)
    expect(credit).toContain(22)
    // débito da taxa: 2.5% de 100 = 2.50, mesmo settled_code 7, mesma conta 8
    const fee = conn.query.mock.calls[11][1]
    expect(fee).toContain(2.5)
    expect(fee).toContain(7)
    expect(fee).toContain(8)
    expect(fee.some((v: any) => typeof v === 'string' && v.startsWith('Taxa 2.5%'))).toBe(true)
  })

  it('título a PAGAR (operation D) com contrato: baixa sem linha de taxa', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ kind: 'C' }]])
      .mockResolvedValueOnce([contractRow()])
      .mockResolvedValueOnce([[{ 1: 1 }]])
    settleMocks(conn, 'D')
    const result = await tryAutoSettleByContract(conn as any, 'setes_setes', 1, 7, baseInput)
    expect(result).toMatchObject({ settled: true, feeStatementId: null })
    expect(conn.query).toHaveBeenCalledTimes(10)
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
