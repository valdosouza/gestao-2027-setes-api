/// <reference types="jest" />
// GATE ADVERSARIAL da IB-2 (fase IBS/CBS — prompt_fase_ibs_cbs.md §12.6/§12.7), 2026-10-15.
//  (1) D-IB65: "como o lote descarta fields[], a MENSAGEM do 422 depois da obrigação nomeia o(s) serviço(s)" — a mensagem do
//      INVOICE_SERVICE_IBSCBS_REQUIRED é cortada em 600 caracteres SEM "e mais N": numa nota com 5+ serviços (há ordens com 9 e
//      15 serviços distintos no setes_setes) os últimos somem do relatório do batch-invoice. Achado ADV-IB2-03 (LOW) CONFIRMADO e
//      CORRIGIDO na sessão (mensagem agrupada por motivo, com "e mais N" — §12.8 do prompt); fica como guarda de regressão.
//  (2) Lote (D-IB65/D7): a ordem que cai no 422 da declaração não derruba as outras e os contadores ibscbsDeclared/ibscbsOmitted
//      contam só as faturadas — guarda de regressão (verde).
import { evaluateIbscbsDeclaration, assertIbscbsDeclarable, ServicePresumption } from '../shared/ibscbs-classification'
import { invoiceOrderBatch } from '../modules/service-orders/service-orders.service'
import { generateInvoice, contractBillingReference, orderExists } from '../modules/service-orders/service-orders.repository'

jest.mock('../modules/service-orders/service-orders.repository', () => ({
  __esModule: true, generateInvoice: jest.fn(), contractBillingReference: jest.fn(), orderExists: jest.fn(),
}))
jest.mock('../shared/logger/logger', () => ({
  __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

const fakeQ = { query: jest.fn(async () => [[{ ok: 1 }]]) }
const sv = (productId: number, description: string, over: Partial<ServicePresumption> = {}): ServicePresumption => ({
  productId, description, field: `product.${productId}`, nbs: null, classificationCode: null, placeIndicatorCode: null, ...over,
})

describe('ADV-IB2-03 — a mensagem do 422 nomeia TODOS os serviços (D-IB65: o lote descarta fields[])', () => {
  it('8 serviços sem declaração depois da obrigação: cada nome aparece na mensagem (ou ela diz quantos faltam)', async () => {
    const names = [
      'Suporte tecnico mensal Financeiro', 'Suporte tecnico mensal Fiscal', 'Suporte tecnico mensal Estoque',
      'Licenca de uso Gestao Comercial', 'Hospedagem do banco de dados', 'Backup em nuvem mensal',
      'Atualizacao de versao do ERP', 'Treinamento remoto de usuarios',
    ]
    const ev = await evaluateIbscbsDeclaration(fakeQ, names.map((n, i) => sv(500 + i, n)), '2027-01-05', '2027-01-01')
    expect(ev.refusal?.code).toBe('INVOICE_SERVICE_IBSCBS_REQUIRED')
    expect(ev.refusal!.fields).toHaveLength(8)          // fields[] completo (porta individual)
    const msg = ev.refusal!.message
    const missing = names.filter(n => !msg.includes(n))
    // o lote só mostra `message`: serviço que não aparece e nenhum "e mais N" = o operador corrige 4, refatura e cai de novo
    const honest = missing.length === 0 || new RegExp(`e mais ${missing.length}\\b`).test(msg)
    expect({ honest, missing }).toEqual({ honest: true, missing: honest ? missing : [] })
  })
})

describe('lote batch-invoice × 422 da declaração (D-IB65) — guarda de regressão', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(orderExists as jest.Mock).mockResolvedValue(true)
    ;(contractBillingReference as jest.Mock).mockResolvedValue({ paymentDay: 10, paymentTypeId: 6, competence: '2027-01' })
  })

  it('a ordem recusada pela declaração não derruba as outras; contadores só das faturadas; a linha nomeia o serviço', async () => {
    const refusal = assertIbscbsDeclarable.bind(null,
      await evaluateIbscbsDeclaration(fakeQ, [sv(7, 'Suporte mensal', { nbs: '115011000' })], '2027-01-05', '2027-01-01'))
    ;(generateInvoice as jest.Mock).mockImplementation(async (orderId: number) => {
      if (orderId === 11) refusal()
      return {
        invoiceNumber: String(6000 + orderId), parcels: 1, totalValue: 250, autoSettled: 0, bankSlipsIssued: 1,
        chargeableParcels: 1,
        ibscbs: orderId === 10 ? { declared: true, omitted: [] } : { declared: false, omitted: ['not-classified'] },
      }
    })
    const r = await invoiceOrderBatch({ orderIds: [10, 11, 12], dtExpiration: '2027-01-10', paymentTypeId: 6, parcels: 1 } as any,
      { schemaName: 'setes_setes', institutionId: 1, userId: 1 })
    expect(r).toMatchObject({ requested: 3, invoiced: 2, failed: 1, ibscbsDeclared: 1, ibscbsOmitted: 1 })
    expect(r.results[1]).toMatchObject({ orderId: 11, ok: false, code: 'INVOICE_SERVICE_IBSCBS_REQUIRED' })
    expect(r.results[1].error).toContain('Suporte mensal')
    expect(r.results[2]).toMatchObject({ orderId: 12, ok: true, ibscbs: { declared: false, omitted: ['not-classified'] } })
  })
})
