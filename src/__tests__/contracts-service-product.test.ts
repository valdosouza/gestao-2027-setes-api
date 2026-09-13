/// <reference types="jest" />
// Q-G27 "ambos" (Valdo 2026-09-10): (b) o contrato valida seus itens pela guarda única do
// serviço (peça @shared/service-product) — produto inexistente/inativo → 400, mercadoria
// → 422, nada gravado; a rotina mensal PULA e REPORTA o que ficou inválido depois.
import pool from '../shared/db/connection'
import { insertContract, updateContract } from '../modules/contracts/contracts.repository'
import { monthlyRun } from '../modules/service-orders/service-orders.repository'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn() },
}))
jest.mock('../shared/invoice', () => ({ __esModule: true, issueInvoice: jest.fn() }))
jest.mock('../shared/order-billing', () => ({ __esModule: true, upsertOrderBilling: jest.fn() }))
jest.mock('../shared/order-installment', () => ({
  __esModule: true, ...jest.requireActual('../shared/order-installment'), assertPaymentRules: jest.fn(),
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
const mockQuery = (pool as any).query as jest.Mock

function mockConn() {
  const conn = {
    beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]),
    commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
  return conn
}
const input = (productId: number) => ({
  customerId: 209, dtStart: '2026-01-01', dtEnd: null, paymentDay: 10, active: 'S', items: [{ productId, value: 100 }],
} as any)

beforeEach(() => jest.clearAllMocks())

describe('contrato × produto (Q-G27 b)', () => {
  it('item com produto INEXISTENTE/inativo → 400 PRODUCT_NOT_FOUND, rollback, nada inserido no item', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])          // papel do cliente
      .mockResolvedValueOnce([[{ nextId: 3 }]])     // MAX+1 do contrato
      .mockResolvedValueOnce([{}])                  // INSERT contrato
      .mockResolvedValueOnce([[]])                  // itens atuais (nenhum — D-G34)
      .mockResolvedValueOnce([[]])                  // produto não existe
    await expect(insertContract(input(999), 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 400, code: 'PRODUCT_NOT_FOUND' })
    expect(conn.rollback).toHaveBeenCalled()
    expect(conn.query.mock.calls.some(c => /tb_contract_item/.test(String(c[0])))).toBe(false)
  })
  it('item com MERCADORIA → 422 SERVICE_ORDER_ITEM_NOT_SERVICE', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[{ nextId: 3 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[]])                  // itens atuais (nenhum — D-G34)
      .mockResolvedValueOnce([[{ kind: 'M', active: 'S' }]])
    await expect(insertContract(input(15), 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 422, code: 'SERVICE_ORDER_ITEM_NOT_SERVICE' })
    expect(conn.rollback).toHaveBeenCalled()
  })
  it('item SERVIÇO ativo → grava e commita', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[{ nextId: 3 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[]])                  // itens atuais (nenhum — D-G34)
      .mockResolvedValueOnce([[{ kind: 'S', active: 'S' }]])
    await expect(insertContract(input(1), 'setes_setes', 1)).resolves.toBe(3)
    expect(conn.commit).toHaveBeenCalled()
    expect(conn.query.mock.calls.some(c => /INSERT INTO \?\? \(tb_contract_id/.test(String(c[0])))).toBe(true)
  })
})

describe('contrato × item herdado (D-G34)', () => {
  it('PUT com item INALTERADO não revalida o produto (encerrar contrato com item que ficou inválido passa)', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])                          // contrato FOR UPDATE
      .mockResolvedValueOnce([[{ 1: 1 }]])                          // papel do cliente
      .mockResolvedValueOnce([{}])                                  // UPDATE contrato
      .mockResolvedValueOnce([[{ productId: 17, value: 100 }]])     // itens atuais: 17 (hoje inválido) herdado
    await expect(updateContract(4, { ...input(17), active: 'N' }, 'setes_setes', 1)).resolves.toBe(true)
    expect(conn.query.mock.calls.some(c => /FROM `setes_setes`\.tb_product/.test(String(c[0])))).toBe(false)
    expect(conn.commit).toHaveBeenCalled()
  })
  it('PUT com valor ALTERADO revalida — produto inválido → 400 e rollback', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ productId: 17, value: 90 }]])      // valor mudou 90 → 100
      .mockResolvedValueOnce([[]])                                  // produto não existe
    await expect(updateContract(4, input(17), 'setes_setes', 1)).rejects.toMatchObject({ statusCode: 400, code: 'PRODUCT_NOT_FOUND' })
    expect(conn.rollback).toHaveBeenCalled()
  })
})

