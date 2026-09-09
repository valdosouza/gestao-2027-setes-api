/// <reference types="jest" />
// Peça compartilhada do CHEQUE (migration 040 — prompt_cheque_
// rastreabilidade.md D1–D10 + D7a–c): estado derivado, recebimento na
// baixa (R), depósito (B), desconto (D), retorno com reembolso (T) e
// bom (F), uso em pagamento (P), devolução (V) e estorno (X).
import {
  stateFromLastEvent, receiveChecksOnBilling, depositCheck, discountCheck,
  returnCheckWithRefund, returnCheckGood, useCheckInPayment, returnCheck,
  reverseCheckEvent, isCheckEventCurrent,
} from '../shared/check'

jest.mock('../shared/financial-settlement', () => ({
  __esModule: true,
  ...jest.requireActual('../shared/financial-settlement'),
  settleOneTitle: jest.fn(),
  findOpenCashierIdTx: jest.fn(),
  insertStatement: jest.fn(),
  nextSettledCode: jest.fn(),
}))
jest.mock('../shared/financial-settlement/settlement-batch', () => ({
  reverseOnePayment: jest.fn(),
}))

const fs = jest.requireMock('../shared/financial-settlement') as any
const batch = jest.requireMock('../shared/financial-settlement/settlement-batch') as any

function fakeConn() { return { query: jest.fn() } }
beforeEach(() => jest.clearAllMocks())

const HEADER = {
  bankId: 1, agency: '1234', account: '56789', number: '000123',
  issuer: 'JOAO DA SILVA', value: 100, dtCheck: '2026-09-10', kind: 'P' as const,
}

describe('stateFromLastEvent', () => {
  it('mapeia cada kind ao estado derivado; nulo/R/F = custódia', () => {
    expect(stateFromLastEvent(null)).toBe('custody')
    expect(stateFromLastEvent('R')).toBe('custody')
    expect(stateFromLastEvent('F')).toBe('custody')
    expect(stateFromLastEvent('B')).toBe('bank')
    expect(stateFromLastEvent('D')).toBe('factoring')
    expect(stateFromLastEvent('P')).toBe('supplier')
    expect(stateFromLastEvent('T')).toBe('refunded')
    expect(stateFromLastEvent('V')).toBe('collection')
  })
})

