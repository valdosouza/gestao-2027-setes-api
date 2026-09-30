/// <reference types="jest" />
// Gate ADVERSARIAL (2026-09-29) — cancelamento de nota COM registro fiscal (D3/D4 reafirmada):
// a nota autorizada e cancelada FICA viva (evento C) e o pedido vira 'C' — "somente leitura,
// NUNCA refaturável". Os ataques abaixo fixam a promessa nas portas que faturam.
//
// ACHADO HIGH (A2): o billing de VENDA só recusa status 'F' (billing.service validateOrder/
// invoiceOrder e billing.repository persistInvoiceOnce). Venda conjugada (itens de serviço →
// ramo tb_invoice_service → NFS-e transmitível) cancelada no fisco vira 'C' e passa pelo
// POST /billing/validate e /billing/invoice: `issueInvoice` faz upsert no cabeçalho VIVO (número
// novo, dps_number NULL, snapshots regravados) + E novo (vida nova — D-N27 esconde a NFS-e
// cancelada) + financeiro/comissão renascem. O documento que a D3 manda manter é sobrescrito.
import pool from '../shared/db/connection'
import { validateOrder, invoiceOrder } from '../modules/billing/billing.service'
import { persistInvoice } from '../modules/billing/billing.repository'
import { buildCancelPlan } from '../shared/invoice/invoice-cancel'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
jest.mock('../shared/fiscal-issuer', () => ({ __esModule: true, ...jest.requireActual('../shared/fiscal-issuer'), getIssuer: jest.fn().mockResolvedValue(null) }))
jest.mock('../shared/interface-config', () => ({
  getConfigContent: jest.fn().mockResolvedValue(null),
  getConfigContentFor: jest.fn().mockResolvedValue(null),
}))
jest.mock('../shared/service-order', () => ({
  __esModule: true,
  ...jest.requireActual('../shared/service-order'),
  hasServiceOrderCycle: jest.fn().mockResolvedValue(false),
}))
jest.mock('../shared/invoice', () => ({
  __esModule: true,
  ...jest.requireActual('../shared/invoice'),
  issueInvoice: jest.fn(async () => ({ invoiceNumber: '99', event: 3 })),
}))

const mockQuery = (pool as any).query as jest.Mock
const mockGetConnection = (pool as any).getConnection as jest.Mock
const mockIssueInvoice = (jest.requireMock('../shared/invoice') as any).issueInvoice as jest.Mock
const inst = { institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes' }

beforeEach(() => {
  jest.clearAllMocks()
  // depois do status: nenhuma ordem/ramo (se o código seguir adiante, cai em 422 — não em 409)
  mockQuery.mockResolvedValue([[]])
})

describe('A2 (HIGH) — pedido cancelado com registro fiscal (status C) NUNCA refatura pelo billing de venda', () => {
  it('POST /billing/validate: status C → 409 (não segue validando/gravando regra em pedido cancelado)', async () => {
    mockQuery.mockResolvedValueOnce([[{ status: 'C' }]])   // getOrderStatus
    await expect(validateOrder(inst as any, { orderId: 10 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ORDER_CANCELLED' })
  })

  it('POST /billing/invoice: status C → 409 antes de qualquer cálculo', async () => {
    mockQuery.mockResolvedValueOnce([[{ status: 'C' }]])   // getOrderStatus
    await expect(invoiceOrder(inst as any, { orderId: 10 } as any))
      .rejects.toMatchObject({ statusCode: 409, code: 'ORDER_CANCELLED' })
  })

  it('persistInvoice (cinto sob FOR UPDATE): status C → 409; nem parcelas nem issueInvoice (o cabeçalho vivo seria sobrescrito)', async () => {
    const conn = {
      query: jest.fn()
        .mockResolvedValueOnce([[{ status: 'C' }]])        // SELECT status ... FOR UPDATE
        .mockResolvedValue([[]]),
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    mockGetConnection.mockResolvedValue(conn)
    const resolveParcels = jest.fn().mockResolvedValue([])
    await expect(persistInvoice('setes_setes', 1, {
      orderId: 10, recipientEntityId: 55, model: 'SE', serie: '1', items: [], totalValue: 100,
      resolveParcels, checks: [], financialKind: 'RA', financialOperation: 'C', noteText: '',
      approxTaxByItem: new Map(), userId: 7, automationConfig: {} as any, commissions: [], returnPlan: null,
    })).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_CANCELLED' })
    expect(resolveParcels).not.toHaveBeenCalled()
    expect(mockIssueInvoice).not.toHaveBeenCalled()
    expect(conn.commit).not.toHaveBeenCalled()
  })
})

describe('A1 (REFUTADO — guarda de regressão) — cancelar de novo um pedido C', () => {
  it('buildCancelPlan: pedido C → 409 INVOICE_NOT_CANCELLABLE (sem 2º evento C, sem 2ª compensação de comissão)', async () => {
    const conn = { query: jest.fn().mockResolvedValueOnce([[{ status: 'C' }]]) }
    await expect(buildCancelPlan(conn as any, 'setes_setes', 1, 10))
      .rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_NOT_CANCELLABLE' })
    expect(conn.query).toHaveBeenCalledTimes(1)
  })
})
