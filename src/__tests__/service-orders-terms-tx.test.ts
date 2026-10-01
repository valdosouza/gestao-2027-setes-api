/// <reference types="jest" />
// M1 do gate socrático da Rodada 5 (2026-09-19): as condições do lote que vêm do
// FATO da competência (D23) eram resolvidas FORA da transação, pelo pool, e a
// rotina mensal escreve na mesma tabela e na mesma OS aberta — entre a leitura e
// o lock da ordem podia entrar um fato com outra forma, e a nota saía com a
// condição envelhecida. Regra 2 do PADROES §9: leitura que DECIDE trava. O que
// estes testes fixam: com `termsFromContract`, `generateInvoice` RE-RESOLVE sob o
// lock (FOR UPDATE), grava o que reconferiu e recusa se a condição sumiu.
import pool from '../shared/db/connection'
import { generateInvoice } from '../modules/service-orders/service-orders.repository'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
jest.mock('../shared/fiscal-issuer', () => ({ __esModule: true, ...jest.requireActual('../shared/fiscal-issuer'), getIssuer: jest.fn().mockResolvedValue(null) }))
jest.mock('../shared/invoice', () => ({
  __esModule: true,
  issueInvoice: jest.fn(async () => ({ invoiceNumber: '12', event: 1 })),
}))
jest.mock('../shared/title-automation', () => ({
  __esModule: true,
  applyTitleAutomation: jest.fn().mockResolvedValue({ autoSettled: 0, bankSlipsIssued: 0, chargeable: 1 }),
  resolveTitleAutomationConfig: jest.fn().mockResolvedValue({ autoBankSlip: false }),
}))
jest.mock('../shared/order-billing', () => ({
  __esModule: true,
  upsertOrderBilling: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../shared/order-installment', () => ({
  __esModule: true,
  ...jest.requireActual('../shared/order-installment'),
  assertPaymentRules: jest.fn().mockResolvedValue(undefined),
}))

// Onda 3 (A2): a nota da OS nasce COM o ramo de serviço — regra de ISS por item
// resolvida ANTES da transação e itens relidos SOB o lock; fronteira mockada.
jest.mock('../shared/service-tax-rule', () => ({
  __esModule: true,
  ...jest.requireActual('../shared/service-tax-rule'),
  resolveServiceTaxRule: jest.fn(),
}))
jest.mock('../shared/entity', () => ({ __esModule: true, getEntityFiscalFull: jest.fn() }))
jest.mock('../shared/entity-tax/entity-tax.repository', () => ({ __esModule: true, getEntityTax: jest.fn().mockResolvedValue(null) }))
const TX_ITEMS = [[{ id: 1, productId: 40, quantity: 1, unitValue: 150, discountValue: 0 }]]
const FISCAL_RULE = { id: 2, cityId: 4004, cityName: 'CURITIBA', serviceListId: '1.02', aliq: 5, municipalCode: '0102', nationalCode: '010201', active: 'S' }
function mockFiscal(customerId: number) {
  ;((pool as any).query as jest.Mock).mockImplementation(async (sql: string) =>
    /tb_order_service/.test(String(sql)) ? [[{ customerId }]]
      : /tb_order_item/.test(String(sql)) ? [[{ productId: 40, description: 'Suporte mensal' }]] : [[]])
  ;(jest.requireMock('../shared/service-tax-rule') as any).resolveServiceTaxRule.mockResolvedValue(FISCAL_RULE)
  ;(jest.requireMock('../shared/entity') as any).getEntityFiscalFull.mockResolvedValue({ addresses: [{ main: 'S', tbCityId: 4004 }] })
}
const rules = jest.requireMock('../shared/order-installment') as any
const billing = jest.requireMock('../shared/order-billing') as any