describe('receiveChecksOnBilling (R — D1/D8/D9)', () => {
  const input = {
    orderId: 10, parcel: 1, dtPayment: '2026-09-04', entityId: 209, checks: [HEADER],
  }

  it('sem checks -> 400 CHECK_REQUIRED, sem tocar o banco', async () => {
    const conn = fakeConn()
    await expect(receiveChecksOnBilling(conn as any, 'setes_setes', 1, 7, { ...input, checks: [] }))
      .rejects.toMatchObject({ statusCode: 400, code: 'CHECK_REQUIRED' })
    expect(conn.query).not.toHaveBeenCalled()
  })

  it('sem caixa aberto -> 409 NO_OPEN_CASHIER (bloqueia — diferente do contrato)', async () => {
    const conn = fakeConn()
    fs.findOpenCashierIdTx.mockResolvedValueOnce(null)
    await expect(receiveChecksOnBilling(conn as any, 'setes_setes', 1, 7, input))
      .rejects.toMatchObject({ statusCode: 409, code: 'NO_OPEN_CASHIER' })
    expect(fs.settleOneTitle).not.toHaveBeenCalled()
  })

  it('soma dos cheques baixa o título (conta 0) e grava 1 evento R por cheque com o MESMO settled_code', async () => {
    const conn = fakeConn()
    fs.findOpenCashierIdTx.mockResolvedValueOnce(42)
    fs.settleOneTitle.mockResolvedValueOnce({ settledCode: 5, statementId: 9, event: 1, operation: 'C', paymentTypeId: 6 })
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])      // findOrCreateCheck: banco existe
      .mockResolvedValueOnce([[]])              // findOrCreateCheck: não existe
      .mockResolvedValueOnce([[{ nextId: 1 }]]) // MAX+1 id
      .mockResolvedValueOnce([{}])              // INSERT tb_check
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]) // MAX+1 event
      .mockResolvedValueOnce([{}])              // INSERT event R
    const r = await receiveChecksOnBilling(conn as any, 'setes_setes', 1, 7, input)
    expect(r).toEqual({ settledCode: 5, statementId: 9, checks: [{ id: 1, event: 1 }] })
    expect(fs.settleOneTitle).toHaveBeenCalledWith(conn, 'setes_setes', 1, 7,
      expect.objectContaining({ orderId: 10, parcel: 1, paidValue: 100, bankAccountId: 0, cashierId: 42 }))
    const eventParams = conn.query.mock.calls[5][1]
    expect(eventParams).toContain('R')
    expect(eventParams).toContain(5) // settled_code
    expect(eventParams).toContain(1) // payment_event (settle.event)
  })

  it('D9: N cheques cuja soma vira o paidValue da baixa (validação de igualdade é do billing.service)', async () => {
    const conn = fakeConn()
    fs.findOpenCashierIdTx.mockResolvedValueOnce(42)
    fs.settleOneTitle.mockResolvedValueOnce({ settledCode: 5, statementId: 9, event: 1, operation: 'C', paymentTypeId: 6 })
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ nextId: 1 }]]).mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]).mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ 1: 1 }]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ nextId: 2 }]]).mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]).mockResolvedValueOnce([{}])
    const r = await receiveChecksOnBilling(conn as any, 'setes_setes', 1, 7, {
      ...input, checks: [{ ...HEADER, value: 60 }, { ...HEADER, number: '000124', value: 40 }],
    })
    expect(r.checks).toHaveLength(2)
    expect(fs.settleOneTitle.mock.calls[0][4].paidValue).toBe(100)
  })

  it('D5: identidade JÁ existe e está LIVRE (sem eventos) -> reusa o id, sem duplicar', async () => {
    const conn = fakeConn()
    fs.findOpenCashierIdTx.mockResolvedValueOnce(42)
    fs.settleOneTitle.mockResolvedValueOnce({ settledCode: 5, statementId: 9, event: 1, operation: 'C', paymentTypeId: 6 })
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]]) // banco existe
      // já existe, livre, MESMOS dados do papel (D5 não é maquiagem de outro cheque)
      .mockResolvedValueOnce([[{ id: 9, lastKind: null, value: 100, issuer: 'JOAO DA SILVA', dtCheck: '2026-09-10' }]])
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]).mockResolvedValueOnce([{}])
    const r = await receiveChecksOnBilling(conn as any, 'setes_setes', 1, 7, input)
    expect(r.checks[0].id).toBe(9)
    expect(conn.query).toHaveBeenCalledTimes(4) // banco + achou + event + insert (sem MAX+1/insert de cabeçalho)
  })

  it('D5: identidade já ATIVA em outro lugar (ex.: em custódia) -> 409 CHECK_ALREADY_ACTIVE', async () => {
    const conn = fakeConn()
    fs.findOpenCashierIdTx.mockResolvedValueOnce(42)
    fs.settleOneTitle.mockResolvedValueOnce({ settledCode: 5, statementId: 9, event: 1, operation: 'C', paymentTypeId: 6 })
    conn.query.mockResolvedValueOnce([[{ 1: 1 }]]).mockResolvedValueOnce([[{ id: 9, lastKind: 'R' }]])
    await expect(receiveChecksOnBilling(conn as any, 'setes_setes', 1, 7, input))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_ALREADY_ACTIVE' })
  })

  it('D5: R estornado (voided) LIBERA a identidade e ATUALIZA o cabeçalho pro dado corrigido — decisão do Valdo (2026-09-04)', async () => {
    // O recebimento original nunca aconteceu de fato (R estornado); o
    // cabeçalho gravado é o ENGANO que motivou o estorno, então a correção
    // do operador substitui o cabeçalho em vez de comparar contra ele
    // (senão a "correção" nunca passaria pelo CHECK_IDENTITY_MISMATCH).
    const conn = fakeConn()
    fs.findOpenCashierIdTx.mockResolvedValueOnce(42)
    fs.settleOneTitle.mockResolvedValueOnce({ settledCode: 5, statementId: 9, event: 1, operation: 'C', paymentTypeId: 6 })
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]]) // banco existe
      .mockResolvedValueOnce([[{
        id: 9, value: 999, issuer: 'QUALQUER OUTRO', dtCheck: '2020-01-01',
        lastKind: 'X', lastOriginKind: 'R',
      }]])
      .mockResolvedValueOnce([{}]) // UPDATE do cabeçalho
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]).mockResolvedValueOnce([{}])
    const r = await receiveChecksOnBilling(conn as any, 'setes_setes', 1, 7, input)
    expect(r.checks[0].id).toBe(9)
    const updateCall = conn.query.mock.calls[2]
    expect(updateCall[0]).toContain('UPDATE')
    expect(updateCall[1]).toEqual(['JOAO DA SILVA', 100, '2026-09-10', 'P', 9, 1])
  })

  it('bankId do cabeçalho inexistente -> 400 BANK_NOT_FOUND (cabeçalho é imutável — nunca grava id órfão)', async () => {
    const conn = fakeConn()
    fs.findOpenCashierIdTx.mockResolvedValueOnce(42)
    fs.settleOneTitle.mockResolvedValueOnce({ settledCode: 5, statementId: 9, event: 1, operation: 'C', paymentTypeId: 6 })
    conn.query.mockResolvedValueOnce([[]]) // banco não existe
    await expect(receiveChecksOnBilling(conn as any, 'setes_setes', 1, 7, input))
      .rejects.toMatchObject({ statusCode: 400, code: 'BANK_NOT_FOUND' })
  })

  it('corrida na identidade (D5): INSERT colide (ER_DUP_ENTRY) -> 409 CHECK_ALREADY_ACTIVE, nunca 500 cru', async () => {
    // Achado do gate socrático (2026-09-04): o SELECT...FOR UPDATE não trava
    // uma linha que ainda não existe — duas transações concorrentes para o
    // MESMO cheque novo podem colidir na UNIQUE KEY depois do SELECT dizer
    // "não existe" nas duas.
    const conn = fakeConn()
    fs.findOpenCashierIdTx.mockResolvedValueOnce(42)
    fs.settleOneTitle.mockResolvedValueOnce({ settledCode: 5, statementId: 9, event: 1, operation: 'C', paymentTypeId: 6 })
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])      // banco existe
      .mockResolvedValueOnce([[]])              // identidade: SELECT diz que não existe (corrida)
      .mockResolvedValueOnce([[{ nextId: 1 }]]) // MAX+1 id
      .mockRejectedValueOnce(Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' })) // INSERT colide
    await expect(receiveChecksOnBilling(conn as any, 'setes_setes', 1, 7, input))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_ALREADY_ACTIVE' })
  })

  it('D5: reuso com valor/emitente/data DIFERENTES do cabeçalho gravado -> 409 CHECK_IDENTITY_MISMATCH', async () => {
    // Achado do gate adversarial (2026-09-04): cabeçalho é IMUTÁVEL — reusar
    // a identidade livre com dados de OUTRO papel deixaria o cabeçalho
    // mentindo sobre o cheque físico por trás do evento mais recente.
    const conn = fakeConn()
    fs.findOpenCashierIdTx.mockResolvedValueOnce(42)
    fs.settleOneTitle.mockResolvedValueOnce({ settledCode: 5, statementId: 9, event: 1, operation: 'C', paymentTypeId: 6 })
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]]) // banco existe
      // livre, mas com EMITENTE diferente do payload novo (mesma identidade banco/agência/conta/número)
      .mockResolvedValueOnce([[{ id: 9, lastKind: null, value: 100, issuer: 'OUTRO EMITENTE', dtCheck: '2026-09-10' }]])
    await expect(receiveChecksOnBilling(conn as any, 'setes_setes', 1, 7, input))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_IDENTITY_MISMATCH' })
  })
})