describe('rotina mensal × contenção (adversarial R5, D5)', () => {
  it('lock wait (1205) na transação do cliente PROPAGA (→ 409 na fronteira), nunca 200 com texto do driver', async () => {
    mockQuery.mockResolvedValueOnce([[{ contractId: 4, customerId: 209, dtStart: '2026-01-01', dtEnd: null, productId: 5, value: 100 }]])
    const conn = mockConn()
    conn.query.mockRejectedValueOnce(Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 }))
    await expect(monthlyRun({ year: 2026, month: 9 }, 'setes_setes', 1, 7)).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' })
    expect(conn.rollback).toHaveBeenCalled()
  })
  it('erro de NEGÓCIO de um cliente continua isolado em errors[] (os demais seguem)', async () => {
    mockQuery.mockResolvedValueOnce([[{ contractId: 4, customerId: 209, dtStart: '2026-01-01', dtEnd: null, productId: 5, value: 100 }]])
    const conn = mockConn()
    conn.query.mockRejectedValueOnce(new Error('cliente sem papel'))
    const report = await monthlyRun({ year: 2026, month: 9 }, 'setes_setes', 1, 7)
    expect(report.errors).toEqual([{ customerId: 209, message: 'cliente sem papel' }])
  })
})

describe('rotina mensal × produto inválido (Q-G27 c)', () => {
  it('produto do contrato inativado depois → item PULADO e REPORTADO em errors; nada injetado', async () => {
    mockQuery.mockResolvedValueOnce([[{ contractId: 4, customerId: 209, dtStart: '2026-01-01', dtEnd: null, productId: 17, value: 100 }]])
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([[]])                  // D-A29: competência ainda não faturada (varredura)
      .mockResolvedValueOnce([[{ kind: 'S', active: 'N' }]])   // produto INATIVO
    const report = await monthlyRun({ year: 2026, month: 9 }, 'setes_setes', 1, 7)
    expect(report).toMatchObject({ processed: 1, opened: 0, injected: 0, skipped: 1 })
    // D-G33: nenhum item injetável → a OS NÃO é aberta (nem consultada)
    expect(conn.query.mock.calls.some(c => /tb_service_order/.test(String(c[0])))).toBe(false)
    expect(report.errors).toEqual([expect.objectContaining({ customerId: 209, contractId: 4, productId: 17 })])
    expect(report.errors[0].message).toMatch(/inexistente ou inativo/)
    expect(conn.query.mock.calls.some(c => /INSERT INTO[\s\S]*tb_order_item/.test(String(c[0])))).toBe(false)
    expect(conn.commit).toHaveBeenCalled()
  })
})

