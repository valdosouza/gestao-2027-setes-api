/// <reference types="jest" />
// Módulo checks: parseState, 404 no detalhe/ações, e o wiring do
// service para a peça @shared/check (mocada — já coberta em check.test.ts).
import pool from '../shared/db/connection'
import { parseState, fetchCheck } from '../modules/checks/checks.service'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
jest.mock('../shared/check', () => ({
  __esModule: true,
  ...jest.requireActual('../shared/check'),
  reverseCheckEvent: jest.fn(),
  depositCheck: jest.fn(),
}))

const mockQuery = (pool as any).query as jest.Mock
const scope = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }

beforeEach(() => jest.clearAllMocks())

describe('parseState', () => {
  it('aceita os 6 estados e vazio; recusa qualquer outro valor', () => {
    for (const s of ['custody', 'bank', 'factoring', 'supplier', 'refunded', 'collection', '']) {
      expect(parseState(s)).toBe(s)
    }
    expect(() => parseState('xx')).toThrow(expect.objectContaining({ statusCode: 400, code: 'INVALID_STATUS' }))
  })
})

describe('fetchCheck', () => {
  it('404 quando o cheque não existe', async () => {
    mockQuery.mockResolvedValueOnce([[]])
    await expect(fetchCheck(99, scope)).rejects.toMatchObject({ statusCode: 404 })
  })
})
