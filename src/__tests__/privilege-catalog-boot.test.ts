/// <reference types="jest" />
// CONFERÊNCIA NO BOOT do catálogo de privilégios (D-PV9 — Valdo 2026-10-18): a lista única `CONSUMED_PRIVILEGES` contra
// `setes_central.tb_interface_has_privilege`; par faltando = ALARME no log, o servidor sobe assim mesmo. Provas sem banco: o catálogo
// de HOJE (23 pares — §2.1 do prompt_privilegios_interfaces.md) grita exatamente o C1; com o seed 64 aplicado, nada falta.
import fs from 'fs'
import path from 'path'

jest.mock('@shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn() } }))
jest.mock('@shared/logger/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import pool from '@shared/db/connection'
import logger from '@shared/logger/logger'
import {
  privilegeCatalogProblems, CONSUMED_PRIVILEGES, PRIVILEGE_ID, CatalogPairRow, PrivilegeDefinitionRow, ConsumedPrivilege, absentMarkHolds,
} from '@shared/auth/privilege-catalog'
import {
  assertPrivilegeCatalog, privilegeCatalogAlarms, CATALOG_PAIRS_SQL, PRIVILEGES_SQL, MENU_INTERFACES_SQL, INTERFACE_KEYS_SQL,
} from '@shared/auth/assert-privilege-catalog'
import { findSiblingRepo } from '../test-setup/privilege-fence'

const ROOT = path.resolve(__dirname, '..', '..')
const query = (pool as unknown as { query: jest.Mock }).query
const warn = (logger as unknown as { warn: jest.Mock }).warn

/** `tb_privilege` como está (sql/06 + 51 + 55 + 59). */
const PRIVILEGES: PrivilegeDefinitionRow[] = [
  { id: 1, description: 'INSERIR' }, { id: 2, description: 'ALTERAR' }, { id: 3, description: 'EXCLUIR' },
  { id: 4, description: 'IMPRIMIR' }, { id: 5, description: 'FATURAR' }, { id: 6, description: 'VISUALIZAR' },
  { id: 7, description: 'CANCELAR' }, { id: 8, description: 'DESCONTO' }, { id: 9, description: 'TRANSMITIR' },
]

/** O catálogo VIVO de 2026-10-18 antes do seed 64 (§2.1: 23 linhas). */
const TODAY: CatalogPairRow[] = [
  ...[1, 6].map(p => ({ interfaceKey: 'institutions', privilegeId: p })),
  ...['countries', 'cities', 'bank-accounts'].flatMap(k => [1, 2, 3, 6].map(p => ({ interfaceKey: k, privilegeId: p }))),
  ...['service-orders', 'orders'].flatMap(k => [5, 7, 9].map(p => ({ interfaceKey: k, privilegeId: p }))),
  { interfaceKey: 'settlements', privilegeId: 8 },
  { interfaceKey: 'order-returns', privilegeId: 5 },
  { interfaceKey: 'bank-charge-agreements', privilegeId: 8 },
]

/** As 29 telas do cliente (kind 'T', fora do grupo Super — §3 do prompt; conferido ao vivo em 2026-10-18). */
const MENU = ['interface-fields', 'users', 'customers', 'interface-configs', 'general-configs', 'collaborators', 'categories',
  'financial-plans', 'payment-types', 'contracts', 'bank-accounts', 'service-orders', 'settlements', 'salesmen', 'carriers',
  'providers', 'modules', 'tax-rules', 'orders', 'cashier', 'order-returns', 'establishment', 'price-lists', 'services',
  'service-tax-rules', 'settlement-rules', 'bank-slips', 'bank-charge-agreements', 'checks']
const SUPER_AND_R = ['institutions', 'privileges', 'interfaces', 'countries', 'states', 'cities', 'cfop', 'banks', 'service-list',
  'partnerships', 'billing']
const ALL_KEYS = [...MENU, ...SUPER_AND_R]

const EMPTY = { missing: [], misnamed: [], duplicateNames: [], menuWithoutView: [], absentButPresent: [], duplicateKeys: [], nonCanonicalKeys: [] }

/** Os pares do estado final do seed 64 (lidos do próprio arquivo — `tmp_seed64_expected`). */
function seed64Pairs(): CatalogPairRow[] {
  const dir = findSiblingRepo(ROOT, 'sql', '64_privileges_backfill_seed.sql')
  if (!dir) throw new Error('repositório sql não achado (defina SQL_DIR)')
  const code = fs.readFileSync(path.join(dir, '64_privileges_backfill_seed.sql'), 'utf8')
    .split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n')   // comentário do seed tem ';'
  const block = /INSERT INTO `tmp_seed64_expected`[^;]*;/.exec(code)?.[0] ?? ''
  return [...block.matchAll(/\('([a-z-]+)',\s*(\d+)\)/g)].map(m => ({ interfaceKey: m[1], privilegeId: Number(m[2]) }))
}

describe('D-PV9 — conferência do catálogo (pura)', () => {
  it('o catálogo de HOJE (sem o seed 64): falta EXATAMENTE o C1 — settlements × ALTERAR', () => {
    const p = privilegeCatalogProblems(TODAY, PRIVILEGES, MENU, CONSUMED_PRIVILEGES, ALL_KEYS)
    expect(p.missing.map(m => `${m.interface}|${m.privilege}`)).toEqual(['settlements|ALTERAR'])
    expect({ ...p, missing: [], menuWithoutView: [] }).toEqual(EMPTY)
    // C2: das 29 telas do cliente, só bank-accounts tem VISUALIZAR
    expect(p.menuWithoutView).toEqual(MENU.filter(k => k !== 'bank-accounts').sort())
  })

  it('com o seed 64 aplicado: nada falta (157 pares), nenhuma tela sem VISUALIZAR', () => {
    const seed = seed64Pairs()
    expect(seed).toHaveLength(157)
    const p = privilegeCatalogProblems(seed, PRIVILEGES, MENU, CONSUMED_PRIVILEGES, ALL_KEYS)
    expect(p).toEqual(EMPTY)
    expect(privilegeCatalogAlarms(p)).toEqual([])
  })

  it('o nome compara como o APP (toLowerCase, SEM trim): caixa não importa; espaço, nome trocado ou privilégio morto grita', () => {
    const lower = privilegeCatalogProblems(TODAY, PRIVILEGES.map(r => ({ ...r, description: r.description!.toLowerCase() })), MENU)
    expect(lower.misnamed).toEqual([])
    const spaced = privilegeCatalogProblems(TODAY, PRIVILEGES.map(r => (r.id === 2 ? { ...r, description: ' ALTERAR' } : r)), MENU)
    expect(spaced.misnamed.map(m => `${m.id}:${m.description}`)).toEqual(['2: ALTERAR'])
    const renamed = PRIVILEGES.map(r => (r.id === 2 ? { ...r, description: 'EDITAR' } : r)).filter(r => r.id !== 9)
    const p = privilegeCatalogProblems(TODAY, renamed, MENU)
    expect(p.misnamed.map(m => `${m.id}:${m.description}`).sort()).toEqual(['2:EDITAR', '9:null'])
  })

  it('nome de privilégio consumido repetido em OUTRA linha: o app libera por qualquer uma, a API pelo id — grita', () => {
    const p = privilegeCatalogProblems(TODAY, [...PRIVILEGES, { id: 10, description: 'alterar' }], MENU)
    expect(p.duplicateNames).toEqual([{ privilege: 'ALTERAR', id: 2, otherIds: [10] }])
  })

  it('i18n_key pela regra do BANCO (sem caixa, sem espaço no fim): acha o par, mas grita a forma e a repetição', () => {
    const odd = TODAY.map(r => (r.interfaceKey === 'settlements' ? { ...r, interfaceKey: 'Settlements ' } : r))
    const p = privilegeCatalogProblems([...odd, { interfaceKey: 'Settlements ', privilegeId: 2 }], PRIVILEGES, MENU, CONSUMED_PRIVILEGES,
      [...ALL_KEYS.filter(k => k !== 'settlements'), 'Settlements ', 'orders'])
    expect(p.missing).toEqual([])                                   // a guarda acharia (colação do banco) — não engana com "falta o seed"
    expect(p.nonCanonicalKeys).toEqual(['"Settlements "'])
    expect(p.duplicateKeys).toEqual(['orders'])
    // acento: o banco iguala (general_ci) — repetição ambígua para a guarda; e fora de [a-z0-9-] é forma não canônica
    const acc = privilegeCatalogProblems(TODAY, PRIVILEGES, MENU, CONSUMED_PRIVILEGES, [...ALL_KEYS, 'séttlements', 'cashier_v2'])
    expect(acc.duplicateKeys).toEqual(['settlements'])
    expect(acc.nonCanonicalKeys).toEqual(['"cashier_v2"', '"séttlements"'])
  })

  it('"ausente por decisão" não grita; se o par aparecer no catálogo, avisa para tirar a marca', () => {
    const absent = CONSUMED_PRIVILEGES.filter(absentMarkHolds)
    expect(absent.map(c => `${c.interface}|${c.privilege}`).sort()).toEqual(['order-returns|CANCELAR', 'order-returns|TRANSMITIR'])
    const withThem = [...seed64Pairs(), ...absent.map(c => ({ interfaceKey: c.interface, privilegeId: PRIVILEGE_ID[c.privilege] }))]
    const p = privilegeCatalogProblems(withThem, PRIVILEGES, MENU)
    expect(p.missing).toEqual([])
    expect(p.absentButPresent.map(a => `${a.interface}|${a.privilege}`).sort()).toEqual(['order-returns|CANCELAR', 'order-returns|TRANSMITIR'])
  })

  it('a marca NÃO vale quando um BOTÃO consome o par (seria o próprio C1): o par volta a ser exigido', () => {
    const withButton: ConsumedPrivilege[] = [{ interface: 'order-returns', privilege: 'CANCELAR', consumers: ['api', 'app'],
      where: 'sonda', absentBy: 'marca indevida — um botão consome o par' }]
    const p = privilegeCatalogProblems(TODAY, PRIVILEGES, MENU, withButton)
    expect(p.missing.map(m => `${m.interface}|${m.privilege}`)).toEqual(['order-returns|CANCELAR'])
  })

  it('privilegeId vindo do banco como texto conta igual', () => {
    const asText = TODAY.map(r => ({ ...r, privilegeId: String(r.privilegeId) as unknown as number }))
    expect(privilegeCatalogProblems(asText, PRIVILEGES, MENU).missing.map(m => m.privilege)).toEqual(['ALTERAR'])
  })
})

describe('D-PV9 — conferência no boot (alarme, nunca derruba)', () => {
  beforeEach(() => { query.mockReset(); warn.mockReset() })

  const answer = (catalog: unknown[], keys: unknown[] = ALL_KEYS.map(k => ({ k }))) => (sql: string) => {
    if (sql === CATALOG_PAIRS_SQL) return Promise.resolve([catalog])
    if (sql === PRIVILEGES_SQL) return Promise.resolve([PRIVILEGES])
    if (sql === MENU_INTERFACES_SQL) return Promise.resolve([MENU.map(k => ({ k }))])
    if (sql === INTERFACE_KEYS_SQL) return Promise.resolve([keys])
    return Promise.reject(new Error(`SQL inesperado: ${sql}`))
  }

  it('catálogo de hoje: grita o C1 (e o C2 em linha própria) e devolve ALARME', async () => {
    query.mockImplementation(answer(TODAY))
    const summary = await assertPrivilegeCatalog()
    expect(summary).toMatch(/^ALARME — 1 par\(es\) faltando, 0 nome\(s\) trocado\(s\)\/repetido\(s\), 28 tela\(s\) sem VISUALIZAR/)
    const lines = warn.mock.calls.map(c => String(c[0]))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('[ALARME D-PV9] 1 par(es)')
    expect(lines[0]).toContain('settlements × ALTERAR (2)')
    expect(lines[1]).toContain('28 tela(s) do cliente sem VISUALIZAR')
  })

  it('seed 64 aplicado: OK, sem nenhum aviso', async () => {
    query.mockImplementation(answer(seed64Pairs()))
    const absent = CONSUMED_PRIVILEGES.filter(absentMarkHolds).length
    expect(await assertPrivilegeCatalog()).toBe(`OK — ${CONSUMED_PRIVILEGES.length - absent} par(es) consumido(s) no catálogo (${absent} ausente(s) por decisão)`)
    expect(warn).not.toHaveBeenCalled()
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
    query.mockReset(); query.mockImplementation(answer(TODAY))
    await expect(assertPrivilegeCatalog()).resolves.toMatch(/^ALARME — 1 par/)
  })

  it('só SELECT no setes_central', () => {
    for (const sql of [CATALOG_PAIRS_SQL, PRIVILEGES_SQL, MENU_INTERFACES_SQL, INTERFACE_KEYS_SQL]) {
      expect(sql.trim()).toMatch(/^SELECT /)
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i)
      expect([...sql.matchAll(/FROM\s+(\S+)|JOIN\s+(\S+)/g)].every(m => (m[1] ?? m[2]).startsWith('setes_central.'))).toBe(true)
    }
  })
})
