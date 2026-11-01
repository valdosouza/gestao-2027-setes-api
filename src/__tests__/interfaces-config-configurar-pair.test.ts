/// <reference types="jest" />
// D-PV25 (regra 5) executada no ESCRITOR do catálogo (gate socrático da costura A1, 2026-11-01): a config que o Super grava na tela
// Interfaces leva o par (interface × CONFIGURAR) na MESMA transação — sem ele a engrenagem some para quem não é admin e a cerca da D-PV51
// grita no boot. Antes do seed 68 (sem o verbo em tb_privilege) não há par a garantir.
jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn() } }))

import pool from '../shared/db/connection'
import { upsertInterfaceConfig, softDeleteInterfaceConfig } from '../modules/interfaces/interfaces.repository'
import { requiredPairsOf } from '../shared/auth/privilege-catalog'
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

describe('D-PV65 (Valdo 2026-11-01, "Sim, retira junto") — a ÚLTIMA config excluída leva o CONFIGURAR junto (o espelho da criação)', () => {
  it('com retireConfigureIfLast: soft delete da config + retirada do par na MESMA transação; devolve se o par saiu', async () => {
    const { conn, calls, log } = fakeConn(true)
    conn.query.mockImplementation(async (sql: string, params: any[] = []) => {
      calls.push({ sql: norm(sql), params })
      return [{ affectedRows: /tb_interface_has_privilege/.test(sql) ? 1 : 1 }, []]
    })
    expect(await softDeleteInterfaceConfig(7, 'page_size', true)).toEqual({ retiredConfigure: true })
    expect(log).toEqual(['BEGIN', 'COMMIT', 'RELEASE'])
    expect(calls[0].sql).toMatch(/^UPDATE setes_central\.tb_interface_has_config SET deleted = 'S'/)
    expect(calls[1].sql).toMatch(/^UPDATE setes_central\.tb_interface_has_privilege ihp SET ihp\.active = 'N', ihp\.deleted = 'S'/)
    expect(calls[1].sql).toMatch(/BINARY p\.description = 'CONFIGURAR'/)                  // só o verbo com o NOME exato (o cuidado do nascimento)
    expect(calls[1].sql).toMatch(/NOT EXISTS \(SELECT 1 FROM setes_central\.tb_interface_has_config c WHERE c\.tb_interface_id = \? AND c\.deleted = 'N'\)/)
    expect(calls[1].sql).toMatch(/NOT EXISTS \(SELECT 1 FROM setes_central\.tb_interface_has_field f WHERE f\.tb_interface_id = \? AND f\.deleted = 'N'\)/)
    expect(calls[1].params).toEqual([7, PRIVILEGE_CONFIGURAR, 7, 7])
  })

  it('o par não saiu (sobra config/campo — 0 linhas) → retiredConfigure false; sem a marca, só a config', async () => {
    const zero = fakeConn(true)
    zero.conn.query.mockImplementation(async (sql: string) => [{ affectedRows: /tb_interface_has_privilege/.test(sql) ? 0 : 1 }, []])
    expect(await softDeleteInterfaceConfig(7, 'a', true)).toEqual({ retiredConfigure: false })
    const keep = fakeConn(true)
    expect(await softDeleteInterfaceConfig(7, 'a', false)).toEqual({ retiredConfigure: false })
    expect(keep.calls.some(c => /tb_interface_has_privilege/.test(c.sql))).toBe(false)
  })

  it('a decisão de manter usa a peça do catálogo: regra (Configurações Gerais) e código (engrenagem do app) seguram o par; sem consumidor, sai', () => {
    const configure = (k: string) => requiredPairsOf(k, { screen: false, configurable: false }).some(r => r.privilege === 'CONFIGURAR')
    // countries: a engrenagem da fábrica consome o CONFIGURAR (lista à mão) — o par fica e não vira "sobrando"; billing não tem consumidor
    expect([configure('general-configs'), configure('countries'), configure('billing')]).toEqual([true, true, false])
  })
})
