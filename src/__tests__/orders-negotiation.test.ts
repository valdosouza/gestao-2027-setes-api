/// <reference types="jest" />
// Módulo orders — NEGOCIAÇÃO do pedido (prompt_negociacao_pedido.md D1–D7):
// GET/PUT /api/orders/:id/negotiation compõem as peças @shared/order-billing
// (via simples), @shared/order-installment (via elaborada), @shared/order
// (base do PEDIDO) e @shared/payment-types (formas habilitadas).
import pool from '../shared/db/connection'
import { getNegotiation, saveNegotiation } from '../modules/orders/orders.repository'
import { fetchNegotiation } from '../modules/orders/orders.service'

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

const OPEN = [[{ status: 'A' }]]
const ENABLED_5 = [[{ id: 5, description: 'BOLETO', kind: 'B', maxParcels: 3 }]]
const BASE_100 = [[{ quantity: 1, unitValue: 100, discountValue: 0, setFinancial: 'S' }]]
const FREIGHT_0 = [[{ freight: 0 }]]

describe('saveNegotiation', () => {
  it('via SIMPLES: trava o pedido, valida forma + limite, normaliza o prazo, upsert do cabeçalho e "voltar ao prazo"', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce(OPEN)         // lockOpenOrder (venda)
      .mockResolvedValueOnce([[]])         // billing atual (Q-N4)
      .mockResolvedValueOnce(ENABLED_5)    // formas habilitadas
      .mockResolvedValueOnce([{}])         // upsert tb_order_billing
      .mockResolvedValueOnce([{}])         // clearInstallments
    await saveNegotiation(10, { paymentTypeId: 5, deadline: '28/56' }, 'setes_setes', 1)
    expect(conn.commit).toHaveBeenCalled()
    expect(conn.query).toHaveBeenCalledTimes(5)
    expect(conn.query.mock.calls[3][1]).toEqual([10, 1, 5, '002', '028/056']) // canônico + plots derivado
    expect(conn.query.mock.calls[4][0]).toContain("SET deleted = 'S'")
  })

  it('prazo com lixo → 422 INVALID_DEADLINE na NEGOCIAÇÃO (não no faturamento), rollback', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce(OPEN).mockResolvedValueOnce([[]]) // billing atual (Q-N4): nenhum
    await expect(saveNegotiation(10, { paymentTypeId: 5, deadline: 'A VISTA' }, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 422, code: 'INVALID_DEADLINE' })
    expect(conn.rollback).toHaveBeenCalled()
    expect(conn.query).toHaveBeenCalledTimes(2)
  })

  it('pedido faturado → 409 ORDER_INVOICED antes de qualquer gravação', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ status: 'F' }]])
    await expect(saveNegotiation(10, { paymentTypeId: 5, deadline: null }, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'ORDER_INVOICED' })
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('forma não vinculada/habilitada → 400 PAYMENT_TYPE_UNAVAILABLE (mesmo código da OS)', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce(OPEN).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]])
    await expect(saveNegotiation(10, { paymentTypeId: 9, deadline: null }, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 400, code: 'PAYMENT_TYPE_UNAVAILABLE' })
  })

  it('nº de parcelas acima do max_parcels da forma do cabeçalho → 422 MAX_PARCELS_EXCEEDED (parecer Q2)', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce(OPEN).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ id: 5, description: 'PIX', kind: 'X', maxParcels: 1 }]])
    await expect(saveNegotiation(10, { paymentTypeId: 5, deadline: '028/056' }, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 422, code: 'MAX_PARCELS_EXCEEDED' })
  })

  it('ELABORADO com buraco na numeração → 422 INSTALLMENT_INVALID', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce(OPEN).mockResolvedValueOnce([[]]).mockResolvedValueOnce(ENABLED_5).mockResolvedValueOnce([{}])
    await expect(saveNegotiation(10, {
      paymentTypeId: 5, deadline: null,
      installments: [{ parcel: 1, dueDate: '2026-10-01', amount: 50 }, { parcel: 3, dueDate: '2026-11-01', amount: 50 }],
    }, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 422, code: 'INSTALLMENT_INVALID' })
  })

  it('ELABORADO cuja soma ≠ base do PEDIDO → 422 INSTALLMENT_MISMATCH (espelho de ValidaParcelamento)', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce(OPEN).mockResolvedValueOnce([[]]).mockResolvedValueOnce(ENABLED_5).mockResolvedValueOnce([{}])
      .mockResolvedValueOnce(BASE_100).mockResolvedValueOnce(FREIGHT_0)
    await expect(saveNegotiation(10, {
      paymentTypeId: 5, deadline: null,
      installments: [{ parcel: 1, dueDate: '2026-10-01', amount: 50 }, { parcel: 2, dueDate: '2026-11-01', amount: 40 }],
    }, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 422, code: 'INSTALLMENT_MISMATCH' })
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('ELABORADO ok: formas por parcela validadas junto, grade substituída (upsert + soft nos ausentes), commit', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce(OPEN)
      .mockResolvedValueOnce([[]])              // billing atual (Q-N4)
      .mockResolvedValueOnce([[ // cabeçalho 5 + parcela 2 com forma própria 7
        { id: 5, description: 'BOLETO', kind: 'B', maxParcels: 3 },
        { id: 7, description: 'CHEQUE', kind: 'Q', maxParcels: 6 },
      ]])
      .mockResolvedValueOnce([{}])              // upsert billing
      .mockResolvedValueOnce(BASE_100).mockResolvedValueOnce(FREIGHT_0)
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]) // upsert parcelas 1 e 2
      .mockResolvedValueOnce([{}])              // soft nos ausentes
    await saveNegotiation(10, {
      paymentTypeId: 5, deadline: '028/056',
      installments: [
        { parcel: 2, dueDate: '2026-11-01', amount: 40, paymentTypeId: 7 },
        { parcel: 1, dueDate: '2026-10-01', amount: 60 }, // fora de ordem — ordenado pela peça
      ],
    }, 'setes_setes', 1)
    expect(conn.commit).toHaveBeenCalled()
    expect(conn.query.mock.calls[2][1]).toEqual([1, 5, 7])      // ids das formas validadas
    expect(conn.query.mock.calls[6][1]).toEqual([1, 10, 1, '2026-10-01', 60, null]) // forma NULL = herda (M2)
    expect(conn.query.mock.calls[7][1]).toEqual([1, 10, 2, '2026-11-01', 40, 7])
    expect(conn.query.mock.calls[8][0]).toContain('NOT IN (?,?)')
  })
})