describe('depositCheck (B)', () => {
  const CHECK_ROW = [{ id: 1, tb_bank_id: 1, agency: '1234', account: '56789', number: '000123', value: 100 }]
  it('exige bankAccountId > 0', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[]])
    await expect(depositCheck(conn as any, 'setes_setes', 1, 7, { checkId: 1, dtRecord: '2026-09-10', bankAccountId: 0 }))
      .rejects.toMatchObject({ statusCode: 400, code: 'BANK_ACCOUNT_REQUIRED' })
  })
  it('cheque fora de custódia -> 409 CHECK_NOT_IN_CUSTODY', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 1, kind: 'D' }]])
    await expect(depositCheck(conn as any, 'setes_setes', 1, 7, { checkId: 1, dtRecord: '2026-09-10', bankAccountId: 3 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_NOT_IN_CUSTODY' })
  })
  it('sem caixa aberto -> 409; com caixa: 2 linhas (débito conta0 + crédito destino), 1 evento B', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ 1: 1 }]]) // conta existe
    fs.findOpenCashierIdTx.mockResolvedValueOnce(null)
    await expect(depositCheck(conn as any, 'setes_setes', 1, 7, { checkId: 1, dtRecord: '2026-09-10', bankAccountId: 3 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'NO_OPEN_CASHIER' })

    const conn2 = fakeConn()
    conn2.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]).mockResolvedValueOnce([{}])
    fs.findOpenCashierIdTx.mockResolvedValueOnce(42)
    fs.nextSettledCode.mockResolvedValueOnce(7)
    const r = await depositCheck(conn2 as any, 'setes_setes', 1, 7, { checkId: 1, dtRecord: '2026-09-10', bankAccountId: 3 })
    expect(r).toEqual({ event: 1, settledCode: 7 })
    expect(fs.insertStatement).toHaveBeenCalledTimes(2)
    expect(fs.insertStatement.mock.calls[0][3]).toMatchObject({ bankAccountId: 0, cashierId: 42, debit: 100 })
    expect(fs.insertStatement.mock.calls[1][3]).toMatchObject({ bankAccountId: 3, cashierId: null, credit: 100 })
  })
})

describe('effectiveState pós-estorno — X é META-EVENTO, não estado (achado CRITICAL do gate adversarial 2026-09-04)', () => {
  const CHECK_ROW = [{ id: 1, tb_bank_id: 1, agency: '1234', account: '56789', number: '000123', value: 100 }]
  it('R estornado (nada "antes") -> continua bloqueado em deposit/discount/pay, NUNCA volta a custody', async () => {
    // Provado ao vivo pelo gate: sem a correção, um cheque cujo R foi
    // estornado (kind='X', reverteu o próprio R) caía no default de
    // stateFromLastEvent = 'custody' e podia ser depositado/descontado/
    // pago de novo, fabricando movimento financeiro sem lastro.
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 2, kind: 'X', originKind: 'R' }]])
    await expect(depositCheck(conn as any, 'setes_setes', 1, 7, { checkId: 1, dtRecord: '2026-09-10', bankAccountId: 3 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_NOT_IN_CUSTODY' })
  })
  it('B estornado -> volta de fato pra custódia (deposit funciona de novo)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 3, kind: 'X', originKind: 'B' }]])
      .mockResolvedValueOnce([[{ 1: 1 }]]) // conta existe
      .mockResolvedValueOnce([[{ nextEvent: 4 }]]).mockResolvedValueOnce([{}])
    fs.findOpenCashierIdTx.mockResolvedValueOnce(42)
    fs.nextSettledCode.mockResolvedValueOnce(9)
    const r = await depositCheck(conn as any, 'setes_setes', 1, 7, { checkId: 1, dtRecord: '2026-09-10', bankAccountId: 3 })
    expect(r.event).toBe(4)
  })
  it('T estornado -> volta pra FACTORING (não custody) — deposit continua bloqueado', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 4, kind: 'X', originKind: 'T' }]])
    await expect(depositCheck(conn as any, 'setes_setes', 1, 7, { checkId: 1, dtRecord: '2026-09-10', bankAccountId: 3 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_NOT_IN_CUSTODY' })
  })
  it('F estornado -> volta pra FACTORING (não custody) — pay continua bloqueado', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 3, kind: 'X', originKind: 'F' }]])
    await expect(useCheckInPayment(conn as any, 'setes_setes', 1, 7, { checkId: 1, dtRecord: '2026-09-10', orderId: 50, parcel: 1 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_NOT_IN_CUSTODY' })
  })
  it('F estornado -> volta pra FACTORING de verdade — return-good funciona de novo (assertDiscounted usa effectiveState)', async () => {
    // Achado ao vivo durante a verificação desta correção: assertDiscounted
    // ainda comparava lastKind==='D' cru — um F estornado (lastKind='X')
    // ficava PRESO (nem custódia nem redescontável), mesmo exibindo o
    // estado correto 'factoring'. Fail-closed (nunca exploitável), mas
    // ainda assim incorreto.
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 3, kind: 'X', originKind: 'F' }]])
      .mockResolvedValueOnce([[{ entityId: 300 }]]) // lastDiscountEntity (último D vigente)
      .mockResolvedValueOnce([[{ nextEvent: 4 }]]).mockResolvedValueOnce([{}])
    const event = await returnCheckGood(conn as any, 'setes_setes', 1, 7, 1, 'compensou de novo')
    expect(event).toBe(4)
  })
})

