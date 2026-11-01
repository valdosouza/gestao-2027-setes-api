// PREDICADO da cerca do catálogo de privilégios (D-PV9 — Valdo 2026-10-18, `Infra-IA/prompts/prompt_privilegios_interfaces.md`;
// molde voice-kind-fence/federal-id-fence). Mora em `src/test-setup/` porque o jest trata qualquer .ts de `__tests__` como suíte.
// Usado pela cerca (`src/__tests__/privilege-catalog-fence.test.ts`) e pelas sondas do gate.
//
// O que ela LÊ (cada consumidor de privilégio vira pares (interface, privilégio) com o lugar de onde veio):
//  - setes-api (`src/**/*.ts`, por AST): as PRIMITIVAS `requirePrivilege(interface|[…], P)`, `requirePrivilegeFor(P, resolver)`,
//    `privilegeVerdict(inst, interfaces, P)` e `accessVerdict(inst, interfaces, P)` (o veredito único da costura A1 — D-AU6; `P` é
//    id OU nome do verbo). Função que só REPASSA a interface (ou o privilégio) recebida por PARÂMETRO vira
//    primitiva DERIVADA, seguida pelo SÍMBOLO (no arquivo que a declara ou importada dele — nunca pelo nome solto). Interface e
//    privilégio são resolvidos pelo ESCOPO LÉXICO (gate adversarial 2026-10-18: a 1ª versão procurava constante pelo NOME no
//    repositório inteiro e lia o par ERRADO com constante sombreada ou import renomeado): texto literal, lista literal (de textos ou
//    de constantes), `const` literal do escopo, constante exportada pelo módulo importado, `PRIVILEGE_<NOME>` importado de
//    `@shared/auth/privileges`, id literal ou o NOME do verbo em texto (D-PV53). O resolver de `requirePrivilegeFor` tem de ser o
//    SÍMBOLO importado de `billing.interface-resolver.ts`. Fora disso a chamada é NÃO RESOLVÍVEL e reprova — quem cria guarda dinâmica
//    registra a primitiva aqui (`API_PRIMITIVES`) com o que ela consome (privilégio fixo, ou vários). A guarda POR ROTEADOR (D-PV2) NÃO
//    passa por aqui: os pares dela vêm da MESMA tabela que ela usa (`listGatedRoutes()` — D-PV14), e o `privilegeAct(PRIVILEGE_X)` no
//    `<m>.routes.ts` de um módulo guardado não é "PRIVILEGE solto";
//  - nfse-api (`src/**/*.ts`): `requireBranchPrivilege(ctx, inst, ref, 'VERBO')` (interface = o RAMO — `ORDER_BRANCH_INTERFACES`),
//    `passScope(ctx, inst, KEYS, 'VERBO')` e o veredito do núcleo (`access.accessVerdict`/`access.grantedKeys`) fora da implementação
//    (`guards.ts`) — o verbo pelo NOME (D-PV53: as APIs fiscais não guardam número de privilégio; `erp.PRIVILEGE_*` não existe mais);
//  - setes-app (`apps/web/lib` e `packages/*/lib`, por um tokenizador de Dart — strings, raw, aspas triplas, interpolação e
//    comentário de bloco ANINHADO): `CurrentInterface.can('NOME')`; a interface é a do MÓDULO (`apps/web/lib/app/modules/<pasta>/`),
//    lida no mapa `interfaceRoutes` (`home/interface_routes.dart`: i18n_key → `/home/<rota>/`, pasta = rota com `_`). `can` fora de um
//    módulo (peça compartilhada) volta como SITE COMPARTILHADO — as telas que ele cobre saem do grafo de import; `.can` em outro
//    receptor, `can` sem chamada (tear-off), nome fora do catálogo, argumento não literal e `CurrentInterface.value` lido direto reprovam.
// Comentário não conta.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import { PRIVILEGE_ID, PrivilegeName, PrivilegeConsumer, ORDER_BRANCH_INTERFACES } from '../shared/auth/privilege-catalog'

export interface FoundPair { interface: string; privilege: PrivilegeName; consumer: PrivilegeConsumer; site: string }
export interface SharedAppSite { site: string; privilege: PrivilegeName }
export interface FenceScan {
  pairs: FoundPair[]
  /** Consumo que não dá para ler estaticamente — reprova. */
  unresolved: string[]
  /** `PRIVILEGE_<NOME>` usado fora de uma primitiva (setes-api) — `arquivo: linha` (× N quando a linha se repete no arquivo). */
  loose: string[]
  /** `CurrentInterface.can('X')` fora de um módulo do app (`arquivo: can('X')`). */
  shared: SharedAppSite[]
}

type KeySpec = { arg: number } | { resolverArg: number } | { keys: readonly string[] }
type PrivSpec = { arg: number } | { fixed: PrivilegeName | readonly PrivilegeName[] }
/** `declFile` só nas DERIVADAS (a função do repasse): a chamada é seguida pelo símbolo, não pelo nome. */
export interface Primitive { name: string; key: KeySpec; priv: PrivSpec; declFile?: string }

/**
 * Primitivas do setes-api. Guarda nova com consumo dinâmico (ex.: privilégio pelo verbo HTTP, vários privilégios por chamada) entra
 * AQUI, com o que consome — o registro vence o repasse que a varredura acharia dentro dela.
 */
export const API_PRIMITIVES: readonly Primitive[] = [
  { name: 'requirePrivilege',    key: { arg: 0 },         priv: { arg: 1 } },
  { name: 'requirePrivilegeFor', key: { resolverArg: 1 }, priv: { arg: 0 } },
  { name: 'privilegeVerdict',    key: { arg: 1 },         priv: { arg: 2 } },
  { name: 'accessVerdict',       key: { arg: 1 },         priv: { arg: 2 } },
  // reaplicar a voz do banco (D-PV27): o privilégio é o do EFEITO, escolhido pela VOZ do evento (`reapplyPrivilegeFor`) — dinâmico,
  // então o registro diz o que ela consome (ALTERAR para a liquidação, CANCELAR para o cancelamento)
  { name: 'reapplyVerdictFor',   key: { arg: 1 },         priv: { fixed: ['ALTERAR', 'CANCELAR'] },
    declFile: 'src/modules/bank-slips/bank-slips.reapply-policy.ts' },
]
/**
 * IMPLEMENTAÇÃO (não é consumidor; os exports de cada arquivo são classificados pela cerca) → o motivo. A varredura não olha dentro
 * delas: quem decide o par é quem CHAMA (as primitivas acima), a tabela do roteador (D-PV14) ou a REGRA conferida contra o banco.
 */
export const API_IMPL_REASONS: Readonly<Record<string, string>> = {
  'src/shared/auth/require-privilege.ts': 'as primitivas (adaptador Express do veredito único — costura A1)',
  'src/shared/access/index.ts': 'o adaptador do veredito único (`fiscal-api/access` — a pilha de views; o verbo pelo NOME)',
  'src/shared/auth/module-privilege-gate.ts': 'a guarda POR ROTEADOR (D-PV2): os pares vêm da tabela `listGatedRoutes()` (D-PV14)',
  'src/shared/auth/configure-privilege.ts': 'a REGRA do CONFIGURAR (D-PV25): CONFIGURAR na interface ALVO, dinâmica — o conjunto (toda ' +
    'interface com config ou campo no catálogo + general-configs) é conferido contra o banco pelo boot e pelo teste ao vivo (D-PV51)',
}
export const API_IMPL = Object.keys(API_IMPL_REASONS)
/** Os ids (`PRIVILEGE_<NOME>`) e o mapa nome → id (não são consumidores). */
export const PRIVILEGES_FILE = 'src/shared/auth/privileges.ts'
export const API_DECLARATIONS = [PRIVILEGES_FILE, 'src/shared/auth/privilege-catalog.ts']
/** O marcador do ato na rota (D-PV2) — lido pela tabela do roteador, não pela varredura. */
export const ROUTER_GATE_FILE = 'src/shared/auth/module-privilege-gate.ts'

/** Resolvers de interface por requisição → as interfaces que podem devolver (a cerca confere o tipo `OrderInterfaceKey`). */
export const API_RESOLVERS: Readonly<Record<string, readonly string[]>> = {
  resolveFromBody:  ORDER_BRANCH_INTERFACES,
  resolveFromParam: ORDER_BRANCH_INTERFACES,
}
export const RESOLVER_FILE = 'src/modules/billing/billing.interface-resolver.ts'

export const NFSE_PRIMITIVES: readonly Primitive[] = [
  { name: 'requireBranchPrivilege', key: { keys: ORDER_BRANCH_INTERFACES }, priv: { arg: 3 } },
  { name: 'passScope',              key: { arg: 2 },                        priv: { arg: 3 } },
  // o veredito do núcleo (`fiscal-api/access`) chamado DIRETO fora de guards.ts é uma guarda nova: lida como as outras
  { name: 'accessVerdict',          key: { arg: 2 },                        priv: { arg: 3 } },
  { name: 'grantedKeys',            key: { arg: 2 },                        priv: { arg: 3 } },
]
export const NFSE_IMPL = ['src/modules/guards.ts']
/** O vocabulário dos verbos do núcleo (`PRIVILEGE_NAMES`) — a cerca o confere contra `PRIVILEGE_ID` (D-PV53). */
export const CORE_ACCESS_FILE = 'src/access/access.ts'

