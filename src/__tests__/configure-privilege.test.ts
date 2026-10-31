/// <reference types="jest" />
// D-PV25/D-PV26 (Valdo 2026-10-20 — prompt_privilegios_interfaces.md): CONFIGURAR (11) — o valor da INSTITUTION ('I') de uma config e o
// required/caption/mask de um campo da tela X exigem CONFIGURAR em X (a interface ALVO, nunca a do painel); admin passa, super escapa,
// regular precisa do par; o override pessoal 'U' segue aberto (A-PV6). D-PV24: o super escapa também do "adquirida"; D-PV39: a tela do
// Super delegável conta como adquirida pela Setes.
import pool from '../shared/db/connection'
import { interfaceAcquiredFor, escapesLicense } from '../shared/auth/require-privilege'
import { configureVerdict, canConfigure, assertCanConfigure } from '../shared/auth/configure-privilege'
import * as vitrineRepo from '../shared/interface-vitrine/interface-vitrine.repository'
import * as configRepo from '../shared/interface-config/interface-config.repository'
import * as valuesRepo from '../modules/interface-configs/interface-configs.repository'
import * as fieldsRepo from '../modules/interface-fields/interface-fields.repository'
import { saveConfigValue, fetchResolvedConfigs } from '../modules/interface-configs/interface-configs.service'
import { saveFieldConfig, fetchResolvedFields } from '../modules/interface-fields/interface-fields.service'
import { invalidateInterfaceConfigCatalog } from '../shared/interface-config/interface-config.service'
import { PRIVILEGE_NAME_BY_ID } from '../shared/access'
import { accessAnswer, AccessModel, ModelProfile } from '../test-setup/access-model'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn() } }))
jest.mock('../shared/interface-vitrine/interface-vitrine.repository', () => {
  const actual = jest.requireActual('../shared/interface-vitrine/interface-vitrine.repository')
  return { __esModule: true, ...actual, interfaceExists: jest.fn(async () => true) }
})
jest.mock('../shared/interface-config/interface-config.repository')
jest.mock('../modules/interface-configs/interface-configs.repository')
jest.mock('../modules/interface-fields/interface-fields.repository')
jest.mock('../shared/field-config/field-config.repository', () => {
  const actual = jest.requireActual('../shared/field-config/field-config.repository')
  return { __esModule: true, ...actual, listCatalogFields: jest.fn(async () => [{ fieldName: 'name', tableName: 't', kind: 'String', required: 'N' }]),
    listFieldConfig: jest.fn(async () => []), findInterfaceIdByKey: jest.fn(async (k: string) => CATALOG[k] ?? null) }
})
jest.mock('../shared/time-zone', () => ({ __esModule: true, invalidateInstitutionZone: jest.fn() }))

const mockQuery = (pool as any).query as jest.Mock
const CATALOG: Record<string, number> = { customers: 9, 'interface-configs': 10, 'general-configs': 11, 'institution-interfaces': 41 }
const BY_ID = Object.fromEntries(Object.entries(CATALOG).map(([k, id]) => [id, k])) as Record<number, string>
let contracted: Set<number>
let privileged: Set<string>                       // `${userId}:${interfaceId}:${privilegeId}`
/** O vínculo vivo de cada usuário × institution (`vw_user_link`) — o perfil do veredito é o DELE, nunca o `role` do token. */
const LINKS: Record<string, ModelProfile> = { '9:2': 'user', '7:2': 'admin', '1:1': 'super', '9:1': 'user' }
function modelFor(userId: number, institutionId: number): AccessModel | null {
  const profile = LINKS[`${userId}:${institutionId}`]
  if (!profile) return null
  const granted: Record<string, string[]> = {}
  for (const p of privileged) {
    const [u, i, v] = p.split(':').map(Number)
    if (u === userId && BY_ID[i]) (granted[BY_ID[i]] ??= []).push(PRIVILEGE_NAME_BY_ID[v])
  }
  return { profile, vendor: institutionId === 1, contracted: [...contracted].map(id => BY_ID[id]).filter(Boolean), granted }
}
function routeDb(): void {
  mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
    const a = accessAnswer(sql, params, modelFor)                     // o veredito: as views (costura A1 — D-AU3/D-AU6)
    if (a) return [a, []]
    if (/FROM setes_central\.tb_interface WHERE i18n_key/.test(sql)) { const id = CATALOG[String(params[0])]; return [id ? [{ id }] : []] }
    if (/SELECT i18n_key AS k FROM setes_central\.tb_interface WHERE id/.test(sql)) { const k = BY_ID[Number(params[0])]; return [k ? [{ k }] : []] }
    throw new Error(`SQL inesperado: ${sql}`)
  })
}
const sqlCalls = (re: RegExp) => mockQuery.mock.calls.filter(c => re.test(String(c[0]))).length
const ACCESS = /vw_user_access/
const REACH = /vw_user_reach/
const reads = (re: RegExp) => mockQuery.mock.calls.filter(c => re.test(String(c[0]))).map(c => c[1])