describe('discountCheck (D) — 3 linhas, 1 código (fiel ao legado, sem os bugs de nome)', () => {
  const CHECK_ROW = [{ id: 1, tb_bank_id: 1, agency: '1234', account: '56789', number: '000123', value: 100 }]
  it('fora de custódia -> 409', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 1, kind: 'B' }]])
    await expect(discountCheck(conn as any, 'setes_setes', 1, 7,
      { checkId: 1, dtRecord: '2026-09-10', factoringEntityId: 300, bankAccountId: 0, feeValue: 5 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_NOT_IN_CUSTODY' })
  })
  it('destino caixa (0): débito face + crédito face + débito taxa, todas conta 0, mesmo settled_code, evento D com a factoring', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ 1: 1 }]]) // factoring existe (tb_entity)
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]).mockResolvedValueOnce([{}])
    fs.findOpenCashierIdTx.mockResolvedValueOnce(42)
    fs.nextSettledCode.mockResolvedValueOnce(8)
    const r = await discountCheck(conn as any, 'setes_setes', 1, 7,
      { checkId: 1, dtRecord: '2026-09-10', factoringEntityId: 300, bankAccountId: 0, feeValue: 5 })
    expect(r).toEqual({ event: 1, settledCode: 8 })
    expect(fs.insertStatement).toHaveBeenCalledTimes(3)
    expect(fs.insertStatement.mock.calls[0][3]).toMatchObject({ bankAccountId: 0, cashierId: 42, debit: 100 })
    expect(fs.insertStatement.mock.calls[1][3]).toMatchObject({ bankAccountId: 0, cashierId: 42, credit: 100 })
    expect(fs.insertStatement.mock.calls[2][3]).toMatchObject({ bankAccountId: 0, cashierId: 42, debit: 5 })
    const eventParams = conn.query.mock.calls[4][1]
    expect(eventParams).toContain('D')
    expect(eventParams).toContain(300)
  })
  it('feeValue 0 -> só 2 linhas (sem débito de taxa)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ 1: 1 }]]) // factoring existe (tb_entity)
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]).mockResolvedValueOnce([{}])
    fs.findOpenCashierIdTx.mockResolvedValueOnce(42)
    fs.nextSettledCode.mockResolvedValueOnce(8)
    await discountCheck(conn as any, 'setes_setes', 1, 7,
      { checkId: 1, dtRecord: '2026-09-10', factoringEntityId: 300, bankAccountId: 0, feeValue: 0 })
    expect(fs.insertStatement).toHaveBeenCalledTimes(2)
  })
  it('destino conta bancária inexistente -> 400 BANK_NOT_FOUND', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ 1: 1 }]]) // factoring existe (tb_entity)
      .mockResolvedValueOnce([[]]) // conta não existe
    await expect(discountCheck(conn as any, 'setes_setes', 1, 7,
      { checkId: 1, dtRecord: '2026-09-10', factoringEntityId: 300, bankAccountId: 9, feeValue: 0 }))
      .rejects.toMatchObject({ statusCode: 400, code: 'BANK_NOT_FOUND' })
  })
  it('factoringEntityId inexistente -> 400 CHECK_FACTORING_NOT_FOUND', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]) // factoring NÃO existe
    await expect(discountCheck(conn as any, 'setes_setes', 1, 7,
      { checkId: 1, dtRecord: '2026-09-10', factoringEntityId: 999999, bankAccountId: 0, feeValue: 0 }))
      .rejects.toMatchObject({ statusCode: 400, code: 'CHECK_FACTORING_NOT_FOUND' })
  })
})