export const APP_ROUTES_FILE = 'apps/web/lib/app/modules/home/interface_routes.dart'
export const APP_IMPL = [
  'apps/web/lib/app/shared/session/current_interface.dart',
  'packages/core/lib/src/menu/domain/entity/menu_entity.dart',
]

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Repositórios irmãos
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const SIBLING_ENV: Record<string, string> = {
  'nfse-api': 'NFSE_API_DIR', 'setes-app': 'SETES_APP_DIR', 'fiscal-api': 'FISCAL_API_DIR', sql: 'SQL_DIR',
}

/**
 * O repositório irmão: a variável de ambiente (`NFSE_API_DIR`, `SETES_APP_DIR`, `FISCAL_API_DIR`, `SQL_DIR`) ou o `<nome>` ao lado do
 * ancestral MAIS PRÓXIMO que o tenha (worktree aninhada `D:\Gestao2027\<frente>\setes-api` acha `D:\Gestao2027\<frente>\setes-app` se
 * existir, senão o da raiz). `null` = não achado — a cerca REPROVA (cerca que pula em silêncio não cerca).
 */
export function findSiblingRepo(root: string, name: string, marker: string): string | null {
  const env = process.env[SIBLING_ENV[name] ?? '']
  if (env) return fs.existsSync(path.join(env, marker)) ? path.resolve(env) : null
  let dir = path.dirname(path.resolve(root))
  for (;;) {
    const cand = path.join(dir, name)
    if (fs.existsSync(path.join(cand, marker))) return cand
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

function walk(dir: string, ext: RegExp, skipDirs: string[]): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (skipDirs.includes(e.name) ? [] : walk(path.join(dir, e.name), ext, skipDirs))
      : ext.test(e.name) ? [path.join(dir, e.name)] : [])
}

const rel = (root: string, f: string): string => path.relative(root, f).split(path.sep).join('/')
const oneLine = (s: string): string => s.split(/\s+/).join(' ').trim()

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// TypeScript (setes-api, nfse-api)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TsSource { file: string; code: string }

const NAME_BY_ID = new Map<number, PrivilegeName>(Object.entries(PRIVILEGE_ID).map(([n, id]) => [id, n as PrivilegeName]))
const privilegeOfName = (text: string): PrivilegeName | null => {
  const m = /^PRIVILEGE_([A-Z]+)$/.exec(text)
  return m && m[1] in PRIVILEGE_ID ? (m[1] as PrivilegeName) : null
}

function unwrap(e: ts.Expression): ts.Expression {
  let x = e
  while (ts.isAsExpression(x) || ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isTypeAssertionExpression(x)
    || ts.isSatisfiesExpression(x)) x = x.expression
  return x
}

/** Texto literal ou lista literal de textos — senão null. */
function literalStrings(e: ts.Expression): string[] | null {
  const x = unwrap(e)
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return [x.text]
  if (ts.isArrayLiteralExpression(x)) {
    const out: string[] = []
    for (const el of x.elements) {
      if (ts.isSpreadElement(el)) return null
      const u = unwrap(el)
      if (!(ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u))) return null
      out.push(u.text)
    }
    return out
  }
  return null
}

const isFunctionLike = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
  || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)

function functionName(fn: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name)) return fn.name.text
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
    return fn.parent.name.text
  }
  return null
}

/** Alias de caminho do setes-api (tsconfig `paths`) → pasta. */
const PATH_ALIASES: Record<string, string> = {
  '@shared/': 'src/shared/', '@modules/': 'src/modules/', '@gateway/': 'src/gateway/', '@feature-flags/': 'src/feature-flags/',
}

/** O módulo importado (`from '…'`) como caminho relativo do repositório SEM extensão — ou null (pacote externo). */
function resolveSpec(fromRel: string, spec: string): string | null {
  const bare = spec.replace(/\.(js|ts)$/, '')
  if (bare.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), bare))
  for (const [a, d] of Object.entries(PATH_ALIASES)) if (bare.startsWith(a)) return d + bare.slice(a.length)
  return null
}
const sameModule = (resolved: string | null, file: string): boolean =>
  resolved !== null && (resolved === file.replace(/\.ts$/, '') || resolved === file.replace(/\/index\.ts$/, ''))

const bindsName = (b: ts.BindingName, name: string): boolean =>
  ts.isIdentifier(b) ? b.text === name : b.elements.some(el => !ts.isOmittedExpression(el) && bindsName(el.name, name))

/** De onde vem um nome, pelo ESCOPO LÉXICO (o mais interno vence). */
type Decl =
  | { kind: 'const'; init: ts.Expression }
  | { kind: 'param'; fn: ts.Node; index: number }
  | { kind: 'import'; original: string; module: string | null; spec: string }
  | { kind: 'namespace'; module: string | null; spec: string }
  | { kind: 'other'; what: string }
  | { kind: 'free' }

function declOf(id: ts.Identifier, fileRel: string): Decl {
  const name = id.text
  for (let cur: ts.Node | undefined = id.parent; cur; cur = cur.parent) {
    if (isFunctionLike(cur)) {
      const i = cur.parameters.findIndex(p => bindsName(p.name, name))
      if (i >= 0) {
        const p = cur.parameters[i]
        return ts.isIdentifier(p.name) && !p.dotDotDotToken ? { kind: 'param', fn: cur, index: i } : { kind: 'other', what: 'parâmetro desestruturado/rest' }
      }
      if (ts.isFunctionExpression(cur) && cur.name?.text === name) return { kind: 'other', what: 'função' }
    }
    if (ts.isCatchClause(cur) && cur.variableDeclaration && bindsName(cur.variableDeclaration.name, name)) return { kind: 'other', what: 'catch' }
    if ((ts.isForStatement(cur) || ts.isForOfStatement(cur) || ts.isForInStatement(cur)) && cur.initializer && ts.isVariableDeclarationList(cur.initializer)
      && cur.initializer.declarations.some(d => bindsName(d.name, name))) return { kind: 'other', what: 'variável de laço' }
    const stmts = ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isModuleBlock(cur) || ts.isCaseClause(cur) || ts.isDefaultClause(cur)
      ? cur.statements : null
    if (!stmts) continue
    for (const st of stmts) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) {
            return (st.declarationList.flags & ts.NodeFlags.Const) && d.initializer ? { kind: 'const', init: d.initializer } : { kind: 'other', what: 'let/var' }
          }
          if (!ts.isIdentifier(d.name) && bindsName(d.name, name)) return { kind: 'other', what: 'desestruturação' }
        }
      } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name?.text === name) {
        return { kind: 'other', what: 'função/classe/enum' }
      } else if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause) {
        const spec = st.moduleSpecifier.text
        const module = resolveSpec(fileRel, spec)
        if (st.importClause.name?.text === name) return { kind: 'other', what: 'import default' }
        const nb = st.importClause.namedBindings
        if (nb && ts.isNamespaceImport(nb) && nb.name.text === name) return { kind: 'namespace', module, spec }
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) if (el.name.text === name) return { kind: 'import', original: (el.propertyName ?? el.name).text, module, spec }
        }
      } else if (ts.isImportEqualsDeclaration(st) && st.name.text === name) {
        return { kind: 'other', what: 'import =' }
      }
    }
  }
  return { kind: 'free' }
}

/** `const NOME = …` de TOPO de um arquivo (o que um import por nome traz). */
function topLevelConstInit(sf: ts.SourceFile, name: string): ts.Expression | null {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer
  }
  return null
}

type Resolved<T> = { ok: T } | { param: number; fn: ts.Node } | { fail: string }
interface ScanFile { rel: string; sf: ts.SourceFile }

/**
 * O arquivo que DECLARA o nome que um módulo exporta — seguindo os BARRIS (`export * from`, `export { a as b } from`, import de pasta
 * → `index.ts`), o padrão das peças `@shared/<peça>` (gate adversarial 2026-10-18: a derivada importada pelo barril sumia da cerca).
 */