describe('saveNegotiation — Rodada 2 (Q-N4 prazo legado)', () => {
  it('prazo LEGADO gravado ("A VISTA") é aceito de volta inalterado; prazo novo com lixo continua estrito', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce(OPEN)
      .mockResolvedValueOnce([[{ paymentTypeId: 5, plots: '000', deadline: 'A VISTA' }]]) // gravado pelo sync
      .mockResolvedValueOnce(ENABLED_5)
      .mockResolvedValueOnce([{}])   // upsert mantém o raw
      .mockResolvedValueOnce([{}])   // clearInstallments
    await saveNegotiation(10, { paymentTypeId: 5, deadline: 'A VISTA' }, 'setes_setes', 1)
    expect(conn.commit).toHaveBeenCalled()
    expect(conn.query.mock.calls[3][1]).toEqual([10, 1, 5, '001', 'A VISTA'])

    const conn2 = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn2)
    conn2.query.mockResolvedValueOnce(OPEN)
      .mockResolvedValueOnce([[{ paymentTypeId: 5, plots: '000', deadline: 'A VISTA' }]])
    await expect(saveNegotiation(10, { paymentTypeId: 5, deadline: '30 DIAS' }, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 422, code: 'INVALID_DEADLINE' })
  })
})

describe('getNegotiation / fetchNegotiation', () => {
  it('pedido inexistente → null / 404 ORDER_NOT_FOUND', async () => {
    mockQuery.mockResolvedValueOnce([[]])
    expect(await getNegotiation(99, 'setes_setes', 1)).toBeNull()
    mockQuery.mockResolvedValueOnce([[]])
    await expect(fetchNegotiation(99, scope)).rejects.toMatchObject({ statusCode: 404, code: 'ORDER_NOT_FOUND' })
  })

  it('via SIMPLES: mode derivado, preview GERADO do prazo sobre a base do PEDIDO (nunca gravado), kind da forma exposto', async () => {
    mockQuery
      .mockResolvedValueOnce(OPEN)                                                        // status (venda)
      .mockResolvedValueOnce([[{ paymentTypeId: 5, plots: '002', deadline: '028/056' }]]) // billing
      .mockResolvedValueOnce(BASE_100).mockResolvedValueOnce(FREIGHT_0)                   // base
      .mockResolvedValueOnce([[]])                                                        // installments
      .mockResolvedValueOnce([[{ id: 5, description: 'BOLETO', kind: 'B' }]])            // catálogo
      .mockResolvedValueOnce(ENABLED_5)                                                   // vínculo (maxParcels)
    const n = await getNegotiation(10, 'setes_setes', 1)
    expect(n).toMatchObject({
      orderId: 10, status: 'A', mode: 'simple',
      billing: { paymentTypeId: 5, paymentTypeDescription: 'BOLETO', paymentTypeKind: 'B', maxParcels: 3, deadline: '028/056', deadlineCanonical: '028/056', deadlineValid: true, plots: 2 },
      base: { itemsValue: 100, freight: 0, base: 100 },
      installments: [],
    })
    expect(n!.preview).toHaveLength(2)
    expect(n!.preview.map(p => p.amount)).toEqual([50, 50])
    expect(n!.preview[0]).toMatchObject({ parcel: 1, paymentTypeId: 5, paymentTypeKind: 'B', ownPaymentType: false })
  })

  it('via ELABORADA: mode elaborated, forma herdada resolvida e marcada como não-própria', async () => {
    mockQuery
      .mockResolvedValueOnce(OPEN)
      .mockResolvedValueOnce([[{ paymentTypeId: 5, plots: '002', deadline: '028/056' }]])
      .mockResolvedValueOnce(BASE_100).mockResolvedValueOnce(FREIGHT_0)
      .mockResolvedValueOnce([[
        { parcel: 1, dueDate: '2026-10-01', amount: 60, paymentTypeId: null },
        { parcel: 2, dueDate: '2026-11-01', amount: 40, paymentTypeId: 7 },
      ]])
      .mockResolvedValueOnce([[{ id: 5, description: 'BOLETO', kind: 'B' }, { id: 7, description: 'CHEQUE', kind: 'Q' }]])
      .mockResolvedValueOnce(ENABLED_5)
    const n = await getNegotiation(10, 'setes_setes', 1)
    expect(n!.mode).toBe('elaborated')
    expect(n!.installments).toEqual([
      { parcel: 1, dueDate: '2026-10-01', amount: 60, paymentTypeId: 5, paymentTypeDescription: 'BOLETO', paymentTypeKind: 'B', ownPaymentType: false },
      { parcel: 2, dueDate: '2026-11-01', amount: 40, paymentTypeId: 7, paymentTypeDescription: 'CHEQUE', paymentTypeKind: 'Q', ownPaymentType: true },
    ])
  })

  it('Q-N4/Q-N5: prazo legado vem com deadlineValid=false; pedido FATURADO não tem preview', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ status: 'F' }]])
      .mockResolvedValueOnce([[{ paymentTypeId: 5, plots: '000', deadline: 'A VISTA' }]])
      .mockResolvedValueOnce(BASE_100).mockResolvedValueOnce(FREIGHT_0)
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ id: 5, description: 'BOLETO', kind: 'B' }]])
      .mockResolvedValueOnce(ENABLED_5)
    const n = await getNegotiation(10, 'setes_setes', 1)
    expect(n!.status).toBe('F')
    expect(n!.billing).toMatchObject({ deadline: 'A VISTA', deadlineCanonical: null, deadlineValid: false })
    expect(n!.preview).toEqual([])
  })

  it('sem billing: mode simple, billing null, preview vazio (pedido ainda sem negociação)', async () => {
    mockQuery
      .mockResolvedValueOnce(OPEN)
      .mockResolvedValueOnce([[]])                      // sem tb_order_billing
      .mockResolvedValueOnce(BASE_100).mockResolvedValueOnce(FREIGHT_0)
      .mockResolvedValueOnce([[]])                      // catálogo (ids vazios → sem query? ver abaixo)
    const n = await getNegotiation(10, 'setes_setes', 1)
    expect(n).toMatchObject({ mode: 'simple', billing: null, installments: [], preview: [] })
  })
})
