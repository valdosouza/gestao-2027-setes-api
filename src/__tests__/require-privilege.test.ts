/// <reference types="jest" />
// Guard de privilégio de AÇÃO (D12 + Q-P5 do cancelamento, 2026-09-08):
// super/admin passam o PRIVILÉGIO; usuário regular precisa da concessão ativa para a interface (i18n_key) × privilégio.
// D-F37 (F2a, etapa A2 — prompt_apis_fiscais_isoladas.md §22.9): a LICENÇA (interface contratada) vale para admin e regular; A-PV1: o
// super passa a licença e o privilégio.
// Costura A1 da auth-api (D-AU3/D-AU6/D-AU8, 2026-10-31): a REGRA é a pilha de views lida pela biblioteca `fiscal-api/access` — aqui o
// dublê `accessAnswer` responde às views a partir do contrato, das concessões e do PERFIL DO VÍNCULO (nunca o `role` do token); o caminho
// quente é UMA leitura da `vw_user_access`; a `vw_user_reach` só na negação (o motivo do 403); sem cache.
import pool from '../shared/db/connection'
import { requirePrivilege, requirePrivilegeFor, requireInterfaceFor } from '../shared/auth/require-privilege'
import { accessAnswer, AccessModel, ModelProfile } from '../test-setup/access-model'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}))
const mockQuery = (pool as any).query as jest.Mock

/** Banco de mentira: o vínculo vivo (perfil por usuário × institution), o contrato e as concessões — respondidos pelas views. */
let contracted: Set<string>
let granted: Set<string>                            // `${userId}:${interfaceKey}:${VERBO}`
let links: Map<string, ModelProfile>                // `${userId}:${institutionId}` → perfil da vw_user_link
function modelFor(userId: number, institutionId: number): AccessModel | null {
  const profile = links.get(`${userId}:${institutionId}`)
  if (!profile) return null
  const mine: Record<string, string[]> = {}
  for (const g of granted) {
    const [u, key, verb] = g.split(':')
    if (Number(u) === userId) (mine[key] ??= []).push(verb)
  }
  return { profile, vendor: institutionId === 1, contracted: [...contracted], granted: mine }
}
function routeDb(): void {
  mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
    const a = accessAnswer(sql, params, modelFor)
    if (a) return [a, []]
    throw new Error(`SQL inesperado: ${sql}`)
  })
}
const sqlCalls = (re: RegExp) => mockQuery.mock.calls.filter(c => re.test(String(c[0])))
const ACCESS = /vw_user_access/
const REACH = /vw_user_reach/