function providerOf(files: readonly ScanFile[], module: string | null, name: string, seen = new Set<string>()): { file: string; name: string } | null {
  const f = files.find(x => sameModule(module, x.rel))
  if (!f || seen.has(`${f.rel}#${name}`)) return null
  seen.add(`${f.rel}#${name}`)
  for (const st of f.sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name?.text === name) return { file: f.rel, name }
    if (ts.isVariableStatement(st) && st.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name)) return { file: f.rel, name }
  }
  for (const st of f.sf.statements) {
    if (!ts.isExportDeclaration(st) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue
    const target = resolveSpec(f.rel, st.moduleSpecifier.text)
    if (!st.exportClause) {
      const r = providerOf(files, target, name, seen)
      if (r) return r
    } else if (ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) if (el.name.text === name) return providerOf(files, target, (el.propertyName ?? el.name).text, seen)
    }
  }
  return null
}
const provides = (files: readonly ScanFile[], module: string | null, name: string, prim: Primitive): boolean => {
  const p = providerOf(files, module, name)
  return !!p && p.file === prim.declFile && p.name === prim.name
}
interface ScanCtx {
  files: ScanFile[]
  resolvers: Readonly<Record<string, readonly string[]>>
  resolverFile: string
  privilegesFile: string
}
const fileOf = (ctx: ScanCtx, module: string | null): ScanFile | undefined => ctx.files.find(f => sameModule(module, f.rel))

function resolveKeys(ctx: ScanCtx, file: ScanFile, e: ts.Expression | undefined, depth = 0): Resolved<string[]> {
  if (!e) return { fail: 'sem argumento da interface' }
  const lit = literalStrings(e)
  if (lit) return { ok: lit }
  const x = unwrap(e)
  if (depth > 8) return { fail: 'constante encadeada demais' }
  // lista com CONSTANTES (`[REAPPLY_INTERFACE]`, `[interfaceKey]` da costura A1): cada item pela mesma regra; um ÚNICO item que é
  // parâmetro vira o repasse daquele parâmetro (a derivada aceita texto ou lista no lugar dele)
  if (ts.isArrayLiteralExpression(x)) {
    if (x.elements.length === 1 && !ts.isSpreadElement(x.elements[0])) {
      const one = resolveKeys(ctx, file, x.elements[0], depth + 1)
      if ('param' in one || 'fail' in one) return one
      return { ok: one.ok }
    }
    const out: string[] = []
    for (const el of x.elements) {
      if (ts.isSpreadElement(el)) return { fail: `lista de interfaces com espalhamento: ${oneLine(x.getText())}` }
      const r = resolveKeys(ctx, file, el, depth + 1)
      if ('fail' in r) return r
      if ('param' in r) return { fail: `lista de interfaces mistura parâmetro e constante: ${oneLine(x.getText())}` }
      out.push(...r.ok)
    }
    return { ok: out }
  }
  if (ts.isIdentifier(x)) {
    const d = declOf(x, file.rel)
    if (d.kind === 'const') return resolveKeys(ctx, file, d.init, depth + 1)
    if (d.kind === 'param') return { param: d.index, fn: d.fn }
    if (d.kind === 'import') {
      const target = fileOf(ctx, d.module)
      const init = target && topLevelConstInit(target.sf, d.original)
      return init ? resolveKeys(ctx, target!, init, depth + 1) : { fail: `interface ${x.text} importada sem constante legível (${d.spec})` }
    }
    return { fail: `interface ${x.text} não resolvível (${d.kind === 'other' ? d.what : d.kind})` }
  }
  if (ts.isPropertyAccessExpression(x) && ts.isIdentifier(x.expression)) {
    const d = declOf(x.expression, file.rel)
    const target = d.kind === 'namespace' ? fileOf(ctx, d.module) : undefined
    const init = target && topLevelConstInit(target.sf, x.name.text)
    if (init) return resolveKeys(ctx, target!, init, depth + 1)
  }
  return { fail: `interface não resolvível: ${oneLine(x.getText())}` }
}

function resolvePriv(ctx: ScanCtx, file: ScanFile, e: ts.Expression | undefined, depth = 0): Resolved<PrivilegeName> {
  if (!e) return { fail: 'sem argumento do privilégio' }
  const x = unwrap(e)
  if (depth > 8) return { fail: 'constante encadeada demais' }
  if (ts.isNumericLiteral(x)) {
    const n = NAME_BY_ID.get(Number(x.text))
    return n ? { ok: n } : { fail: `privilégio ${x.text} fora do catálogo` }
  }
  // D-PV53: o verbo pelo NOME (`'TRANSMITIR'`) — a mesma forma do `CurrentInterface.can('X')` do app; EXATO, como a view
  // (`privilege` COLLATE utf8mb4_bin — migration 075)
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) {
    return x.text in PRIVILEGE_ID ? { ok: x.text as PrivilegeName } : { fail: `privilégio "${x.text}" fora do catálogo (${Object.keys(PRIVILEGE_ID).join(', ')})` }
  }
  const byName = (text: string): Resolved<PrivilegeName> => {
    const n = privilegeOfName(text)
    return n ? { ok: n } : { fail: `privilégio não resolvível: ${text}` }
  }
  if (ts.isIdentifier(x)) {
    const d = declOf(x, file.rel)
    if (d.kind === 'import') {
      if (sameModule(d.module, ctx.privilegesFile)) return byName(d.original)
      const target = fileOf(ctx, d.module)
      const init = target && topLevelConstInit(target.sf, d.original)
      return init ? resolvePriv(ctx, target!, init, depth + 1) : { fail: `privilégio ${x.text} importado sem constante legível (${d.spec})` }
    }
    if (d.kind === 'const') return resolvePriv(ctx, file, d.init, depth + 1)
    if (d.kind === 'param') return { param: d.index, fn: d.fn }
    if (d.kind === 'free') return byName(x.text)   // só nas sondas: em código real o tsc não deixa nome livre
    return { fail: `privilégio ${x.text} não resolvível (${d.kind === 'other' ? d.what : d.kind})` }
  }
  if (ts.isPropertyAccessExpression(x) && ts.isIdentifier(x.expression)) {
    const d = declOf(x.expression, file.rel)
    // `erp.PRIVILEGE_*` do núcleo NÃO vale mais (D-PV53: as APIs fiscais não guardam número de privilégio) — cai em "não resolvível"
    if ((d.kind === 'namespace' && sameModule(d.module, ctx.privilegesFile)) || d.kind === 'free') return byName(x.name.text)
  }
  return { fail: `privilégio não resolvível: ${oneLine(x.getText())}` }
}

/** O resolver de `requirePrivilegeFor` tem de ser o SÍMBOLO do arquivo do resolver (importado dele, ou declarado nele). */
function resolveResolver(ctx: ScanCtx, file: ScanFile, e: ts.Expression | undefined): Resolved<string[]> {
  const x = e && unwrap(e)
  if (x && ts.isIdentifier(x)) {
    const d = declOf(x, file.rel)
    if (d.kind === 'import' && sameModule(d.module, ctx.resolverFile) && ctx.resolvers[d.original]) return { ok: [...ctx.resolvers[d.original]] }
    if (d.kind === 'other' && file.rel === ctx.resolverFile && ctx.resolvers[x.text]) return { ok: [...ctx.resolvers[x.text]] }
  }
  return { fail: `resolver de interface não registrado (tem de vir de ${ctx.resolverFile}): ${x ? oneLine(x.getText()) : '(nenhum)'}` }
}

const siteOf = (file: string, n: ts.Node): string =>
  `${file}:${n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1}`

