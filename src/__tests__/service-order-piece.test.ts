/// <reference types="jest" />
// Peça @shared/service-order (Q-G3): reabertura da OS no cancelamento da nota —
// leitura sob lock + trava D5 (1 OS aberta por cliente) conferida e restaurada.
import { findServiceOrderForReopen, reopenServiceOrder, openLockOf } from '../shared/service-order'

function fakeConn() { return { query: jest.fn() } }

describe('findServiceOrderForReopen', () => {
  it('pedido de VENDA (sem tb_order_service) → null com UMA leitura travante', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]])
    expect(await findServiceOrderForReopen(conn as any, 'setes_setes', 1, 100)).toBeNull()
    expect(conn.query).toHaveBeenCalledTimes(1)
    // D-G11 (047): a identidade da OS é a EXISTÊNCIA do ciclo — lido sob lock,
    // com o tomador vindo da natureza; nada de "ausência de tb_order_sale"
    expect(String(conn.query.mock.calls[0][0])).toMatch(/FROM `setes_setes`\.tb_service_order c[\s\S]*JOIN `setes_setes`\.tb_order_service so[\s\S]*FOR UPDATE/)
    expect(String(conn.query.mock.calls[0][0])).not.toMatch(/tb_order_sale/)
  })
  it('OS: devolve a trava a restaurar e a OUTRA OS aberta do cliente (se houver), ambas sob lock', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[{ customerId: 55 }]]).mockResolvedValueOnce([[{ id: 7001 }]])
    expect(await findServiceOrderForReopen(conn as any, 'setes_setes', 1, 100))
      .toEqual({ customerId: 55, openLock: '1-55', blockingOrderId: 7001 })
    expect(String(conn.query.mock.calls[1][0])).toMatch(/open_lock = \? AND deleted = 'N' AND id <> \?[\s\S]*FOR UPDATE/)
    expect(conn.query.mock.calls[1][1]).toEqual([1, '1-55', 100])
    conn.query.mockResolvedValueOnce([[{ customerId: 55 }]]).mockResolvedValueOnce([[]])
    expect((await findServiceOrderForReopen(conn as any, 'setes_setes', 1, 100))!.blockingOrderId).toBeNull()
  })
  it('openLockOf = mesma composição do módulo (institution-cliente)', () => {
    expect(openLockOf(1, 55)).toBe('1-55')
  })
})

describe('reopenServiceOrder', () => {
  it('restaura open_lock da OS viva', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([{}])
    await reopenServiceOrder(conn as any, 'setes_setes', 1, 100, '1-55')
    expect(String(conn.query.mock.calls[0][0])).toMatch(/UPDATE `setes_setes`\.tb_service_order SET open_lock = \?/)
    expect(conn.query.mock.calls[0][1]).toEqual(['1-55', 100, 1])
  })
  it('trava ocupada na execução (ER_DUP_ENTRY) → 409 SERVICE_ORDER_CUSTOMER_OPEN, nunca 500', async () => {
    const conn = fakeConn()
    conn.query.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }))
    await expect(reopenServiceOrder(conn as any, 'setes_setes', 1, 100, '1-55'))
      .rejects.toMatchObject({ statusCode: 409, code: 'SERVICE_ORDER_CUSTOMER_OPEN' })
  })
})