const USER = { institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' }
const ADMIN = { institutionId: 2, userId: 7, role: 'admin', schemaName: 'setes_x' }
const SUPER = { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' }
const SETES_USER = { institutionId: 1, userId: 9, role: 'user', schemaName: 'setes_setes' }
const CONFIGS = [
  { name: 'page_size', description: 'Itens', kind: 'Options', options: '10=10;25=25', defaultContent: '25', scope: 'U' },
  { name: 'restrict_customer_to_salesman', description: 'Carteira', kind: 'Boolean', options: null, defaultContent: 'N', scope: 'I' },
]

beforeEach(() => {
  jest.clearAllMocks(); invalidateInterfaceConfigCatalog(9); invalidateInterfaceConfigCatalog(41)
  contracted = new Set([9, 10, 11]); privileged = new Set()
  routeDb()
  ;(configRepo.listCatalogConfigs as jest.Mock).mockResolvedValue(CONFIGS)
  ;(configRepo.listConfigValues as jest.Mock).mockResolvedValue([])
  ;(valuesRepo.getConfigValue as jest.Mock).mockResolvedValue(null)
  ;(fieldsRepo.getCatalogFieldRequired as jest.Mock).mockResolvedValue('N')
})

describe('configureVerdict — CONFIGURAR na interface ALVO', () => {
  it('regular sem o par → no-privilege; com (X × 11) → ok; interface não contratada → not-contracted; fora do catálogo → not-contracted', async () => {
    expect(await configureVerdict(USER, 9)).toBe('no-privilege')
    privileged.add('9:9:11')
    expect(await configureVerdict(USER, 9)).toBe('ok')
    contracted.delete(9)
    expect(await configureVerdict(USER, 9)).toBe('not-contracted')
    expect(await configureVerdict(USER, 777)).toBe('not-contracted')
  })
  it('o par é da interface ALVO, não do painel: ALTERAR/CONFIGURAR em interface-configs não configura Clientes', async () => {
    privileged.add('9:10:11'); privileged.add('9:10:2')
    expect(await configureVerdict(USER, 9)).toBe('no-privilege')
    expect(reads(ACCESS)).toEqual([[9, 2, ['customers'], 'CONFIGURAR']])            // só a ALVO, só o CONFIGURAR
  })
  it('admin passa sem concessão; super escapa até sem contrato — os dois pelo caminho quente (uma leitura, sem o motivo)', async () => {
    expect(await configureVerdict(ADMIN, 9)).toBe('ok')
    expect(reads(ACCESS)).toEqual([[7, 2, ['customers'], 'CONFIGURAR']])
    jest.clearAllMocks(); routeDb()
    contracted.clear()
    expect(await configureVerdict(SUPER, 9)).toBe('ok')
    expect(reads(ACCESS)).toEqual([[1, 1, ['customers'], 'CONFIGURAR']])
    expect(sqlCalls(REACH)).toBe(0)
  })
  it('assertCanConfigure: 403 PRIVILEGE_REQUIRED sem o par, 403 INTERFACE_NOT_ALLOWED sem contrato', async () => {
    await expect(assertCanConfigure(USER, 9)).rejects.toMatchObject({ statusCode: 403, code: 'PRIVILEGE_REQUIRED' })
    contracted.delete(9)
    await expect(assertCanConfigure(USER, 9)).rejects.toMatchObject({ statusCode: 403, code: 'INTERFACE_NOT_ALLOWED' })
    expect(await canConfigure(ADMIN, 9)).toBe(false)              // D-F37: o admin passa o privilégio, nunca a licença
    contracted.add(9)
    expect(await canConfigure(ADMIN, 9)).toBe(true)
  })
})

describe('D-PV24/D-PV39 — "adquirida" pela peça única', () => {
  it('o super escapa (alcança sem contrato); o regular pelo contrato; D-PV39: a tela delegável conta como adquirida pela Setes — tudo pela vw_user_reach', async () => {
    expect(escapesLicense(SUPER)).toBe(true)
    contracted.clear()
    expect(await interfaceAcquiredFor(SUPER, 9)).toBe(true)                    // fora do contrato: o super escapa (D-PV24)
    expect(await interfaceAcquiredFor(USER, 9)).toBe(false)
    contracted = new Set([9, 10, 11])
    expect(await interfaceAcquiredFor(USER, 9)).toBe(true)
    expect(await interfaceAcquiredFor(USER, 41)).toBe(false)                   // cliente: a delegável não está ao alcance
    expect(await interfaceAcquiredFor(SETES_USER, 41)).toBe(true)              // Setes: delegável = adquirida (D-PV39), sem contrato e sem concessão
    expect(await interfaceAcquiredFor(SETES_USER, 9)).toBe(true)               // o resto segue pelo CONTRATO
    contracted.delete(9)
    expect(await interfaceAcquiredFor(SETES_USER, 9)).toBe(false)
    expect(await interfaceAcquiredFor(USER, 777)).toBe(false)                  // fora do catálogo: nega sem perguntar à view
    expect(reads(REACH)).toEqual([
      [1, 1, ['customers']], [9, 2, ['customers']], [9, 2, ['customers']], [9, 2, ['institution-interfaces']],
      [9, 1, ['institution-interfaces']], [9, 1, ['customers']], [9, 1, ['customers']],
    ])
    expect(sqlCalls(ACCESS)).toBe(0)                                            // "adquirida" é alcance, nunca verbo
  })
})

describe('painel de configurações — saveConfigValue (D-PV25/D-PV26)', () => {
  it("target 'I' pelo regular SEM CONFIGURAR em X → 403 PRIVILEGE_REQUIRED, nada gravado", async () => {
    await expect(saveConfigValue(USER, 9, 'restrict_customer_to_salesman', { content: 'S', target: 'I' }))
      .rejects.toMatchObject({ statusCode: 403, code: 'PRIVILEGE_REQUIRED' })
    expect(valuesRepo.upsertConfigValue).not.toHaveBeenCalled()
  })
  it("target 'I' pelo regular COM CONFIGURAR em X grava o valor da institution (tb_user_id 0) — a decisão 4 'só o admin' foi superada", async () => {
    privileged.add('9:9:11')
    await saveConfigValue(USER, 9, 'restrict_customer_to_salesman', { content: 'S', target: 'I' })
    expect(valuesRepo.upsertConfigValue).toHaveBeenCalledWith('setes_x', 2, 9, 'restrict_customer_to_salesman', 0, 'S')
  })
  it("target 'U' (override pessoal, scope U) NÃO pede CONFIGURAR (A-PV6)", async () => {
    await saveConfigValue(USER, 9, 'page_size', { content: '10', target: 'U' })
    expect(valuesRepo.upsertConfigValue).toHaveBeenCalledWith('setes_x', 2, 9, 'page_size', 9, '10')
    expect(sqlCalls(ACCESS)).toBe(0)                                            // só o alcance da tela (vw_user_reach), nenhum verbo
  })
  it('admin grava I sem par; super grava I em tela NÃO contratada (D-PV24 — fica latente até a contratação)', async () => {
    await saveConfigValue(ADMIN, 9, 'restrict_customer_to_salesman', { content: 'S', target: 'I' })
    contracted.clear()
    await saveConfigValue(SUPER, 9, 'restrict_customer_to_salesman', { content: 'S', target: 'I' })
    expect(valuesRepo.upsertConfigValue).toHaveBeenCalledTimes(2)
  })
  it('interface não adquirida pelo cliente → 403 INTERFACE_NOT_ALLOWED antes de qualquer privilégio', async () => {
    contracted.clear()
    await expect(saveConfigValue(USER, 9, 'page_size', { content: '10', target: 'U' }))
      .rejects.toMatchObject({ statusCode: 403, code: 'INTERFACE_NOT_ALLOWED' })
  })
  it("'Configurações Gerais' = CONFIGURAR em general-configs (a interface alvo é ela)", async () => {
    await expect(saveConfigValue(USER, 11, 'restrict_customer_to_salesman', { content: 'S', target: 'I' })).rejects.toMatchObject({ code: 'PRIVILEGE_REQUIRED' })
    privileged.add('9:11:11')
    await saveConfigValue(USER, 11, 'restrict_customer_to_salesman', { content: 'S', target: 'I' })
    expect(valuesRepo.upsertConfigValue).toHaveBeenCalledTimes(1)
  })
  it('GET resolvido traz canConfigure (a tela decide o alvo pela API, não pelo perfil)', async () => {
    expect((await fetchResolvedConfigs(USER, 9)).map(c => c.canConfigure)).toEqual([false, false])
    privileged.add('9:9:11')
    expect((await fetchResolvedConfigs(USER, 9)).map(c => c.canConfigure)).toEqual([true, true])
    expect((await fetchResolvedConfigs(ADMIN, 9)).every(c => c.canConfigure)).toBe(true)
  })
})

describe('painel de campos — saveFieldConfig (D-PV25 supera a D-PV6)', () => {
  it('regular sem CONFIGURAR em X → 403; com → grava; admin passa; não adquirida → 403 INTERFACE_NOT_ALLOWED', async () => {
    await expect(saveFieldConfig(USER, 9, 'name', { required: 'S', fieldCaption: null, mask: null } as any))
      .rejects.toMatchObject({ statusCode: 403, code: 'PRIVILEGE_REQUIRED' })
    expect(fieldsRepo.upsertFieldConfig).not.toHaveBeenCalled()
    privileged.add('9:9:11')
    await saveFieldConfig(USER, 9, 'name', { required: 'S', fieldCaption: null, mask: null } as any)
    await saveFieldConfig(ADMIN, 9, 'name', { required: 'S', fieldCaption: null, mask: null } as any)
    expect(fieldsRepo.upsertFieldConfig).toHaveBeenCalledTimes(2)
    contracted.clear()
    await expect(saveFieldConfig(USER, 9, 'name', { required: 'S', fieldCaption: null, mask: null } as any))
      .rejects.toMatchObject({ statusCode: 403, code: 'INTERFACE_NOT_ALLOWED' })
  })
  it('GET /:id resolvido traz canConfigure', async () => {
    expect((await fetchResolvedFields(USER, 9)).map(f => f.canConfigure)).toEqual([false])
    privileged.add('9:9:11')
    expect((await fetchResolvedFields(USER, 9)).map(f => f.canConfigure)).toEqual([true])
  })
})