/** Lê os consumidores de um repositório TS a partir das primitivas (com as derivadas, até o ponto fixo). */
export function scanTs(
  sources: readonly TsSource[], primitives: readonly Primitive[], consumer: PrivilegeConsumer,
  opts: {
    impl?: string[]; declarations?: string[]; resolvers?: Readonly<Record<string, readonly string[]>>
    resolverFile?: string; privilegesFile?: string
    /**
     * `<m>.routes.ts` dos módulos GUARDADOS pela guarda por roteador (D-PV2): ali o `privilegeAct(PRIVILEGE_X, …)` é o marcador que a
     * TABELA do roteador lê (`listGatedRoutes()` — D-PV14), não "PRIVILEGE solto". Fora deles o marcador nunca é lido — é solto.
     */
    routerActFiles?: readonly string[]
  } = {},
): FenceScan {
  const impl = opts.impl ?? []
  const declarations = opts.declarations ?? []
  const routerActFiles = new Set(opts.routerActFiles ?? [])
  const files: ScanFile[] = sources.map(s => ({ rel: s.file, sf: ts.createSourceFile(s.file, s.code, ts.ScriptTarget.Latest, true) }))
  const ctx: ScanCtx = {
    files, resolvers: opts.resolvers ?? API_RESOLVERS, resolverFile: opts.resolverFile ?? RESOLVER_FILE,
    privilegesFile: opts.privilegesFile ?? PRIVILEGES_FILE,
  }
  const out: FenceScan = { pairs: [], unresolved: [], loose: [], shared: [] }
  const consumedPrivNodes = new Set<ts.Node>()
  const idOf = (p: Primitive): string => (p.declFile ? `${p.declFile}#${p.name}` : p.name)
  const prims = new Map<string, Primitive>(primitives.map(p => [idOf(p), p]))
  const registered = new Set(primitives.map(p => p.name))
  const done = new Set<string>()
  const queue = [...prims.keys()]

  /**
   * O nó (identificador do chamador, ou `ns.nome`) é a primitiva? As REGISTRADAS valem pelo NOME (nomes da casa, específicos); a
   * DERIVADA vale pelo SÍMBOLO — no arquivo que a declara, ou importada DELE (por nome, alias ou `* as ns`) —, senão um `update(key)`
   * derivado faria todo `service.update(…)` virar primitiva.
   */
  const refersTo = (f: ScanFile, n: ts.Node, prim: Primitive): boolean => {
    if (!prim.declFile) {
      if (ts.isIdentifier(n)) return n.text === prim.name
      return ts.isPropertyAccessExpression(n) && n.name.text === prim.name
    }
    if (ts.isIdentifier(n)) {
      const d = declOf(n, f.rel)
      if (d.kind === 'import') return provides(files, d.module, d.original, prim)
      return f.rel === prim.declFile && n.text === prim.name && (d.kind === 'other' || d.kind === 'const')
    }
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
      const d = declOf(n.expression, f.rel)
      return d.kind === 'namespace' && provides(files, d.module, n.name.text, prim)
    }
    return false
  }

  while (queue.length) {
    const id = queue.shift()!
    if (done.has(id)) continue
    done.add(id)
    const prim = prims.get(id)!
    for (const f of files) {
      if (impl.includes(f.rel)) continue
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && refersTo(f, n.expression, prim)) {
          const site = siteOf(f.rel, n)
          const text = `${site} ${oneLine(n.getText()).slice(0, 160)}`
          const args = n.arguments
          if (args.some(a => ts.isSpreadElement(a))) { out.unresolved.push(`${text} — argumentos espalhados (...)`); return }
          let pr: Resolved<PrivilegeName[]>
          if ('fixed' in prim.priv) pr = { ok: ([] as PrivilegeName[]).concat(prim.priv.fixed) }
          else {
            if (args[prim.priv.arg]) consumedPrivNodes.add(unwrap(args[prim.priv.arg]))
            const one = resolvePriv(ctx, f, args[prim.priv.arg])
            pr = 'ok' in one ? { ok: [one.ok] } : one
          }
          let kr: Resolved<string[]>
          if ('keys' in prim.key) kr = { ok: [...prim.key.keys] }
          else if ('resolverArg' in prim.key) kr = resolveResolver(ctx, f, args[prim.key.resolverArg])
          else kr = resolveKeys(ctx, f, args[prim.key.arg])

          if ('fail' in pr) { out.unresolved.push(`${text} — ${pr.fail}`); return }
          if ('fail' in kr) { out.unresolved.push(`${text} — ${kr.fail}`); return }
          if ('param' in pr || 'param' in kr) {
            // a função que envolve só REPASSA: vira primitiva derivada (as duas pontas do MESMO parâmetro-função)
            const fn = 'param' in kr ? kr.fn : (pr as { fn: ts.Node }).fn
            if ('param' in pr && 'param' in kr && pr.fn !== kr.fn) { out.unresolved.push(`${text} — interface e privilégio vêm de funções diferentes`); return }
            const fname = functionName(fn)
            if (fname && registered.has(fname)) return   // primitiva REGISTRADA: o registro diz o que ela consome
            if (!ts.isFunctionDeclaration(fn) && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) {
              out.unresolved.push(`${text} — repassa parâmetro de MÉTODO/acessor (as chamadas não são seguidas: use função de módulo)`); return
            }
            if (!fname) { out.unresolved.push(`${text} — repassa parâmetro de função ANÔNIMA (dê nome à função)`); return }
            const derived: Primitive = {
              name: fname,
              key: 'param' in kr ? { arg: kr.param } : { keys: kr.ok },
              priv: 'param' in pr ? { arg: pr.param } : { fixed: pr.ok },
              declFile: f.rel,
            }
            const prev = prims.get(idOf(derived))
            if (prev && JSON.stringify(prev) !== JSON.stringify(derived)) {
              out.unresolved.push(`${text} — a função ${fname} repassa privilégio de duas formas (registre-a em API_PRIMITIVES)`); return
            }
            if (!prev) { prims.set(idOf(derived), derived); queue.push(idOf(derived)) }
            return
          }
          for (const k of kr.ok) for (const p of pr.ok) out.pairs.push({ interface: k, privilege: p, consumer, site })
          return
        }
        ts.forEachChild(n, visit)
      }
      visit(f.sf)
    }
  }

  // uso INDIRETO das primitivas (como valor, renomeada, acessada por texto) — só fora da implementação
  const all = [...prims.values()]
  for (const f of files) {
    if (impl.includes(f.rel)) continue
    const visit = (n: ts.Node): void => {
      if ((ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) && n.propertyName && n.name.text !== n.propertyName.text) {
        const original = n.propertyName.text
        const decl = ts.isImportSpecifier(n) ? n.parent.parent.parent : n.parent.parent
        const spec = (ts.isImportDeclaration(decl) || ts.isExportDeclaration(decl)) && decl.moduleSpecifier && ts.isStringLiteral(decl.moduleSpecifier)
          ? decl.moduleSpecifier.text : null
        const hit = all.some(p => (!p.declFile ? p.name === original
          : spec !== null ? provides(files, resolveSpec(f.rel, spec), original, p) : (f.rel === p.declFile && p.name === original)))
        if (hit) out.unresolved.push(`${siteOf(f.rel, n)} — ${original} renomeada para ${n.name.text} (use o nome da primitiva)`)
      }
      if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && all.some(p => p.name === (n.argumentExpression as ts.StringLiteralLike).text)) {
        out.unresolved.push(`${siteOf(f.rel, n)} — ${n.argumentExpression.text} acessada por texto (consumo indireto)`)
      }
      if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
        const isMemberName = ts.isIdentifier(n) && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n   // visto pelo pai
        const candidates: Primitive[] = isMemberName ? [] : all
        for (const prim of candidates) {
          if (!refersTo(f, n, prim)) continue
          const p: ts.Node = n.parent
          const asCallee = ts.isCallExpression(p) && p.expression === n
          const declared = ts.isIdentifier(n) && (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isVariableDeclaration(p)
            || ts.isPropertyAssignment(p) || ts.isParameter(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p)
            || ts.isPropertyDeclaration(p)) && (p as { name?: ts.Node }).name === n
          const inImport = ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isExportSpecifier(p)
          if (!asCallee && !declared && !inImport) out.unresolved.push(`${siteOf(f.rel, n)} — ${prim.name} usada como valor (consumo indireto)`)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(f.sf)
  }

  // `PRIVILEGE_<NOME>` fora do argumento de uma primitiva — `arquivo: linha` (× N quando a mesma linha se repete no arquivo)
  const loose = new Map<string, number>()
  for (const f of files) {
    if (impl.includes(f.rel) || declarations.includes(f.rel)) continue
    const lines = f.sf.getFullText().split(/\r?\n/)
    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n)) return
      // D-PV14: o marcador do ato no roteador de um módulo GUARDADO — a 1ª ponta (o privilégio) é lida pela tabela, não solta. Só o
      // `privilegeAct` importado da peça da guarda (pelo símbolo, não pelo nome solto)
      if (routerActFiles.has(f.rel) && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'privilegeAct'
        && n.arguments.length > 0) {
        const d = declOf(n.expression, f.rel)
        if (d.kind === 'import' && d.original === 'privilegeAct' && sameModule(d.module, ROUTER_GATE_FILE)) {
          consumedPrivNodes.add(unwrap(n.arguments[0]))
        }
      }
      const isRef = (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && privilegeOfName(n.text))
        || (ts.isPropertyAccessExpression(n) && privilegeOfName(n.name.text))
      if (isRef && !consumedPrivNodes.has(n)) {
        const line = f.sf.getLineAndCharacterOfPosition(n.getStart()).line
        const entry = `${f.rel}: ${oneLine(lines[line] ?? '')}`
        loose.set(entry, (loose.get(entry) ?? 0) + 1)
      }
      if (ts.isPropertyAccessExpression(n) && privilegeOfName(n.name.text)) return
      ts.forEachChild(n, visit)
    }
    visit(f.sf)
  }
  out.loose = [...loose].map(([e, n]) => (n > 1 ? `${e} ×${n}` : e))
  return out
}

/**
 * Quantos trechos de SQL (texto/template) de cada arquivo leem a concessão do usuário (`tb_user_has_privilege`) — consumidor que não
 * passa pelas primitivas (uma guarda nova por SQL direto, um `tb_privilege_id = 2` numa consulta). A cerca exige o registro POR
 * CONTAGEM: um SQL novo num arquivo já registrado também reprova.
 */
export function grantSqlCounts(sources: readonly TsSource[], impl: string[] = []): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of sources) {
    if (impl.includes(s.file)) continue
    const sf = ts.createSourceFile(s.file, s.code, ts.ScriptTarget.Latest, true)
    let n = 0
    const visit = (node: ts.Node): void => {
      if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
        && /tb_user_has_privilege/i.test(node.text)) n++
      ts.forEachChild(node, visit)
    }
    visit(sf)
    if (n) out[s.file] = n
  }
  return out
}

