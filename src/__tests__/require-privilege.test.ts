/// <reference types="jest" />
// Guard de privilégio de AÇÃO (D12 + Q-P5 do cancelamento, 2026-09-08):
// super/admin passam o PRIVILÉGIO; usuário regular precisa de tb_user_has_privilege ativo
// para a interface (i18n_key) × privilégio.
// D-F37 (F2a, etapa A2 — prompt_apis_fiscais_isoladas.md §22.9): a LICENÇA (interface contratada em
// tb_institution_has_interface) vale para TODOS — admin e super passam só o privilégio, nunca a licença.
import pool from '../shared/db/connection'
import {
  requirePrivilege, requirePrivilegeFor, requireInterfaceFor, userHasPrivilege, institutionHasInterface, resetPrivilegeCache,
} from '../shared/auth/require-privilege'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}))
const mockQuery = (pool as any).query as jest.Mock

/** Banco de mentira roteado pelo SQL: catálogo central (i18n_key → id), contrato da institution e vínculos do usuário. */
const CATALOG: Record<string, number> = { orders: 29, 'service-orders': 20, 'order-returns': 31, settlements: 21 }
let contracted: Set<number>
let privileged: Set<string>                         // `${userId}:${interfaceId}:${privilegeId}`
function routeDb(): void {
  mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
    if (/FROM setes_central\.tb_interface WHERE i18n_key/.test(sql)) {
      const id = CATALOG[String(params[0])]
      return [id ? [{ id }] : []]
    }
    if (/tb_institution_has_interface/.test(sql)) return [contracted.has(Number(params[1])) ? [{ 1: 1 }] : []]
    if (/tb_user_has_privilege/.test(sql)) return [privileged.has(`${params[0]}:${params[1]}:${params[2]}`) ? [{ 1: 1 }] : []]
    throw new Error(`SQL inesperado: ${sql}`)
  })
}
const sqlCalls = (re: RegExp) => mockQuery.mock.calls.filter(c => re.test(String(c[0])))

