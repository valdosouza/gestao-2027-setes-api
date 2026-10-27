/// <reference types="jest" />
// D-PV29 (Valdo 2026-10-20 — prompt_privilegios_interfaces.md): cache EM MEMÓRIA do VEREDITO (licença + privilégio) por
// (institution, schema, usuário, interface, privilégio), TTL curto, INVALIDADO ao salvar privilégio/contrato/vínculo no mesmo
// processo; sem cache para o super. A suíte roda com o cache DESLIGADO (setup `privilege-cache.ts`) — este teste o LIGA pelo
// ambiente, porque o TTL é lido a cada veredito.
import pool from '../shared/db/connection'
import {
  privilegeVerdict, invalidatePrivilegeVerdicts, privilegeVerdictCacheSize, resetPrivilegeCache, verdictCacheTtlMs,
} from '../shared/auth/require-privilege'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn() } }))
const mockQuery = (pool as any).query as jest.Mock

const CATALOG: Record<string, number> = { customers: 9, orders: 29 }
let contracted: Set<number>
let privileged: Set<string>
function routeDb(): void {
  mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
    if (/FROM setes_central\.tb_interface WHERE i18n_key/.test(sql)) { const id = CATALOG[String(params[0])]; return [id ? [{ id }] : []] }
    if (/tb_institution_has_interface/.test(sql)) return [contracted.has(Number(params[1])) ? [{ 1: 1 }] : []]
    if (/tb_user_has_privilege/.test(sql)) return [privileged.has(`${params[0]}:${params[1]}:${params[2]}`) ? [{ 1: 1 }] : []]
    throw new Error(`SQL inesperado: ${sql}`)
  })
}
const calls = (re: RegExp) => mockQuery.mock.calls.filter(c => re.test(String(c[0]))).length

