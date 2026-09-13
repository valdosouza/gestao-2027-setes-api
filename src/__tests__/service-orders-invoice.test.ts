/// <reference types="jest" />
// Q-G3 (Valdo 2026-09-09): a nota da ORDEM DE SERVIÇO nasce pela peça
// @shared/invoice (evento E, numeração D4 por modelo/série 'SE'/'1', cabeçalho
// revivido) e o financeiro revive a parcela soft-deletada pelo cancelamento.
import pool from '../shared/db/connection'
import { generateInvoice } from '../modules/service-orders/service-orders.repository'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
jest.mock('../shared/invoice', () => ({
  __esModule: true,
  issueInvoice: jest.fn(async () => ({ invoiceNumber: '12', event: 1 })),
}))
// automatismos do título (A1/D5 da fase Primeiro Cliente) têm teste próprio em
// title-automation.test.ts — aqui só não podem tocar o mock do pool
jest.mock('../shared/title-automation', () => ({
  __esModule: true,
  applyTitleAutomation: jest.fn().mockResolvedValue({ autoSettled: 0, bankSlipsIssued: 0 }),
  resolveTitleAutomationConfig: jest.fn().mockResolvedValue({ autoBankSlip: false }),
  localIsoDate: () => '2026-09-13',
}))
jest.mock('../shared/order-billing', () => ({
  __esModule: true,
  upsertOrderBilling: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../shared/order-installment', () => ({
  __esModule: true,
  ...jest.requireActual('../shared/order-installment'),   // parcelQuotas real (o calc da OS reexporta daqui)
  assertPaymentRules: jest.fn().mockResolvedValue(undefined),
}))
const inv = jest.requireMock('../shared/invoice') as any
const auto = jest.requireMock('../shared/title-automation') as any

function mockConn() {
  const conn = {
    beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]),
    commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
  return conn
}
beforeEach(() => jest.clearAllMocks())