describe('returnCheckWithRefund (T) e returnCheckGood (F) — D7a/b/c', () => {
  const CHECK_ROW = [{ id: 1, tb_bank_id: 1, agency: '1234', account: '56789', number: '000123', value: 100 }]
  it('não descontado -> 409 CHECK_NOT_DISCOUNTED nos dois', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 1, kind: 'R' }]])
    await expect(returnCheckWithRefund(conn as any, 'setes_setes', 1, 7, { checkId: 1, dtRecord: '2026-09-10', bankAccountId: 0 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_NOT_DISCOUNTED' })
    const conn2 = fakeConn()
    conn2.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 1, kind: 'R' }]])
    await expect(returnCheckGood(conn2 as any, 'setes_setes', 1, 7, 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_NOT_DISCOUNTED' })
  })
  it('T: 1 linha de DÉBITO no destino (reembolso à factoring) + evento T', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 2, kind: 'D' }]])
      .mockResolvedValueOnce([[{ entityId: 300 }]]) // lastDiscountEntity
      .mockResolvedValueOnce([[{ nextEvent: 3 }]]).mockResolvedValueOnce([{}])
    fs.findOpenCashierIdTx.mockResolvedValueOnce(42)
    fs.nextSettledCode.mockResolvedValueOnce(9)
    const r = await returnCheckWithRefund(conn as any, 'setes_setes', 1, 7, { checkId: 1, dtRecord: '2026-09-12', bankAccountId: 0 })
    expect(r).toEqual({ event: 3, settledCode: 9 })
    expect(fs.insertStatement).toHaveBeenCalledTimes(1)
    expect(fs.insertStatement.mock.calls[0][3]).toMatchObject({ bankAccountId: 0, cashierId: 42, debit: 100 })
    const eventParams = conn.query.mock.calls[4][1]
    expect(eventParams).toContain('T')
    expect(eventParams).toContain(300)
  })
  it('F: SEM movimento (insertStatement não chamado); evento F carrega a factoring do D', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 2, kind: 'D' }]])
      .mockResolvedValueOnce([[{ entityId: 300 }]])
      .mockResolvedValueOnce([[{ nextEvent: 3 }]]).mockResolvedValueOnce([{}])
    const event = await returnCheckGood(conn as any, 'setes_setes', 1, 7, 1, 'compensou')
    expect(event).toBe(3)
    expect(fs.insertStatement).not.toHaveBeenCalled()
    const eventParams = conn.query.mock.calls[4][1]
    expect(eventParams).toContain('F')
    expect(eventParams).toContain(300)
  })
})

describe('useCheckInPayment (P — D2)', () => {
  const CHECK_ROW = [{ id: 1, tb_bank_id: 1, agency: '1234', account: '56789', number: '000123', value: 100 }]
  it('sem caixa aberto -> 409', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ balance: 100 }]]) // saldo cobre o valor de face
    fs.findOpenCashierIdTx.mockResolvedValueOnce(null)
    await expect(useCheckInPayment(conn as any, 'setes_setes', 1, 7,
      { checkId: 1, dtRecord: '2026-09-10', orderId: 50, parcel: 1 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'NO_OPEN_CASHIER' })
  })
  it('paga o título PA com o valor de face na conta 0; evento P com o fornecedor derivado', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ balance: 100 }]]) // saldo aberto do título
      .mockResolvedValueOnce([[{ entityId: 400 }]]) // tb_order_financial do PA
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]).mockResolvedValueOnce([{}])
    fs.findOpenCashierIdTx.mockResolvedValueOnce(42)
    fs.settleOneTitle.mockResolvedValueOnce({ settledCode: 11, statementId: 20, event: 1, operation: 'D', paymentTypeId: 6 })
    const r = await useCheckInPayment(conn as any, 'setes_setes', 1, 7,
      { checkId: 1, dtRecord: '2026-09-10', orderId: 50, parcel: 1 })
    expect(r).toEqual({ event: 1, settledCode: 11 })
    expect(fs.settleOneTitle).toHaveBeenCalledWith(conn, 'setes_setes', 1, 7,
      expect.objectContaining({ orderId: 50, parcel: 1, paidValue: 100, bankAccountId: 0, cashierId: 42 }))
    const eventParams = conn.query.mock.calls[5][1]
    expect(eventParams).toContain('P')
    expect(eventParams).toContain(400)
  })
  it('cheque excede o saldo aberto do título -> 422 CHECK_EXCEEDS_BALANCE', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ balance: 30 }]]) // saldo menor que o valor de face (100)
    await expect(useCheckInPayment(conn as any, 'setes_setes', 1, 7,
      { checkId: 1, dtRecord: '2026-09-10', orderId: 50, parcel: 1 }))
      .rejects.toMatchObject({ statusCode: 422, code: 'CHECK_EXCEEDS_BALANCE' })
  })
})

