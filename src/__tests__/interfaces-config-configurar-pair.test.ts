/// <reference types="jest" />
// D-PV25 (regra 5) executada no ESCRITOR do catálogo (gate socrático da costura A1, 2026-11-01): a config que o Super grava na tela
// Interfaces leva o par (interface × CONFIGURAR) na MESMA transação — sem ele a engrenagem some para quem não é admin e a cerca da D-PV51
// grita no boot. Antes do seed 68 (sem o verbo em tb_privilege) não há par a garantir.
jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn() } }))

import pool from '../shared/db/connection'
import { upsertInterfaceConfig } from '../modules/interfaces/interfaces.repository'
import { PRIVILEGE_CONFIGURAR } from '../shared/auth/privileges'

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

function fakeConn(verbAlive: boolean, failOn?: RegExp) {
  const log: string[] = []
  const calls: { sql: string; params: any[] }[] = []
  const conn = {
    beginTransaction: jest.fn(async () => { log.push('BEGIN') }),
    commit: jest.fn(async () => { log.push('COMMIT') }),
    rollback: jest.fn(async () => { log.push('ROLLBACK') }),
    release: jest.fn(() => { log.push('RELEASE') }),
    query: jest.fn(async (sql: string, params: any[] = []) => {
      const t = norm(sql)
      calls.push({ sql: t, params })
      if (failOn?.test(t)) throw new Error('falha simulada')
      if (/FROM setes_central\.tb_privilege/.test(t)) return [verbAlive ? [{ 1: 1 }] : [], []]
      return [{ affectedRows: 1 }, []]
    }),
  }
  ;(pool.getConnection as jest.Mock).mockResolvedValue(conn)
  return { conn, calls, log }
}

const INPUT = { description: 'Itens por página', kind: 'Options', options: '10=10;25=25', defaultContent: '25', scope: 'U' } as any

describe('upsertInterfaceConfig — a config e o CONFIGURAR da interface na mesma transação (D-PV25)', () => {
  it('grava a config, confere o verbo vivo e garante o par (revive o soft-deletado; updated_at só muda se mudou)', async () => {
    const { calls, log } = fakeConn(true)
    await upsertInterfaceConfig(7, 'page_size', INPUT)
    expect(log).toEqual(['BEGIN', 'COMMIT', 'RELEASE'])
    expect(calls).toHaveLength(3)
    expect(calls[0].sql).toMatch(/^INSERT INTO setes_central\.tb_interface_has_config/)
    expect(calls[1]).toEqual({ sql: "SELECT 1 FROM setes_central.tb_privilege WHERE id = ? AND deleted = 'N' AND BINARY description = 'CONFIGURAR'",
      params: [PRIVILEGE_CONFIGURAR] })
    expect(calls[2].sql).toMatch(/^INSERT INTO setes_central\.tb_interface_has_privilege .* VALUES \(\?, \?, 'S', NOW\(\), NOW\(\), 'N'\)/)
    expect(calls[2].sql).toMatch(/ON DUPLICATE KEY UPDATE updated_at = IF\(active = 'S' AND deleted = 'N', updated_at, NOW\(\)\), active = 'S', deleted = 'N'$/)
    expect(calls[2].params).toEqual([7, PRIVILEGE_CONFIGURAR])
  })

  it('sem o verbo CONFIGURAR em tb_privilege (antes do seed 68): só a config', async () => {
    const { calls, log } = fakeConn(false)
    await upsertInterfaceConfig(7, 'page_size', INPUT)
    expect(calls.map(c => c.sql.slice(0, 40))).toHaveLength(2)
    expect(calls.some(c => /tb_interface_has_privilege/.test(c.sql))).toBe(false)
    expect(log).toEqual(['BEGIN', 'COMMIT', 'RELEASE'])
  })

  it('falha no par desfaz a config (nunca config sem o CONFIGURAR)', async () => {
    const { log } = fakeConn(true, /tb_interface_has_privilege/)
    await expect(upsertInterfaceConfig(7, 'page_size', INPUT)).rejects.toThrow('falha simulada')
    expect(log).toEqual(['BEGIN', 'ROLLBACK', 'RELEASE'])
  })
})