/** `arquivo: nome` de toda referência (identificador) a um dos nomes — para os leitores da concessão que não são primitivas. */
export function identifierUses(sources: readonly TsSource[], names: readonly string[]): string[] {
  const out = new Set<string>()
  for (const s of sources) {
    const sf = ts.createSourceFile(s.file, s.code, ts.ScriptTarget.Latest, true)
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && names.includes(n.text)) out.add(`${s.file}: ${n.text}`)
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return [...out].sort()
}

/** Os `.ts` de um repositório (fora `node_modules`, `dist`, `__tests__`, `test-setup`), caminho relativo com `/`. */
export function repoTsSources(root: string, dirs: string[] = ['src']): TsSource[] {
  return dirs.flatMap(d => walk(path.join(root, d), /\.ts$/, ['node_modules', 'dist', '__tests__', 'test-setup']))
    .filter(f => !/\.(test|spec)\.ts$/.test(f) && !/\.d\.ts$/.test(f))
    .map(f => ({ file: rel(root, f), code: fs.readFileSync(f, 'utf8') }))
}

/** O domínio do tipo `OrderInterfaceKey` (união de textos) num arquivo (o resolver do billing, o `erp/facts.ts` do núcleo). */
export function orderInterfaceKeyDomain(code: string): string[] | null {
  const sf = ts.createSourceFile('resolver.ts', code, ts.ScriptTarget.Latest, true)
  for (const st of sf.statements) {
    if (ts.isTypeAliasDeclaration(st) && st.name.text === 'OrderInterfaceKey') {
      const t = st.type
      const parts = ts.isUnionTypeNode(t) ? t.types : [t]
      const out: string[] = []
      for (const p of parts) {
        if (!ts.isLiteralTypeNode(p) || !ts.isStringLiteral(p.literal)) return null
        out.push(p.literal.text)
      }
      return out
    }
  }
  return null
}

/** Os nomes que um arquivo TS EXPORTA (função, classe, const, `export { … }`) — para classificar a implementação das primitivas. */
export function exportedNames(code: string): string[] {
  const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const isExported = (n: ts.Node): boolean =>
    !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword))
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name && isExported(st)) out.push(st.name.text)
    else if (ts.isVariableStatement(st) && isExported(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) out.push(d.name.text)
    } else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) out.push(el.name.text)
    } else if (ts.isExportAssignment(st)) out.push('default')
  }
  return out
}

/** `[export] const PRIVILEGE_<NOME> = <id>` de um arquivo — o núcleo fiscal NÃO pode ter nenhuma (D-PV53). */
export function privilegeConstants(code: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of code.matchAll(/\bconst\s+PRIVILEGE_([A-Z]+)\s*(?::[^=]*)?=\s*(\d+)/g)) out[m[1]] = Number(m[2])
  return out
}

/** Os textos de `[export] const NOME = ['a', 'b'] [as const]` de TOPO de um arquivo TS — ou null (o vocabulário `PRIVILEGE_NAMES`). */
export function constStringArray(code: string, name: string): string[] | null {
  const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true)
  const init = topLevelConstInit(sf, name)
  return init ? literalStrings(init) : null
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Dart (setes-app)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Mapa `interfaceRoutes` → pasta do módulo (`/home/<rota>/` → `<rota com _>`) → i18n_key. */
export function appModuleInterfaces(routesCode: string): Map<string, string> {
  const out = new Map<string, string>()
  const code = stripDartComments(routesCode)
  const re = /'([a-z0-9-]+)'\s*:\s*'\/home\/([a-z0-9-]+)\/'/g
  for (let m = re.exec(code); m; m = re.exec(code)) out.set(m[2].replace(/-/g, '_'), m[1])
  return out
}

const isQuote = (c: string | undefined): boolean => c === '\'' || c === '"'

/** Fim de um texto Dart que começa em [i] (aspas, ou `r` antes delas): simples, triplo, raw, `\` e interpolação `${…}`. */
function skipDartString(code: string, i: number): number {
  let j = i
  const raw = code[j] === 'r' || code[j] === 'R'
  if (raw) j++
  const q = code[j]
  const triple = code.startsWith(q.repeat(3), j)
  const close = triple ? q.repeat(3) : q
  j += close.length
  while (j < code.length) {
    if (!raw && code[j] === '\\') { j += 2; continue }
    if (!raw && code.startsWith('${', j)) { j = skipDartInterpolation(code, j + 2); continue }
    if (code.startsWith(close, j)) return j + close.length
    if (!triple && code[j] === '\n') return j          // texto simples não atravessa linha: código mal formado, para aqui
    j++
  }
  return j
}

function skipDartInterpolation(code: string, j: number): number {
  let depth = 1
  while (j < code.length) {
    const c = code[j]
    if (isQuote(c) || ((c === 'r' || c === 'R') && isQuote(code[j + 1]) && !/[\w$]/.test(code[j - 1] ?? ''))) { j = skipDartString(code, j); continue }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return j + 1
    j++
  }
  return j
}

/**
 * Tira os comentários (de linha, de doc e de BLOCO ANINHADO, como o Dart aceita) trocando-os por espaço (as linhas não mudam) e
 * preserva os TEXTOS inteiros — um texto `image/` + asterisco não abre comentário (gate adversarial 2026-10-18: a 1ª versão apagava
 * código até o próximo fecho de bloco).
 */
export function stripDartComments(code: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ')
  let out = ''
  let i = 0
  while (i < code.length) {
    const c = code[i]
    const d = code[i + 1]
    if (c === '/' && d === '/') {
      const nl = code.indexOf('\n', i)
      const end = nl < 0 ? code.length : nl
      out += blank(code.slice(i, end)); i = end; continue
    }
    if (c === '/' && d === '*') {
      let depth = 1
      let j = i + 2
      while (j < code.length && depth > 0) {
        if (code[j] === '/' && code[j + 1] === '*') { depth++; j += 2 } else if (code[j] === '*' && code[j + 1] === '/') { depth--; j += 2 } else j++
      }
      out += blank(code.slice(i, j)); i = j; continue
    }
    if (isQuote(c) || ((c === 'r' || c === 'R') && isQuote(d) && !/[\w$]/.test(code[i - 1] ?? ''))) {
      const j = skipDartString(code, i)
      out += code.slice(i, j); i = j; continue
    }
    out += c; i++
  }
  return out
}

/**
 * O código com o CONTEÚDO dos textos trocado por espaço (mesmo comprimento; a interpolação `${…}` continua código) — a procura
 * de `.can` e de `CurrentInterface.value` roda aqui, para um texto como "use CurrentInterface.can" não reprovar.
 */
export function maskDartStrings(clean: string): string {
  const out = clean.split('')
  const mask = (j: number): void => { if (j < out.length && out[j] !== '\n') out[j] = ' ' }
  const rawAt = (j: number): boolean => (clean[j] === 'r' || clean[j] === 'R') && isQuote(clean[j + 1]) && !/[\w$]/.test(clean[j - 1] ?? '')
  const code = (start: number, stopBrace: boolean): number => {
    let depth = 0
    let j = start
    while (j < clean.length) {
      const c = clean[j]
      if (isQuote(c) || rawAt(j)) { j = str(j); continue }
      if (stopBrace) { if (c === '{') depth++; else if (c === '}') { if (depth === 0) return j + 1; depth-- } }
      j++
    }
    return j
  }
  const str = (i: number): number => {
    let j = i
    const raw = clean[j] === 'r' || clean[j] === 'R'
    if (raw) j++
    const q = clean[j]
    const triple = clean.startsWith(q.repeat(3), j)
    const close = triple ? q.repeat(3) : q
    j += close.length
    while (j < clean.length) {
      if (!raw && clean[j] === '\\') { mask(j); mask(j + 1); j += 2; continue }
      if (!raw && clean.startsWith('${', j)) { j = code(j + 2, true); continue }
      if (clean.startsWith(close, j)) return j + close.length
      if (!triple && clean[j] === '\n') return j
      mask(j); j++
    }
    return j
  }
  code(0, false)
  return out.join('')
}

