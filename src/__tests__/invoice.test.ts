/// <reference types="jest" />
// Peça @shared/invoice (prompt_cancelamento_nota.md D3/D4/D5/D17 + parecer
// setes-conceito, 2026-09-08): nota = documento com história; estado
// derivado do último evento; E nasce no faturamento com snapshot; número
// MAX+1 ignora canceladas; cabeçalho e ramos REVIVEM por upsert.
import {
  stateFromLastEvent, nextInvoiceNumber, issueInvoice, insertInvoiceEvent, lockInvoice,
} from '../shared/invoice'

function fakeConn() { return { query: jest.fn() } }
beforeEach(() => jest.clearAllMocks())

describe('stateFromLastEvent', () => {
  it('C = cancelada; E ou sem evento (sincronizada) = emitida', () => {
    expect(stateFromLastEvent('C')).toBe('cancelled')
    expect(stateFromLastEvent('E')).toBe('issued')
    expect(stateFromLastEvent(null)).toBe('issued')
  })
})

describe('nextInvoiceNumber (D4)', () => {
  it('MAX+1 por modelo+série IGNORA notas canceladas (deleted=S) e trava a leitura', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{ nextNumber: 12 }]])
    const n = await nextInvoiceNumber(conn as any, 'setes_setes', 1, '55', '1')
    expect(n).toBe('12')
    const sql = String(conn.query.mock.calls[0][0])
    expect(sql).toMatch(/deleted = 'N'/)
    expect(sql).toMatch(/FOR UPDATE/)
    expect(conn.query.mock.calls[0][1]).toEqual([1, '55', '1'])
  })
})

describe('issueInvoice', () => {
  it('cabeçalho por upsert (REVIVE), ramos por PRESENÇA, evento E com snapshot', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ nextNumber: 7 }]]) // MAX+1
      .mockResolvedValueOnce([{}])                  // tb_invoice upsert
      .mockResolvedValueOnce([{}])                  // merchandise upsert
      .mockResolvedValueOnce([{}])                  // service → deleted='S' (ausente nesta vida)
      .mockResolvedValueOnce([[{ nextEvent: 3 }]]) // MAX(event)+1 (2ª vida: E1, C2, E3)
      .mockResolvedValueOnce([{}])                  // INSERT evento
    const r = await issueInvoice(conn as any, 'setes_setes', 1, 7, {
      orderId: 100, recipientEntityId: 209, model: '55', serie: '1', totalValue: 250,
      noteText: 'obs', merchandise: {
        baseIcms: 250, icms: 45, baseIcmsSt: 0, icmsSt: 0, ipi: 0, totalValue: 250,
        freight: 0, expenses: 0, discount: 0, quantity: 2,
      }, serviceTotal: null, dtRecord: '2026-09-08',
    })
    expect(r).toEqual({ invoiceNumber: '7', event: 3 })
    const sqls = conn.query.mock.calls.map(c => String(c[0]))
    expect(sqls[1]).toMatch(/INSERT INTO `setes_setes`.tb_invoice[\s\S]*ON DUPLICATE KEY UPDATE[\s\S]*deleted = 'N'/)
    expect(conn.query.mock.calls[1][1]).toEqual([100, 1, 1, '7', '1', 209, 250, '55', 'obs'])
    expect(sqls[2]).toMatch(/tb_invoice_merchandise[\s\S]*ON DUPLICATE KEY UPDATE/)
    expect(sqls[3]).toMatch(/UPDATE `setes_setes`.tb_invoice_service SET deleted = 'S'/)
    expect(sqls[5]).toMatch(/INSERT INTO `setes_setes`.tb_invoice_event/)
    // snapshot do fato: número/série/modelo/valor + autor
    expect(conn.query.mock.calls[5][1]).toEqual([1, 100, 3, 'E', '2026-09-08', '7', '1', '55', 250, null, null, 7])
  })

  it('nota SÓ de serviço: ramo de mercadoria vira S, serviço upsert', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ nextNumber: 1 }]])
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ nextEvent: 1 }]]).mockResolvedValueOnce([{}])
    await issueInvoice(conn as any, 'setes_setes', 1, 7, {
      orderId: 101, recipientEntityId: 209, model: 'SE', serie: '1', totalValue: 80,
      noteText: null, merchandise: null, serviceTotal: 80,
    })
    const sqls = conn.query.mock.calls.map(c => String(c[0]))
    expect(sqls[2]).toMatch(/UPDATE `setes_setes`.tb_invoice_merchandise SET deleted = 'S'/)
    expect(sqls[3]).toMatch(/tb_invoice_service[\s\S]*ON DUPLICATE KEY UPDATE total_value/)
  })
})

describe('insertInvoiceEvent / lockInvoice', () => {
  it('C guarda motivo, origem e o snapshot; autor pode ser NULL (retroativo)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{ nextEvent: 2 }]]).mockResolvedValueOnce([{}])
    const ev = await insertInvoiceEvent(conn as any, 'setes_setes', 1, 100, null, {
      kind: 'C', dtRecord: '2026-09-08', note: 'x'.repeat(300), originEvent: 1,
      snapshot: { number: '7', serie: '1', model: '55', value: 250 },
    })
    expect(ev).toBe(2)
    const params = conn.query.mock.calls[1][1]
    expect(params.slice(0, 5)).toEqual([1, 100, 2, 'C', '2026-09-08'])
    expect(params[9]).toBe(1)              // origin_event
    expect(String(params[10])).toHaveLength(255) // note cortada
    expect(params[11]).toBeNull()          // autor
  })

  it('lockInvoice: 404 quando a nota não existe ou está soft-deletada; devolve o último evento', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]])
    await expect(lockInvoice(conn as any, 'setes_setes', 1, 5))
      .rejects.toMatchObject({ statusCode: 404, code: 'INVOICE_NOT_FOUND' })
    conn.query.mockResolvedValueOnce([[{ id: 5, number: '9', serie: '1', model: '55', value: '10.00', status: '0' }]])
      .mockResolvedValueOnce([[{ event: 2, kind: 'C' }]])
    const inv = await lockInvoice(conn as any, 'setes_setes', 1, 5)
    expect(inv).toMatchObject({ id: 5, number: '9', value: 10, lastEvent: 2, lastKind: 'C' })
    expect(String(conn.query.mock.calls[1][0])).toMatch(/deleted = 'N' FOR UPDATE/)
  })
})
