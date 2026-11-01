/// <reference types="jest" />
// CONFERÊNCIA do catálogo de privilégios (D-PV9 — Valdo 2026-10-18; IGUALDADE por interface da D-PV51, 2026-10-27; alarme sem recusar
// subir — D-PV52): o registro vivo e ativo (`setes_central.tb_interface_has_privilege`) tem de ser IGUAL a o que o código opera (lista à
// mão ∪ tabela do roteador — D-PV14) ∪ VISUALIZAR em toda tela ∪ CONFIGURAR em toda interface com config/campo (+ general-configs — D-PV25)
// ∪ reservados. Par faltando ou sobrando = ALARME no log, o servidor sobe assim mesmo. Provas sem banco (o pool é dublado).
jest.mock('@shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('@shared/logger/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import pool from '@shared/db/connection'
import logger from '@shared/logger/logger'
import router from '../gateway/router'
import {
  privilegeCatalogProblems, consumedPrivileges, CONSUMED_PRIVILEGES, RESERVED_PRIVILEGES, PRIVILEGE_ID, CONFIGURE_RULE_KEYS, pairKey,
  absentMarkHolds, CatalogPairRow, PrivilegeDefinitionRow, ConsumedPrivilege, CatalogFacts, PrivilegeCatalogProblems,
} from '@shared/auth/privilege-catalog'
import { APP_INTERFACE_ROUTE_KEYS } from '@shared/auth/app-interface-routes'
import {
  assertPrivilegeCatalog, privilegeCatalogAlarms, CATALOG_PAIRS_SQL, PRIVILEGES_SQL, SCREEN_INTERFACES_SQL, CONFIGURABLE_INTERFACES_SQL,
  INTERFACE_KEYS_SQL,
} from '@shared/auth/assert-privilege-catalog'

void router                                                     // montar o gateway registra as guardas (a tabela da D-PV14)

const query = (pool as unknown as { query: jest.Mock }).query
const warn = (logger as unknown as { warn: jest.Mock }).warn

/** `tb_privilege` depois do seed 68 (sql/06 + 51 + 55 + 59 + 66 + 68). */
const PRIVILEGES: PrivilegeDefinitionRow[] = [
  { id: 1, description: 'INSERIR' }, { id: 2, description: 'ALTERAR' }, { id: 3, description: 'EXCLUIR' },
  { id: 4, description: 'IMPRIMIR' }, { id: 5, description: 'FATURAR' }, { id: 6, description: 'VISUALIZAR' },
  { id: 7, description: 'CANCELAR' }, { id: 8, description: 'DESCONTO' }, { id: 9, description: 'TRANSMITIR' },
  { id: 10, description: 'CATALOGAR' }, { id: 11, description: 'CONFIGURAR' }, { id: 12, description: 'CONSULTAR' },
]

/** As telas (kind 'T', inclusive o grupo Super): as que o app abre + a "Configurações Gerais" (sem módulo próprio). */
const SCREENS = [...APP_INTERFACE_ROUTE_KEYS, 'general-configs']
/** Recursos (kind 'R') — fora da regra do menu. */
const RESOURCES = ['partnerships', 'billing']
/** Interfaces com config ou campo no catálogo (a REGRA do CONFIGURAR) — um recorte do dev: inclui recurso (R) e o painel. */
const CONFIGURABLE = ['customers', 'orders', 'settlements', 'billing', 'partnerships', 'interface-configs', 'institutions']
const ALL_KEYS = [...SCREENS, ...RESOURCES]

const CONSUMED = consumedPrivileges()

/** O registro EXATAMENTE como a D-PV51 pede (operados fora os ausentes ∪ VISUALIZAR nas telas ∪ CONFIGURAR da regra ∪ reservados). */
function expectedCatalog(consumed: readonly ConsumedPrivilege[] = CONSUMED, configurable: readonly string[] = CONFIGURABLE): CatalogPairRow[] {
  const out = new Map<string, CatalogPairRow>()
  const add = (k: string, id: number): void => { out.set(pairKey(k, id), { interfaceKey: k, privilegeId: id }) }
  for (const c of consumed) if (!absentMarkHolds(c)) add(c.interface, PRIVILEGE_ID[c.privilege])
  for (const s of SCREENS) add(s, PRIVILEGE_ID.VISUALIZAR)
  for (const k of [...configurable, ...CONFIGURE_RULE_KEYS]) add(k, PRIVILEGE_ID.CONFIGURAR)
  for (const r of RESERVED_PRIVILEGES) add(r.interface, PRIVILEGE_ID[r.privilege])
  return [...out.values()]
}
const facts = (catalog: CatalogPairRow[], over: Partial<CatalogFacts> = {}): CatalogFacts =>
  ({ catalog, privileges: PRIVILEGES, screens: SCREENS, configurable: CONFIGURABLE, interfaceKeys: ALL_KEYS, ...over })
const without = (catalog: CatalogPairRow[], k: string, id: number): CatalogPairRow[] =>
  catalog.filter(r => !(r.interfaceKey === k && r.privilegeId === id))

const EMPTY: PrivilegeCatalogProblems = {
  missing: [], misnamed: [], duplicateNames: [], menuWithoutView: [], configureMissing: [], surplus: [], reservedAbsent: [],
  absentButPresent: [], duplicateKeys: [], nonCanonicalKeys: [],
}

describe('D-PV51 — conferência do catálogo, igualdade por interface (pura)', () => {
  it('o conjunto operado inclui a tabela do roteador (D-PV14): o CRUD de um cadastro guardado vem só dela', () => {
    expect(CONSUMED.length).toBeGreaterThan(CONSUMED_PRIVILEGES.length)
    const customers = CONSUMED.filter(c => c.interface === 'customers' && c.consumers.includes('api')).map(c => c.privilege).sort()
    expect(customers).toEqual(['ALTERAR', 'EXCLUIR', 'INSERIR', 'VISUALIZAR'])
  })

  it('o registro IGUAL ao esperado: nenhum problema, nenhum alarme', () => {
    const p = privilegeCatalogProblems(facts(expectedCatalog()))
    expect(p).toEqual(EMPTY)
    expect(privilegeCatalogAlarms(p)).toEqual([])
  })

  it('o C1: sem settlements × ALTERAR (a rota PUT /bills/…/charge pela guarda por roteador + o ícone ⇄) — falta EXATAMENTE ele', () => {
    const p = privilegeCatalogProblems(facts(without(expectedCatalog(), 'settlements', PRIVILEGE_ID.ALTERAR)))
    expect(p.missing.map(m => `${m.interface}|${m.privilege}`)).toEqual(['settlements|ALTERAR'])
    expect({ ...p, missing: [] }).toEqual(EMPTY)
  })

  it('par REGISTRADO que nenhum código opera (fora as regras e os reservados) SOBRA — D-PV51', () => {
    const catalog = [...expectedCatalog(), { interfaceKey: 'billing', privilegeId: PRIVILEGE_ID.ALTERAR },
      { interfaceKey: 'establishment', privilegeId: 13 }]
    const p = privilegeCatalogProblems(facts(catalog))
    expect(p.surplus.map(s => `${s.interface}|${s.privilegeId}|${s.privilege}`)).toEqual(['billing|2|ALTERAR', 'establishment|13|null'])
    expect({ ...p, surplus: [] }).toEqual(EMPTY)
    expect(privilegeCatalogAlarms(p)).toEqual([expect.stringContaining('2 par(es) REGISTRADO(S) que nenhum código opera')])
  })

  it('RESERVADO: no catálogo não sobra; fora dele, grita (a decisão manda manter)', () => {
    expect(RESERVED_PRIVILEGES.length).toBeGreaterThan(0)
    const r = RESERVED_PRIVILEGES[0]
    const p = privilegeCatalogProblems(facts(without(expectedCatalog(), r.interface, PRIVILEGE_ID[r.privilege])))
    expect(p.reservedAbsent).toEqual([{ interface: r.interface, privilege: r.privilege }])
    expect({ ...p, reservedAbsent: [] }).toEqual(EMPTY)
    // sem a marca, o mesmo par registrado SOBRARIA
    const unmarked = privilegeCatalogProblems(facts(expectedCatalog()), CONSUMED, [])
    expect(unmarked.surplus.map(s => `${s.interface}|${s.privilege}`)).toEqual(RESERVED_PRIVILEGES.map(x => `${x.interface}|${x.privilege}`).sort())
  })

  it('REGRA do menu: tela sem VISUALIZAR grita UMA vez (em menuWithoutView, não também em missing) — inclusive tela do grupo Super', () => {
    const cut = without(without(expectedCatalog(), 'customers', PRIVILEGE_ID.VISUALIZAR), 'countries', PRIVILEGE_ID.VISUALIZAR)
    const p = privilegeCatalogProblems(facts(cut))
    expect(p.menuWithoutView).toEqual(['countries', 'customers'])
    expect({ ...p, menuWithoutView: [] }).toEqual(EMPTY)
    // recurso (kind 'R') não é tela: VISUALIZAR dele só se o código o operar (a aba Parceria opera — guarda por roteador)
    expect(privilegeCatalogProblems(facts(without(expectedCatalog(), 'partnerships', PRIVILEGE_ID.VISUALIZAR))).missing
      .map(m => `${m.interface}|${m.privilege}`)).toEqual(['partnerships|VISUALIZAR'])
  })

  it('REGRA do CONFIGURAR: interface com config/campo (inclusive recurso) e general-configs sem o par gritam UMA vez', () => {
    const cut = without(without(without(expectedCatalog(), 'billing', 11), 'general-configs', 11), 'customers', 11)
    const p = privilegeCatalogProblems(facts(cut))
    expect(p.configureMissing).toEqual(['billing', 'customers', 'general-configs'])
    expect({ ...p, configureMissing: [] }).toEqual(EMPTY)
    // general-configs só é exigida se existir (a regra fala das interfaces vivas)
    const noGeneral = privilegeCatalogProblems(facts(without(expectedCatalog(), 'general-configs', 11),
      { interfaceKeys: ALL_KEYS.filter(k => k !== 'general-configs'), screens: SCREENS.filter(k => k !== 'general-configs') }))
    expect(noGeneral.configureMissing).toEqual([])
    // CONFIGURAR registrado numa interface SEM config nem campo e sem engrenagem que o pergunte SOBRA
    const extra = privilegeCatalogProblems(facts([...expectedCatalog(), { interfaceKey: 'cashier', privilegeId: 11 }]))
    expect(extra.surplus.map(s => `${s.interface}|${s.privilege}`)).toEqual(['cashier|CONFIGURAR'])
  })

  it('o nome é EXATO (A-PV26 — view + biblioteca decidem pelo nome binário): caixa, espaço, nome trocado ou privilégio morto grita', () => {
    const catalog = expectedCatalog()
    expect(privilegeCatalogProblems(facts(catalog)).misnamed).toEqual([])
    const lower = privilegeCatalogProblems(facts(catalog, { privileges: PRIVILEGES.map(r => (r.id === 5 ? { ...r, description: 'faturar' } : r)) }))
    expect(lower.misnamed.map(m => `${m.id}:${m.description}`)).toEqual(['5:faturar'])
    const padded = privilegeCatalogProblems(facts(catalog, { privileges: PRIVILEGES.map(r => (r.id === 5 ? { ...r, description: 'FATURAR ' } : r)) }))
    expect(padded.misnamed.map(m => `${m.id}:${m.description}`)).toEqual(['5:FATURAR '])
    const spaced = privilegeCatalogProblems(facts(catalog, { privileges: PRIVILEGES.map(r => (r.id === 2 ? { ...r, description: ' ALTERAR' } : r)) }))
    expect(spaced.misnamed.map(m => `${m.id}:${m.description}`)).toEqual(['2: ALTERAR'])
    const renamed = PRIVILEGES.map(r => (r.id === 2 ? { ...r, description: 'EDITAR' } : r)).filter(r => r.id !== 12)
    const p = privilegeCatalogProblems(facts(catalog, { privileges: renamed }))
    expect(p.misnamed.map(m => `${m.id}:${m.description}`)).toEqual(['2:EDITAR', '12:null'])
  })

  it('o catálogo SEM o seed 68 (CONFIGURAR/CONSULTAR fora de tb_privilege): os dois nomes gritam', () => {
    const p = privilegeCatalogProblems(facts(expectedCatalog(), { privileges: PRIVILEGES.filter(r => r.id <= 10) }))
    expect(p.misnamed.map(m => `${m.id}:${m.privilege}`)).toEqual(['11:CONFIGURAR', '12:CONSULTAR'])
  })

  it('nome de privilégio consumido repetido em OUTRA linha (mesmo com outra caixa ou espaço nas pontas) — grita', () => {
    const p = privilegeCatalogProblems(facts(expectedCatalog(), { privileges: [...PRIVILEGES, { id: 13, description: 'alterar' }] }))
    expect(p.duplicateNames).toEqual([{ privilege: 'ALTERAR', id: 2, otherIds: [13] }])
    const pad = privilegeCatalogProblems(facts(expectedCatalog(), { privileges: [...PRIVILEGES, { id: 13, description: 'FATURAR ' }] }))
    expect(pad.duplicateNames).toEqual([{ privilege: 'FATURAR', id: 5, otherIds: [13] }])
  })

  it('i18n_key pela regra do BANCO (sem caixa, sem espaço no fim): acha o par, mas grita a forma (D-PV42) e a repetição', () => {
    const odd = expectedCatalog().map(r => (r.interfaceKey === 'settlements' ? { ...r, interfaceKey: 'Settlements ' } : r))
    const p = privilegeCatalogProblems(facts(odd, { interfaceKeys: [...ALL_KEYS.filter(k => k !== 'settlements'), 'Settlements ', 'orders'] }))
    expect(p.missing).toEqual([])                                   // a guarda acharia (colação do banco) — não engana com "falta o seed"
    expect(p.surplus).toEqual([])
    expect(p.nonCanonicalKeys).toEqual(['"Settlements "'])
    expect(p.duplicateKeys).toEqual(['orders'])
    // acento: o banco iguala (general_ci) — repetição ambígua; fora da forma da rota (D-PV42: começa por letra; [a-z0-9-]) não é canônica
    const acc = privilegeCatalogProblems(facts(expectedCatalog(), { interfaceKeys: [...ALL_KEYS, 'séttlements', 'cashier_v2', '2fa', 'x--y'] }))
    expect(acc.duplicateKeys).toEqual(['settlements'])
    expect(acc.nonCanonicalKeys).toEqual(['"2fa"', '"cashier_v2"', '"séttlements"', '"x--y"'])
  })

  it('"ausente por decisão" não é exigido nem sobra; se o par aparecer no catálogo, avisa para tirar a marca (ou o par)', () => {
    const absent = CONSUMED.filter(absentMarkHolds)
    expect(absent.map(c => `${c.interface}|${c.privilege}`).sort())
      .toEqual(['order-returns|CANCELAR', 'order-returns|CONSULTAR', 'order-returns|TRANSMITIR'])
    const withThem = [...expectedCatalog(), ...absent.map(c => ({ interfaceKey: c.interface, privilegeId: PRIVILEGE_ID[c.privilege] }))]
    const p = privilegeCatalogProblems(facts(withThem))
    expect(p.missing).toEqual([])
    expect(p.surplus).toEqual([])
    expect(p.absentButPresent.map(a => `${a.interface}|${a.privilege}`).sort())
      .toEqual(['order-returns|CANCELAR', 'order-returns|CONSULTAR', 'order-returns|TRANSMITIR'])
  })

  it('a marca NÃO vale quando um BOTÃO consome o par (seria o próprio C1): o par volta a ser exigido', () => {
    const withButton: ConsumedPrivilege[] = [{ interface: 'order-returns', privilege: 'CANCELAR', consumers: ['api', 'app'],
      where: 'sonda', absentBy: 'marca indevida — um botão consome o par' }]
    const p = privilegeCatalogProblems(facts([]), withButton, [])
    expect(p.missing.map(m => `${m.interface}|${m.privilege}`)).toEqual(['order-returns|CANCELAR'])
  })

  it('privilegeId vindo do banco como texto conta igual', () => {
    const asText = expectedCatalog().map(r => ({ ...r, privilegeId: String(r.privilegeId) as unknown as number }))
    expect(privilegeCatalogProblems(facts(asText))).toEqual(EMPTY)
  })
})

describe('D-PV9/D-PV52 — conferência no boot (alarme, nunca derruba)', () => {
  beforeEach(() => { query.mockReset(); warn.mockReset() })

  const answer = (catalog: unknown[], privileges: unknown[] = PRIVILEGES) => (sql: string) => {
    if (sql === CATALOG_PAIRS_SQL) return Promise.resolve([catalog])
    if (sql === PRIVILEGES_SQL) return Promise.resolve([privileges])
    if (sql === SCREEN_INTERFACES_SQL) return Promise.resolve([SCREENS.map(k => ({ k }))])
    if (sql === CONFIGURABLE_INTERFACES_SQL) return Promise.resolve([CONFIGURABLE.map(k => ({ k }))])
    if (sql === INTERFACE_KEYS_SQL) return Promise.resolve([ALL_KEYS.map(k => ({ k }))])
    return Promise.reject(new Error(`SQL inesperado: ${sql}`))
  }

  it('registro igual ao esperado: OK, sem nenhum aviso', async () => {
    query.mockImplementation(answer(expectedCatalog()))
    const absent = CONSUMED.filter(absentMarkHolds).length
    expect(await assertPrivilegeCatalog()).toBe(
      `OK — ${CONSUMED.length - absent} par(es) operado(s) no catálogo (${absent} ausente(s) por decisão, ${RESERVED_PRIVILEGES.length} reservado(s))`)
    expect(warn).not.toHaveBeenCalled()
  })

  it('falta o C1 e sobra um par: grita as duas classes e devolve ALARME (sobe assim mesmo)', async () => {
    query.mockImplementation(answer([...without(expectedCatalog(), 'settlements', 2), { interfaceKey: 'users', privilegeId: 3 }]))
    const summary = await assertPrivilegeCatalog()
    expect(summary).toMatch(/^ALARME — 1 par\(es\) faltando, 1 sobrando, 0 nome\(s\) trocado\(s\)\/repetido\(s\), 0 tela\(s\) sem VISUALIZAR, 0 sem CONFIGURAR/)
    const lines = warn.mock.calls.map(c => String(c[0]))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('settlements × ALTERAR (2)')
    expect(lines[1]).toContain('users × EXCLUIR (3)')
  })

  it('antes do seed 68: os nomes CONFIGURAR/CONSULTAR e a REGRA do CONFIGURAR gritam', async () => {
    const before68 = expectedCatalog().filter(r => r.privilegeId < 11)
    query.mockImplementation(answer(before68, PRIVILEGES.filter(r => r.id <= 10)))
    const summary = await assertPrivilegeCatalog()
    expect(summary).toMatch(/^ALARME — \d+ par\(es\) faltando, 0 sobrando, 2 nome\(s\)/)
    expect(warn.mock.calls.map(c => String(c[0])).some(l => l.includes('sem CONFIGURAR'))).toBe(true)
  })

  it('a tabela do roteador vazia (gateway não montado) é alarme próprio', async () => {
    await jest.isolateModulesAsync(async () => {
      // registro novo de módulos: a peça da guarda nasce sem nenhum módulo montado
      const isolatedPool = (await import('@shared/db/connection')).default as unknown as { query: jest.Mock }
      const isolatedLog = (await import('@shared/logger/logger')).default as unknown as { warn: jest.Mock }
      isolatedPool.query.mockImplementation(answer(expectedCatalog(CONSUMED_PRIVILEGES)))
      const { assertPrivilegeCatalog: isolated } = await import('@shared/auth/assert-privilege-catalog')
      await isolated()
      expect(isolatedLog.warn.mock.calls.map(c => String(c[0]))).toContainEqual(expect.stringContaining('tabela da guarda por roteador está VAZIA'))
    })
  })

  it('linhas com forma inesperada (null, número, BigInt, objeto no lugar da lista) viram problema ou OK — nunca lançam', async () => {
    query.mockImplementation((sql: string) => {
      if (sql === CATALOG_PAIRS_SQL) return Promise.resolve([[null, { interfaceKey: 'settlements', privilegeId: BigInt(2) }]])
      if (sql === PRIVILEGES_SQL) return Promise.resolve([{ nao: 'lista' }])
      return Promise.resolve([undefined])
    })
    await expect(assertPrivilegeCatalog()).resolves.toMatch(/^ALARME/)
  })

  it('falha de leitura do banco (inclusive erro que lança ao ler a mensagem): alarme e NÃO lança (o servidor sobe)', async () => {
    query.mockRejectedValue(new Error("SELECT command denied to user 'x' for table 'tb_interface_has_privilege'"))
    await expect(assertPrivilegeCatalog()).resolves.toBe('NÃO CONFERIDO (falha de leitura — ver alarme)')
    expect(String(warn.mock.calls[0][0])).toContain('[ALARME D-PV9] não foi possível conferir')
    const evil = Object.create(Error.prototype, { message: { get() { throw new Error('getter') } } })
    query.mockRejectedValue(evil)
    await expect(assertPrivilegeCatalog()).resolves.toBe('NÃO CONFERIDO (falha de leitura — ver alarme)')
    warn.mockImplementation(() => { throw new Error('logger quebrado') })
    await expect(assertPrivilegeCatalog()).resolves.toBe('NÃO CONFERIDO (falha de leitura — ver alarme)')
    // logger quebrado com a LEITURA certa: o resumo diz a verdade (não vira "falha de leitura")
    query.mockReset(); query.mockImplementation(answer(without(expectedCatalog(), 'settlements', 2)))
    await expect(assertPrivilegeCatalog()).resolves.toMatch(/^ALARME — 1 par/)
  })

  it('só SELECT no setes_central', () => {
    for (const sql of [CATALOG_PAIRS_SQL, PRIVILEGES_SQL, SCREEN_INTERFACES_SQL, CONFIGURABLE_INTERFACES_SQL, INTERFACE_KEYS_SQL]) {
      expect(sql.trim()).toMatch(/^SELECT /)
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i)
      expect([...sql.matchAll(/FROM\s+(\S+)|JOIN\s+(\S+)/g)].every(m => (m[1] ?? m[2]).startsWith('setes_central.'))).toBe(true)
    }
  })
})
