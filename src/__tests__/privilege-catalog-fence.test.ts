/// <reference types="jest" />
// CERCA do catálogo de privilégios (D-PV9 = Q-PV9 (a), Valdo 2026-10-18 — `Infra-IA/prompts/prompt_privilegios_interfaces.md`; molde
// voice-kind-fence/federal-id-fence): todo par (interface, privilégio) que o CÓDIGO consome — guarda de rota e política do setes-api,
// guarda da nfse-api, `CurrentInterface.can('X')` do setes-app — tem de estar na lista única `CONSUMED_PRIVILEGES`
// (`src/shared/auth/privilege-catalog.ts`), que o boot confere contra o catálogo do banco. Origem: o C1 — a rota do "trocar a
// cobrança" exigia ALTERAR em `settlements`, o catálogo não tinha o par e o botão sumiu até para o admin, sem nenhum gate perceber.
// O PREDICADO (as varreduras e as sondas) mora em `src/test-setup/privilege-fence.ts`.
import fs from 'fs'
import path from 'path'
import {
  CONSUMED_PRIVILEGES, PRIVILEGE_ID, ORDER_BRANCH_INTERFACES, pairKey, PrivilegeConsumer,
} from '../shared/auth/privilege-catalog'
import { CATALOG_PAIRS_SQL, MENU_INTERFACES_SQL } from '../shared/auth/assert-privilege-catalog'
import {
  scanTs, repoTsSources, findSiblingRepo, orderInterfaceKeyDomain, appModuleInterfaces, scanDartFile, appDartSources, grantSqlCounts, identifierUses,
  appImportGraph, sharedFileInterfaces, exportedNames, privilegeConstants, expandSharedSite, SharedConsumerEntry,
  API_PRIMITIVES, API_IMPL, API_DECLARATIONS, API_RESOLVERS, RESOLVER_FILE, NFSE_PRIMITIVES, NFSE_IMPL, APP_ROUTES_FILE,
  TS_PROBES, LOOSE_PROBES, DART_PROBES, DART_PROBE_MODULES, DART_PROBE_CONSTANTS, dartStringConstants, FoundPair, FenceScan,
} from '../test-setup/privilege-fence'

const ROOT = path.resolve(__dirname, '..', '..')
const NFSE = findSiblingRepo(ROOT, 'nfse-api', 'src/modules/guards.ts')
const APP = findSiblingRepo(ROOT, 'setes-app', APP_ROUTES_FILE)
/** O núcleo fiscal: os ids `erp.PRIVILEGE_*` e o domínio `erp.orderInterface` que as guardas da nfse-api usam moram lá. */
const CORE = findSiblingRepo(ROOT, 'fiscal-api', 'src/erp/facts.ts')

/**
 * Exports das IMPLEMENTAÇÕES das primitivas que NÃO consomem privilégio (motivo). Export novo ali (ex.: um helper de veredito que
 * recebe o id) reprova até virar primitiva registrada no predicado ou entrar aqui — a varredura não olha dentro da implementação.
 */
const IMPL_NON_PRIVILEGE: Record<string, Record<string, string>> = {
  'setes-api src/shared/auth/require-privilege.ts': {
    institutionHasInterface: 'LICENÇA (interface contratada), não privilégio — D-F37',
    requireInterfaceFor: 'LICENÇA do ramo nas leituras fiscais (Q-N32) — sem privilégio',
    resetPrivilegeCache: 'testes / catálogo alterado em runtime',
  },
  'nfse-api src/modules/guards.ts': {
    requireCutover: 'cerca da virada (D-F18/D-F39), não privilégio',
    visibleInterfaces: 'LICENÇA: ramos contratados (D-F14/D-F37)',
    requireBranchInterface: 'LICENÇA do ramo nas leituras (Q-N32)',
    requireAnyInterface: 'LICENÇA: alguma interface contratada',
    requireAdmin: 'PERFIL admin (habilitação/A1), não privilégio de interface',
    parseInvoiceId: 'parse do id da rota',
  },
}

