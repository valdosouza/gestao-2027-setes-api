/// <reference types="jest" />
// HIGH da adversarial da Rodada 5 (2026-09-11): o lookup de títulos para emissão de boleto
// tinha fórmula própria de saldo (tag − Σ pago) — 6º consumidor fora da peça única.
import pool from '../shared/db/connection'
import { listOpenTitles } from '../modules/bank-slips/bank-slips.repository'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn() },
}))
const mockQuery = (pool as any).query as jest.Mock

beforeEach(() => jest.clearAllMocks())

describe('listOpenTitles — saldo pela peça única', () => {
  it('usa OPEN_BALANCE_SQL (juros/multa/desconto entram no principal coberto) e só títulos sem boleto vigente', async () => {
    mockQuery.mockResolvedValueOnce([[{ orderId: 10, parcel: 1, balance: 40, openSlips: 0 }]])
    const rows = await listOpenTitles('', null, 'setes_setes', 1)
    const sql = String(mockQuery.mock.calls[0][0])
    expect(sql).toMatch(/GREATEST\(ROUND\(f\.tag_value - [\s\S]*COALESCE\(p\.discount_value, 0\)/)
    expect(sql).not.toMatch(/SUM\(p\.paid_value\), 0\)/)
    expect(sql).toMatch(/x\.balance > 0 AND x\.openSlips = 0/)
    expect(rows).toEqual([{ orderId: 10, parcel: 1, balance: 40 }])
  })
})