function res() {
  const r: any = { status: jest.fn(() => r), json: jest.fn(() => r) }
  return r
}
const SUPER = { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' }
const ADMIN = { institutionId: 2, userId: 9, role: 'admin', schemaName: 'setes_x' }
const USER = { institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' }

beforeEach(() => {
  jest.clearAllMocks(); resetPrivilegeCache()
  contracted = new Set(Object.values(CATALOG)); privileged = new Set()
  routeDb()
})

describe('requirePrivilege', () => {
  it('sem JWT → 401', async () => {
    const r = res(); const next = jest.fn()
    await requirePrivilege('orders', 7)({ } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
  it('super e admin passam o PRIVILÉGIO (sem consultar vínculo); só o admin consulta o contrato (A-PV1)', async () => {
    const next = jest.fn()
    await requirePrivilege('orders', 7)({ institution: SUPER } as any, res(), next)
    await requirePrivilege('orders', 7)({ institution: ADMIN } as any, res(), next)
    expect(next).toHaveBeenCalledTimes(2)
    expect(sqlCalls(/tb_user_has_privilege/)).toHaveLength(0)
    expect(sqlCalls(/tb_institution_has_interface/).map(c => c[1])).toEqual([[2, 29]])
  })
  it('Q-G16: lista de interfaces — passa pelo privilégio em QUALQUER uma (orders sem, service-orders com)', async () => {
    privileged.add('9:20:7')
    const next = jest.fn()
    await requirePrivilege(['orders', 'service-orders'], 7)({ institution: USER } as any, res(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(sqlCalls(/tb_user_has_privilege/).map(c => c[1])).toEqual([[9, 29, 7], [9, 20, 7]])
  })
  it('Q-G16: sem privilégio em nenhuma das interfaces → 403 PRIVILEGE_REQUIRED', async () => {
    const r = res(); const next = jest.fn()
    await requirePrivilege(['orders', 'service-orders'], 7)({ institution: USER } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(403)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PRIVILEGE_REQUIRED' }))
    expect(next).not.toHaveBeenCalled()
  })
  it('regular COM vínculo passa; interface resolvida por i18n_key e cacheada', async () => {
    privileged.add('9:29:7')
    const next = jest.fn()
    await requirePrivilege('orders', 7)({ institution: USER } as any, res(), next)
    expect(next).toHaveBeenCalledTimes(1)
    const priv = sqlCalls(/tb_user_has_privilege/)
    expect(priv[0][1]).toEqual([9, 29, 7])
    expect(String(priv[0][0])).toMatch(/`setes_x`.tb_user_has_privilege[\s\S]*active = 'S' AND deleted = 'N'/)
    // segunda chamada: interface vem do cache (só a consulta do vínculo)
    mockQuery.mockClear()
    expect(await userHasPrivilege('setes_x', 9, 'orders', 5)).toBe(false)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })
  it('regular SEM vínculo → 403 PRIVILEGE_REQUIRED no envelope do Framework', async () => {
    const r = res(); const next = jest.fn()
    await requirePrivilege('orders', 7)({ institution: USER } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(403)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PRIVILEGE_REQUIRED', fields: [] }))
    expect(next).not.toHaveBeenCalled()
  })
  it('interface inexistente no catálogo → nega (nunca libera por engano)', async () => {
    expect(await userHasPrivilege('setes_x', 9, 'nada', 7)).toBe(false)
    expect(await institutionHasInterface('setes_x', 2, 'nada')).toBe(false)
  })
})

describe('D-F37 — a LICENÇA vale para todos (admin passa só o privilégio)', () => {
  it('interface NÃO contratada → 403 INTERFACE_NOT_ALLOWED para admin e regular com o privilégio — nem chega ao vínculo', async () => {
    contracted.delete(29)
    privileged.add('9:29:7')
    for (const inst of [ADMIN, USER]) {
      const r = res(); const next = jest.fn()
      await requirePrivilege('orders', 7)({ institution: inst } as any, r, next)
      expect(r.status).toHaveBeenCalledWith(403)
      expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERFACE_NOT_ALLOWED', fields: [] }))
      expect(next).not.toHaveBeenCalled()
    }
    expect(sqlCalls(/tb_user_has_privilege/)).toHaveLength(0)
  })
  it('lista: só contam as CONTRATADAS — privilégio na não contratada não vale; admin passa pela contratada', async () => {
    contracted.delete(20)                                   // service-orders fora do contrato
    privileged.add('9:20:7')                                // o vínculo existe, mas a licença não
    const r = res(); const next = jest.fn()
    await requirePrivilege(['orders', 'service-orders'], 7)({ institution: USER } as any, r, next)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PRIVILEGE_REQUIRED' }))
    expect(next).not.toHaveBeenCalled()
    const n2 = jest.fn()
    await requirePrivilege(['orders', 'service-orders'], 7)({ institution: ADMIN } as any, res(), n2)
    expect(n2).toHaveBeenCalledTimes(1)                     // orders contratada: o admin passa o privilégio
  })
  it('lista sem NENHUMA contratada → 403 INTERFACE_NOT_ALLOWED (inclusive admin)', async () => {
    contracted.delete(29); contracted.delete(20)
    const r = res(); const next = jest.fn()
    await requirePrivilege(['orders', 'service-orders'], 5)({ institution: ADMIN } as any, r, next)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERFACE_NOT_ALLOWED',
      error: expect.stringMatching(/orders \/ service-orders/) }))
    expect(next).not.toHaveBeenCalled()
  })
  it('requirePrivilegeFor: ramo resolvido NÃO contratado → 403 INTERFACE_NOT_ALLOWED para o admin; contratado → passa o privilégio', async () => {
    contracted.delete(20)
    const resolve = jest.fn(async () => 'service-orders')
    const r = res(); const next = jest.fn()
    await requirePrivilegeFor(7, resolve)({ institution: ADMIN, body: { orderId: 300 } } as any, r, next)
    expect(resolve).toHaveBeenCalledTimes(1)                // o admin agora resolve o ramo (antes passava sem olhar)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERFACE_NOT_ALLOWED', error: expect.stringMatching(/service-orders/) }))
    expect(next).not.toHaveBeenCalled()
    const n2 = jest.fn()
    await requirePrivilegeFor(7, async () => 'orders')({ institution: ADMIN, body: { orderId: 301 } } as any, res(), n2)
    expect(n2).toHaveBeenCalledTimes(1)
    expect(sqlCalls(/tb_user_has_privilege/)).toHaveLength(0)
  })
  it('requireInterfaceFor (leituras fiscais, Q-N32): o admin NÃO passa mais a licença', async () => {
    contracted.delete(20)
    const r = res(); const next = jest.fn()
    await requireInterfaceFor(async () => 'service-orders')({ institution: ADMIN } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(403)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERFACE_NOT_ALLOWED' }))
    expect(next).not.toHaveBeenCalled()
    const n2 = jest.fn()
    await requireInterfaceFor(async () => 'orders')({ institution: SUPER } as any, res(), n2)
    expect(n2).toHaveBeenCalledTimes(1)
  })
  it('licença conferida no schema e na institution do TOKEN (nunca do corpo)', async () => {
    await requirePrivilege('settlements', 3)({ institution: ADMIN, body: { institutionId: 1, schemaName: 'setes_setes' } } as any, res(), jest.fn())
    const lic = sqlCalls(/tb_institution_has_interface/)
    expect(String(lic[0][0])).toMatch(/`setes_x`\.tb_institution_has_interface/)
    expect(lic[0][1]).toEqual([2, 21])
  })
})

describe('A-PV1 — o super escapa também da LICENÇA (revê a D-F37 só para ele — Valdo 2026-10-18)', () => {
  it('as 3 guardas passam o super com a interface NÃO contratada — sem consultar contrato nem vínculo', async () => {
    contracted.clear()
    for (const guard of [
      requirePrivilege('orders', 7),
      requirePrivilege(['orders', 'service-orders'], 5),
      requirePrivilegeFor(7, async () => 'service-orders'),
      requireInterfaceFor(async () => 'orders'),
    ]) {
      const next = jest.fn()
      await guard({ institution: SUPER, body: { orderId: 1 } } as any, res(), next)
      expect(next).toHaveBeenCalledTimes(1)
    }
    expect(sqlCalls(/tb_institution_has_interface|tb_user_has_privilege/)).toHaveLength(0)
  })
  it('role "super" fora da institution da Setes NÃO é super (isSuper exige a institution 1) — segue barrado pela licença', async () => {
    contracted.clear()
    const r = res(); const next = jest.fn()
    await requirePrivilege('orders', 7)({ institution: { ...SUPER, institutionId: 2, schemaName: 'setes_x' } } as any, r, next)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERFACE_NOT_ALLOWED' }))
    expect(next).not.toHaveBeenCalled()
  })
})

describe('Q-G22 — interface resolvida pelo RAMO', () => {
  it('OS exige service-orders (quem só tem orders → 403)', async () => {
    privileged.add('9:29:7')
    const r = res(); const next = jest.fn()
    const guard = requirePrivilegeFor(7, async () => 'service-orders')
    await guard({ institution: USER, body: { orderId: 300 } } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(403)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PRIVILEGE_REQUIRED' }))
    expect(sqlCalls(/tb_user_has_privilege/).map(c => c[1])).toEqual([[9, 20, 7]])
    expect(next).not.toHaveBeenCalled()
  })
})