/**
 * `PRIVILEGE_<NOME>` usado FORA de uma primitiva no setes-api (`arquivo: linha`) → motivo. Consumidor que não passa pelas
 * primitivas: ou é uma REGRA conferida no boot (o menu), ou tem de virar primitiva.
 */
const ALLOWED_LOOSE: Record<string, string> = {
  'src/modules/core/core.repository.ts: AND uhp.tb_privilege_id = ${PRIVILEGE_VISUALIZAR} ×2':
    'menu do usuário regular (getModuleInterfaces + getUngroupedInterfaces): VISUALIZAR em toda tela — regra MENU_PRIVILEGE, ' +
    'conferida no boot (telas sem VISUALIZAR = C2)',
}

/**
 * Arquivo do setes-api cujo SQL lê a concessão do usuário (`tb_user_has_privilege`) fora das primitivas → motivo. Guarda por SQL
 * direto não entra aqui: vira primitiva (ou usa `requirePrivilege`).
 */
const ALLOWED_GRANT_SQL: Record<string, { count: number; reason: string }> = {
  'src/modules/core/core.repository.ts': { count: 3, reason:
    'menu (VISUALIZAR — regra MENU_PRIVILEGE, conferida no boot) nas duas consultas do menu + os botões do regular (getUserPrivileges ' +
    'devolve o que foi concedido)' },
  'src/modules/users/users.repository.ts': { count: 4, reason:
    'cadastro de privilégios do usuário: lista e grava a concessão, não decide ato nenhum' },
}

/**
 * Leitores da concessão/catálogo que NÃO são primitivas (devolvem a lista; quem decide pelo NOME passaria calado) → os únicos
 * arquivos que podem usá-los (a declaração e o consumidor de hoje, com o motivo).
 */
const GRANT_READERS: Record<string, Record<string, string>> = {
  getUserPrivileges: {
    'src/modules/core/core.repository.ts': 'declaração', 'src/modules/core/core.service.ts': 'menu do regular (botões = concedidos)',
  },
  getAllInterfacePrivileges: {
    'src/modules/core/core.repository.ts': 'declaração', 'src/modules/core/core.service.ts': 'menu do admin/super (botões = catálogo — C1)',
  },
  listUserPrivileges: {
    'src/modules/users/users.repository.ts': 'declaração', 'src/modules/users/users.service.ts': 'tela de privilégios do usuário',
  },
  listInterfaceCatalogPrivilegeIds: {
    'src/modules/users/users.repository.ts': 'declaração', 'src/modules/users/users.service.ts': 'recusa conceder fora do catálogo',
  },
}

/**
 * `CurrentInterface.can('X')` numa peça COMPARTILHADA do app (fora de `modules/<m>/`, ex.: a fábrica Register* na onda da D-PV2) →
 * o motivo. As telas cobertas são DERIVADAS do código (todo módulo que alcança o arquivo pelo grafo de import/export —
 * `sharedFileInterfaces`): a tela nova que usar a peça entra sozinha. Exceção = `exclude` (tela → motivo), que SUBTRAI da derivação
 * — ex.: o painel que usa a lista mas não tem "Novo" (interface-configs só tem ALTERAR/VISUALIZAR no catálogo, D-PV1).
 */
const APP_SHARED_CONSUMERS: Record<string, SharedConsumerEntry> = {}

