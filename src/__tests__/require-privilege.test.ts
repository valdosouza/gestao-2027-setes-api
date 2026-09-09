/// <reference types="jest" />
// Guard de privilégio de AÇÃO (D12 + Q-P5 do cancelamento, 2026-09-08):
// super/admin passam; usuário regular precisa de tb_user_has_privilege ativo
// para a interface (i18n_key) × privilégio.
import pool from '../shared/db/connection'
import { requirePrivilege, requirePrivilegeFor, userHasPrivilege, resetPrivilegeCache } from '../shared/auth/require-privilege'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}))
const mockQuery = (pool as any).query as jest.Mock

function res() {
  const r: any = { status: jest.fn(() => r), json: jest.fn(() => r) }
  return r
}
beforeEach(() => { jest.clearAllMocks(); resetPrivilegeCache() })

describe('requirePrivilege', () => {
  it('sem JWT → 401', async () => {
    const r = res(); const next = jest.fn()
    await requirePrivilege('orders', 7)({ } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
  it('super e admin passam sem consultar o banco', async () => {
    const next = jest.fn()
    await requirePrivilege('orders', 7)({ institution: { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' } } as any, res(), next)
    await requirePrivilege('orders', 7)({ institution: { institutionId: 2, userId: 9, role: 'admin', schemaName: 'setes_x' } } as any, res(), next)
    expect(next).toHaveBeenCalledTimes(2)
    expect(mockQuery).not.toHaveBeenCalled()
  })
  it('Q-G16: lista de interfaces — passa pelo privilégio em QUALQUER uma (orders sem, service-orders com)', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 29 }]]).mockResolvedValueOnce([[]])          // orders: sem vínculo
      .mockResolvedValueOnce([[{ id: 31 }]]).mockResolvedValueOnce([[{ 1: 1 }]])  // service-orders: com vínculo
    const next = jest.fn()
    await requirePrivilege(['orders', 'service-orders'], 7)({ institution: { institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' } } as any, res(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(mockQuery.mock.calls[3][1]).toEqual([9, 31, 7])
  })
  it('Q-G22: interface resolvida pelo RAMO — OS exige service-orders (quem só tem orders → 403)', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 20 }]]).mockResolvedValueOnce([[]])   // service-orders: sem vínculo
    const r = res(); const next = jest.fn()
    const guard = requirePrivilegeFor(7, async () => 'service-orders')
    await guard({ institution: { institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' }, body: { orderId: 300 } } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(403)
    expect(mockQuery.mock.calls[1][1]).toEqual([9, 20, 7])
    expect(next).not.toHaveBeenCalled()
  })
  it('Q-G16: sem privilégio em nenhuma das interfaces → 403', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 29 }]]).mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ id: 31 }]]).mockResolvedValueOnce([[]])
    const r = res(); const next = jest.fn()
    await requirePrivilege(['orders', 'service-orders'], 7)({ institution: { institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' } } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })
  it('regular COM vínculo passa; interface resolvida por i18n_key e cacheada', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 29 }]]).mockResolvedValueOnce([[{ 1: 1 }]])
    const next = jest.fn()
    await requirePrivilege('orders', 7)({ institution: { institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' } } as any, res(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(mockQuery.mock.calls[1][1]).toEqual([9, 29, 7])
    expect(String(mockQuery.mock.calls[1][0])).toMatch(/`setes_x`.tb_user_has_privilege[\s\S]*active = 'S' AND deleted = 'N'/)
    // segunda chamada: interface vem do cache (só a consulta do vínculo)
    mockQuery.mockResolvedValueOnce([[]])
    expect(await userHasPrivilege('setes_x', 9, 'orders', 5)).toBe(false)
    expect(mockQuery).toHaveBeenCalledTimes(3)
  })
  it('regular SEM vínculo → 403 PRIVILEGE_REQUIRED no envelope do Framework', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 29 }]]).mockResolvedValueOnce([[]])
    const r = res(); const next = jest.fn()
    await requirePrivilege('orders', 7)({ institution: { institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' } } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(403)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PRIVILEGE_REQUIRED', fields: [] }))
    expect(next).not.toHaveBeenCalled()
  })
  it('interface inexistente no catálogo → nega (nunca libera por engano)', async () => {
    mockQuery.mockResolvedValueOnce([[]])
    expect(await userHasPrivilege('setes_x', 9, 'nada', 7)).toBe(false)
  })
})
