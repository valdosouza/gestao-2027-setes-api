/// <reference types="jest" />
// Peça @shared/order-installment (prompt_negociacao_pedido.md D2 emendada/§6):
// parcela COMBINADA (data/valor absolutos, forma própria opcional), puras de
// materialização e a COMPOSIÇÃO resolveOrderParcels (decisão 25 + D7: no
// elaborado a soma é validada contra a base do PEDIDO e a diferença até a
// base da NOTA entra na 1ª parcela; sem elaborado o prazo gera).
import {
  parcelQuotas, addDays, materializeParcels, getInstallments, replaceInstallments,
  clearInstallments, resolveOrderParcels,
} from '../shared/order-installment'

function fakeConn() { return { query: jest.fn() } }
const BILLING = [{ paymentTypeId: 5, plots: '002', deadline: '028/056' }]
const BASE_100 = [{ quantity: 1, unitValue: 100, discountValue: 0, setFinancial: 'S' }]

describe('puras', () => {
  it('parcelQuotas: resíduo de centavos na ÚLTIMA (FIN-03)', () => {
    expect(parcelQuotas(100, 3)).toEqual([33.33, 33.33, 33.34])
    expect(parcelQuotas(300, 3)).toEqual([100, 100, 100])
  })
  it('addDays formata em data LOCAL', () => {
    expect(addDays(new Date(2026, 8, 6), 28)).toBe('2026-10-04')
    expect(addDays(new Date(2026, 11, 31), 1)).toBe('2027-01-01')
  })
  it('materializeParcels: base 0 ou sem dias = nada; senão 1..n com a forma do cabeçalho', () => {
    expect(materializeParcels({ days: [0, 30], base: 0, baseDate: new Date(2026, 8, 6), paymentTypeId: 5 })).toEqual([])
    expect(materializeParcels({ days: [], base: 100, baseDate: new Date(2026, 8, 6), paymentTypeId: 5 })).toEqual([])
    expect(materializeParcels({ days: [0, 30], base: 100, baseDate: new Date(2026, 8, 6), paymentTypeId: 5 })).toEqual([
      { parcel: 1, dueDate: '2026-09-06', amount: 50, paymentTypeId: 5 },
      { parcel: 2, dueDate: '2026-10-06', amount: 50, paymentTypeId: 5 },
    ])
  })
})

describe('getInstallments / replaceInstallments / clearInstallments', () => {
  it('lê ordenado por parcela com forma NULL preservada (referência — M2)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[
      { parcel: 1, dueDate: '2026-10-01', amount: '60.00', paymentTypeId: null },
      { parcel: 2, dueDate: '2026-11-01', amount: '40.00', paymentTypeId: 7 },
    ]])
    expect(await getInstallments(conn as any, 'setes_setes', 1, 10)).toEqual([
      { parcel: 1, dueDate: '2026-10-01', amount: 60, paymentTypeId: null },
      { parcel: 2, dueDate: '2026-11-01', amount: 40, paymentTypeId: 7 },
    ])
  })
  it('replace = upsert das enviadas + deleted=S nas ausentes (padrão syncAddresses, nunca DELETE)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValue([{}])
    await replaceInstallments(conn as any, 'setes_setes', 1, 10, [
      { parcel: 1, dueDate: '2026-10-01', amount: 60, paymentTypeId: null },
      { parcel: 2, dueDate: '2026-11-01', amount: 40, paymentTypeId: 7 },
    ])
    expect(conn.query).toHaveBeenCalledTimes(3)
    expect(conn.query.mock.calls[0][0]).toContain('ON DUPLICATE KEY UPDATE')
    expect(conn.query.mock.calls[0][1]).toEqual([1, 10, 1, '2026-10-01', 60, null])
    const [sql, params] = conn.query.mock.calls[2]
    expect(sql).toContain("SET deleted = 'S'")
    expect(sql).toContain('NOT IN (?,?)')
    expect(sql).not.toMatch(/\bDELETE\b/)
    expect(params).toEqual([10, 1, 1, 2])
  })
  it('clear = "voltar ao prazo": um UPDATE soft em todas', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([{}])
    await clearInstallments(conn as any, 'setes_setes', 1, 10)
    expect(conn.query).toHaveBeenCalledTimes(1)
    expect(conn.query.mock.calls[0][0]).toContain("SET deleted = 'S'")
  })
})