function scanAll(): { pairs: FoundPair[]; api: FenceScan; nfse: FenceScan; app: FenceScan } {
  const api = scanTs(repoTsSources(ROOT), API_PRIMITIVES, 'api', { impl: API_IMPL, declarations: API_DECLARATIONS, resolvers: API_RESOLVERS })
  const nfse = scanTs(repoTsSources(NFSE!), NFSE_PRIMITIVES, 'nfse', { impl: NFSE_IMPL })
  const modules = appModuleInterfaces(fs.readFileSync(path.join(APP!, APP_ROUTES_FILE), 'utf8'))
  const app: FenceScan = { pairs: [], unresolved: [], loose: [], shared: [] }
  const dart = appDartSources(APP!)
  const constants = dartStringConstants(dart)
  for (const s of dart) {
    const r = scanDartFile(s.file, s.code, modules, constants)
    app.pairs.push(...r.pairs); app.unresolved.push(...r.unresolved); app.shared.push(...r.shared)
  }
  const graph = appImportGraph(dart)
  const sharedPairs: FoundPair[] = app.shared.filter(s => s.site in APP_SHARED_CONSUMERS).flatMap(s => {
    const derived = sharedFileInterfaces(s.site.slice(0, s.site.indexOf(': ')), graph, modules)
    const r = expandSharedSite(s, derived, APP_SHARED_CONSUMERS[s.site])
    app.unresolved.push(...r.problems)
    return r.pairs
  })
  return { pairs: [...api.pairs, ...nfse.pairs, ...app.pairs, ...sharedPairs], api, nfse, app }
}

describe('D-PV9 — cerca: todo par (interface, privilégio) consumido pelo código está na lista única', () => {
  it('os repositórios irmãos foram achados (cerca que pula não cerca — defina NFSE_API_DIR / SETES_APP_DIR)', () => {
    expect({ nfse: NFSE !== null, app: APP !== null }).toEqual({ nfse: true, app: true })
  })

  const scan = NFSE && APP ? scanAll() : null
  const listed = new Map(CONSUMED_PRIVILEGES.map(c => [pairKey(c.interface, PRIVILEGE_ID[c.privilege]), c]))

  it('nenhum consumo ilegível (guarda dinâmica, nome trocado, can fora do CurrentInterface…)', () => {
    expect([...scan!.api.unresolved, ...scan!.nfse.unresolved, ...scan!.app.unresolved]).toEqual([])
  })

  it('todo par consumido está em CONSUMED_PRIVILEGES (par novo: entra na lista E no seed por i18n_key, antes do app)', () => {
    const out = scan!.pairs.filter(p => !listed.has(pairKey(p.interface, PRIVILEGE_ID[p.privilege])))
      .map(p => `${p.interface} × ${p.privilege} ← ${p.consumer} ${p.site}`)
    expect([...new Set(out)]).toEqual([])
  })

  it('a lista não apodrece: cada entrada tem EXATAMENTE os consumidores que o código mostra', () => {
    const found = new Map<string, Set<PrivilegeConsumer>>()
    for (const p of scan!.pairs) {
      const k = pairKey(p.interface, PRIVILEGE_ID[p.privilege])
      if (!found.has(k)) found.set(k, new Set())
      found.get(k)!.add(p.consumer)
    }
    const wrong = CONSUMED_PRIVILEGES
      .map(c => ({ c, got: [...(found.get(pairKey(c.interface, PRIVILEGE_ID[c.privilege])) ?? [])].sort() }))
      .filter(({ c, got }) => got.join(',') !== [...c.consumers].sort().join(','))
      .map(({ c, got }) => `${c.interface} × ${c.privilege}: lista diz [${[...c.consumers].sort()}], código mostra [${got}]`)
    expect(wrong).toEqual([])
  })

  it('PRIVILEGE_<NOME> fora de primitiva só nos lugares registrados (com o motivo) — e o registro não apodrece', () => {
    expect(scan!.api.loose.filter(l => !(l in ALLOWED_LOOSE))).toEqual([])
    expect(scan!.nfse.loose).toEqual([])   // na nfse-api nenhum `PRIVILEGE_*` fora das guardas
    expect(Object.keys(ALLOWED_LOOSE).filter(k => !scan!.api.loose.includes(k))).toEqual([])
  })

  it('SQL que lê a concessão do usuário só nos lugares registrados — e o registro não apodrece', () => {
    const counts = grantSqlCounts(repoTsSources(ROOT), API_IMPL)
    const want = Object.fromEntries(Object.entries(ALLOWED_GRANT_SQL).map(([f, v]) => [f, v.count]))
    expect(counts).toEqual(want)   // arquivo novo OU SQL novo num arquivo registrado reprova (registro por contagem)
  })

  it('leitores da concessão (que devolvem a lista) só nos arquivos registrados', () => {
    const uses = identifierUses(repoTsSources(ROOT), Object.keys(GRANT_READERS))
    const allowed = Object.entries(GRANT_READERS).flatMap(([n, files]) => Object.keys(files).map(f => `${f}: ${n}`)).sort()
    expect(uses).toEqual(allowed)
  })

  it('can() compartilhado do app só registrado (com as interfaces) — e o registro não apodrece', () => {
    expect(scan!.app.shared.map(s => s.site).filter(s => !(s in APP_SHARED_CONSUMERS))).toEqual([])
    expect(Object.keys(APP_SHARED_CONSUMERS).filter(k => !scan!.app.shared.some(s => s.site === k))).toEqual([])
  })
})

