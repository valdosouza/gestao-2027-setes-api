/// <reference types="jest" />
// Q-CH1 (2026-09-08): convenção ÚNICA de estorno do extrato para movimentos
// SEM título (cheque B/D/T) — espelho 'R' com origem, dt_record HERDADO da
// original (D-G3), dt_original = fato gerador, original vira 'E'.
import { reverseStatementLines, mirrorStatementLine } from '../shared/financial-settlement/statement-reversal'

jest.mock('../shared/financial-settlement', () => ({
  __esModule: true,
  ...jest.requireActual('../shared/financial-settlement'),
  insertStatement: jest.fn(),
  nextSettledCode: jest.fn(),
}))
const fs = jest.requireMock('../shared/financial-settlement') as any

function fakeConn() { return { query: jest.fn() } }
beforeEach(() => jest.clearAllMocks())

const LINES = [
  { id: 30, bankAccountId: 0, cashierId: 42, dtRecord: '2026-09-01', creditValue: '0.00', debitValue: '40.00',
    history: 'Depósito cheque X', paymentTypeId: null, planCre: 0, planDeb: 0 },
  { id: 31, bankAccountId: 3, cashierId: null, dtRecord: '2026-09-01', creditValue: '40.00', debitValue: '0.00',
    history: 'Depósito cheque X', paymentTypeId: null, planCre: 0, planDeb: 0 },
]

describe('reverseStatementLines', () => {
  it('espelha cada linha viva com R + origem, herda dt_record, marca a original E e devolve o código novo', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([LINES]) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]) // UPDATE 'E' × 2
    fs.nextSettledCode.mockResolvedValueOnce(108)
    fs.insertStatement.mockResolvedValueOnce(90).mockResolvedValueOnce(91)

    const code = await reverseStatementLines(conn as any, 'setes_setes', 1, 7, 107, 'conta errada', '2026-09-08')
    expect(code).toBe(108)

    // SELECT exclui o que já é estorno ou já foi estornado
    expect(conn.query.mock.calls[0][0]).toMatch(/status NOT IN \('R', 'E'\)/)
    expect(conn.query.mock.calls[0][1]).toEqual([1, 107])

    expect(fs.insertStatement).toHaveBeenCalledTimes(2)
    expect(fs.insertStatement.mock.calls[0][3]).toMatchObject({
      bankAccountId: 0, cashierId: 42, credit: 40, debit: 0, // inverteu
      dtRecord: '2026-09-01', dtOriginal: '2026-09-08',      // herdou / fato gerador
      status: 'R', originId: 30, settledCode: 108, userId: 7,
      history: 'Estorno: conta errada',
    })
    expect(fs.insertStatement.mock.calls[1][3]).toMatchObject({
      bankAccountId: 3, cashierId: null, credit: 0, debit: 40, status: 'R', originId: 31,
    })
    // originais viram 'E'
    expect(conn.query.mock.calls[1][0]).toMatch(/SET status = 'E'/)
    expect(conn.query.mock.calls[1][1]).toEqual([1, 30])
    expect(conn.query.mock.calls[2][1]).toEqual([1, 31])
  })

  it('sem linha viva: ainda minta o código (identificador do evento X) e não grava nada', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]])
    fs.nextSettledCode.mockResolvedValueOnce(109)
    const code = await reverseStatementLines(conn as any, 'setes_setes', 1, 7, 107, 'x')
    expect(code).toBe(109)
    expect(fs.insertStatement).not.toHaveBeenCalled()
    expect(conn.query).toHaveBeenCalledTimes(1)
  })

  it('dt_original omitido = hoje; linha sem dt_record herda a data do fato gerador', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{ ...LINES[0], dtRecord: null }]]).mockResolvedValueOnce([{}])
    fs.nextSettledCode.mockResolvedValueOnce(110)
    fs.insertStatement.mockResolvedValueOnce(92)
    await reverseStatementLines(conn as any, 'setes_setes', 1, 7, 107, 'x')
    const line = fs.insertStatement.mock.calls[0][3]
    expect(line.dtOriginal).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(line.dtRecord).toBe(line.dtOriginal)
  })
})

describe('mirrorStatementLine', () => {
  it('corta o histórico em 100 e devolve o id do espelho', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([{}])
    fs.insertStatement.mockResolvedValueOnce(77)
    const id = await mirrorStatementLine(conn as any, 'setes_setes', 1, 7, LINES[0], {
      reversalCode: 5, history: 'Estorno: ' + 'x'.repeat(200), dtOriginal: '2026-09-08',
    })
    expect(id).toBe(77)
    expect(fs.insertStatement.mock.calls[0][3].history).toHaveLength(100)
  })
})