describe('service-orders.generateInvoice (Q-G3)', () => {
  it('fatura pela peça: issueInvoice(model SE, série 1, sem ramos) + financeiro com revive + OS fecha (open_lock NULL)', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([{}])                                        // regra 7: lockInstitutionCounters (1o lock)
      .mockResolvedValueOnce([[{ status: 'A' }]])                                           // lockOpenOrder
      .mockResolvedValueOnce([[{ itemsQtde: 1, productQtde: 1, productValue: 150, discountValue: 0 }]]) // recalc sums
      .mockResolvedValueOnce([{}])                                                          // totalizer upsert
      .mockResolvedValueOnce([[{ n: 1 }]])                                                  // itens vivos
      .mockResolvedValueOnce([[{ n: 0 }]])                                                  // Q-A20: nenhum item inválido
      .mockResolvedValueOnce([[{ customerId: 55 }]])                                        // cliente da OS

    const r = await generateInvoice(300, { dtExpiration: '2026-10-05', paymentTypeId: 6, parcels: 2 }, 'setes_setes', 1, 7)

    // o resultado passou a dizer o que a automação FEZ (gate adversarial,
    // achado 5): "faturada" sem baixa nem boleto é o pior caso da cobrança
    expect(r).toEqual({
      invoiceNumber: '12', parcels: 2, totalValue: 150,
      autoSettled: 0, bankSlipsIssued: 0,
    })
    expect(inv.issueInvoice).toHaveBeenCalledWith(conn, 'setes_setes', 1, 7, {
      orderId: 300, recipientEntityId: 55, model: 'SE', serie: '1', totalValue: 150,
      noteText: null, merchandise: null, serviceTotal: null,
    })
    const sqls = conn.query.mock.calls.map(c => String(c[0]))
    expect(sqls.some(q => /INSERT INTO `setes_setes`\.tb_invoice\b/.test(q))).toBe(false)   // nada inline
    const fin = conn.query.mock.calls.filter(c => /INSERT INTO `setes_setes`\.tb_financial\s/.test(String(c[0])))
    expect(fin).toHaveLength(2)
    expect(String(fin[0][0])).toMatch(/ON DUPLICATE KEY UPDATE[\s\S]*deleted = 'N'/)
    expect(fin[0][1]).toEqual([1, 300, 1, '2026-10-05', 6, 75])
    const bills = conn.query.mock.calls.filter(c => /tb_financial_bills/.test(String(c[0])))
    expect(bills).toHaveLength(2)
    expect(String(bills[1][0])).toMatch(/ON DUPLICATE KEY UPDATE[\s\S]*kind = 'RA'/)
    expect(bills[1][1]).toEqual([1, 300, 2, '300/12-2'])
    expect(sqls[sqls.length - 2]).toMatch(/UPDATE `setes_setes`\.tb_order\s+SET status = 'F'/)
    expect(sqls[sqls.length - 1]).toMatch(/UPDATE `setes_setes`\.tb_service_order[\s\S]*SET open_lock = NULL/)
    expect(conn.commit).toHaveBeenCalled()
  })

  it('Q-A20 (cinto): item com produto inativo/mercadoria/inexistente → 422 antes da nota', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([{}])                                        // regra 7: lockInstitutionCounters (1o lock)
      .mockResolvedValueOnce([[{ status: 'A' }]])
      .mockResolvedValueOnce([[{ itemsQtde: 1, productQtde: 1, productValue: 150, discountValue: 0 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ n: 1 }]])
      .mockResolvedValueOnce([[{ n: 1 }]])   // 1 item inválido
    await expect(generateInvoice(300, { dtExpiration: '2026-10-05', paymentTypeId: 6, parcels: 1 }, 'setes_setes', 1, 7))
      .rejects.toMatchObject({ statusCode: 422, code: 'SERVICE_ORDER_ITEM_NOT_SERVICE' })
    expect(inv.issueInvoice).not.toHaveBeenCalled()
  })

  it('OS sem itens → 400 ORDER_NO_ITEMS antes da nota', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([{}])                                        // regra 7: lockInstitutionCounters (1o lock)
      .mockResolvedValueOnce([[{ status: 'A' }]])
      .mockResolvedValueOnce([[{ itemsQtde: 0, productQtde: 0, productValue: 0, discountValue: 0 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ n: 0 }]])
    await expect(generateInvoice(300, { dtExpiration: '2026-10-05', paymentTypeId: 6, parcels: 1 }, 'setes_setes', 1, 7))
      .rejects.toMatchObject({ statusCode: 400, code: 'ORDER_NO_ITEMS' })
    expect(inv.issueInvoice).not.toHaveBeenCalled()
    expect(conn.rollback).toHaveBeenCalled()
  })

  // ACHADO A1 da Onda 0 (fase Primeiro Cliente, 2026-09-13): até aqui o
  // faturamento da OS gravava os títulos e parava — baixa por contrato e
  // boleto automático só existiam no billing da VENDA, e a receita de
  // contrato mensal nasce TODA por este caminho.
  it('A1/D5: os títulos da OS passam pelos automatismos da forma (mesma composição da venda)', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([{}])                                        // regra 7: lockInstitutionCounters (1o lock)
      .mockResolvedValueOnce([[{ status: 'A' }]])
      .mockResolvedValueOnce([[{ itemsQtde: 1, productQtde: 1, productValue: 150, discountValue: 0 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ n: 1 }]])
      .mockResolvedValueOnce([[{ n: 0 }]])
      .mockResolvedValueOnce([[{ customerId: 55 }]])

    await generateInvoice(300, { dtExpiration: '2026-10-05', paymentTypeId: 6, parcels: 2 }, 'setes_setes', 1, 7)

    expect(auto.applyTitleAutomation).toHaveBeenCalledTimes(1)
    const [, schema, institutionId, userId, input] = auto.applyTitleAutomation.mock.calls[0]
    expect([schema, institutionId, userId]).toEqual(['setes_setes', 1, 7])
    // uma entrada por parcela, com a MESMA forma e as quotas do rateio
    expect(input).toMatchObject({
      orderId: 300,
      dtPayment: '2026-09-13',
      parcels: [
        { parcel: 1, paymentTypeId: 6, amount: 75 },
        { parcel: 2, paymentTypeId: 6, amount: 75 },
      ],
    })
  })

  it('A1: a composição roda DEPOIS de os títulos existirem (senão não haveria o que baixar)', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([{}])                                        // regra 7: lockInstitutionCounters (1o lock)
      .mockResolvedValueOnce([[{ status: 'A' }]])
      .mockResolvedValueOnce([[{ itemsQtde: 1, productQtde: 1, productValue: 150, discountValue: 0 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ n: 1 }]])
      .mockResolvedValueOnce([[{ n: 0 }]])
      .mockResolvedValueOnce([[{ customerId: 55 }]])

    let titulosNaChamada = -1
    auto.applyTitleAutomation.mockImplementation(async () => {
      titulosNaChamada = conn.query.mock.calls
        .filter(c => /INSERT INTO `setes_setes`\.tb_financial\s/.test(String(c[0]))).length
      return { autoSettled: 0, bankSlipsIssued: 0 }
    })

    await generateInvoice(300, { dtExpiration: '2026-10-05', paymentTypeId: 6, parcels: 2 }, 'setes_setes', 1, 7)

    expect(titulosNaChamada).toBe(2)
  })
})