const USER = { institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' }
const USER_B = { institutionId: 2, userId: 10, role: 'user', schemaName: 'setes_x' }
const OTHER = { institutionId: 3, userId: 9, role: 'user', schemaName: 'setes_y' }
const ADMIN = { institutionId: 2, userId: 7, role: 'admin', schemaName: 'setes_x' }
const SUPER = { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' }

let now = 1_000_000
beforeEach(() => {
  jest.clearAllMocks(); resetPrivilegeCache()
  process.env.PRIVILEGE_VERDICT_CACHE_TTL_MS = '60000'
  jest.spyOn(Date, 'now').mockImplementation(() => now)
  contracted = new Set([9, 29]); privileged = new Set(['9:9:6'])
  routeDb()
})
afterEach(() => { process.env.PRIVILEGE_VERDICT_CACHE_TTL_MS = '0'; jest.restoreAllMocks() })

describe('TTL pelo ambiente', () => {
  it('ausente = 60 s; 0 ou lixo = desligado; lido a cada chamada', () => {
    delete process.env.PRIVILEGE_VERDICT_CACHE_TTL_MS
    expect(verdictCacheTtlMs()).toBe(60_000)
    process.env.PRIVILEGE_VERDICT_CACHE_TTL_MS = '0'
    expect(verdictCacheTtlMs()).toBe(0)
    process.env.PRIVILEGE_VERDICT_CACHE_TTL_MS = 'abc'
    expect(verdictCacheTtlMs()).toBe(0)
    process.env.PRIVILEGE_VERDICT_CACHE_TTL_MS = '1500'
    expect(verdictCacheTtlMs()).toBe(1500)
  })
})

describe('o veredito é guardado e reusado', () => {
  it('2ª pergunta igual não vai ao banco; vereditos ok, no-privilege e not-contracted são guardados', async () => {
    expect(await privilegeVerdict(USER, ['customers'], 6)).toBe('ok')
    expect(await privilegeVerdict(USER, ['customers'], 2)).toBe('no-privilege')
    contracted.delete(29)
    expect(await privilegeVerdict(USER, ['orders'], 6)).toBe('not-contracted')
    const contractCalls = calls(/tb_institution_has_interface/), privCalls = calls(/tb_user_has_privilege/)
    expect(await privilegeVerdict(USER, ['customers'], 6)).toBe('ok')
    expect(await privilegeVerdict(USER, ['customers'], 2)).toBe('no-privilege')
    expect(await privilegeVerdict(USER, ['orders'], 6)).toBe('not-contracted')
    expect([calls(/tb_institution_has_interface/), calls(/tb_user_has_privilege/)]).toEqual([contractCalls, privCalls])
    expect(privilegeVerdictCacheSize()).toBe(3)
  })

  it('a chave carrega institution, schema e usuário: outro usuário ou outra institution não herdam o veredito', async () => {
    expect(await privilegeVerdict(USER, ['customers'], 6)).toBe('ok')
    expect(await privilegeVerdict(USER_B, ['customers'], 6)).toBe('no-privilege')     // 10 não tem o par
    expect(await privilegeVerdict(OTHER, ['customers'], 6)).toBe('ok')                // a 3 contrata 9 no dublê; vínculo 9:9:6 é por schema no dublê
    expect(privilegeVerdictCacheSize()).toBe(3)
    expect(calls(/tb_institution_has_interface/)).toBe(3)
  })

  it('admin: a licença é guardada (o privilégio o admin passa sem consultar)', async () => {
    expect(await privilegeVerdict(ADMIN, ['customers'], 2)).toBe('ok')
    expect(await privilegeVerdict(ADMIN, ['customers'], 2)).toBe('ok')
    expect(calls(/tb_institution_has_interface/)).toBe(1)
    expect(calls(/tb_user_has_privilege/)).toBe(0)
  })

  it('o SUPER nunca entra no cache (ele não consulta contrato nem vínculo)', async () => {
    expect(await privilegeVerdict(SUPER, ['customers'], 2)).toBe('ok')
    expect(await privilegeVerdict(SUPER, ['customers'], 2)).toBe('ok')
    expect(privilegeVerdictCacheSize()).toBe(0)
    expect(calls(/tb_institution_has_interface/)).toBe(0)
  })
})

describe('invalidação e expiração', () => {
  it('revogar o privilégio e invalidar POR USUÁRIO: o próximo veredito relê o banco e nega', async () => {
    expect(await privilegeVerdict(USER, ['customers'], 6)).toBe('ok')
    privileged.clear()
    expect(await privilegeVerdict(USER, ['customers'], 6)).toBe('ok')              // ainda no cache
    invalidatePrivilegeVerdicts({ userId: 9 })
    expect(await privilegeVerdict(USER, ['customers'], 6)).toBe('no-privilege')    // revogação imediata no processo
  })

  it('invalidar POR INSTITUTION derruba só os vereditos dela (o contrato de outra institution fica)', async () => {
    await privilegeVerdict(USER, ['customers'], 6)
    await privilegeVerdict(OTHER, ['customers'], 6)
    expect(privilegeVerdictCacheSize()).toBe(2)
    invalidatePrivilegeVerdicts({ institutionId: 2 })
    expect(privilegeVerdictCacheSize()).toBe(1)
    contracted.clear()
    expect(await privilegeVerdict(USER, ['customers'], 6)).toBe('not-contracted')  // releu: contrato caiu
    expect(await privilegeVerdict(OTHER, ['customers'], 6)).toBe('ok')             // da outra institution segue guardado
  })

  it('sem escopo derruba tudo; escopo que não casa não derruba nada', async () => {
    await privilegeVerdict(USER, ['customers'], 6)
    invalidatePrivilegeVerdicts({ userId: 999 })
    expect(privilegeVerdictCacheSize()).toBe(1)
    invalidatePrivilegeVerdicts()
    expect(privilegeVerdictCacheSize()).toBe(0)
  })

  it('o veredito expira no TTL (limite conhecido da Onda 4: outro processo só vê a revogação na expiração)', async () => {
    expect(await privilegeVerdict(USER, ['customers'], 6)).toBe('ok')
    privileged.clear()
    now += 59_999
    expect(await privilegeVerdict(USER, ['customers'], 6)).toBe('ok')
    now += 2
    expect(await privilegeVerdict(USER, ['customers'], 6)).toBe('no-privilege')
  })

  it('TTL 0 = nenhuma entrada guardada (o modo da suíte)', async () => {
    process.env.PRIVILEGE_VERDICT_CACHE_TTL_MS = '0'
    await privilegeVerdict(USER, ['customers'], 6)
    await privilegeVerdict(USER, ['customers'], 6)
    expect(privilegeVerdictCacheSize()).toBe(0)
    expect(calls(/tb_user_has_privilege/)).toBe(2)
  })

  it('resetPrivilegeCache também limpa os vereditos', async () => {
    await privilegeVerdict(USER, ['customers'], 6)
    resetPrivilegeCache()
    expect(privilegeVerdictCacheSize()).toBe(0)
  })
})
