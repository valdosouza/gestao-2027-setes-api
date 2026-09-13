/// <reference types="jest" />
// Q-A23 (re-prova adversarial final do cancelamento, Valdo 2026-09-10 "sim"): o lock
// da institution espera no máximo N s (FOR UPDATE WAIT n, MariaDB ≥ 10.3) — 1 detentor
// lento não prende mais o pool inteiro por innodb_lock_wait_timeout (50 s).
import pool from '../shared/db/connection'
import {
  lockInstitutionCounters, detectLockWaitSupport, setLockWaitSupported, isLockWaitSupported,
  INSTITUTION_LOCK_WAIT_SECONDS,
} from '../shared/db/counters'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
const mockQuery = (pool as any).query as jest.Mock

beforeEach(() => { jest.clearAllMocks(); setLockWaitSupported(false) })

describe('lockInstitutionCounters — WAIT n', () => {
  it('com suporte: SELECT … FOR UPDATE WAIT <n> na linha da institution', async () => {
    setLockWaitSupported(true)
    const conn = { query: jest.fn().mockResolvedValue([{}]) }
    await lockInstitutionCounters(conn as any, 1)
    expect(conn.query).toHaveBeenCalledWith(
      `SELECT id FROM setes_central.tb_institution WHERE id = ? FOR UPDATE WAIT ${INSTITUTION_LOCK_WAIT_SECONDS}`, [1])
  })
  it('sem suporte: FOR UPDATE puro (timeout global do servidor)', async () => {
    const conn = { query: jest.fn().mockResolvedValue([{}]) }
    await lockInstitutionCounters(conn as any, 1)
    expect(conn.query).toHaveBeenCalledWith('SELECT id FROM setes_central.tb_institution WHERE id = ? FOR UPDATE', [1])
  })
  it('detecta MariaDB ≥ 10.3 (10.4.20 sim; 10.2 não; MySQL 8 não)', async () => {
    mockQuery.mockResolvedValueOnce([[{ v: '10.4.20-MariaDB' }]])
    expect(await detectLockWaitSupport()).toBe(true)
    expect(isLockWaitSupported()).toBe(true)
    mockQuery.mockResolvedValueOnce([[{ v: '10.2.9-MariaDB' }]])
    expect(await detectLockWaitSupport()).toBe(false)
    mockQuery.mockResolvedValueOnce([[{ v: '8.0.36' }]])
    expect(await detectLockWaitSupport()).toBe(false)
    expect(isLockWaitSupported()).toBe(false)
  })
})