/** Índice do `)` que fecha o `(` em [open] (pulando textos e parênteses aninhados) — ou -1. */
function matchParen(code: string, open: number): number {
  let depth = 0
  for (let j = open; j < code.length;) {
    const c = code[j]
    if (isQuote(c) || ((c === 'r' || c === 'R') && isQuote(code[j + 1]) && !/[\w$]/.test(code[j - 1] ?? ''))) { j = skipDartString(code, j); continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return j
    j++
  }
  return -1
}

/** Índice do `}` que fecha o `{` em [open] (pulando textos) — ou -1. */
function matchBrace(code: string, open: number): number {
  let depth = 0
  for (let j = open; j < code.length;) {
    const c = code[j]
    if (isQuote(c) || ((c === 'r' || c === 'R') && isQuote(code[j + 1]) && !/[\w$]/.test(code[j - 1] ?? ''))) { j = skipDartString(code, j); continue }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return j
    j++
  }
  return -1
}

/**
 * `Classe.membro` → texto, de todo `static const [String] membro = 'TEXTO';` dentro de `class Classe { … }` do app — para o
 * `CurrentInterface.can(PrivilegeNames.cancel)` da onda D-PV2 (o nome continua legível, só que por constante).
 */
export function dartStringConstants(sources: readonly { file: string; code: string }[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const s of sources) {
    const code = stripDartComments(s.code)
    const reClass = /\bclass\s+([A-Za-z_]\w*)[^{;]*\{/g
    for (let m = reClass.exec(code); m; m = reClass.exec(code)) {
      const open = m.index + m[0].length - 1
      const close = matchBrace(code, open)
      const body = code.slice(open, close < 0 ? code.length : close)
      for (const c of body.matchAll(/static\s+const\s+(?:String\s+)?([A-Za-z_]\w*)\s*=\s*[rR]?(['"])([A-Za-z]+)\2\s*;/g)) {
        out.set(`${m[1]}.${c[1]}`, c[3])
      }
    }
  }
  return out
}

/** Os `.can` de UM arquivo Dart — `fileRel` decide o módulo (e o site compartilhado); `constants` = `dartStringConstants` do app. */
export function scanDartFile(fileRel: string, code: string, modules: Map<string, string>, constants: Map<string, string> = new Map()): FenceScan {
  const out: FenceScan = { pairs: [], unresolved: [], loose: [], shared: [] }
  const clean = stripDartComments(code)
  const masked = maskDartStrings(clean)
  const lineAt = (idx: number): number => clean.slice(0, idx).split('\n').length
  const mod = /^apps\/web\/lib\/app\/modules\/([a-z0-9_]+)\//.exec(fileRel)
  // a interface atual só é LIDA pelo can(): ler `CurrentInterface.value` direto (ex.: `.value?.privileges`) escapa da cerca
  if (fileRel !== APP_ROUTES_FILE) {
    const reVal = /CurrentInterface\s*\.\s*value\b/g
    for (let m = reVal.exec(masked); m; m = reVal.exec(masked)) {
      out.unresolved.push(`${fileRel}:${lineAt(m.index)} — CurrentInterface.value lido direto (use CurrentInterface.can('NOME'))`)
    }
  }
  const re = /\.\s*can\b/g
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const site = `${fileRel}:${lineAt(m.index)}`
    let k = m.index - 1
    while (k >= 0 && /[\s?!]/.test(masked[k])) k--
    const end = k + 1
    while (k >= 0 && /[\w$]/.test(masked[k])) k--
    const receiver = masked.slice(k + 1, end)
    let j = m.index + m[0].length
    while (j < masked.length && /\s/.test(masked[j])) j++
    if (masked[j] !== '(') {
      out.unresolved.push(`${site} — ${receiver || '(expressão)'}.can sem chamada (tear-off): o privilégio não é legível`)
      continue
    }
    const close = matchParen(clean, j)
    const call = oneLine(clean.slice(k + 1, close < 0 ? j + 1 : close + 1))
    if (receiver !== 'CurrentInterface') {
      out.unresolved.push(`${site} — privilégio consultado fora do CurrentInterface: ${call}`)
      continue
    }
    const argText = close < 0 ? '' : clean.slice(j + 1, close)
    const lit = /^\s*[rR]?(['"])([A-Za-z]+)\1\s*,?\s*$/.exec(argText)
    const cst = /^\s*([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*,?\s*$/.exec(argText)
    const raw = lit ? lit[2] : cst ? constants.get(`${cst[1]}.${cst[2]}`) : undefined
    if (raw === undefined) { out.unresolved.push(`${site} — CurrentInterface.can com argumento não literal (nem constante de texto conhecida): ${call}`); continue }
    const name = raw.toUpperCase()
    if (!(name in PRIVILEGE_ID)) { out.unresolved.push(`${site} — privilégio "${raw}" fora do catálogo (${Object.keys(PRIVILEGE_ID).join(', ')})`); continue }
    const privilege = name as PrivilegeName
    if (!mod) { out.shared.push({ site: `${fileRel}: can('${privilege}')`, privilege }); continue }
    const key = modules.get(mod[1])
    if (!key) { out.unresolved.push(`${site} — módulo ${mod[1]} sem interface no interfaceRoutes`); continue }
    out.pairs.push({ interface: key, privilege, consumer: 'app', site })
  }
  return out
}

/**
 * Grafo de `import`/`export` do app (arquivo → arquivos que ele importa ou reexporta), caminhos relativos ao repositório. Resolve
 * `package:setes_web/…` (apps/web/lib), `package:<pacote>/…` (packages/<pacote>/lib) e relativos; `dart:` e pacotes de fora somem.
 */
export function appImportGraph(sources: readonly { file: string; code: string }[]): Map<string, Set<string>> {
  const g = new Map<string, Set<string>>()
  for (const s of sources) {
    const targets = new Set<string>()
    const re = /^\s*(?:import|export|part)\b(?!\s+of\b)([^;]*);/gm   // `part` e o 2º alvo do import condicional (`if (…) 'b.dart'`)
    const code = stripDartComments(s.code)
    for (let m = re.exec(code); m; m = re.exec(code)) {
      for (const u of m[1].matchAll(/['"]([^'"]+)['"]/g)) {
        const uri = u[1]
        let target: string | null = null
        const pkg = /^package:([a-z0-9_]+)\/(.+)$/.exec(uri)
        if (pkg) target = pkg[1] === 'setes_web' ? `apps/web/lib/${pkg[2]}` : `packages/${pkg[1]}/lib/${pkg[2]}`
        else if (!uri.includes(':') && /\.dart$/.test(uri)) target = path.posix.normalize(path.posix.join(path.posix.dirname(s.file), uri))
        if (target) targets.add(target)
      }
    }
    g.set(s.file, targets)
  }
  return g
}

/**
 * As interfaces das telas que ALCANÇAM um arquivo compartilhado (importam, direto ou por outras peças/barris): o `can()` dele roda
 * com a interface da tela que o usa. `unmapped` = pastas de módulo sem interface (o shell `home` fica fora: a interface dele é a do
 * último clique).
 */
export function sharedFileInterfaces(file: string, graph: Map<string, Set<string>>, modules: Map<string, string>)
  : { interfaces: string[]; unmapped: string[] } {
  const reverse = new Map<string, string[]>()
  for (const [from, tos] of graph) for (const to of tos) reverse.set(to, [...(reverse.get(to) ?? []), from])
  const seen = new Set<string>([file])
  const queue = [file]
  const keys = new Set<string>()
  const unmapped = new Set<string>()
  while (queue.length) {
    const cur = queue.shift()!
    const m = /^apps\/web\/lib\/app\/modules\/([a-z0-9_]+)\//.exec(cur)
    if (m && m[1] !== 'home') {
      const k = modules.get(m[1])
      if (k) keys.add(k); else unmapped.add(m[1])
    }
    for (const importer of reverse.get(cur) ?? []) if (!seen.has(importer)) { seen.add(importer); queue.push(importer) }
  }
  return { interfaces: [...keys].sort(), unmapped: [...unmapped].sort() }
}

/** Registro de um `can()` numa peça compartilhada: o motivo e, se preciso, telas EXCLUÍDAS da derivação (cada uma com o motivo). */
export interface SharedConsumerEntry { reason: string; exclude?: Readonly<Record<string, string>> }

/**
 * Os pares de um site compartilhado: as telas DERIVADAS do grafo MENOS as exclusões (a exceção humana SUBTRAI, nunca substitui —
 * gate socrático 2026-10-18: uma lista explícita congelaria o site e a próxima tela que usar a peça ficaria de fora). Reprova:
 * módulo sem interface, site que NENHUMA tela alcança (peça morta ou só o shell — o `can` não tem interface) e exclusão que não
 * alcança mais (apodreceu).
 */
export function expandSharedSite(site: SharedAppSite, derived: { interfaces: string[]; unmapped: string[] }, entry: SharedConsumerEntry)
  : { pairs: FoundPair[]; problems: string[] } {
  const problems: string[] = []
  if (derived.unmapped.length) problems.push(`${site.site} — alcançado por módulo sem interface: ${derived.unmapped.join(', ')}`)
  if (!derived.interfaces.length) problems.push(`${site.site} — nenhuma tela alcança este arquivo (peça morta ou só o shell): o can() não tem interface`)
  const exclude = entry.exclude ?? {}
  for (const k of Object.keys(exclude)) {
    if (!derived.interfaces.includes(k)) problems.push(`${site.site} — exclusão de ${k} não alcança mais (tirar do registro)`)
    if (exclude[k].trim().length < 15) problems.push(`${site.site} — exclusão de ${k} sem motivo`)
  }
  const pairs = derived.interfaces.filter(k => !(k in exclude))
    .map(k => ({ interface: k, privilege: site.privilege, consumer: 'app' as const, site: site.site }))
  return { pairs, problems }
}

/** Os `.dart` do app (fora a implementação e os testes), caminho relativo com `/`. */
export function appDartSources(appRoot: string): { file: string; code: string }[] {
  const pkgs = path.join(appRoot, 'packages')
  const roots = [path.join(appRoot, 'apps', 'web', 'lib'),
    ...(fs.existsSync(pkgs) ? fs.readdirSync(pkgs).map(p => path.join(pkgs, p, 'lib')) : [])]
  return roots.flatMap(r => walk(r, /\.dart$/, ['build', '.dart_tool']))
    .map(f => ({ file: rel(appRoot, f), code: fs.readFileSync(f, 'utf8') }))
    .filter(s => !APP_IMPL.includes(s.file) && !/_test\.dart$/.test(s.file) && !/\.(g|freezed)\.dart$/.test(s.file))
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Sondas (o gate e a cerca conferem que o predicado ENXERGA o que deve)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ROUTES = 'src/modules/billing/billing.routes.ts'

/** Código TS → { pares esperados ('interface|NOME'), reprova? }. `file` padrão = `probe.ts`. */
export const TS_PROBES: { code: string; pairs: string[]; unresolved: number; file?: string }[] = [
  { code: `router.put('/x', requirePrivilege('settlements', PRIVILEGE_ALTERAR), c.x)`, pairs: ['settlements|ALTERAR'], unresolved: 0 },
  { code: `router.put('/x', requirePrivilege(['orders', 'service-orders'], 7), c.x)`, pairs: ['orders|CANCELAR', 'service-orders|CANCELAR'], unresolved: 0 },
  { code: `const K = 'customers' as const\nrouter.post('/', requirePrivilege(K, PRIVILEGE_INSERIR))`, pairs: ['customers|INSERIR'], unresolved: 0 },
  { file: ROUTES, code: `import { resolveFromBody } from './billing.interface-resolver'\nrouter.post('/i', requirePrivilegeFor(PRIVILEGE_FATURAR, resolveFromBody))`,
    pairs: ['orders|FATURAR', 'service-orders|FATURAR', 'order-returns|FATURAR'], unresolved: 0 },
  // repasse por parâmetro: a derivada é lida nas chamadas dela
  { code: `export async function pol(inst: any, key: string) { await accessVerdict(inst, [key], PRIVILEGE_DESCONTO) }\n` +
      `const A = 'bank-charge-agreements'\nawait pol(i, A)\nawait pol(i, 'settlements')`,
    pairs: ['bank-charge-agreements|DESCONTO', 'settlements|DESCONTO'], unresolved: 0 },
  // dois níveis de repasse (interface e privilégio por parâmetro)
  { code: `function g(k: string, p: number) { return requirePrivilege(k, p) }\nfunction h(k: string) { return g(k, PRIVILEGE_EXCLUIR) }\n` +
      `router.delete('/:id', h('contracts'))`, pairs: ['contracts|EXCLUIR'], unresolved: 0 },
  // ESCOPO (gate adversarial): o parâmetro e a const local SOMBREIAM a constante de fora — vale o mais interno
  { code: `const IFACE = 'settlements'\nexport function guardFor(IFACE: string) { return requirePrivilege(IFACE, PRIVILEGE_ALTERAR) }\n` +
      `router.put('/x', guardFor('cashier'))`, pairs: ['cashier|ALTERAR'], unresolved: 0 },
  { code: `const SETTLEMENTS_INTERFACE = 'settlements'\nfunction mount() { const SETTLEMENTS_INTERFACE = 'cashier'\n` +
      `  router.put('/x', requirePrivilege(SETTLEMENTS_INTERFACE, PRIVILEGE_ALTERAR)) }`, pairs: ['cashier|ALTERAR'], unresolved: 0 },
  { code: `let K = 'settlements'\nK = 'cashier'\nrouter.put('/x', requirePrivilege(K, PRIVILEGE_ALTERAR))`, pairs: [], unresolved: 1 },
  { code: `import { PRIVILEGE_CANCELAR as PRIVILEGE_ALTERAR } from '@shared/auth/privileges'\n` +
      `router.put('/x', requirePrivilege('settlements', PRIVILEGE_ALTERAR))`, pairs: ['settlements|CANCELAR'], unresolved: 0 },
  { code: `export function g(PRIVILEGE_ALTERAR: number) { return requirePrivilege('settlements', PRIVILEGE_ALTERAR) }\nrouter.put('/x', g(3))`,
    pairs: ['settlements|EXCLUIR'], unresolved: 0 },
  // resolver só vale pelo SÍMBOLO importado do arquivo do resolver
  { file: 'src/modules/cashier/cashier.routes.ts', code: `const resolveFromBody = async () => 'cashier'\n` +
      `router.post('/c', requirePrivilegeFor(PRIVILEGE_CANCELAR, resolveFromBody))`, pairs: [], unresolved: 1 },
  { code: `router.post('/i', requirePrivilegeFor(PRIVILEGE_FATURAR, (req) => pick(req)))`, pairs: [], unresolved: 1 },
  // NÃO resolvíveis — reprovam
  { code: `router.put('/x', requirePrivilege(req.params.k, PRIVILEGE_ALTERAR))`, pairs: [], unresolved: 1 },
  { code: `const P = { put: 2 }\nrouter.put('/x', requirePrivilege('customers', P.put))`, pairs: [], unresolved: 1 },
  { code: `export function crud(key: string) { return async (req: any) => privilegeVerdict(inst, [key], METHOD[req.method]) }`, pairs: [], unresolved: 1 },
  { code: `const guard = (k: string) => async () => accessVerdict(inst, k, PRIVILEGE_ALTERAR)\n[1].map(() => (x: string) => requirePrivilege(x, 6))`,
    pairs: [], unresolved: 1 },
  { code: `import { requirePrivilege as rp } from '@shared/auth/require-privilege'\nrouter.put('/x', rp('a', 2))`, pairs: [], unresolved: 1 },
  { code: `const g = requirePrivilege\nrouter.put('/x', g('a', 2))`, pairs: [], unresolved: 1 },
  { code: `router.put('/x', auth['requirePrivilege']('a', 2))`, pairs: [], unresolved: 1 },
  { code: `export { requirePrivilege as guardaDeAcao } from '@shared/auth/require-privilege'`, pairs: [], unresolved: 1 },
  { code: `router.put('/x', requirePrivilege(...args))`, pairs: [], unresolved: 1 },
  { code: `router.put('/x', requirePrivilege('a', 99))`, pairs: [], unresolved: 1 },
  // comentário não conta
  { code: `// requirePrivilege('x', 2)\n/* requirePrivilege('y', 3) */`, pairs: [], unresolved: 0 },
  // derivada de nome GENÉRICO: só as chamadas do PRÓPRIO símbolo contam (service.update / controller.update ficam de fora)
  { code: `export function update(key: string) { return requirePrivilege(key, PRIVILEGE_ALTERAR) }\n` +
      `router.put('/a', update('customers'), controller.update)\nawait service.update(id, body)`, pairs: ['customers|ALTERAR'], unresolved: 0 },
  // repasse dentro de MÉTODO: as chamadas (this.x / obj.x) não são seguidas — reprova
  { code: `class G { gate(k: string) { return requirePrivilege(k, PRIVILEGE_ALTERAR) } }`, pairs: [], unresolved: 1 },
  // `.js` no import resolve como o arquivo (ESM)
  // campo/membro com o nome de uma primitiva não é consumo
  { code: `interface Port { privilegeVerdict(a: string): boolean }\nconst mock = { accessVerdict: () => true }`, pairs: [], unresolved: 0 },
  // costura A1 (D-AU6): o veredito único pelo id ou pelo NOME do verbo (D-PV53 — exato, como a view)
  { code: `if ((await accessVerdict(inst, ['bank-slips'], 'CONSULTAR')) === 'ok') ok()`, pairs: ['bank-slips|CONSULTAR'], unresolved: 0 },
  { code: `const v = await privilegeVerdict(inst, ['orders', 'service-orders'], PRIVILEGE_FATURAR)`, pairs: ['orders|FATURAR', 'service-orders|FATURAR'], unresolved: 0 },
  { code: `await accessVerdict(inst, ['bank-slips'], 'consultar')`, pairs: [], unresolved: 1 },
  { code: `await accessVerdict(inst, ['bank-slips'], 'AUTORIZAR')`, pairs: [], unresolved: 1 },
  // lista com CONSTANTES (o `[REAPPLY_INTERFACE]` da política); parâmetro misturado com constante reprova
  { code: `const K = 'cashier'\nrouter.put('/x', requirePrivilege([K, 'orders'], PRIVILEGE_ALTERAR))`, pairs: ['cashier|ALTERAR', 'orders|ALTERAR'], unresolved: 0 },
  { code: `export function g(k: string) { return requirePrivilege([k, 'orders'], 2) }`, pairs: [], unresolved: 1 },
  // D-PV53: o número do núcleo (`erp.PRIVILEGE_*`) não existe mais — importado de verdade, não resolve
  { code: `import { erp } from 'fiscal-api'\nrouter.put('/x', requirePrivilege('settlements', erp.PRIVILEGE_ALTERAR))`, pairs: [], unresolved: 1 },
  // a primitiva antiga (antes da costura A1) não é mais primitiva: o nome solto não vira par
  { code: `await userHasPrivilege(s, u, 'settlements', 2)`, pairs: [], unresolved: 0 },
]

/** Código TS → linhas soltas esperadas (`PRIVILEGE_<NOME>` fora de primitiva). */
export const LOOSE_PROBES: { code: string; loose: number; file?: string; routerActFiles?: string[] }[] = [
  { code: `const sql = \`... tb_privilege_id = \${PRIVILEGE_ALTERAR}\``, loose: 1 },
  { code: `if (await accessVerdict(inst, ['settlements'], PRIVILEGE_DESCONTO)) ok()`, loose: 0 },
  { code: `throw new Error(ErrorCodes.PRIVILEGE_REQUIRED)`, loose: 0 },
  { code: `const map = { PRIVILEGE_ALTERAR: 7 }`, loose: 1 },
  // D-PV14: o marcador do ato no <m>.routes.ts de um módulo GUARDADO é lido pela tabela do roteador — não é solto
  { file: 'src/modules/orders/orders.routes.ts', routerActFiles: ['src/modules/orders/orders.routes.ts'],
    code: `import { privilegeAct } from '@shared/auth/module-privilege-gate'\nimport { PRIVILEGE_ALTERAR } from '@shared/auth/privileges'\n` +
      `router.post('/:id/items', privilegeAct(PRIVILEGE_ALTERAR), c.add)`, loose: 0 },
  // … fora de um módulo guardado o marcador nunca é lido (nenhuma guarda o procura): é solto
  { file: 'src/modules/users/users.routes.ts', routerActFiles: ['src/modules/orders/orders.routes.ts'],
    code: `import { privilegeAct } from '@shared/auth/module-privilege-gate'\nimport { PRIVILEGE_ALTERAR } from '@shared/auth/privileges'\n` +
      `router.post('/:id/items', privilegeAct(PRIVILEGE_ALTERAR), c.add)`, loose: 1 },
  // … e um `privilegeAct` que não é o da guarda (homônimo local) também
  { file: 'src/modules/orders/orders.routes.ts', routerActFiles: ['src/modules/orders/orders.routes.ts'],
    code: `function privilegeAct(p: number) { return p }\nrouter.post('/x', privilegeAct(PRIVILEGE_ALTERAR))`, loose: 1 },
  // o 2º argumento (a interface) não muda nada; um PRIVILEGE_ fora do 1º argumento segue solto
  { file: 'src/modules/orders/orders.routes.ts', routerActFiles: ['src/modules/orders/orders.routes.ts'],
    code: `import { privilegeAct } from '@shared/auth/module-privilege-gate'\nrouter.get('/p', privilegeAct(PRIVILEGE_VISUALIZAR, 'partnerships'))\n` +
      `const outro = PRIVILEGE_EXCLUIR`, loose: 1 },
]

/** Arquivo/código Dart → { pares esperados, compartilhados, reprova? }. */
export const DART_PROBES: { file: string; code: string; pairs: string[]; shared: number; unresolved: number }[] = [
  { file: 'apps/web/lib/app/modules/settlements/presentation/page/p.dart',
    code: `trailing: CurrentInterface.can('ALTERAR') ? x : null`, pairs: ['settlements|ALTERAR'], shared: 0, unresolved: 0 },
  { file: 'apps/web/lib/app/modules/order_returns/presentation/page/p.dart',
    code: `if (CurrentInterface\n    .can(\n  "faturar"))`, pairs: ['order-returns|FATURAR'], shared: 0, unresolved: 0 },
  // espaço antes do parêntese, vírgula final do dart format e texto raw valem
  { file: 'apps/web/lib/app/modules/orders/p.dart', code: `CurrentInterface.can ('CANCELAR')`, pairs: ['orders|CANCELAR'], shared: 0, unresolved: 0 },
  { file: 'apps/web/lib/app/modules/orders/p.dart', code: `CurrentInterface.can(\n  'CANCELAR',\n)`, pairs: ['orders|CANCELAR'], shared: 0, unresolved: 0 },
  { file: 'apps/web/lib/app/modules/orders/p.dart', code: `CurrentInterface.can(r'FATURAR')`, pairs: ['orders|FATURAR'], shared: 0, unresolved: 0 },
  { file: 'apps/web/lib/app/shared/register/register_form_page.dart',
    code: `final canSave = CurrentInterface.can('INSERIR');`, pairs: [], shared: 1, unresolved: 0 },
  { file: 'apps/web/lib/app/modules/orders/p.dart', code: `item.can('FATURAR')`, pairs: [], shared: 0, unresolved: 1 },
  { file: 'apps/web/lib/app/modules/orders/p.dart', code: `CurrentInterface.can(priv)`, pairs: [], shared: 0, unresolved: 1 },
  // constante de texto conhecida (`PrivilegeNames`, onda D-PV2) vale; desconhecida reprova
  { file: 'apps/web/lib/app/modules/orders/p.dart', code: `CurrentInterface.can(PrivilegeNames.cancel)`, pairs: ['orders|CANCELAR'], shared: 0, unresolved: 0 },
  { file: 'apps/web/lib/app/modules/orders/p.dart', code: `CurrentInterface.can(PrivilegeNames.nada)`, pairs: [], shared: 0, unresolved: 1 },
  { file: 'apps/web/lib/app/modules/orders/p.dart', code: `CurrentInterface.can('insert')`, pairs: [], shared: 0, unresolved: 1 },
  // os verbos da D-PV25/D-PV40 (o vocabulário inteiro do catálogo vale)
  { file: 'apps/web/lib/app/modules/orders/p.dart', code: `if (CurrentInterface.can('CONSULTAR') && CurrentInterface.can('CONFIGURAR')) x();`,
    pairs: ['orders|CONSULTAR', 'orders|CONFIGURAR'], shared: 0, unresolved: 0 },
  { file: 'apps/web/lib/app/modules/sem_rota/p.dart', code: `CurrentInterface.can('ALTERAR')`, pairs: [], shared: 0, unresolved: 1 },
  { file: 'apps/web/lib/app/modules/orders/p.dart',
    code: `final pode = CurrentInterface.value?.privileges.contains('FATURAR') ?? true;`, pairs: [], shared: 0, unresolved: 1 },
  // tear-off (gate adversarial): a função passada como valor consome privilégio sem nome legível — reprova
  { file: 'apps/web/lib/app/modules/orders/p.dart', code: `const ['IMPRIMIR'].every(CurrentInterface.can)`, pairs: [], shared: 0, unresolved: 1 },
  { file: 'apps/web/lib/app/modules/orders/p.dart', code: `final f = CurrentInterface.can; f('CANCELAR');`, pairs: [], shared: 0, unresolved: 1 },
  // `/*` dentro de texto não abre comentário; comentário de bloco ANINHADO esconde o can de dentro
  { file: 'apps/web/lib/app/modules/orders/p.dart',
    code: `final a = 'image/*';\nif (CurrentInterface.can('IMPRIMIR')) x();\n/* fim */`, pairs: ['orders|IMPRIMIR'], shared: 0, unresolved: 0 },
  { file: 'apps/web/lib/app/modules/orders/p.dart',
    code: `/* a /* b */ CurrentInterface.can('EXCLUIR') */`, pairs: [], shared: 0, unresolved: 0 },
  { file: 'apps/web/lib/app/modules/orders/p.dart',
    code: `final s = 'x \${y ? 'a' : 'b'} /* nada';\nCurrentInterface.can('FATURAR');`, pairs: ['orders|FATURAR'], shared: 0, unresolved: 0 },
  // texto que CITA o can não é consumo; interpolação continua código
  { file: 'apps/web/lib/app/modules/orders/p.dart', code: `final dica = 'use CurrentInterface.can para checar';`, pairs: [], shared: 0, unresolved: 0 },
  { file: 'apps/web/lib/app/modules/orders/p.dart',
    code: `final t = 'pode: \${CurrentInterface.can('FATURAR') ? 'sim' : 'não'}';`, pairs: ['orders|FATURAR'], shared: 0, unresolved: 0 },
  { file: 'apps/web/lib/app/modules/orders/p.dart',
    code: `/// CurrentInterface.can('FATURAR') no comentário\nfinal s = 'url//x'; // CurrentInterface.can('CANCELAR')`, pairs: [], shared: 0, unresolved: 0 },
]
export const DART_PROBE_MODULES = new Map([['settlements', 'settlements'], ['order_returns', 'order-returns'], ['orders', 'orders']])
export const DART_PROBE_CONSTANTS = dartStringConstants([{ file: 'apps/web/lib/app/shared/session/privilege_names.dart',
  code: `class PrivilegeNames {\n  PrivilegeNames._();\n  static const String cancel = 'CANCELAR';\n  static const insert = 'INSERIR'; // INSERIR\n}` }])