describe('D-PV9 — a lista é coerente com o código que ela descreve', () => {
  it('a marca "ausente por decisão" nunca em par que um BOTÃO consome (botão sem o par no catálogo é o próprio C1)', () => {
    expect(CONSUMED_PRIVILEGES.filter(c => c.absentBy && c.consumers.includes('app')).map(c => `${c.interface} × ${c.privilege}`)).toEqual([])
  })

  it('a implementação das primitivas só exporta primitivas registradas ou o que não é privilégio (com motivo)', () => {
    const impls: [string, string, readonly string[]][] = [
      ['setes-api src/shared/auth/require-privilege.ts', path.join(ROOT, API_IMPL[0]), API_PRIMITIVES.map(p => p.name)],
      ['nfse-api src/modules/guards.ts', path.join(NFSE!, NFSE_IMPL[0]), NFSE_PRIMITIVES.map(p => p.name)],
    ]
    for (const [label, file, prims] of impls) {
      const allowed = IMPL_NON_PRIVILEGE[label]
      const exported = exportedNames(fs.readFileSync(file, 'utf8'))
      expect([label, exported.filter(n => !prims.includes(n) && !(n in allowed))]).toEqual([label, []])
      expect([label, Object.keys(allowed).filter(n => !exported.includes(n))]).toEqual([label, []])
    }
  })

  it('o núcleo fiscal usa os MESMOS ids e o MESMO domínio do ramo (a nfse-api lê erp.PRIVILEGE_* pelo nome)', () => {
    expect(CORE).not.toBeNull()
    const facts = fs.readFileSync(path.join(CORE!, 'src', 'erp', 'facts.ts'), 'utf8')
    const ids = privilegeConstants(facts)
    expect(Object.keys(ids).length).toBeGreaterThan(0)
    for (const [n, id] of Object.entries(ids)) expect([n, id]).toEqual([n, PRIVILEGE_ID[n as keyof typeof PRIVILEGE_ID]])
    expect((orderInterfaceKeyDomain(facts) ?? []).sort()).toEqual([...ORDER_BRANCH_INTERFACES].sort())
  })

  it('sem par repetido; "ausente por decisão" sempre com o motivo', () => {
    const keys = CONSUMED_PRIVILEGES.map(c => pairKey(c.interface, PRIVILEGE_ID[c.privilege]))
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([])
    expect(CONSUMED_PRIVILEGES.filter(c => c.absentBy !== undefined && c.absentBy.trim().length < 20)).toEqual([])
    expect(CONSUMED_PRIVILEGES.filter(c => c.consumers.length === 0 || !/^[a-z]+(-[a-z]+)*$/.test(c.interface))).toEqual([])
  })

  it('PRIVILEGE_ID cobre EXATAMENTE as constantes de @shared/auth/privileges (privilégio novo entra no mapa)', () => {
    const code = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'auth', 'privileges.ts'), 'utf8')
    const declared = [...code.matchAll(/export const PRIVILEGE_([A-Z]+)\s*=\s*(\d+)/g)].map(m => `${m[1]}=${m[2]}`).sort()
    expect(Object.entries(PRIVILEGE_ID).map(([n, id]) => `${n}=${id}`).sort()).toEqual(declared)
  })

  it('o resolver do billing devolve EXATAMENTE as interfaces do ramo (OrderInterfaceKey = ORDER_BRANCH_INTERFACES)', () => {
    const code = fs.readFileSync(path.join(ROOT, RESOLVER_FILE), 'utf8')
    expect((orderInterfaceKeyDomain(code) ?? []).sort()).toEqual([...ORDER_BRANCH_INTERFACES].sort())
    for (const fn of Object.keys(API_RESOLVERS)) expect(code).toMatch(new RegExp(`export function ${fn}\\b[\\s\\S]*?return resolveOrderInterface\\(`))
  })

  it('o boot lê o catálogo pelo MESMO predicado dos botões e do menu (core.repository)', () => {
    const core = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'core', 'core.repository.ts'), 'utf8')
    expect(core).toContain(`const SUPER_MENU_GROUP = 'Super'`)
    expect(core).toContain('const ONLY_SCREEN_KIND = `AND i.kind = \'T\'`')
    expect(core).toMatch(/getAllInterfacePrivileges[\s\S]*?p\.deleted = 'N'[\s\S]*?WHERE ihp\.active = 'S' AND ihp\.deleted = 'N'/)
    expect(MENU_INTERFACES_SQL).toContain(`i.kind = 'T'`)
    expect(MENU_INTERFACES_SQL).toContain(`COALESCE(i.group_default, '') <> 'Super'`)
    expect(CATALOG_PAIRS_SQL).toMatch(/p\.deleted = 'N'[\s\S]*WHERE ihp\.active = 'S' AND ihp\.deleted = 'N'/)
  })
})