function res() {
  const r: any = { status: jest.fn(() => r), json: jest.fn(() => r) }
  return r
}
const SUPER = { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' }
const ADMIN = { institutionId: 2, userId: 8, role: 'admin', schemaName: 'setes_x' }
const USER = { institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' }

beforeEach(() => {
  jest.clearAllMocks()
  contracted = new Set(['orders', 'service-orders', 'order-returns', 'settlements']); granted = new Set()
  links = new Map<string, ModelProfile>([['1:1', 'super'], ['8:2', 'admin'], ['9:2', 'user']])
  routeDb()
})

describe('requirePrivilege', () => {
  it('sem JWT → 401', async () => {
    const r = res(); const next = jest.fn()
    await requirePrivilege('orders', 7)({ } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
  })
  it('super e admin passam o PRIVILÉGIO: uma leitura da vw_user_access cada, pelo NOME do verbo, sem ler o motivo', async () => {
    const next = jest.fn()
    await requirePrivilege('orders', 7)({ institution: SUPER } as any, res(), next)
    await requirePrivilege('orders', 7)({ institution: ADMIN } as any, res(), next)
    expect(next).toHaveBeenCalledTimes(2)
    expect(sqlCalls(ACCESS).map(c => c[1])).toEqual([[1, 1, ['orders'], 'CANCELAR'], [8, 2, ['orders'], 'CANCELAR']])
    expect(sqlCalls(REACH)).toHaveLength(0)
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })
  it('Q-G16: lista de interfaces — passa pelo privilégio em QUALQUER uma (orders sem, service-orders com) — UMA leitura', async () => {
    granted.add('9:service-orders:CANCELAR')
    const next = jest.fn()
    await requirePrivilege(['orders', 'service-orders'], 7)({ institution: USER } as any, res(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(sqlCalls(ACCESS).map(c => c[1])).toEqual([[9, 2, ['orders', 'service-orders'], 'CANCELAR']])
  })
  it('Q-G16: sem privilégio em nenhuma das interfaces → 403 PRIVILEGE_REQUIRED (o motivo vem da vw_user_reach)', async () => {
    const r = res(); const next = jest.fn()
    await requirePrivilege(['orders', 'service-orders'], 7)({ institution: USER } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(403)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PRIVILEGE_REQUIRED' }))
    expect(next).not.toHaveBeenCalled()
    expect(sqlCalls(REACH).map(c => c[1])).toEqual([[9, 2, ['orders', 'service-orders']]])
  })
  it('regular COM a concessão passa; a leitura é no schema e na institution do TOKEN', async () => {
    granted.add('9:orders:CANCELAR')
    const next = jest.fn()
    await requirePrivilege('orders', 7)({ institution: USER } as any, res(), next)
    expect(next).toHaveBeenCalledTimes(1)
    const acc = sqlCalls(ACCESS)
    expect(acc).toHaveLength(1)
    expect(String(acc[0][0])).toMatch(/`setes_x`\.vw_user_access/)
    expect(acc[0][1]).toEqual([9, 2, ['orders'], 'CANCELAR'])
  })
  it('D-AU8 — sem cache: cada requisição relê a view (a revogação vale na requisição seguinte)', async () => {
    granted.add('9:orders:CANCELAR')
    const n1 = jest.fn()
    await requirePrivilege('orders', 7)({ institution: USER } as any, res(), n1)
    expect(n1).toHaveBeenCalledTimes(1)
    granted.delete('9:orders:CANCELAR')                     // o admin revoga
    const r = res(); const n2 = jest.fn()
    await requirePrivilege('orders', 7)({ institution: USER } as any, r, n2)
    expect(n2).not.toHaveBeenCalled()
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PRIVILEGE_REQUIRED' }))
    expect(sqlCalls(ACCESS)).toHaveLength(2)
  })
  it('regular SEM a concessão → 403 PRIVILEGE_REQUIRED no envelope do Framework', async () => {
    const r = res(); const next = jest.fn()
    await requirePrivilege('orders', 7)({ institution: USER } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(403)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PRIVILEGE_REQUIRED', fields: [] }))
    expect(next).not.toHaveBeenCalled()
  })
  it('interface inexistente no catálogo → nega (nunca libera por engano), inclusive para o admin', async () => {
    for (const inst of [ADMIN, USER]) {
      const r = res(); const next = jest.fn()
      await requirePrivilege('nada', 7)({ institution: inst } as any, r, next)
      expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERFACE_NOT_ALLOWED' }))
      expect(next).not.toHaveBeenCalled()
    }
  })
  it('verbo fora do vocabulário (id sem nome) → nega sem consultar nada (falha fechada), até para o super', async () => {
    const r = res(); const next = jest.fn()
    await requirePrivilege('orders', 999)({ institution: SUPER } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
  })
  it('vínculo que não vale mais (a view não o devolve) → nega mesmo com o token de admin', async () => {
    links.delete('8:2')
    const r = res(); const next = jest.fn()
    await requirePrivilege('orders', 7)({ institution: ADMIN } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })
  it('erro do banco segue para o tratador (next(err)) — nunca libera', async () => {
    mockQuery.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const r = res(); const next = jest.fn()
    await requirePrivilege('orders', 7)({ institution: ADMIN } as any, r, next)
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(r.status).not.toHaveBeenCalled()
  })
})

describe('D-F37 — a LICENÇA vale para admin e regular (o admin passa só o privilégio)', () => {
  it('interface NÃO contratada → 403 INTERFACE_NOT_ALLOWED para admin e regular com a concessão', async () => {
    contracted.delete('orders')
    granted.add('9:orders:CANCELAR')
    for (const inst of [ADMIN, USER]) {
      const r = res(); const next = jest.fn()
      await requirePrivilege('orders', 7)({ institution: inst } as any, r, next)
      expect(r.status).toHaveBeenCalledWith(403)
      expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERFACE_NOT_ALLOWED', fields: [] }))
      expect(next).not.toHaveBeenCalled()
    }
  })
  it('lista: só contam as CONTRATADAS — concessão na não contratada não vale; admin passa pela contratada', async () => {
    contracted.delete('service-orders')                     // service-orders fora do contrato
    granted.add('9:service-orders:CANCELAR')                // a concessão existe, mas a licença não
    const r = res(); const next = jest.fn()
    await requirePrivilege(['orders', 'service-orders'], 7)({ institution: USER } as any, r, next)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PRIVILEGE_REQUIRED' }))
    expect(next).not.toHaveBeenCalled()
    const n2 = jest.fn()
    await requirePrivilege(['orders', 'service-orders'], 7)({ institution: ADMIN } as any, res(), n2)
    expect(n2).toHaveBeenCalledTimes(1)                     // orders contratada: o admin passa o privilégio
  })
  it('lista sem NENHUMA contratada → 403 INTERFACE_NOT_ALLOWED (inclusive admin)', async () => {
    contracted.delete('orders'); contracted.delete('service-orders')
    const r = res(); const next = jest.fn()
    await requirePrivilege(['orders', 'service-orders'], 5)({ institution: ADMIN } as any, r, next)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERFACE_NOT_ALLOWED',
      error: expect.stringMatching(/orders \/ service-orders/) }))
    expect(next).not.toHaveBeenCalled()
  })
  it('requirePrivilegeFor: ramo resolvido NÃO contratado → 403 INTERFACE_NOT_ALLOWED para o admin; contratado → passa o privilégio', async () => {
    contracted.delete('service-orders')
    const resolve = jest.fn(async () => 'service-orders')
    const r = res(); const next = jest.fn()
    await requirePrivilegeFor(7, resolve)({ institution: ADMIN, body: { orderId: 300 } } as any, r, next)
    expect(resolve).toHaveBeenCalledTimes(1)                // o admin resolve o ramo (antes passava sem olhar)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERFACE_NOT_ALLOWED', error: expect.stringMatching(/service-orders/) }))
    expect(next).not.toHaveBeenCalled()
    const n2 = jest.fn()
    await requirePrivilegeFor(7, async () => 'orders')({ institution: ADMIN, body: { orderId: 301 } } as any, res(), n2)
    expect(n2).toHaveBeenCalledTimes(1)
  })
  it('requireInterfaceFor (leituras fiscais, Q-N32): o admin NÃO passa a licença; lê só a vw_user_reach (sem verbo)', async () => {
    contracted.delete('service-orders')
    const r = res(); const next = jest.fn()
    await requireInterfaceFor(async () => 'service-orders')({ institution: ADMIN } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(403)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERFACE_NOT_ALLOWED' }))
    expect(next).not.toHaveBeenCalled()
    const n2 = jest.fn()
    await requireInterfaceFor(async () => 'orders')({ institution: SUPER } as any, res(), n2)
    expect(n2).toHaveBeenCalledTimes(1)
    expect(sqlCalls(ACCESS)).toHaveLength(0)
    expect(sqlCalls(REACH).map(c => c[1])).toEqual([[8, 2, ['service-orders']], [1, 1, ['orders']]])
  })
  it('licença conferida no schema e na institution do TOKEN (nunca do corpo)', async () => {
    await requirePrivilege('settlements', 3)({ institution: ADMIN, body: { institutionId: 1, schemaName: 'setes_setes' } } as any, res(), jest.fn())
    const acc = sqlCalls(ACCESS)
    expect(String(acc[0][0])).toMatch(/`setes_x`\.vw_user_access/)
    expect(acc[0][1]).toEqual([8, 2, ['settlements'], 'EXCLUIR'])
  })
})

describe('A-PV1 — o super escapa também da LICENÇA (revê a D-F37 só para ele — Valdo 2026-10-18)', () => {
  it('as 3 guardas passam o super com a interface NÃO contratada', async () => {
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
  })
  it('role "super" no TOKEN fora da institution da Setes NÃO é super — o perfil é o do VÍNCULO (a view dá "user") — segue barrado pela licença', async () => {
    contracted.clear()
    links.set('1:2', 'user')                                // vw_user_link: kind 'super' fora da institution 1 = 'user'
    const r = res(); const next = jest.fn()
    await requirePrivilege('orders', 7)({ institution: { ...SUPER, institutionId: 2, schemaName: 'setes_x' } } as any, r, next)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERFACE_NOT_ALLOWED' }))
    expect(next).not.toHaveBeenCalled()
  })
  it('o veredito ignora o role do TOKEN: token "user" de quem é admin no vínculo passa; token "admin" de quem é regular não', async () => {
    const n1 = jest.fn()
    await requirePrivilege('orders', 7)({ institution: { ...ADMIN, role: 'user' } } as any, res(), n1)
    expect(n1).toHaveBeenCalledTimes(1)
    const r = res(); const n2 = jest.fn()
    await requirePrivilege('orders', 7)({ institution: { ...USER, role: 'admin' } } as any, r, n2)
    expect(n2).not.toHaveBeenCalled()
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PRIVILEGE_REQUIRED' }))
  })
})

describe('Q-G22 — interface resolvida pelo RAMO', () => {
  it('OS exige service-orders (quem só tem orders → 403)', async () => {
    granted.add('9:orders:CANCELAR')
    const r = res(); const next = jest.fn()
    const guard = requirePrivilegeFor(7, async () => 'service-orders')
    await guard({ institution: USER, body: { orderId: 300 } } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(403)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PRIVILEGE_REQUIRED' }))
    expect(sqlCalls(ACCESS).map(c => c[1])).toEqual([[9, 2, ['service-orders'], 'CANCELAR']])
    expect(next).not.toHaveBeenCalled()
  })
})
