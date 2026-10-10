/// <reference types="jest" />
// D-IB26 (fase IBS/CBS — gate socrático da IB-1): o boot confere que o motor APLICA CHECK
// (molde da D-F45 da fiscal-api). Sem esta conferência, a "guarda" do catálogo e das colunas
// congeladas era um comentário: MySQL < 8.0.16 aceita o CHECK e o ignora em silêncio.
import { assertCheckConstraintsEnforced } from '@shared/db/connection'

const poolWith = (insert: () => Promise<unknown>) => {
  const conn = { beginTransaction: jest.fn(), rollback: jest.fn(), release: jest.fn(), query: jest.fn(async () => insert()) }
  return { conn, pool: { getConnection: jest.fn(async () => conn) } as any }
}

describe('D-IB26 — boot confere que o motor aplica CHECK', () => {
  it('o banco RECUSA a NBS fora do formato (MariaDB 4025 / MySQL 3819) → boot segue; a transação é sempre desfeita', async () => {
    for (const errno of [4025, 3819]) {
      const { conn, pool } = poolWith(async () => { throw Object.assign(new Error('CONSTRAINT `ck_nbs_code` failed'), { errno }) })
      await expect(assertCheckConstraintsEnforced(pool)).resolves.toBe('aplicado')
      expect(conn.rollback).toHaveBeenCalledTimes(1)
      expect(conn.release).toHaveBeenCalledTimes(1)
    }
  })

  it('o banco ACEITA (motor que ignora CHECK) → boot FALHA ALTO, e nada fica gravado (rollback)', async () => {
    const { conn, pool } = poolWith(async () => [{ affectedRows: 1 }])
    await expect(assertCheckConstraintsEnforced(pool)).rejects.toThrow(/não aplica CHECK/)
    expect(conn.rollback).toHaveBeenCalledTimes(1)
  })

  it('outro erro (tabela ausente — script sql/61 não aplicado; sem permissão) sobe como está', async () => {
    const { pool } = poolWith(async () => { throw Object.assign(new Error("Table 'setes_central.tb_nbs' doesn't exist"), { errno: 1146 }) })
    await expect(assertCheckConstraintsEnforced(pool)).rejects.toMatchObject({ errno: 1146 })
  })
})