describe('resolveOrderParcels (composição — única fonte da tela e do faturamento)', () => {
  const baseDate = new Date(2026, 8, 6)

  it('financeiro > 0 sem billing → 422 ORDER_NO_BILLING', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]])
    await expect(resolveOrderParcels(conn as any, 'setes_setes', 1, 10, { noteBase: 100, baseDate }))
      .rejects.toMatchObject({ statusCode: 422, code: 'ORDER_NO_BILLING' })
  })

  it('financeiro 0 → mode none, sem parcelas', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([BILLING])
    expect(await resolveOrderParcels(conn as any, 'setes_setes', 1, 10, { noteBase: 0, baseDate }))
      .toEqual({ mode: 'none', parcels: [], paymentTypeId: 5 })
  })

  it('via SIMPLES: o prazo gera sobre a base da NOTA a partir da data base', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([BILLING]).mockResolvedValueOnce([[]]) // sem elaborado
      .mockResolvedValueOnce([[{ id: 5, description: 'BOLETO', kind: 'O', maxParcels: 6 }]]) // assertPaymentRules (Q-N1)
    const r = await resolveOrderParcels(conn as any, 'setes_setes', 1, 10, { noteBase: 118, baseDate })
    expect(r.mode).toBe('simple')
    expect(r.parcels).toEqual([
      { parcel: 1, dueDate: '2026-10-04', amount: 59, paymentTypeId: 5 },
      { parcel: 2, dueDate: '2026-11-01', amount: 59, paymentTypeId: 5 },
    ])
    expect(conn.query).toHaveBeenCalledTimes(3) // base do PEDIDO NÃO é lida na via simples (billing, installments, formas)
  })

  it('via SIMPLES com prazo acima do teto → 422 INVALID_DEADLINE', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{ paymentTypeId: 5, plots: '001', deadline: '5000' }]])
      .mockResolvedValueOnce([[]])
    await expect(resolveOrderParcels(conn as any, 'setes_setes', 1, 10, { noteBase: 100, baseDate }))
      .rejects.toMatchObject({ statusCode: 422, code: 'INVALID_DEADLINE' })
  })

  it('ELABORADO: soma ≠ base do PEDIDO (não da nota) → 422 INSTALLMENT_MISMATCH', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([BILLING])
      .mockResolvedValueOnce([[{ parcel: 1, dueDate: '2026-10-01', amount: 40, paymentTypeId: null },
        { parcel: 2, dueDate: '2026-11-01', amount: 40, paymentTypeId: null }]])
      .mockResolvedValueOnce([BASE_100]).mockResolvedValueOnce([[{ freight: 0 }]])
    await expect(resolveOrderParcels(conn as any, 'setes_setes', 1, 10, { noteBase: 118, baseDate }))
      .rejects.toMatchObject({ statusCode: 422, code: 'INSTALLMENT_MISMATCH',
        fields: [{ field: 'installments', message: 'Parcelamento 80 difere do valor atual da ordem 100' }] })
  })

  it('ELABORADO ok: usa cada parcela como negociada, forma NULL herda o cabeçalho e a diferença da NOTA entra na 1ª (D7)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([BILLING])
      .mockResolvedValueOnce([[{ parcel: 1, dueDate: '2026-10-01', amount: 60, paymentTypeId: null },
        { parcel: 2, dueDate: '2026-11-01', amount: 40, paymentTypeId: 7 }]])
      .mockResolvedValueOnce([BASE_100]).mockResolvedValueOnce([[{ freight: 0 }]])
      .mockResolvedValueOnce([[{ id: 5, description: 'BOLETO', kind: 'O', maxParcels: 6 },
        { id: 7, description: 'CHEQUE', kind: 'Q', maxParcels: 6 }]]) // assertPaymentRules (Q-N1)
    const r = await resolveOrderParcels(conn as any, 'setes_setes', 1, 10, { noteBase: 118, baseDate })
    expect(r.mode).toBe('elaborated')
    expect(r.parcels).toEqual([
      { parcel: 1, dueDate: '2026-10-01', amount: 78, paymentTypeId: 5 }, // 60 + 18 (ST/IPI/despesas)
      { parcel: 2, dueDate: '2026-11-01', amount: 40, paymentTypeId: 7 },
    ])
  })

  it('Q-N1(b): forma desabilitada DEPOIS da negociação não fatura (400 PAYMENT_TYPE_UNAVAILABLE)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([BILLING]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]) // vínculo desabilitado
    await expect(resolveOrderParcels(conn as any, 'setes_setes', 1, 10, { noteBase: 100, baseDate }))
      .rejects.toMatchObject({ statusCode: 400, code: 'PAYMENT_TYPE_UNAVAILABLE' })
  })

  it('Q-N1(a): parcelas com forma PRÓPRIA contam contra o max_parcels DELA (cabeçalho max 6, cheque max 1 em 2 parcelas → 422 com expected)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([BILLING])
      .mockResolvedValueOnce([[{ parcel: 1, dueDate: '2026-10-01', amount: 50, paymentTypeId: 7 },
        { parcel: 2, dueDate: '2026-11-01', amount: 50, paymentTypeId: 7 }]])
      .mockResolvedValueOnce([BASE_100]).mockResolvedValueOnce([[{ freight: 0 }]])
      .mockResolvedValueOnce([[{ id: 5, description: 'BOLETO', kind: 'O', maxParcels: 6 },
        { id: 7, description: 'CHEQUE', kind: 'Q', maxParcels: 1 }]])
    await expect(resolveOrderParcels(conn as any, 'setes_setes', 1, 10, { noteBase: 100, baseDate }))
      .rejects.toMatchObject({ statusCode: 422, code: 'MAX_PARCELS_EXCEEDED',
        fields: [{ field: 'installments', expected: 1 }] })
  })

  it('Q-N1(c): max_parcels 0 vale 1 (só chega por SQL/sync)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([BILLING]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ id: 5, description: 'BOLETO', kind: 'O', maxParcels: 0 }]])
    await expect(resolveOrderParcels(conn as any, 'setes_setes', 1, 10, { noteBase: 100, baseDate }))
      .rejects.toMatchObject({ statusCode: 422, code: 'MAX_PARCELS_EXCEEDED', fields: [{ field: 'deadline', expected: 1 }] })
  })

  it('ELABORADO: diferença negativa que anula a 1ª parcela → 422 (renegociar)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([BILLING])
      .mockResolvedValueOnce([[{ parcel: 1, dueDate: '2026-10-01', amount: 10, paymentTypeId: null },
        { parcel: 2, dueDate: '2026-11-01', amount: 90, paymentTypeId: null }]])
      .mockResolvedValueOnce([BASE_100]).mockResolvedValueOnce([[{ freight: 0 }]])
      .mockResolvedValueOnce([[{ id: 5, description: 'BOLETO', kind: 'O', maxParcels: 6 }]]) // assertPaymentRules (Q-N1)
    await expect(resolveOrderParcels(conn as any, 'setes_setes', 1, 10, { noteBase: 80, baseDate }))
      .rejects.toMatchObject({ statusCode: 422, code: 'INSTALLMENT_MISMATCH' })
  })
})