describe('rotina mensal × competência (D-A29) e OS só com item (D-G33)', () => {
  it('competência já faturada (tb_contract_item_competence) → skipped, sem abrir OS; chave = contrato × produto × YYYY-MM', async () => {
    mockQuery.mockResolvedValueOnce([[{ contractId: 4, customerId: 209, dtStart: '2026-01-01', dtEnd: null, productId: 5, value: 100 }]])
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([[{ 1: 1 }]])          // já faturada em 2026-08 (varredura, sem lock — D-A35)
    const report = await monthlyRun({ year: 2026, month: 8 }, 'setes_setes', 1, 7)
    expect(report).toMatchObject({ processed: 1, opened: 0, injected: 0, skipped: 1, errors: [] })
    const ledger = conn.query.mock.calls[0]
    expect(String(ledger[0])).toMatch(/tb_contract_item_competence[\s\S]*competence = \?[\s\S]*deleted = 'N'/)
    expect(ledger[1]).toEqual([1, 4, 5, '2026-08'])
    expect(conn.query.mock.calls.some(c => /tb_service_order|tb_order_item/.test(String(c[0])))).toBe(false)
    expect(conn.commit).toHaveBeenCalled()
  })
  it('item injetável → trava a institution, RECONFERE a competência travante, abre a OS, injeta e grava o fato', async () => {
    mockQuery.mockResolvedValueOnce([[{ contractId: 4, customerId: 209, dtStart: '2026-01-01', dtEnd: null, productId: 5, value: 100 }]])
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([[]])                              // varredura: competência livre (sem lock ainda)
      .mockResolvedValueOnce([[{ kind: 'S', active: 'S' }]])    // produto ok
      .mockResolvedValueOnce([{}])                              // D-A35: lock da institution AGORA
      .mockResolvedValueOnce([[]])                              // reconferência TRAVANTE
      .mockResolvedValueOnce([[{ id: 50 }]])                    // OS aberta do cliente
      .mockResolvedValueOnce([[{ nextId: 3 }]])                 // id do item
      .mockResolvedValueOnce([{}])                              // INSERT item
      .mockResolvedValueOnce([{}])                              // INSERT fato da competência
      .mockResolvedValueOnce([[{ productValue: 100, discountValue: 0 }]])   // recalcTotalizer
    const report = await monthlyRun({ year: 2026, month: 9 }, 'setes_setes', 1, 7)
    expect(report).toMatchObject({ processed: 1, opened: 0, injected: 1, skipped: 0 })
    // D-A35: a 1ª consulta é a varredura (sem FOR UPDATE); o lock vem DEPOIS
    expect(String(conn.query.mock.calls[0][0])).not.toMatch(/FOR UPDATE/)
    expect(String(conn.query.mock.calls[2][0])).toMatch(/tb_institution[\s\S]*FOR UPDATE/)
    expect(String(conn.query.mock.calls[3][0])).toMatch(/tb_contract_item_competence[\s\S]*FOR UPDATE/)
    const fact = conn.query.mock.calls.find(c => /INSERT INTO[\s\S]*tb_contract_item_competence/.test(String(c[0])))!
    expect(String(fact[0])).toMatch(/ON DUPLICATE KEY UPDATE[\s\S]*deleted = 'N'/)
    expect(fact[1]).toEqual([1, 4, 5, '2026-09', 50, 3])
  })

  it('D-A35: nada a injetar → NENHUM lock da institution é tomado (a varredura não trava)', async () => {
    mockQuery.mockResolvedValueOnce([[{ contractId: 4, customerId: 209, dtStart: '2026-01-01', dtEnd: null, productId: 5, value: 100 }]])
    const conn = mockConn()
    conn.query.mockResolvedValueOnce([[{ 1: 1 }]])   // competência já faturada
    const report = await monthlyRun({ year: 2026, month: 8 }, 'setes_setes', 1, 7)
    expect(report).toMatchObject({ injected: 0, skipped: 1 })
    expect(conn.query.mock.calls.some(c => /tb_institution[\s\S]*FOR UPDATE/.test(String(c[0])))).toBe(false)
    expect(conn.commit).toHaveBeenCalled()
  })

  it('D-A35: competência ocupada ENTRE a varredura e o lock (outra rotina no meio) → não injeta duas vezes', async () => {
    mockQuery.mockResolvedValueOnce([[{ contractId: 4, customerId: 209, dtStart: '2026-01-01', dtEnd: null, productId: 5, value: 100 }]])
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([[]])                              // varredura: livre
      .mockResolvedValueOnce([[{ kind: 'S', active: 'S' }]])    // produto ok
      .mockResolvedValueOnce([{}])                              // lock
      .mockResolvedValueOnce([[{ 1: 1 }]])                      // reconferência: ocupada agora
    const report = await monthlyRun({ year: 2026, month: 9 }, 'setes_setes', 1, 7)
    expect(report).toMatchObject({ injected: 0, opened: 0, skipped: 1 })
    expect(conn.query.mock.calls.some(c => /INSERT INTO[\s\S]*tb_order_item/.test(String(c[0])))).toBe(false)
    expect(conn.commit).toHaveBeenCalled()
  })
})