function mockConn() {
  const conn = {
    beginTransaction: jest.fn(), query: jest.fn(async (sql: string, ..._params: any[]) => (/tb_order_item i\s+WHERE i\.tb_order_id/.test(String(sql)) ? TX_ITEMS : [{}])),
    commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
  mockFiscal(263)
  return conn
}
/** Linha do agregado dos fatos (como a leitura de dentro da transação a vê). */
const fatos = (over: Record<string, any> = {}) => [[{
  competence: '2026-09', dias: 1, paymentDay: 15,
  contratos: 1, formas: 1, comForma: 1, paymentTypeId: 7, ...over,
}]]
/** Sequência de queries DEPOIS da reconferência (recalc, itens, cliente). */
function restante(conn: any) {
  conn.query
    .mockResolvedValueOnce([[{ itemsQtde: 1, productQtde: 1, productValue: 250, discountValue: 0 }]])
    .mockResolvedValueOnce([{}])
    .mockResolvedValueOnce([[{ n: 1 }]])
    .mockResolvedValueOnce([[{ n: 0 }]])
    .mockResolvedValueOnce([[{ customerId: 263 }]])
      .mockResolvedValueOnce(TX_ITEMS)                                                      // itens sob o lock (Onda 3)
      .mockResolvedValueOnce([{}])                                                          // tb_order_item_issqn
}
// o que o LOTE viu fora da transação: dia 10 / forma 6 (já envelhecido)
const deFora = { dtExpiration: '2026-10-10', paymentTypeId: 6, parcels: 1 }

beforeEach(() => jest.clearAllMocks())

describe('generateInvoice × condições do fato reconferidas na transação (M1 / D23)', () => {
  it('com termsFromContract, relê os fatos FOR UPDATE após o lock da ordem e GRAVA o que reconferiu', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([{}])                     // lockInstitutionCounters
      .mockResolvedValueOnce([[{ status: 'A' }]])      // lockOpenOrder
      .mockResolvedValueOnce(fatos())                  // reconferência TRAVANTE: dia 15 / forma 7
    restante(conn)

    const r = await generateInvoice(7984,
      { ...deFora, termsFromContract: { dtExpiration: true, paymentTypeId: true } },
      'setes_setes', 1, 7)

    const sqls = conn.query.mock.calls.map(c => String(c[0]))
    expect(sqls[1]).toMatch(/tb_service_order[\s\S]*FOR UPDATE/)                      // lock da ordem ANTES
    expect(sqls[2]).toMatch(/tb_contract_item_competence comp[\s\S]*FOR UPDATE$/)     // fatos travados DEPOIS
    expect(conn.query.mock.calls[2][1]).toEqual([1, 7984])
    // o que foi gravado é o reconferido, não o que o lote viu de fora
    expect(r).toMatchObject({ dtExpiration: '2026-10-15', paymentTypeId: 7 })
    const fin = conn.query.mock.calls.find(c => /INSERT INTO `setes_setes`\.tb_financial\s/.test(String(c[0])))!
    expect(fin[1]).toEqual([1, 7984, 1, '2026-10-15', 7, 250])
    expect(rules.assertPaymentRules.mock.calls[0][3]).toMatchObject({ headerPaymentTypeId: 7 })
    expect(billing.upsertOrderBilling.mock.calls[0][4]).toMatchObject({ paymentTypeId: 7 })
    expect(conn.commit).toHaveBeenCalled()
  })

  it('só a condição que veio do fato é reconferida — o override do operador é respeitado', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ status: 'A' }]])
      .mockResolvedValueOnce(fatos())                  // dia 15 / forma 7 nos fatos
    restante(conn)

    const r = await generateInvoice(7984,
      { ...deFora, termsFromContract: { dtExpiration: false, paymentTypeId: true } },
      'setes_setes', 1, 7)

    expect(r).toMatchObject({ dtExpiration: '2026-10-10', paymentTypeId: 7 })   // data do operador, forma do fato
  })

  it('condição SUMIU entre a leitura do lote e o lock (fatos sem forma combinada) → 422 do mesmo código, nada gravado', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ status: 'A' }]])
      .mockResolvedValueOnce(fatos({ contratos: 2, comForma: 1 }))   // entrou fato sem forma

    await expect(generateInvoice(7984,
      { ...deFora, termsFromContract: { dtExpiration: true, paymentTypeId: true } },
      'setes_setes', 1, 7))
      .rejects.toMatchObject({ statusCode: 422, code: 'ORDER_NO_CONTRACT_PAYMENT_TYPE' })

    expect(conn.rollback).toHaveBeenCalled()
    expect(conn.query.mock.calls.some(c => /INSERT INTO/.test(String(c[0])))).toBe(false)
  })

  it('dia divergente entre os fatos → 422 ORDER_NO_CONTRACT_DUE_DAY com a mensagem que aponta as saídas (M2)', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ status: 'A' }]])
      .mockResolvedValueOnce(fatos({ dias: 2 }))

    const err = await generateInvoice(7984,
      { ...deFora, termsFromContract: { dtExpiration: true, paymentTypeId: false } },
      'setes_setes', 1, 7).catch(e => e)

    expect(err).toMatchObject({ statusCode: 422, code: 'ORDER_NO_CONTRACT_DUE_DAY' })
    expect(err.message).toMatch(/remova o item ou cancele a OS/)
    expect(err.message).not.toMatch(/acerte o contrato/)
  })

  it('sem termsFromContract (avulso ou override total) NÃO relê os fatos — sequência de queries inalterada', async () => {
    const conn = mockConn()
    conn.query
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ status: 'A' }]])
    restante(conn)

    const r = await generateInvoice(7984, deFora, 'setes_setes', 1, 7)

    expect(conn.query.mock.calls.some(c => /tb_contract_item_competence/.test(String(c[0])))).toBe(false)
    expect(r).toMatchObject({ dtExpiration: '2026-10-10', paymentTypeId: 6 })
  })
})
