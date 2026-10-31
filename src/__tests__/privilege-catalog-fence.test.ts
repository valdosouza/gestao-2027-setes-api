/// <reference types="jest" />
// CERCA do catálogo de privilégios (D-PV9 = Q-PV9 (a), Valdo 2026-10-18 — `Infra-IA/prompts/prompt_privilegios_interfaces.md`; molde
// voice-kind-fence/federal-id-fence), fundida com a guarda por roteador (D-PV2) pela D-PV14 e com a igualdade da D-PV51: todo par
// (interface, privilégio) que o CÓDIGO opera — a guarda por roteador (pela MESMA tabela que ela usa, `listGatedRoutes()`), as primitivas
// e políticas do setes-api, as guardas da nfse-api (o verbo pelo NOME — D-PV53) e o `CurrentInterface.can('X')` do setes-app — está no
// conjunto `consumedPrivileges()` (`src/shared/auth/privilege-catalog.ts`), que o boot e o teste ao vivo conferem contra o registro do
// banco nos DOIS sentidos. Origem: o C1 — a rota do "trocar a cobrança" exigia ALTERAR em `settlements`, o catálogo não tinha o par e o
// botão sumiu até para o admin, sem nenhum gate perceber. O PREDICADO (as varreduras e as sondas) mora em `src/test-setup/privilege-fence.ts`.
import fs from 'fs'
import path from 'path'
import router from '../gateway/router'
import { listGatedRoutes, listGatedModules } from '../shared/auth/module-privilege-gate'
import {
  CONSUMED_PRIVILEGES, RESERVED_PRIVILEGES, PRIVILEGE_ID, ORDER_BRANCH_INTERFACES, CONFIGURE_RULE_KEYS, INTERFACE_KEY_PATTERN,
  pairKey, PrivilegeConsumer, consumedPrivileges, routerConsumedPrivileges, absentMarkHolds, privilegeNameById,
} from '../shared/auth/privilege-catalog'
import { APP_INTERFACE_ROUTE_KEYS } from '../shared/auth/app-interface-routes'
import { PRIVILEGE_NAME_BY_ID } from '../shared/access'
import { CATALOG_PAIRS_SQL, SCREEN_INTERFACES_SQL, CONFIGURABLE_INTERFACES_SQL } from '../shared/auth/assert-privilege-catalog'
import {
  scanTs, repoTsSources, findSiblingRepo, orderInterfaceKeyDomain, appModuleInterfaces, scanDartFile, appDartSources, grantSqlCounts, identifierUses,
  appImportGraph, sharedFileInterfaces, exportedNames, privilegeConstants, constStringArray, expandSharedSite, SharedConsumerEntry,
  API_PRIMITIVES, API_IMPL, API_IMPL_REASONS, API_DECLARATIONS, API_RESOLVERS, RESOLVER_FILE, NFSE_PRIMITIVES, NFSE_IMPL, APP_ROUTES_FILE,
  CORE_ACCESS_FILE, TS_PROBES, LOOSE_PROBES, DART_PROBES, DART_PROBE_MODULES, DART_PROBE_CONSTANTS, dartStringConstants, FoundPair, FenceScan,
} from '../test-setup/privilege-fence'

void router                                                     // montar o gateway registra as guardas (a tabela da D-PV14)

const ROOT = path.resolve(__dirname, '..', '..')
const NFSE = findSiblingRepo(ROOT, 'nfse-api', 'src/modules/guards.ts')
const APP = findSiblingRepo(ROOT, 'setes-app', APP_ROUTES_FILE)
/** O núcleo fiscal: o vocabulário dos verbos (`PRIVILEGE_NAMES`) e o domínio `erp.orderInterface` que as guardas da nfse-api usam. */
const CORE = findSiblingRepo(ROOT, 'fiscal-api', 'src/erp/facts.ts')
/** O repositório `sql`: o script 70 (as views centrais) e o seed 68 (a REGRA do CONFIGURAR). */
const SQL = findSiblingRepo(ROOT, 'sql', '70_user_access_central_views.sql')

/** Os `<m>.routes.ts` dos módulos guardados — ali o `privilegeAct(PRIVILEGE_X)` é lido pela tabela, não solto (D-PV14). */
const ROUTER_ACT_FILES = listGatedModules().map(m => `src/modules/${m}/${m}.routes.ts`)

/**
 * Exports das IMPLEMENTAÇÕES (as primitivas, o veredito único, a guarda por roteador, a regra do CONFIGURAR) que NÃO são primitiva
 * registrada (motivo). Export novo ali (ex.: um helper de veredito que recebe o verbo) reprova até virar primitiva registrada no
 * predicado ou entrar aqui — a varredura não olha dentro da implementação.
 */
