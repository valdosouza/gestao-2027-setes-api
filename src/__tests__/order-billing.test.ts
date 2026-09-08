/// <reference types="jest" />
// Peça @shared/order-billing (prompt_negociacao_pedido.md D2/§6): COMO o
// pedido será cobrado — forma + prazo RELATIVO (string livre, decisão 31).
// Leitura tolerante (parseDeadline, dado do sync) × gravação estrita
// (normalizeDeadline, parecer Q3); plots DERIVADO na venda, informado na OS.
import {
  parseDeadline, normalizeDeadline, MAX_DEADLINE_DAYS, getOrderBilling, upsertOrderBilling,
} from '../shared/order-billing'

function fakeConn() { return { query: jest.fn() } }

describe('parseDeadline (leitura tolerante)', () => {
  it('"028/056/084" → dias; vazio/lixo total = à vista; acima do teto = null', () => {
    expect(parseDeadline('028/056/084')).toEqual([28, 56, 84])
    expect(parseDeadline('')).toEqual([0])
    expect(parseDeadline(null)).toEqual([0])
    expect(parseDeadline('A VISTA')).toEqual([0])
    expect(parseDeadline('28/5x/84')).toEqual([28, 5, 84]) // tolerante — só para LER
    expect(parseDeadline(`${MAX_DEADLINE_DAYS + 1}`)).toBeNull()
  })
})

describe('normalizeDeadline (gravação estrita — parecer Q3)', () => {
  it('canoniza para 3 dígitos separados por "/"', () => {
    expect(normalizeDeadline('28/56/84')).toEqual({ valid: true, deadline: '028/056/084', days: [28, 56, 84] })
    expect(normalizeDeadline(' 30 , 60 ')).toEqual({ valid: true, deadline: '030/060', days: [30, 60] })
  })
  it('vazio, null ou só "0" = à vista → deadline NULL, 1 parcela', () => {
    for (const v of ['', null, undefined, '0', '000']) {
      expect(normalizeDeadline(v)).toEqual({ valid: true, deadline: null, days: [0] })
    }
  })
  it('recusa texto, parte não numérica e prazo acima do teto (o erro nasce na negociação)', () => {
    expect(normalizeDeadline('A VISTA').valid).toBe(false)
    expect(normalizeDeadline('28/5x/84').valid).toBe(false)
    expect(normalizeDeadline('28//56').valid).toBe(false)
    expect(normalizeDeadline(`${MAX_DEADLINE_DAYS + 1}`).valid).toBe(false)
  })
})

describe('getOrderBilling', () => {
  it('mapeia plots/deadline; inexistente → null', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{ paymentTypeId: 5, plots: '002', deadline: '028/056' }]])
    expect(await getOrderBilling(conn as any, 'setes_setes', 1, 10))
      .toEqual({ paymentTypeId: 5, plots: 2, deadline: '028/056' })
    conn.query.mockResolvedValueOnce([[{ paymentTypeId: 5, plots: null, deadline: '' }]])
    expect(await getOrderBilling(conn as any, 'setes_setes', 1, 10))
      .toEqual({ paymentTypeId: 5, plots: null, deadline: null })
    conn.query.mockResolvedValueOnce([[]])
    expect(await getOrderBilling(conn as any, 'setes_setes', 1, 10)).toBeNull()
  })
})

describe('upsertOrderBilling (1:1 por PK compartilhada)', () => {
  it('venda: plots DERIVADO do prazo (M3 — nunca input livre)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([{}])
    await upsertOrderBilling(conn as any, 'setes_setes', 1, 10, { paymentTypeId: 5, deadline: '028/056' })
    const [sql, params] = conn.query.mock.calls[0]
    expect(sql).toContain('ON DUPLICATE KEY UPDATE')
    expect(params).toEqual([10, 1, 5, '002', '028/056'])
  })
  it('à vista (deadline NULL) → plots "001"', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([{}])
    await upsertOrderBilling(conn as any, 'setes_setes', 1, 10, { paymentTypeId: 5, deadline: null })
    expect(conn.query.mock.calls[0][1]).toEqual([10, 1, 5, '001', null])
  })
  it('OS informa plots (contrato) com deadline NULL — comportamento inalterado (D2)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([{}])
    await upsertOrderBilling(conn as any, 'setes_setes', 1, 10, { paymentTypeId: 5, deadline: null, plots: 3 })
    expect(conn.query.mock.calls[0][1]).toEqual([10, 1, 5, '003', null])
  })
})