describe('returnCheck (V) — D6/parecer: novo título contra o cliente de origem', () => {
  const CHECK_ROW = [{ id: 1, tb_bank_id: 1, agency: '1234', account: '56789', number: '000123', value: 100 }]
  it('estado não devolvível (ex.: já pago a fornecedor) -> 409 CHECK_NOT_RETURNABLE', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 2, kind: 'P' }]])
    await expect(returnCheck(conn as any, 'setes_setes', 1, 7, { checkId: 1, dtRecord: '2026-09-15' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_NOT_RETURNABLE' })
  })
  it('sem evento R (nunca foi recebido) -> 409 CHECK_NO_ORIGIN', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 1, kind: 'R' }]])
      .mockResolvedValueOnce([[]])
    await expect(returnCheck(conn as any, 'setes_setes', 1, 7, { checkId: 1, dtRecord: '2026-09-15' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_NO_ORIGIN' })
  })
  it('cria tb_order + tb_order_financial (trilha) + tb_financial/bills kind=CH; evento V aponta o título NOVO', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 1, kind: 'R' }]])
      .mockResolvedValueOnce([[{ entityId: 209, paymentEvent: 1, orderId: 10, parcel: 1 }]]) // R event
      .mockResolvedValueOnce([[{ paymentTypeId: 6 }]])   // título de origem
      .mockResolvedValueOnce([[{ nextId: 99 }]])         // MAX+1 tb_order
      .mockResolvedValueOnce([{}])                       // insert tb_order
      .mockResolvedValueOnce([{}])                       // insert tb_order_financial
      .mockResolvedValueOnce([{}])                       // insert tb_financial
      .mockResolvedValueOnce([{}])                       // insert tb_financial_bills
      .mockResolvedValueOnce([[{ nextEvent: 2 }]]).mockResolvedValueOnce([{}]) // evento V
    const r = await returnCheck(conn as any, 'setes_setes', 1, 7, { checkId: 1, dtRecord: '2026-09-15', note: 'sem fundos' })
    expect(r).toEqual({ event: 2, orderId: 99 })
    expect(conn.query.mock.calls[6][0]).toContain('INSERT INTO')
    expect(conn.query.mock.calls[6][0]).toContain('tb_order_financial')
    expect(conn.query.mock.calls[6][1]).toContain(10) // origin order
    expect(conn.query.mock.calls[8][0]).toContain('tb_financial_bills')
    expect(conn.query.mock.calls[8][0]).toContain(`'CH'`)
    expect(conn.query.mock.calls[8][1]).toContain('99/CH-1')
    const eventParams = conn.query.mock.calls[10][1]
    expect(eventParams).toContain('V')
    expect(eventParams).toContain(99) // orderId do evento aponta o NOVO título
  })
  it('devolvido a partir do BANCO (depositado) reverte o depósito antes de criar o título novo', async () => {
    // Achado do gate socrático (2026-09-04): sem isso, o saldo da conta
    // corrente ficava inflado para sempre pelo cheque que nunca compensou.
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 2, kind: 'B' }]])
      .mockResolvedValueOnce([[{ settledCode: 61 }]]) // evento B vigente
      .mockResolvedValueOnce([[ // linhas do depósito (settled_code 61)
        { id: 40, bankAccountId: 0, cashierId: 42, creditValue: 0, debitValue: 100,
          history: 'x', paymentTypeId: null, planCre: 0, planDeb: 0 },
        { id: 41, bankAccountId: 3, cashierId: null, creditValue: 100, debitValue: 0,
          history: 'x', paymentTypeId: null, planCre: 0, planDeb: 0 },
      ]])
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]) // UPDATE status='E' das 2 linhas
      .mockResolvedValueOnce([[{ entityId: 209, paymentEvent: 1, orderId: 10, parcel: 1 }]]) // R event
      .mockResolvedValueOnce([[{ paymentTypeId: 6 }]])   // título de origem
      .mockResolvedValueOnce([[{ nextId: 99 }]])         // MAX+1 tb_order
      .mockResolvedValueOnce([{}])                       // insert tb_order
      .mockResolvedValueOnce([{}])                       // insert tb_order_financial
      .mockResolvedValueOnce([{}])                       // insert tb_financial
      .mockResolvedValueOnce([{}])                       // insert tb_financial_bills
      .mockResolvedValueOnce([[{ nextEvent: 3 }]]).mockResolvedValueOnce([{}]) // evento V
    fs.nextSettledCode.mockResolvedValueOnce(70)
    const r = await returnCheck(conn as any, 'setes_setes', 1, 7, { checkId: 1, dtRecord: '2026-09-15', note: 'sem fundos' })
    expect(r).toEqual({ event: 3, orderId: 99 })
    expect(fs.insertStatement).toHaveBeenCalledTimes(2) // inverteu as 2 linhas do depósito
    expect(fs.insertStatement.mock.calls[0][3]).toMatchObject({ credit: 100, debit: 0 })
    expect(fs.insertStatement.mock.calls[1][3]).toMatchObject({ credit: 0, debit: 100 })
  })
})