const IMPL_NON_PRIVILEGE: Record<string, Record<string, string>> = {
  'setes-api src/shared/auth/require-privilege.ts': {
    resolveInterfaceId: 'REGISTRO: id da interface pela chave (não é veredito)',
    resolveInterfaceKey: 'REGISTRO: chave da interface pelo id (não é veredito)',
    escapesLicense: 'LICENÇA: só o super escapa (D-PV24/A-PV1) — sem verbo',
    interfaceAcquiredFor: 'LICENÇA/alcance da interface (D-PV39) — sem verbo',
    denyPrivilege: 'envelope do 403 (INTERFACE_NOT_ALLOWED × PRIVILEGE_REQUIRED)',
    requireInterfaceFor: 'LICENÇA do ramo nas leituras fiscais (Q-N32) — sem privilégio',
  },
  'setes-api src/shared/access/index.ts': {
    PrivilegeName: 'tipo (vocabulário dos verbos)', AccessVerdict: 'tipo', AccessProfile: 'tipo', AccessRow: 'tipo',
    PRIVILEGE_NAMES: 'vocabulário dos verbos do núcleo (conferido contra PRIVILEGE_ID nesta cerca)',
    isPrivilegeName: 'predicado do vocabulário',
    PRIVILEGE_NAME_BY_ID: 'id → nome (conferido contra PRIVILEGE_ID nesta cerca)',
    privilegeNameOf: 'id → nome (falha fechada)',
    liveSession: 'SESSÃO viva (D-UC9/D-AU3) — perfil, não verbo',
    reachableKeys: 'ALCANCE/licença (sem verbo)',
    accessRows: 'o MENU: devolve TUDO o que o usuário pode (leitor registrado em GRANT_READERS — VISUALIZAR dá o item, REGRA do menu)',
    assertAccessViews: 'boot: as views existem e os literais batem (sem verbo)',
  },
  'setes-api src/shared/auth/module-privilege-gate.ts': {
    PRIVILEGE_BY_METHOD: 'a guarda por roteador: verbo HTTP → privilégio — pares pela tabela `listGatedRoutes()` (D-PV14)',
    privilegeAct: 'marcador do ato na rota — lido pela tabela (D-PV14)',
    openRoute: 'exceção NOMEADA da guarda (sem privilégio) — fica fora da tabela de pares',
    matchModuleRoute: 'casamento da rota (forma interna do Express)',
    modulePrivilegeGate: 'a guarda por roteador — pares pela tabela (D-PV14)',
    gatedModule: 'montagem da guarda no gateway — pares pela tabela (D-PV14)',
    listGatedRoutes: 'a TABELA dos pares da guarda (a fonte da D-PV14)',
    listGatedModules: 'os módulos guardados',
    isGatedModule: 'D-PV36: módulo guardado não consulta a flag',
  },
  'setes-api src/shared/auth/configure-privilege.ts': {
    configureVerdict: 'REGRA do CONFIGURAR (D-PV25) — dinâmica pela interface ALVO; o conjunto é conferido contra o banco (D-PV51)',
    canConfigure: 'REGRA do CONFIGURAR (D-PV25) — a resposta aditiva dos painéis',
    assertCanConfigure: 'REGRA do CONFIGURAR (D-PV25) — o 403 dos painéis',
  },
  'nfse-api src/modules/guards.ts': {
    requireCutover: 'cerca da virada (D-F18/D-F39), não privilégio',
    visibleInterfaces: 'LICENÇA: ramos ao alcance (D-F14/D-F37)',
    requireBranchInterface: 'LICENÇA do ramo nas leituras (Q-N32)',
    requireAnyInterface: 'LICENÇA: alguma interface contratada',
    requireAdmin: 'PERFIL admin (habilitação/A1), não privilégio de interface',
    parseInvoiceId: 'parse do id da rota',
  },
}

/**
 * `PRIVILEGE_<NOME>` usado FORA de uma primitiva no setes-api (`arquivo: linha`) → motivo. Consumidor que não passa pelas
 * primitivas: ou é uma REGRA (a concessão), ou é o mapa de uma primitiva REGISTRADA, ou tem de virar primitiva.
 */
