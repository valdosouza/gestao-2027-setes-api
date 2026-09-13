/// <reference types="jest" />
// PEÇA @shared/title-charge — redirecionar a cobrança de um título (D17/D18/D19,
// Valdo 2026-09-13). O que estes testes fixam é a SEMÂNTICA do ato: o que ele
// recusa, o que ele escreve e o que ele deliberadamente NÃO faz.
import { retargetTitleCharge } from '../shared/title-charge'
import { assertPaymentTypesEnabled } from '../shared/payment-types'
import { getPrincipalPaidTx } from '../shared/financial-settlement/title-balance'

jest.mock('../shared/payment-types', () => ({
  __esModule: true, assertPaymentTypesEnabled: jest.fn(),
}))
jest.mock('../shared/financial-settlement/title-balance', () => ({
  __esModule: true, getPrincipalPaidTx: jest.fn().mockResolvedValue(0),
}))

const mockForma = assertPaymentTypesEnabled as jest.Mock
const mockPago  = getPrincipalPaidTx as jest.Mock

const TITULO = (over: Record<string, any> = {}) => [[{
  paymentTypeId: 1, tagValue: 250, dtExpiration: '2026-10-10', ...over,
}]]

function conn(titulo = TITULO()) {
  const c: any = { query: jest.fn() }
  c.query.mockResolvedValueOnce(titulo).mockResolvedValue([{}])
  return c
}
const alvo = { orderId: 700, parcel: 1, paymentTypeId: 6 }

beforeEach(() => {
  jest.clearAllMocks()
  mockPago.mockResolvedValue(0)
  mockForma.mockResolvedValue(new Map())
})

describe('retargetTitleCharge (D17)', () => {
  it('escreve a forma nova no título e devolve de onde veio', async () => {
    const c = conn()
    const r = await retargetTitleCharge(c, 'setes_setes', 1, alvo)

    expect(r).toMatchObject({
      orderId: 700, parcel: 1,
      previousPaymentTypeId: 1, paymentTypeId: 6, changed: true,
    })
    const update = c.query.mock.calls.find((x: any[]) =>
      /SET tb_payment_types_id/.test(String(x[0])))
    expect(update).toBeDefined()
    expect(update[1]).toEqual([6, '2026-10-10', 1, 700, 1])
  })

  it('lê o título com FOR UPDATE ANTES de decidir', async () => {
    const c = conn()
    await retargetTitleCharge(c, 'setes_setes', 1, alvo)

    expect(String(c.query.mock.calls[0][0])).toContain('FOR UPDATE')
  })

  it('D19: vencimento novo entra junto; ausente mantém o atual', async () => {
    const c = conn()
    await retargetTitleCharge(c, 'setes_setes', 1, { ...alvo, dtExpiration: '2026-11-30' })

    const update = c.query.mock.calls.find((x: any[]) => /SET tb_payment_types_id/.test(String(x[0])))
    expect(update[1]).toEqual([6, '2026-11-30', 1, 700, 1])
  })

  it('redirecionar para a MESMA condição é no-op (não escreve)', async () => {
    const c = conn(TITULO({ paymentTypeId: 6 }))
    const r = await retargetTitleCharge(c, 'setes_setes', 1, alvo)

    expect(r.changed).toBe(false)
    expect(c.query.mock.calls.some((x: any[]) => /SET tb_payment_types_id/.test(String(x[0])))).toBe(false)
  })

  it('título QUITADO não se redireciona — não há cobrança a redirecionar', async () => {
    mockPago.mockResolvedValue(250)

    await expect(retargetTitleCharge(conn(), 'setes_setes', 1, alvo))
      .rejects.toMatchObject({ statusCode: 409, code: 'TITLE_SETTLED' })
  })

  it('título inexistente/soft-deletado → 404 (nota cancelada morre por construção)', async () => {
    const c: any = { query: jest.fn().mockResolvedValueOnce([[]]) }

    await expect(retargetTitleCharge(c, 'setes_setes', 1, alvo))
      .rejects.toMatchObject({ statusCode: 404, code: 'TITLE_NOT_FOUND' })
  })

  it('forma não habilitada: a recusa vem da peça ÚNICA, não de fórmula local', async () => {
    const c = conn()
    mockForma.mockRejectedValue(Object.assign(new Error('x'), { code: 'PAYMENT_TYPE_UNAVAILABLE' }))

    await expect(retargetTitleCharge(c, 'setes_setes', 1, alvo)).rejects.toMatchObject({
      code: 'PAYMENT_TYPE_UNAVAILABLE',
    })
    expect(mockForma).toHaveBeenCalledWith(c, 'setes_setes', 1, [6], 'paymentTypeId')
    expect(c.query.mock.calls.some((x: any[]) => /SET tb_payment_types_id/.test(String(x[0])))).toBe(false)
  })

  it('data inválida é recusada antes de qualquer leitura', async () => {
    const c: any = { query: jest.fn() }

    await expect(retargetTitleCharge(c, 'setes_setes', 1,
      { ...alvo, dtExpiration: '2026-13-45' }))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(c.query).not.toHaveBeenCalled()
  })

  it('o ato é NEUTRO quanto ao sentido: título a pagar também redireciona', async () => {
    // "ia pagar o fornecedor em dinheiro, vou pagar por transferência" é a
    // mesma nuvem — quem restringe a recebíveis é o BOLETO, não o título.
    const c = conn()
    const r = await retargetTitleCharge(c, 'setes_setes', 1, alvo)
    expect(r.changed).toBe(true)
  })

  it('NUNCA liquida: não toca pagamento, extrato nem caixa', async () => {
    const c = conn()
    await retargetTitleCharge(c, 'setes_setes', 1, alvo)

    const sqls = c.query.mock.calls.map((x: any[]) => String(x[0])).join(' ')
    expect(sqls).not.toMatch(/tb_financial_payment|tb_financial_statement|tb_cashier/)
  })

  it('não toca a negociação ORIGINAL do pedido (D18)', async () => {
    const c = conn()
    await retargetTitleCharge(c, 'setes_setes', 1, alvo)

    const sqls = c.query.mock.calls.map((x: any[]) => String(x[0])).join(' ')
    expect(sqls).not.toMatch(/tb_order_billing|tb_order_installment/)
  })
})