describe('reverseCheckEvent (X — D10)', () => {
  const CHECK_ROW = [{ id: 1, tb_bank_id: 1, agency: '1234', account: '56789', number: '000123', value: 100 }]
  it('evento não é o mais recente -> 409 CHECK_ALREADY_MOVED', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 2, kind: 'B' }]])
      .mockResolvedValueOnce([[{ kind: 'R', settledCode: 5, paymentEvent: 1, orderId: 10, parcel: 1 }]]) // evento 1 existe
      .mockResolvedValueOnce([[{ event: 2, kind: 'B', originEvent: null }]]) // Q-P6: B vigente depois do R
    await expect(reverseCheckEvent(conn as any, 'setes_setes', 1, 7, { checkId: 1, event: 1, reason: 'erro' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_ALREADY_MOVED' })
  })
  it('evento inexistente -> 404 CHECK_EVENT_NOT_FOUND (antes do D10)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 2, kind: 'B' }]])
      .mockResolvedValueOnce([[]]) // evento 999 não existe
    await expect(reverseCheckEvent(conn as any, 'setes_setes', 1, 7, { checkId: 1, event: 999, reason: 'erro' }))
      .rejects.toMatchObject({ statusCode: 404, code: 'CHECK_EVENT_NOT_FOUND' })
  })
  it('X não pode ser estornado; V não é suportado', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 1, kind: 'X' }]])
      .mockResolvedValueOnce([[{ kind: 'X' }]]).mockResolvedValueOnce([[]]) // + Q-P6 (sem posterior)
    await expect(reverseCheckEvent(conn as any, 'setes_setes', 1, 7, { checkId: 1, event: 1, reason: 'erro' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_EVENT_NOT_REVERSIBLE' })
    const conn2 = fakeConn()
    conn2.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 1, kind: 'V' }]])
      .mockResolvedValueOnce([[{ kind: 'V' }]]).mockResolvedValueOnce([[]])
    await expect(reverseCheckEvent(conn2 as any, 'setes_setes', 1, 7, { checkId: 1, event: 1, reason: 'erro' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_EVENT_NOT_REVERSIBLE' })
  })
  it('R: reverte a baixa (reverseOnePayment) e propaga X a TODOS os cheques do mesmo settled_code (D9)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 1, kind: 'R' }]])
      .mockResolvedValueOnce([[{ kind: 'R', settledCode: 5, paymentEvent: 1, orderId: 10, parcel: 1 }]])
      .mockResolvedValueOnce([[]]) // Q-P6: nada vigente depois do R
      .mockResolvedValueOnce([[{ checkId: 1, event: 1 }, { checkId: 2, event: 1 }]]) // irmãos
      .mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 1, kind: 'R' }]]) // lockCheck do irmão: ainda em R
      .mockResolvedValueOnce([[]]) // Q-P6 do irmão
      .mockResolvedValueOnce([[{ status: 'N' }]]) // Q-G20: baixa VIVA → reverseOnePayment
      .mockResolvedValueOnce([[{ nextEvent: 2 }]]).mockResolvedValueOnce([{}]) // X do próprio
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]).mockResolvedValueOnce([{}]) // X do irmão
    batch.reverseOnePayment.mockResolvedValueOnce({ reversalEvent: 2, settledCode: 12 })
    const r = await reverseCheckEvent(conn as any, 'setes_setes', 1, 7, { checkId: 1, event: 1, reason: 'erro banco' })
    expect(r.affectedCheckIds.sort()).toEqual([1, 2])
    expect(batch.reverseOnePayment).toHaveBeenCalledWith(conn, 'setes_setes', 1, 7, 10, 1, 1, 'erro banco')
  })
  it('irmão do mesmo settled_code JÁ AVANÇOU de estado (ex.: depositado) -> 409 CHECK_ALREADY_MOVED, bloqueia o grupo inteiro sem mexer no financeiro', async () => {
    // Achado CRITICAL do gate adversarial (2026-09-04): sem esta guarda, o X
    // forçado no irmão que já saiu de R (depositado/pago) mentia o estado
    // dele (voltava a 'custody' com o dinheiro intocado no banco) e reabria
    // o título inteiro mesmo com parte já resolvida.
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 1, kind: 'R' }]])
      .mockResolvedValueOnce([[{ kind: 'R', settledCode: 5, paymentEvent: 1, orderId: 10, parcel: 1 }]])
      .mockResolvedValueOnce([[]]) // Q-P6: o próprio está vigente
      .mockResolvedValueOnce([[{ checkId: 1, event: 1 }, { checkId: 2, event: 1 }]]) // irmãos
      .mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 2, kind: 'B' }]]) // irmão JÁ depositado (evento 2, não 1)
      .mockResolvedValueOnce([[{ event: 2, kind: 'B', originEvent: null }]]) // Q-P6 do irmão: B vigente
    await expect(reverseCheckEvent(conn as any, 'setes_setes', 1, 7, { checkId: 1, event: 1, reason: 'erro banco' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_ALREADY_MOVED' })
    expect(batch.reverseOnePayment).not.toHaveBeenCalled()
  })
  it('B/D/T: inverte as linhas do próprio settled_code (sem título)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 1, kind: 'B' }]])
      .mockResolvedValueOnce([[{ kind: 'B', settledCode: 7 }]])
      .mockResolvedValueOnce([[]]) // Q-P6: nada vigente depois
      .mockResolvedValueOnce([[ // linhas do settled_code 7 (já com os aliases do SELECT)
        { id: 30, bankAccountId: 0, cashierId: 42, creditValue: 0, debitValue: 100,
          history: 'x', paymentTypeId: null, planCre: 0, planDeb: 0 },
        { id: 31, bankAccountId: 3, cashierId: null, creditValue: 100, debitValue: 0,
          history: 'x', paymentTypeId: null, planCre: 0, planDeb: 0 },
      ]])
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]) // UPDATE status='E' das 2 linhas
      .mockResolvedValueOnce([[{ nextEvent: 2 }]]).mockResolvedValueOnce([{}]) // X
    fs.nextSettledCode.mockResolvedValueOnce(13)
    const r = await reverseCheckEvent(conn as any, 'setes_setes', 1, 7, { checkId: 1, event: 1, reason: 'reversão' })
    expect(r).toEqual({ event: 1, affectedCheckIds: [1] })
    expect(fs.insertStatement).toHaveBeenCalledTimes(2)
    expect(fs.insertStatement.mock.calls[0][3]).toMatchObject({ credit: 100, debit: 0 }) // inverteu
    expect(fs.insertStatement.mock.calls[1][3]).toMatchObject({ credit: 0, debit: 100 })
    // Q-CH1: convenção única do extrato — espelho 'R' apontando a origem
    expect(fs.insertStatement.mock.calls[0][3]).toMatchObject({ status: 'R', originId: 30, settledCode: 13 })
    expect(fs.insertStatement.mock.calls[1][3]).toMatchObject({ status: 'R', originId: 31 })
    expect(fs.insertStatement.mock.calls[0][3].history).toMatch(/^Estorno: reversão/)
  })
  it('C2 (gate socrático): alvo que JÁ tem X apontando para ele não é vigente — estornar duas vezes recusa', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 3, kind: 'X' }]])
      .mockResolvedValueOnce([[{ kind: 'B', settledCode: 7 }]]) // alvo: B (evento 2)
      .mockResolvedValueOnce([[{ event: 3, kind: 'X', originEvent: 2 }]]) // X(2) já existe
    await expect(reverseCheckEvent(conn as any, 'setes_setes', 1, 7, { checkId: 1, event: 2, reason: 'de novo' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CHECK_ALREADY_MOVED' })
    expect(fs.insertStatement).not.toHaveBeenCalled()
  })
  it('isCheckEventCurrent: neutralizado = não vigente; posterior neutralizado não conta', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{ event: 2, kind: 'B', originEvent: null }, { event: 3, kind: 'X', originEvent: 2 }]])
    expect(await isCheckEventCurrent(conn as any, 'setes_setes', 1, 1, 1)).toBe(true)  // R com B→X(B) depois
    conn.query.mockResolvedValueOnce([[{ event: 3, kind: 'X', originEvent: 2 }]])
    expect(await isCheckEventCurrent(conn as any, 'setes_setes', 1, 1, 2)).toBe(false) // o próprio B já estornado
    conn.query.mockResolvedValueOnce([[{ event: 2, kind: 'B', originEvent: null }]])
    expect(await isCheckEventCurrent(conn as any, 'setes_setes', 1, 1, 1)).toBe(false) // B vigente depois do R
    // gate adversarial CRITICAL 2: leitura travante (snapshot não decide)
    expect(String(conn.query.mock.calls[0][0])).toMatch(/tb_check_event[\s\S]*FOR UPDATE/)
  })
  it('Q-P6 (cancelamento): R → B → X(B) deixa o cheque em custódia e o R volta a ser estornável', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 3, kind: 'X' }]]) // último = X
      .mockResolvedValueOnce([[{ kind: 'R', settledCode: 5, paymentEvent: 1, orderId: 10, parcel: 1 }]]) // alvo: R (evento 1)
      .mockResolvedValueOnce([[ // posteriores: B neutralizado pelo X → nada VIGENTE
        { event: 2, kind: 'B', originEvent: null }, { event: 3, kind: 'X', originEvent: 2 },
      ]])
      .mockResolvedValueOnce([[{ checkId: 1, event: 1 }]]) // sem irmãos
      .mockResolvedValueOnce([[{ status: 'N' }]]) // Q-G20: baixa viva
      .mockResolvedValueOnce([[{ nextEvent: 4 }]]).mockResolvedValueOnce([{}]) // X do R
    batch.reverseOnePayment.mockResolvedValueOnce({ reversalEvent: 2, settledCode: 12 })
    const r = await reverseCheckEvent(conn as any, 'setes_setes', 1, 7, { checkId: 1, event: 1, reason: 'cancelamento da nota' })
    expect(r).toEqual({ event: 1, affectedCheckIds: [1], core: { reversalEvent: 2, settledCode: 12 } }) // core: D-G7 (Baixas compõe a resposta)
    expect(batch.reverseOnePayment).toHaveBeenCalledTimes(1)
  })
  it('Q-G20: R cuja baixa já morreu por outra porta → X sem tocar a baixa (identidade liberada)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ id: 1, bankId: 1, agency: '1', account: '2', number: 'ORF', value: 70 }]]) // lockCheck
      .mockResolvedValueOnce([[{ event: 3, kind: 'X', originKind: 'B' }]])                                   // último evento: X do depósito
      .mockResolvedValueOnce([[{ kind: 'R', settledCode: 50, paymentEvent: 1, orderId: 99, parcel: 1 }]])   // alvo R
      .mockResolvedValueOnce([[{ event: 2, kind: 'B', originEvent: null }, { event: 3, kind: 'X', originEvent: 2 }]]) // isCheckEventCurrent: B neutralizado → vigente
      .mockResolvedValueOnce([[{ checkId: 1, event: 1 }]])                                                   // irmãos do grupo
      .mockResolvedValueOnce([[{ status: 'E' }]])                                                            // baixa já 'E' (Baixas D-G7a)
      .mockResolvedValueOnce([[{ nextEvent: 4 }]]).mockResolvedValueOnce([{}])                                // X
    const r = await reverseCheckEvent(conn as any, 'setes_setes', 1, 7, { checkId: 1, event: 1, reason: 'cheque errado' })
    expect(r).toEqual({ event: 1, affectedCheckIds: [1] })
    expect(batch.reverseOnePayment).not.toHaveBeenCalled()
    const ins = conn.query.mock.calls.find(c => /INSERT INTO `setes_setes`\.tb_check_event/.test(String(c[0])))!
    expect(ins[1]).toEqual(expect.arrayContaining([1, 'X', null, 1]))
    expect(String(conn.query.mock.calls[5][0])).toMatch(/tb_financial_payment[\s\S]*event = \?[\s\S]*FOR UPDATE/)
  })

  it('F: só grava X, sem tocar o extrato', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([CHECK_ROW]).mockResolvedValueOnce([[{ event: 1, kind: 'F' }]])
      .mockResolvedValueOnce([[{ kind: 'F', settledCode: null }]])
      .mockResolvedValueOnce([[]]) // Q-P6
      .mockResolvedValueOnce([[{ nextEvent: 2 }]]).mockResolvedValueOnce([{}])
    const r = await reverseCheckEvent(conn as any, 'setes_setes', 1, 7, { checkId: 1, event: 1, reason: 'engano' })
    expect(r).toEqual({ event: 1, affectedCheckIds: [1] })
    expect(fs.insertStatement).not.toHaveBeenCalled()
  })
})