const ALLOWED_LOOSE: Record<string, string> = {
  "src/modules/bank-slips/bank-slips.reapply-policy.ts: return kind === 'R' ? PRIVILEGE_ALTERAR : PRIVILEGE_CANCELAR ×2":
    'o mapa voz → privilégio do EFEITO do reaplicar (D-PV27): a primitiva REGISTRADA `reapplyVerdictFor` declara os dois (fixed ' +
    'ALTERAR/CANCELAR) — trocar o mapa exige trocar o registro',
  'src/modules/users/users.service.ts: if (ids.length > 0 && !ids.includes(PRIVILEGE_VISUALIZAR) && catalog.has(PRIVILEGE_VISUALIZAR)) ids.push(PRIVILEGE_VISUALIZAR) ×3':
    'regra da CONCESSÃO (D-PV58): todo verbo escolhido leva o VISUALIZAR da mesma interface — escreve a concessão, não decide ato',
}

/**
 * Arquivo do setes-api cujo SQL lê a concessão do usuário (`tb_user_has_privilege`) fora das primitivas → motivo. Guarda por SQL
 * direto não entra aqui: o veredito é a view (`@shared/access` — costura A1); o menu também lê por ela (não lê mais a concessão).
 */
const ALLOWED_GRANT_SQL: Record<string, { count: number; reason: string }> = {
  'src/modules/users/users.repository.ts': { count: 5, reason:
    'cadastro de privilégios do usuário: lista e grava a concessão (D-PV57…D-PV60), não decide ato nenhum' },
}

/**
 * Leitores da concessão/catálogo que NÃO são primitivas (devolvem a lista; quem decide pelo NOME passaria calado) → os únicos
 * arquivos que podem usá-los (a declaração e o consumidor de hoje, com o motivo).
 */
const GRANT_READERS: Record<string, Record<string, string>> = {
  accessRows: {
    'src/shared/access/index.ts': 'declaração (adaptador da `fiscal-api/access`)',
    'src/modules/core/core.service.ts': 'o MENU: VISUALIZAR dá o item, os verbos dão os botões (REGRA do menu, costura A1)',
  },
  listUserPrivileges: {
    'src/modules/users/users.repository.ts': 'declaração', 'src/modules/users/users.service.ts': 'tela de privilégios do usuário',
  },
  listInterfaceCatalogPrivilegeIds: {
    'src/modules/users/users.repository.ts': 'declaração', 'src/modules/users/users.service.ts': 'recusa conceder fora do catálogo',
  },
}

const CRUD_FILE = 'apps/web/lib/app/shared/session/crud_privileges.dart'
const GEAR_FILE = 'apps/web/lib/app/shared/register/register_config_button.dart'
const PANEL_CONFIGS = 'painel de configurações: só a lista da fábrica, sem "Novo" (onNew nulo) nem ficha — o salvar do valor é CONFIGURAR ' +
  'na tela-alvo (D-PV25/D-PV26: o ALTERAR dos painéis saiu do catálogo)'
const PANEL_FIELDS = 'painel de campos: só a lista da fábrica, sem "Novo" (onNew nulo) nem ficha — o salvar do campo é CONFIGURAR na ' +
  'tela-alvo (D-PV25/D-PV26)'
const INST_IFACES_NO_FORM = 'tela das interfaces do cliente: só a lista da fábrica, sem "Novo" nem ficha — marcar/desmarcar é o ALTERAR ' +
  'do próprio módulo (institution_interfaces_page — D-PV34)'
const INSTITUTIONS_NO_FORM = 'a ficha do Estabelecimento é artesanal (SetesFormShell, tela do Super sob superGuard): não pergunta o ' +
  'verbo — o par fica RESERVADO (D-PV3/A-PV3, RESERVED_PRIVILEGES)'

/**
 * `CurrentInterface.can('X')` numa peça COMPARTILHADA do app (fora de `modules/<m>/`) → o motivo. As telas cobertas são DERIVADAS do
 * código (todo módulo que alcança o arquivo pelo grafo de import/export — `sharedFileInterfaces`): a tela nova que usar a peça entra
 * sozinha. Exceção = `exclude` (tela → motivo), que SUBTRAI da derivação: o grafo é por ARQUIVO, então o módulo que importa a lista da
 * fábrica alcança os três verbos do CrudPrivileges mesmo sem usar a ficha.
 */