describe('D-PV9 — a cerca enxerga o que deve (sondas)', () => {
  it.each(TS_PROBES.map(p => [p.code.split('\n')[0].slice(0, 70), p] as const))('TS: %s', (_t, p) => {
    const r = scanTs([{ file: p.file ?? 'probe.ts', code: p.code }], API_PRIMITIVES, 'api', { resolvers: API_RESOLVERS })
    expect([...new Set(r.pairs.map(x => `${x.interface}|${x.privilege}`))].sort()).toEqual([...p.pairs].sort())
    expect(r.unresolved.length > 0 ? 'reprova' : 'passa').toBe(p.unresolved > 0 ? 'reprova' : 'passa')
  })

  it.each(LOOSE_PROBES.map(p => [p.code.slice(0, 70), p] as const))('PRIVILEGE solto: %s', (_t, p) => {
    expect(scanTs([{ file: 'probe.ts', code: p.code }], API_PRIMITIVES, 'api').loose.length).toBe(p.loose)
  })

  it.each(DART_PROBES.map(p => [`${p.file.split('/').slice(-3).join('/')} ${p.code.slice(0, 50)}`, p] as const))('Dart: %s', (_t, p) => {
    const r = scanDartFile(p.file, p.code, DART_PROBE_MODULES, DART_PROBE_CONSTANTS)
    expect(r.pairs.map(x => `${x.interface}|${x.privilege}`)).toEqual(p.pairs)
    expect(r.shared.length).toBe(p.shared)
    expect(r.unresolved.length > 0 ? 'reprova' : 'passa').toBe(p.unresolved > 0 ? 'reprova' : 'passa')
  })

  it('a nfse-api: guarda pelo RAMO vale nas três interfaces; userHasPrivilege fora de guards.ts reprova', () => {
    const r = scanTs([{ file: 'r.ts', code: `await requireBranchPrivilege(ctx, inst, ref, erp.PRIVILEGE_CANCELAR)\n` +
      `const KS = ['orders'] as const\nawait passScope(ctx, inst, KS, erp.PRIVILEGE_TRANSMITIR)` }], NFSE_PRIMITIVES, 'nfse')
    expect(r.pairs.map(x => `${x.interface}|${x.privilege}`).sort())
      .toEqual(['order-returns|CANCELAR', 'orders|CANCELAR', 'orders|TRANSMITIR', 'service-orders|CANCELAR'])
    const bad = scanTs([{ file: 'x.ts', code: `await erp.userHasPrivilege(p, s, u, key, 9)` }], NFSE_PRIMITIVES, 'nfse')
    expect(bad.unresolved.length).toBeGreaterThan(0)
  })

  it('SQL com a concessão do usuário é achado (texto e template); comentário não conta', () => {
    expect(grantSqlCounts([
      { file: 'a.ts', code: 'const q = `SELECT 1 FROM ${s}.tb_user_has_privilege WHERE tb_privilege_id = 2`' },
      { file: 'b.ts', code: `pool.query("select * from TB_USER_HAS_PRIVILEGE"); pool.query('x tb_user_has_privilege')` },
      { file: 'c.ts', code: `// tb_user_has_privilege só no comentário` },
    ])).toEqual({ 'a.ts': 1, 'b.ts': 2 })
  })

  it('derivada seguida pelo SÍMBOLO entre arquivos (import por nome, alias e namespace); homônima de outro módulo não conta', () => {
    const r = scanTs([
      { file: 'src/shared/x/gate.ts', code: `export function gate(k: string) { return requirePrivilege(k, PRIVILEGE_EXCLUIR) }` },
      { file: 'src/modules/a/a.routes.ts', code: `import { gate } from '@shared/x/gate'\nrouter.delete('/:id', gate('contracts'))` },
      { file: 'src/modules/b/b.routes.ts', code: `import * as G from '../../shared/x/gate'\nrouter.delete('/:id', G.gate('carriers'))` },
      { file: 'src/modules/c/c.service.ts', code: `import { gate } from './outro'\nexport const z = gate(req.body.k)` },
    ], API_PRIMITIVES, 'api')
    expect(r.pairs.map(x => `${x.interface}|${x.privilege}`).sort()).toEqual(['carriers|EXCLUIR', 'contracts|EXCLUIR'])
    expect(r.unresolved).toEqual([])
    const renamed = scanTs([
      { file: 'src/shared/x/gate.ts', code: `export function gate(k: string) { return requirePrivilege(k, PRIVILEGE_EXCLUIR) }` },
      { file: 'src/modules/a/a.routes.ts', code: `import { gate as g } from '@shared/x/gate'\nrouter.delete('/:id', g('contracts'))` },
    ], API_PRIMITIVES, 'api')
    expect(renamed.unresolved.length).toBeGreaterThan(0)
  })

  it('derivada importada pelo BARRIL da peça (export *, export { } from, import de pasta, .js) é seguida até quem declara', () => {
    const gate = { file: 'src/shared/cashier-gate/cashier-gate.ts',
      code: `export function cashierGate(key: string) { return requirePrivilege(key, PRIVILEGE_ALTERAR) }\nexport function cashierCan(p: number) { return requirePrivilege('cashier', p) }` }
    const r = scanTs([
      gate,
      { file: 'src/shared/cashier-gate/index.ts', code: `export * from './cashier-gate'` },
      { file: 'src/shared/caixa/index.ts', code: `export { cashierGate } from '../cashier-gate/cashier-gate'` },
      { file: 'src/modules/cashier/cashier.routes.ts', code: `import { cashierGate, cashierCan } from '@shared/cashier-gate'\n` +
          `router.put('/close', cashierGate('cashier'))\nrouter.get('/pdf', cashierCan(4))` },
      { file: 'src/modules/bank-slips/x.routes.ts', code: `import * as G from '../../shared/cashier-gate'\nrouter.post('/a', G.cashierGate('bank-slips'))` },
      { file: 'src/modules/checks/y.routes.ts', code: `import { cashierGate } from '@shared/caixa'\nrouter.post('/b', cashierGate('checks'))` },
      { file: 'src/modules/orders/z.routes.ts', code: `import { cashierGate } from '../../shared/cashier-gate/cashier-gate.js'\nrouter.post('/c', cashierGate('orders'))` },
    ], API_PRIMITIVES, 'api')
    expect(r.pairs.map(x => `${x.interface}|${x.privilege}`).sort())
      .toEqual(['bank-slips|ALTERAR', 'cashier|ALTERAR', 'cashier|IMPRIMIR', 'checks|ALTERAR', 'orders|ALTERAR'])
    expect(r.unresolved).toEqual([])
  })

  it('peça compartilhada do app: as telas são as que a ALCANÇAM pelo grafo (direto, por outra peça ou por barril)', () => {
    const g = appImportGraph([
      { file: 'apps/web/lib/app/shared/register/register_form_page.dart', code: `import 'package:core/core.dart';` },
      { file: 'apps/web/lib/app/shared/register/register.dart', code: `export 'register_form_page.dart';` },
      { file: 'apps/web/lib/app/modules/customers/presentation/page/p.dart', code: `import '../../../../shared/register/register_form_page.dart';` },
      { file: 'apps/web/lib/app/modules/order_returns/presentation/page/p.dart', code: `import 'package:setes_web/app/shared/register/register.dart';` },
      { file: 'apps/web/lib/app/modules/home/home_module.dart', code: `import '../../shared/register/register.dart';` },
      { file: 'apps/web/lib/app/modules/sem_rota/p.dart', code: `// import '../../shared/register/register.dart';` },
      { file: 'apps/web/lib/app/modules/settlements/s.dart', code: `import 'x.dart' if (dart.library.html) '../../shared/register/register.dart';` },
    ])
    const r = sharedFileInterfaces('apps/web/lib/app/shared/register/register_form_page.dart', g,
      new Map([['customers', 'customers'], ['order_returns', 'order-returns'], ['settlements', 'settlements']]))
    expect(r).toEqual({ interfaces: ['customers', 'order-returns', 'settlements'], unmapped: [] })
  })

  it('site compartilhado: a exclusão SUBTRAI da derivação (tela nova entra sozinha); alcance vazio e exclusão podre reprovam', () => {
    const site = { site: 'apps/web/lib/app/shared/register/register_search_page.dart: can(\'INSERIR\')', privilege: 'INSERIR' as const }
    const derived = { interfaces: ['customers', 'interface-configs', 'merchandise'], unmapped: [] }
    const r = expandSharedSite(site, derived, { reason: 'botão Novo da fábrica', exclude: { 'interface-configs': 'painel sem Novo (só ALTERAR/VISUALIZAR — D-PV1)' } })
    expect(r.pairs.map(p => p.interface)).toEqual(['customers', 'merchandise'])
    expect(r.problems).toEqual([])
    expect(expandSharedSite(site, { interfaces: [], unmapped: [] }, { reason: 'x' }).problems.length).toBe(1)
    expect(expandSharedSite(site, derived, { reason: 'x', exclude: { cashier: 'não usa mais a fábrica faz tempo' } }).problems.length).toBe(1)
    expect(expandSharedSite(site, derived, { reason: 'x', exclude: { customers: '' } }).problems.length).toBe(1)
  })

  it('o mapa do app lê o interfaceRoutes (pasta = rota com _)', () => {
    const m = appModuleInterfaces(`const interfaceRoutes = {\n  'order-returns': '/home/order-returns/',\n  'users':      '/home/users/',\n}`)
    expect([...m]).toEqual([['order_returns', 'order-returns'], ['users', 'users']])
  })
})
