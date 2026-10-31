/// <reference types="jest" />
// D-PV2 (Valdo 2026-10-18 — prompt_privilegios_interfaces.md): "possível porque o módulo do app só fala com o seu /api/<m>"
// era FALSO em 12 chamadas do app (§10.2 do prompt). Cada tela passou a ter a SUA lista de apoio — o usuário que só tem a
// tela consumidora lê a lista (VISUALIZAR dela); o privilégio da tela dona NÃO basta mais para a lista da outra, e o regular
// sem nada recebe 403 em todas. De ponta a ponta pelo app real (JWT → flags → guarda → rota).
import request from 'supertest'
import { bearer } from '../test-setup/test-token'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFPV'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../shared/customer-wallet', () => ({ __esModule: true, walletSalesmanId: jest.fn(async () => null) }))

import pool from '../shared/db/connection'
import { PRIVILEGE_NAME_BY_ID } from '../shared/access'
import { accessAnswer, AccessModel } from '../test-setup/access-model'
import app from '../app'

const q = (pool as any).query as jest.Mock
const CATALOG: Record<string, number> = {
  settlements: 21, cashier: 30, 'service-orders': 20, 'payment-types': 16, customers: 9, partnerships: 18,
  'order-returns': 31, orders: 29, contracts: 17, 'bank-accounts': 19, 'financial-plans': 14, collaborators: 12, cfop: 15,
}
const BY_ID = Object.fromEntries(Object.entries(CATALOG).map(([k, id]) => [id, k])) as Record<number, string>
let granted: Set<string>                                           // `${interfaceId}:${privilegeId}` do usuário 9
const USER = bearer({ institutionId: 1, userId: 9, role: 'user', schemaName: 'setes_setes' })

/** As views do veredito (costura A1): o usuário 9 é regular na institution 1, tudo contratado — o teste é da CONCESSÃO. */
function modelFor(userId: number, institutionId: number): AccessModel | null {
  if (userId !== 9 || institutionId !== 1) return null
  const g: Record<string, string[]> = {}
  for (const p of granted) {
    const [i, v] = p.split(':').map(Number)
    ;(g[BY_ID[i]] ??= []).push(PRIVILEGE_NAME_BY_ID[v])
  }
  return { profile: 'user', vendor: true, contracted: Object.keys(CATALOG), granted: g }
}

beforeEach(() => {
  jest.clearAllMocks();  granted = new Set()
  q.mockImplementation(async (sql: string, params: any[] = []) => {
    const a = accessAnswer(sql, params, modelFor)
    if (a) return [a, []]
    return [[{ id: 1 }]]                                                              // qualquer consulta de lista de apoio
  })
})

const LOOKUPS: Array<[string, string, string]> = [
  // [rota própria, interface que a libera, interface DONA do dado (que já não basta)]
  ['/api/settlements/bank-accounts', 'settlements', 'bank-accounts'],
  ['/api/settlements/payment-types', 'settlements', 'payment-types'],
  ['/api/cashier/bank-accounts', 'cashier', 'bank-accounts'],
  ['/api/service-orders/payment-types', 'service-orders', 'payment-types'],
  ['/api/service-orders/customer-lookup', 'service-orders', 'customers'],
  ['/api/payment-types/financial-plans', 'payment-types', 'financial-plans'],
  ['/api/customers/collaborator-lookup', 'partnerships', 'collaborators'],
  ['/api/order-returns/cfop-lookup', 'order-returns', 'cfop'],
  ['/api/orders/active-salesman-lookup', 'orders', 'customers'],
  ['/api/orders/customer-lookup', 'orders', 'customers'],
  ['/api/contracts/customer-lookup', 'contracts', 'customers'],
  ['/api/contracts/payment-types', 'contracts', 'payment-types'],
]

describe.each(LOOKUPS)('GET %s', (url, consumer, owner) => {
  it(`regular sem nada → 403; com VISUALIZAR só na dona (${owner}) → 403; com VISUALIZAR em ${consumer} → 200`, async () => {
    expect((await request(app).get(url).set('Authorization', USER)).body.code).toBe('PRIVILEGE_REQUIRED')
    granted.add(`${CATALOG[owner]}:6`)
    expect((await request(app).get(url).set('Authorization', USER)).body.code).toBe('PRIVILEGE_REQUIRED')
    granted.add(`${CATALOG[consumer]}:6`)
    const ok = await request(app).get(url).set('Authorization', USER)
    expect([ok.status, ok.body.ok]).toEqual([200, true])
  })
})

describe('as listas novas reproduzem o conjunto de hoje (SQL)', () => {
  it('contas bancárias: institution do token, vivas, filtro escapado, ordem da lista do cadastro, até 100', async () => {
    granted.add('21:6')
    await request(app).get('/api/settlements/bank-accounts?filter=50%').set('Authorization', USER)
    const [sql, params] = q.mock.calls.find(c => /tb_bank_account a/.test(String(c[0])))!
    expect(String(sql)).toMatch(/FROM `setes_setes`\.tb_bank_account a[\s\S]*a\.tb_institution_id = \? AND a\.deleted = 'N'[\s\S]*ORDER BY b\.description, a\.agency, a\.number, a\.id/)
    expect(params).toEqual([1, '%50\\%%', '%50\\%%', '%50\\%%', '%50\\%%', 100])
  })
  it('vendedores do pedido: só ATIVOS (o mesmo lookup de atribuição de Clientes), filtro escapado', async () => {
    granted.add('29:6')
    await request(app).get('/api/orders/active-salesman-lookup?filter=a_b').set('Authorization', USER)
    const [sql, params] = q.mock.calls.find(c => /tb_salesman sm/.test(String(c[0])))!
    expect(String(sql)).toMatch(/sm\.deleted = 'N' AND sm\.active = 'S'/)
    expect(params).toEqual([1, '%a\\_b%', '%a\\_b%', '%a\\_b%'])
  })
  it('CFOP da devolução: catálogo central vivo, mesmo filtro e ordem da 1ª página do cadastro de CFOP (50)', async () => {
    granted.add('31:6')
    await request(app).get('/api/order-returns/cfop-lookup?filter=1202').set('Authorization', USER)
    const [sql] = q.mock.calls.find(c => /tb_cfop c/.test(String(c[0])))!
    expect(String(sql)).toMatch(/FROM setes_central\.tb_cfop c[\s\S]*c\.deleted = 'N'[\s\S]*ORDER BY c\.id[\s\S]*LIMIT 50/)
  })
  it('clientes do pedido/OS/contrato: a lista de apoio devolve também nickTrade/nameCompany (o formulário lê os dois)', async () => {
    granted.add('20:6')
    await request(app).get('/api/service-orders/customer-lookup').set('Authorization', USER)
    const [sql] = q.mock.calls.find(c => /tb_customer cu/.test(String(c[0])))!
    expect(String(sql)).toMatch(/AS name,\s+e\.nick_trade AS nickTrade, e\.name_company AS nameCompany/)
  })
})