const APP_SHARED_CONSUMERS: Record<string, SharedConsumerEntry> = {
  [`${CRUD_FILE}: can('INSERIR')`]: {
    reason: 'fábrica: "Novo" da lista (RegisterSearchPage com onNew) e salvar o registro novo (canSave(creating: true)) — D-PV2',
    exclude: { 'interface-configs': PANEL_CONFIGS, 'interface-fields': PANEL_FIELDS, 'institution-interfaces': INST_IFACES_NO_FORM },
  },
  [`${CRUD_FILE}: can('ALTERAR')`]: {
    reason: 'fábrica: salvar a edição (canSave(creating: false) na RegisterFormPage/RegisterFormShell) — D-PV2',
    exclude: {
      'interface-configs': PANEL_CONFIGS, 'interface-fields': PANEL_FIELDS, 'institution-interfaces': INST_IFACES_NO_FORM,
      institutions: INSTITUTIONS_NO_FORM,
    },
  },
  [`${CRUD_FILE}: can('EXCLUIR')`]: {
    reason: 'fábrica: excluir na ficha (RegisterFormPage com onDelete; RegisterFormShell fora da criação) — D-PV2',
    exclude: {
      'interface-configs': PANEL_CONFIGS, 'interface-fields': PANEL_FIELDS, 'institution-interfaces': INST_IFACES_NO_FORM,
      institutions: INSTITUTIONS_NO_FORM,
      users: 'a ficha de Usuários não exclui (onDelete nulo — D-PV19: a credencial nunca é excluída, só inativada no vínculo)',
    },
  },
  [`${GEAR_FILE}: can('CONFIGURAR')`]: {
    reason: 'engrenagem da tela (RegisterConfigButton): aparece só com configs no catálogo e CONFIGURAR na tela atual — D-PV25',
    exclude: {
      'interface-configs': 'o painel não monta a engrenagem (RegisterSearchPage sem configModuleKey) — ele É o painel; o CONFIGURAR dele ' +
        'vem da REGRA (tem config no catálogo)',
      'interface-fields': 'o painel não monta a engrenagem (RegisterSearchPage sem configModuleKey) — o CONFIGURAR dele vem da REGRA',
      cashier: 'o Caixa monta a engrenagem, mas não tem config nem campo no catálogo: o botão nunca aparece (só com configs) — sem ' +
        'par na REGRA do CONFIGURAR (se ganhar config, a REGRA o exige)',
    },
  },
}

function scanAll(): { pairs: FoundPair[]; api: FenceScan; nfse: FenceScan; app: FenceScan } {
  const api = scanTs(repoTsSources(ROOT), API_PRIMITIVES, 'api',
    { impl: API_IMPL, declarations: API_DECLARATIONS, resolvers: API_RESOLVERS, routerActFiles: ROUTER_ACT_FILES })
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

describe('D-PV9/D-PV14 — cerca: todo par operado pelo código está no conjunto (lista à mão ∪ tabela do roteador)', () => {
  it('os repositórios irmãos foram achados (cerca que pula não cerca — defina NFSE_API_DIR / SETES_APP_DIR / FISCAL_API_DIR / SQL_DIR)', () => {
    expect({ nfse: NFSE !== null, app: APP !== null, core: CORE !== null, sql: SQL !== null }).toEqual({ nfse: true, app: true, core: true, sql: true })
  })

  it('o gateway montou a tabela da guarda por roteador e cada módulo guardado tem o <m>.routes.ts (onde o marcador é lido)', () => {
    expect(listGatedModules().length).toBeGreaterThan(0)
    expect(ROUTER_ACT_FILES.filter(f => !fs.existsSync(path.join(ROOT, f)))).toEqual([])
  })

  const scan = NFSE && APP ? scanAll() : null
  const listed = new Map(CONSUMED_PRIVILEGES.map(c => [pairKey(c.interface, PRIVILEGE_ID[c.privilege]), c]))

  it('nenhum consumo ilegível (guarda dinâmica, nome trocado, can fora do CurrentInterface…)', () => {
    expect([...scan!.api.unresolved, ...scan!.nfse.unresolved, ...scan!.app.unresolved]).toEqual([])
  })

  it('todo par consumido FORA do roteador está na lista à mão (par novo: entra na lista E no seed por i18n_key, antes do app)', () => {
    const out = scan!.pairs.filter(p => !listed.has(pairKey(p.interface, PRIVILEGE_ID[p.privilege])))
      .map(p => `${p.interface} × ${p.privilege} ← ${p.consumer} ${p.site}`)
    expect([...new Set(out)]).toEqual([])
  })

  it('a lista à mão não apodrece: cada entrada tem EXATAMENTE os consumidores (fora o roteador) que o código mostra', () => {
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

  it('a tabela do roteador só usa verbos do vocabulário e entra INTEIRA no conjunto operado, com o consumidor api (D-PV14)', () => {
    expect(listGatedRoutes().filter(r => r.privilegeId !== null && privilegeNameById(r.privilegeId) === null)
      .map(r => `${r.moduleKey} ${r.method} ${r.path} → ${r.privilegeId}`)).toEqual([])
    const fused = new Map(consumedPrivileges().map(c => [pairKey(c.interface, PRIVILEGE_ID[c.privilege]), c]))
    const router = routerConsumedPrivileges()
    expect(router.length).toBeGreaterThan(0)
    expect(router.filter(r => !fused.get(pairKey(r.interface, PRIVILEGE_ID[r.privilege]))?.consumers.includes('api'))
      .map(r => `${r.interface} × ${r.privilege}`)).toEqual([])
    // a fusão não inventa nem perde par: lista à mão ∪ roteador, um por par
    const union = new Set([...CONSUMED_PRIVILEGES, ...router].map(c => pairKey(c.interface, PRIVILEGE_ID[c.privilege])))
    expect([...fused.keys()].sort()).toEqual([...union].sort())
  })

  it('PRIVILEGE_<NOME> fora de primitiva só nos lugares registrados (com o motivo) — e o registro não apodrece', () => {
    expect(scan!.api.loose.filter(l => !(l in ALLOWED_LOOSE))).toEqual([])
    expect(scan!.nfse.loose).toEqual([])   // na nfse-api nenhum `PRIVILEGE_*` (D-PV53: o verbo pelo NOME)
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

  it('D-PV42: a lista das chaves de rota do app no setes-api = o interfaceRoutes do app (tela nova no app entra na lista)', () => {
    const appKeys = [...appModuleInterfaces(fs.readFileSync(path.join(APP!, APP_ROUTES_FILE), 'utf8')).values()].sort()
    expect([...APP_INTERFACE_ROUTE_KEYS].sort()).toEqual(appKeys)
    expect(APP_INTERFACE_ROUTE_KEYS.filter(k => !INTERFACE_KEY_PATTERN.test(k))).toEqual([])
  })
})

describe('D-PV9/D-PV51 — a lista é coerente com o código que ela descreve', () => {
  it('a marca "ausente por decisão" nunca em par que um BOTÃO consome nem em par que a guarda por roteador pergunta', () => {
    expect(CONSUMED_PRIVILEGES.filter(c => c.absentBy && c.consumers.includes('app')).map(c => `${c.interface} × ${c.privilege}`)).toEqual([])
    const router = new Set(routerConsumedPrivileges().map(r => pairKey(r.interface, PRIVILEGE_ID[r.privilege])))
    expect(CONSUMED_PRIVILEGES.filter(c => c.absentBy && router.has(pairKey(c.interface, PRIVILEGE_ID[c.privilege])))
      .map(c => `${c.interface} × ${c.privilege}`)).toEqual([])
  })

  it('RESERVADOS (D-PV51): com o motivo, sem repetição, e NUNCA operados pelo código (operado = tirar a marca)', () => {
    const keys = RESERVED_PRIVILEGES.map(r => pairKey(r.interface, PRIVILEGE_ID[r.privilege]))
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([])
    expect(RESERVED_PRIVILEGES.filter(r => r.reason.trim().length < 20 || !/D-PV\d+|A-PV\d+/.test(r.reason))).toEqual([])
    const operated = new Set(consumedPrivileges().map(c => pairKey(c.interface, PRIVILEGE_ID[c.privilege])))
    expect(RESERVED_PRIVILEGES.filter(r => operated.has(pairKey(r.interface, PRIVILEGE_ID[r.privilege])))
      .map(r => `${r.interface} × ${r.privilege}`)).toEqual([])
  })

  it('a implementação só exporta primitivas registradas ou o que não é privilégio (com motivo) — setes-api e nfse-api', () => {
    const prims = API_PRIMITIVES.map(p => p.name)
    const impls: [string, string, readonly string[]][] = [
      ...API_IMPL.map((f): [string, string, readonly string[]] => [`setes-api ${f}`, path.join(ROOT, f), prims]),
      ['nfse-api src/modules/guards.ts', path.join(NFSE!, NFSE_IMPL[0]), NFSE_PRIMITIVES.map(p => p.name)],
    ]
    for (const [label, file, registered] of impls) {
      const allowed = IMPL_NON_PRIVILEGE[label] ?? {}
      const exported = exportedNames(fs.readFileSync(file, 'utf8'))
      expect([label, exported.filter(n => !registered.includes(n) && !(n in allowed))]).toEqual([label, []])
      expect([label, Object.keys(allowed).filter(n => !exported.includes(n))]).toEqual([label, []])
    }
    expect(Object.keys(IMPL_NON_PRIVILEGE).filter(l => l.startsWith('setes-api ')).map(l => l.slice(10)).sort()).toEqual([...API_IMPL].sort())
    expect(Object.values(API_IMPL_REASONS).filter(r => r.trim().length < 20)).toEqual([])
  })

  it('a REGRA do CONFIGURAR (implementação) pergunta CONFIGURAR na interface ALVO pela peça das guardas', () => {
    const code = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'auth', 'configure-privilege.ts'), 'utf8')
    expect(code).toMatch(/privilegeVerdict\(inst, \[key\], PRIVILEGE_CONFIGURAR\)/)
    expect(code).toMatch(/resolveInterfaceKey\(interfaceId\)/)
  })

  it('D-PV53: o núcleo fiscal NÃO guarda número de privilégio; o vocabulário dele = os nomes de PRIVILEGE_ID; o domínio do ramo é o mesmo', () => {
    const facts = fs.readFileSync(path.join(CORE!, 'src', 'erp', 'facts.ts'), 'utf8')
    expect(privilegeConstants(facts)).toEqual({})
    const names = constStringArray(fs.readFileSync(path.join(CORE!, CORE_ACCESS_FILE), 'utf8'), 'PRIVILEGE_NAMES')
    expect([...(names ?? [])].sort()).toEqual(Object.keys(PRIVILEGE_ID).sort())
    expect((orderInterfaceKeyDomain(facts) ?? []).sort()).toEqual([...ORDER_BRANCH_INTERFACES].sort())
    expect(fs.existsSync(path.join(NFSE!, 'src', 'modules', 'privileges.ts'))).toBe(false)   // D-PV53: o arquivo local MORREU
  })

  it('o adaptador do setes-api traduz id → nome igual à lista (o veredito pergunta pelo NOME — D-PV53)', () => {
    expect(Object.entries(PRIVILEGE_NAME_BY_ID).map(([id, n]) => `${n}=${id}`).sort())
      .toEqual(Object.entries(PRIVILEGE_ID).map(([n, id]) => `${n}=${id}`).sort())
  })

  it('sem par repetido; "ausente por decisão" sempre com o motivo', () => {
    const keys = CONSUMED_PRIVILEGES.map(c => pairKey(c.interface, PRIVILEGE_ID[c.privilege]))
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([])
    expect(CONSUMED_PRIVILEGES.filter(c => c.absentBy !== undefined && c.absentBy.trim().length < 20)).toEqual([])
    expect(CONSUMED_PRIVILEGES.filter(c => c.consumers.length === 0 || !INTERFACE_KEY_PATTERN.test(c.interface))).toEqual([])
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

  it('o boot lê o registro pelo MESMO predicado da view (vw_user_access) e as REGRAS pelo mesmo critério do menu e do seed 68', () => {
    const view = fs.readFileSync(path.join(ROOT, 'src', 'migrations', 'sql', '075_user_access_views.sql'), 'utf8')
    expect(view).toMatch(/JOIN `setes_central`\.`tb_interface_has_privilege` ihp\s+ON ihp\.`tb_interface_id` = r\.`tb_interface_id` AND ihp\.`active` = 'S' AND ihp\.`deleted` = 'N'/)
    expect(view).toMatch(/JOIN `setes_central`\.`tb_privilege` p\s+ON p\.`id` = ihp\.`tb_privilege_id` AND p\.`deleted` = 'N'/)
    const central = fs.readFileSync(path.join(SQL!, '70_user_access_central_views.sql'), 'utf8')
    expect(central).toMatch(/`vw_interface_catalog` AS[\s\S]*?FROM `setes_central`\.`tb_interface` i\s+WHERE i\.`deleted` = 'N'/)
    expect(CATALOG_PAIRS_SQL).toMatch(/tb_interface i ON \(i\.id = ihp\.tb_interface_id AND i\.deleted = 'N'\)/)
    expect(CATALOG_PAIRS_SQL).toMatch(/p\.deleted = 'N'[\s\S]*WHERE ihp\.active = 'S' AND ihp\.deleted = 'N'/)
    // REGRA do menu: o item entra com VISUALIZAR (todos os perfis); o menu do super é toda tela kind 'T' (inclusive o grupo Super)
    const service = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'core', 'core.service.ts'), 'utf8')
    expect(service).toMatch(/const visible = \(interfaceId: number\) => \(privMap\.get\(interfaceId\) \?\? \[\]\)\.includes\('VISUALIZAR'\)/)
    const core = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'core', 'core.repository.ts'), 'utf8')
    expect(core).toContain('const ONLY_SCREEN_KIND = `AND i.kind = \'T\'`')
    expect(core).toMatch(/getAllCentralInterfaces[\s\S]*?WHERE i\.deleted = 'N' \$\{ONLY_SCREEN_KIND\}/)
    expect(SCREEN_INTERFACES_SQL).toContain(`i.kind = 'T'`)
    expect(SCREEN_INTERFACES_SQL).not.toMatch(/Super/)
    // REGRA do CONFIGURAR: config OU campo vivo (o mesmo critério do seed 68) + general-configs
    const seed68 = fs.readFileSync(path.join(SQL!, '68_privilege_configure_consult_seed.sql'), 'utf8')
    for (const t of ['tb_interface_has_config', 'tb_interface_has_field']) {
      expect(CONFIGURABLE_INTERFACES_SQL).toMatch(new RegExp(`${t} \\w+ WHERE \\w+\\.tb_interface_id = i\\.id AND \\w+\\.deleted = 'N'`))
      expect(seed68).toMatch(new RegExp(`\`${t}\`\\s+\\w+ WHERE \\w+\\.\`tb_interface_id\` = i\\.\`id\` AND \\w+\\.\`deleted\` = 'N'`))
    }
    for (const k of CONFIGURE_RULE_KEYS) expect(seed68).toContain(`('${k}', 11)`)
  })
})

describe('D-PV9 — a cerca enxerga o que deve (sondas)', () => {
  it.each(TS_PROBES.map(p => [p.code.split('\n')[0].slice(0, 70), p] as const))('TS: %s', (_t, p) => {
    const r = scanTs([{ file: p.file ?? 'probe.ts', code: p.code }], API_PRIMITIVES, 'api', { resolvers: API_RESOLVERS })
    expect([...new Set(r.pairs.map(x => `${x.interface}|${x.privilege}`))].sort()).toEqual([...p.pairs].sort())
    expect(r.unresolved.length > 0 ? 'reprova' : 'passa').toBe(p.unresolved > 0 ? 'reprova' : 'passa')
  })

  it.each(LOOSE_PROBES.map(p => [p.code.slice(0, 70), p] as const))('PRIVILEGE solto: %s', (_t, p) => {
    const file = p.file ?? 'probe.ts'
    expect(scanTs([{ file, code: p.code }], API_PRIMITIVES, 'api', { routerActFiles: p.routerActFiles ?? [] }).loose.length).toBe(p.loose)
  })

  it.each(DART_PROBES.map(p => [`${p.file.split('/').slice(-3).join('/')} ${p.code.slice(0, 50)}`, p] as const))('Dart: %s', (_t, p) => {
    const r = scanDartFile(p.file, p.code, DART_PROBE_MODULES, DART_PROBE_CONSTANTS)
    expect(r.pairs.map(x => `${x.interface}|${x.privilege}`)).toEqual(p.pairs)
    expect(r.shared.length).toBe(p.shared)
    expect(r.unresolved.length > 0 ? 'reprova' : 'passa').toBe(p.unresolved > 0 ? 'reprova' : 'passa')
  })

  it('a nfse-api (D-PV53): o verbo pelo NOME; guarda pelo RAMO vale nas três interfaces; número do núcleo e nome fora do catálogo reprovam', () => {
    const r = scanTs([{ file: 'r.ts', code: `await requireBranchPrivilege(ctx, inst, ref, 'CANCELAR')\n` +
      `const KS = ['orders'] as const\nawait passScope(ctx, inst, KS, 'CONSULTAR')` }], NFSE_PRIMITIVES, 'nfse')
    expect(r.pairs.map(x => `${x.interface}|${x.privilege}`).sort())
      .toEqual(['order-returns|CANCELAR', 'orders|CANCELAR', 'orders|CONSULTAR', 'service-orders|CANCELAR'])
    expect(r.unresolved).toEqual([])
    // o número do núcleo (D-PV53 tirou `erp.PRIVILEGE_*`): na guarda não resolve; fora dela é solto
    const old = scanTs([{ file: 'o.ts', code: `import { erp } from 'fiscal-api'\nawait requireBranchPrivilege(ctx, inst, ref, erp.PRIVILEGE_CANCELAR)` }],
      NFSE_PRIMITIVES, 'nfse')
    expect(old.unresolved.length).toBeGreaterThan(0)
    expect(scanTs([{ file: 'l.ts', code: `import { erp } from 'fiscal-api'\nconst p = erp.PRIVILEGE_CANCELAR` }], NFSE_PRIMITIVES, 'nfse').loose.length)
      .toBe(1)
    // nome fora do catálogo, ou com caixa trocada (a view compara EXATO — COLLATE utf8mb4_bin)
    for (const bad of [`'TRANSMISSAO'`, `'transmitir'`]) {
      expect(scanTs([{ file: 'b.ts', code: `await requireBranchPrivilege(ctx, inst, ref, ${bad})` }], NFSE_PRIMITIVES, 'nfse').unresolved.length)
        .toBeGreaterThan(0)
    }
    // o veredito do núcleo chamado DIRETO fora de guards.ts é guarda nova: lida pelo par (e reprova se ilegível)
    const direct = scanTs([{ file: 'd.ts', code: `await access.accessVerdict(ctx.pool, inst, ['service-orders'], 'TRANSMITIR')\n` +
      `await access.grantedKeys(ctx.pool, inst, keys, 'CANCELAR')` }], NFSE_PRIMITIVES, 'nfse')
    expect(direct.pairs.map(x => `${x.interface}|${x.privilege}`)).toEqual(['service-orders|TRANSMITIR'])
    expect(direct.unresolved.length).toBe(1)
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

  it('a política da costura A1: lista com a constante e o verbo importado — a derivada é lida em cada chamada (mesmo importada de outro módulo)', () => {
    const r = scanTs([
      { file: 'src/modules/settlements/settlements.discount-policy.ts', code:
          `import { PRIVILEGE_DESCONTO } from '@shared/auth/privileges'\nexport const SETTLEMENTS_INTERFACE = 'settlements'\n` +
          `export const CHARGE_AGREEMENTS_INTERFACE = 'bank-charge-agreements'\n` +
          `export async function assertDiscountAliquot(inst: any, requested: number, interfaceKey: string) {\n` +
          `  if ((await accessVerdict(inst, [interfaceKey], PRIVILEGE_DESCONTO)) === 'ok') return }\n` +
          `export async function assertDiscountPolicy(inst: any) { return assertDiscountAliquot(inst, 1, SETTLEMENTS_INTERFACE) }` },
      { file: 'src/modules/bank-charge-agreements/bank-charge-agreements.controller.ts', code:
          `import { assertDiscountAliquot, CHARGE_AGREEMENTS_INTERFACE } from '@modules/settlements/settlements.discount-policy'\n` +
          `await assertDiscountAliquot(req.institution!, 2, CHARGE_AGREEMENTS_INTERFACE)` },
    ], API_PRIMITIVES, 'api')
    expect(r.pairs.map(x => `${x.interface}|${x.privilege}`).sort()).toEqual(['bank-charge-agreements|DESCONTO', 'settlements|DESCONTO'])
    expect(r.unresolved).toEqual([])
  })

  it('primitiva REGISTRADA com consumo dinâmico (o reaplicar): o registro diz o que ela consome; o repasse dentro dela não reprova', () => {
    const file = 'src/modules/bank-slips/bank-slips.reapply-policy.ts'
    const r = scanTs([{ file, code:
      `import { PRIVILEGE_ALTERAR, PRIVILEGE_CANCELAR } from '@shared/auth/privileges'\nexport const REAPPLY_INTERFACE = 'bank-slips'\n` +
      `export function reapplyPrivilegeFor(kind: string) { return kind === 'R' ? PRIVILEGE_ALTERAR : PRIVILEGE_CANCELAR }\n` +
      `export async function reapplyEffectVerdict(inst: any, event: any) {\n  const privilegeId = reapplyPrivilegeFor(event.kind)\n` +
      `  const interfaces = [REAPPLY_INTERFACE] as const\n  return reapplyVerdictFor(inst, interfaces, privilegeId) }\n` +
      `function reapplyVerdictFor(inst: any, interfaces: readonly string[], privilegeId: number) { return privilegeVerdict(inst, interfaces, privilegeId) }` }],
    API_PRIMITIVES, 'api')
    expect(r.pairs.map(x => `${x.interface}|${x.privilege}`).sort()).toEqual(['bank-slips|ALTERAR', 'bank-slips|CANCELAR'])
    expect(r.unresolved).toEqual([])
    // a MESMA forma sem o registro (outro arquivo = outro símbolo): o privilégio da voz não é legível — reprova
    const unregistered = scanTs([{ file: 'src/modules/x/x.policy.ts', code:
      `export async function v(inst: any, event: any) { const id = pick(event.kind)\n  return privilegeVerdict(inst, ['bank-slips'], id) }` }],
    API_PRIMITIVES, 'api')
    expect(unregistered.unresolved.length).toBeGreaterThan(0)
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

  it('o vocabulário do núcleo e as constantes de privilégio são lidos de um arquivo TS', () => {
    expect(constStringArray(`export const PRIVILEGE_NAMES = [\n  'INSERIR', 'ALTERAR',\n] as const`, 'PRIVILEGE_NAMES')).toEqual(['INSERIR', 'ALTERAR'])
    expect(constStringArray(`export const X = 1`, 'PRIVILEGE_NAMES')).toBeNull()
    expect(privilegeConstants(`export const PRIVILEGE_CANCELAR = 7\nconst PRIVILEGE_TRANSMITIR: number = 9`)).toEqual({ CANCELAR: 7, TRANSMITIR: 9 })
  })
})
