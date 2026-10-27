import { Request, Response, NextFunction, RequestHandler, Router } from 'express'
import { privilegeVerdict, denyPrivilege } from '@shared/auth/require-privilege'
import { delegatedSuperVerdict, isDelegableSuperInterface } from '@shared/auth/super-delegation'
import logger from '@shared/logger/logger'
import {
  PRIVILEGE_INSERIR, PRIVILEGE_ALTERAR, PRIVILEGE_EXCLUIR, PRIVILEGE_VISUALIZAR,
} from '@shared/auth/privileges'

/**
 * Guarda de privilégio POR ROTEADOR do módulo (D-PV2, Valdo 2026-10-18 — `Infra-IA/prompts/prompt_privilegios_interfaces.md`).
 *
 * Regra Q-G29 (tabela → tela → código): o privilégio existe no catálogo (`tb_interface_has_privilege` — seed 64), é opção no
 * cadastro do usuário e o CÓDIGO confere. Até aqui só os privilégios de AÇÃO tinham consumidor; o CRUD (e o VISUALIZAR) eram
 * só UX do menu. Esta peça é o ÚNICO ponto da API que confere o CRUD:
 *
 *   GET/HEAD → VISUALIZAR (6) · POST → INSERIR (1) · PUT/PATCH → ALTERAR (2) · DELETE → EXCLUIR (3)
 *
 * na interface do MÓDULO (a URL `/api/<m>` espelha `/home/<m>` e o i18n_key da interface). Os ATOS que não são CRUD (mapa da
 * D-PV7/D-PV8) são declarados NA ROTA com `privilegeAct(...)`; as poucas rotas sem privilégio (leituras de motor que toda
 * tela consome) com `openRoute(...)`. Rota sem marcador vale pelo VERBO — esquecer o marcador nega (privilégio do verbo),
 * nunca libera.
 *
 * A conferência é a MESMA das guardas de ação (`privilegeVerdict`): licença antes do privilégio (D-F37: admin e regular só
 * em interface CONTRATADA; A-PV1: o super passa as duas), admin passa o privilégio, regular precisa do vínculo ativo em
 * `tb_user_has_privilege`.
 *
 * Como a guarda acha o marcador: ela roda no gateway ANTES do roteador do módulo e procura, no `stack` dele, a rota que casa
 * com o verbo + caminho (a mesma `regexp` que o Express usará logo depois — sem efeito colateral: `RegExp.exec` sem flag
 * `g`). Conhecimento negativo: isso depende da forma interna do Router do Express 4 (`stack[].route`, `.regexp`, `.keys`,
 * `route.methods`, `route.stack[].handle`); a prova `module-privilege-gate.test.ts` quebra alto se a forma mudar (Express 5).
 * Sub-roteador DENTRO do módulo (`router.use`) não é percorrido — a cerca `listGatedRoutes` recusa módulo com um.
 */

export const PRIVILEGE_BY_METHOD: Readonly<Record<string, number>> = Object.freeze({
  GET: PRIVILEGE_VISUALIZAR,
  HEAD: PRIVILEGE_VISUALIZAR,
  POST: PRIVILEGE_INSERIR,
  PUT: PRIVILEGE_ALTERAR,
  PATCH: PRIVILEGE_ALTERAR,
  DELETE: PRIVILEGE_EXCLUIR,
})

/** Interface(s) resolvidas pelos parâmetros da rota (ex.: o painel de configs aberto pela "Configurações Gerais"). */
export interface DynamicInterfaces {
  /** Todas as interfaces que `resolve` pode devolver — a tabela/cerca confere cada uma contra o catálogo. */
  readonly possible: readonly string[]
  readonly resolve: (params: Record<string, string>) => Promise<readonly string[]>
}

/** Interface(s) de um ato que não é a do módulo: fixa(s) ou dinâmica(s). */
export type ActInterfaces = string | readonly string[] | DynamicInterfaces

function isDynamic(i: ActInterfaces | undefined): i is DynamicInterfaces {
  return typeof i === 'object' && i !== null && !Array.isArray(i) && 'resolve' in i
}

export interface PrivilegeActSpec {
  /** null = rota aberta a qualquer autenticado do módulo (`openRoute`). */
  readonly privilegeId: number | null
  readonly interfaces?: ActInterfaces
  /** Por que a rota é aberta (só `openRoute`) — aparece na tabela e na cerca. */
  readonly reason?: string
}

const ACT = Symbol.for('setes.privilegeAct')
type MarkedHandler = RequestHandler & { [ACT]?: PrivilegeActSpec }

function marker(spec: PrivilegeActSpec): RequestHandler {
  const handler: MarkedHandler = (_req: Request, _res: Response, next: NextFunction) => next()
  handler[ACT] = Object.freeze({ ...spec })
  return handler
}

/**
 * Ato de processo com privilégio próprio (D-PV7/D-PV8): ex. `router.post('/reversal', privilegeAct(PRIVILEGE_EXCLUIR), …)`.
 * `interfaces` troca a interface conferida (ex.: a aba Parceria — interface kind 'R' `partnerships`, A-PV2).
 * O marcador NÃO confere nada sozinho: quem confere é a guarda do roteador (um só ponto, uma consulta).
 */
export function privilegeAct(privilegeId: number, interfaces?: ActInterfaces): RequestHandler {
  return marker({ privilegeId, interfaces })
}

/** Rota sem privilégio (exceção NOMEADA da D-PV2): só leituras de motor que toda tela consome. */
export function openRoute(reason: string): RequestHandler {
  return marker({ privilegeId: null, reason })
}

// ---------------------------------------------------------------------------------------------------------------------
// Casamento da rota no roteador do módulo (forma interna do Express 4 — ver o aviso no topo)
// ---------------------------------------------------------------------------------------------------------------------

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: MarkedHandler; method?: string }> }
  regexp: RegExp
  keys: Array<{ name: string | number }>
  name?: string
}

function stackOf(subRouter: Router): ExpressLayer[] {
  return ((subRouter as unknown as { stack?: ExpressLayer[] }).stack) ?? []
}

function handlesMethod(methods: Record<string, boolean>, method: string): boolean {
  if (methods._all) return true
  const name = method.toLowerCase()
  if (name === 'head' && !methods.head) return Boolean(methods.get)
  return Boolean(methods[name])
}

/** Verbo efetivo da rota: HEAD sem handler próprio cai no GET (mesma regra do Express). */
function routeVerb(methods: Record<string, boolean>, method: string): string {
  const name = method.toLowerCase()
  return name === 'head' && !methods.head ? 'get' : name
}

/**
 * Marcador da rota PARA O VERBO: cada handler do `route.stack` guarda o seu `method` (undefined = `route.all`). Em
 * `router.route('/x').get(privilegeAct(A), h).post(h2)` o POST NÃO herda o marcador do GET (gate socrático da D-PV2).
 */
function actOf(layer: ExpressLayer, method: string): PrivilegeActSpec | undefined {
  const verb = routeVerb(layer.route?.methods ?? {}, method)
  for (const s of layer.route?.stack ?? []) {
    if (s.method !== undefined && s.method !== verb) continue
    if (s.handle?.[ACT]) return s.handle[ACT]
  }
  return undefined
}

function decode(v: string): string {
  try { return decodeURIComponent(v) } catch { return v }
}

interface MatchedRoute { layer: ExpressLayer; params: Record<string, string> }

/** A 1ª rota do módulo que casa com verbo + caminho — a mesma que o Express vai despachar. */
export function matchModuleRoute(subRouter: Router, method: string, path: string): MatchedRoute | null {
  for (const layer of stackOf(subRouter)) {
    if (!layer.route || !handlesMethod(layer.route.methods, method)) continue
    const m = layer.regexp.exec(path)
    if (!m) continue
    const params: Record<string, string> = {}
    layer.keys.forEach((k, i) => { if (m[i + 1] !== undefined) params[String(k.name)] = decode(m[i + 1]) })
    return { layer, params }
  }
  return null
}

async function interfacesOf(spec: PrivilegeActSpec | undefined, moduleKey: string, params: Record<string, string>)
  : Promise<readonly string[]> {
  const i = spec?.interfaces
  if (i === undefined) return [moduleKey]
  if (typeof i === 'string') return [i]
  if (isDynamic(i)) return i.resolve(params)
  return i as readonly string[]
}

// ---------------------------------------------------------------------------------------------------------------------
// A guarda + o registro (a tabela dos pares que o código consome — insumo da cerca D-PV9)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `delegatedSuper` (D-PV11): tela do grupo Super DELEGÁVEL a usuário da Setes — o veredito é o da delegação (super passa; usuário da
 * Setes, admin inclusive, só com o privilégio marcado pelo Super; outra institution: a tela não existe), sem licença. Só vale para as
 * chaves da lista `DELEGABLE_SUPER_INTERFACES` (a montagem lança com outra chave — D-PV11 (d)).
 */
export interface GateOptions { delegatedSuper?: boolean }

interface GateEntry { moduleKey: string; subRouter: Router; delegatedSuper: boolean }
const gates: GateEntry[] = []

/**
 * Guarda do roteador de UM módulo: `router.use('/customers', ...gatedModule('customers', customersRoutes))`.
 * `moduleKey` = i18n_key da interface no catálogo central = segmento da URL.
 */
export function modulePrivilegeGate(moduleKey: string, subRouter: Router, opts: GateOptions = {}): RequestHandler {
  const delegatedSuper = opts.delegatedSuper === true
  if (delegatedSuper && !isDelegableSuperInterface(moduleKey)) {
    throw new Error(`Módulo ${moduleKey} montado como delegável do Super sem estar em DELEGABLE_SUPER_INTERFACES (D-PV11 (d))`)
  }
  if (!gates.some(g => g.moduleKey === moduleKey)) gates.push({ moduleKey, subRouter, delegatedSuper })
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const inst = req.institution
    if (!inst) {
      res.status(401).json({ error: 'Não autenticado', code: 'UNAUTHORIZED', fields: [] })
      return
    }
    try {
      const matched = matchModuleRoute(subRouter, req.method, req.path)
      const spec = matched ? actOf(matched.layer, req.method) : undefined
      if (spec && spec.privilegeId === null) { next(); return }                // openRoute: exceção nomeada
      const privilegeId = spec?.privilegeId ?? PRIVILEGE_BY_METHOD[req.method.toUpperCase()]
      if (privilegeId === undefined) {                                          // verbo sem privilégio no mapa: nega
        denyPrivilege(res, 'no-privilege', [moduleKey])
        return
      }
      const keys = await interfacesOf(spec, moduleKey, matched?.params ?? {})
      const verdict = delegatedSuper
        ? await delegatedSuperVerdict(inst, keys, privilegeId)
        : await privilegeVerdict(inst, keys, privilegeId)
      if (verdict !== 'ok') {
        // rastro da negação (gate socrático da D-PV2 — a "conferência depois" da janela precisa saber QUEM foi barrado e por QUÊ)
        logger.warn('Privilégio negado pela guarda do roteador', {
          institutionId: inst.institutionId, userId: inst.userId, role: inst.role,
          interfaces: keys, privilegeId, verdict, method: req.method, route: matched?.layer.route?.path ?? null,
        })
        denyPrivilege(res, verdict, keys)
        return
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

/** Atalho do gateway: `[guarda, roteador]` para `router.use('/<m>', ...gatedModule('<m>', routes))`. */
export function gatedModule(moduleKey: string, subRouter: Router, opts: GateOptions = {}): [RequestHandler, Router] {
  return [modulePrivilegeGate(moduleKey, subRouter, opts), subRouter]
}

export interface GatedRoute {
  moduleKey: string
  method: string
  path: string
  /** null = rota aberta (`openRoute`). */
  privilegeId: number | null
  /** Interfaces que a rota pode conferir (dinâmica = todas as possíveis). */
  interfaces: readonly string[]
  dynamic: boolean
  /** Tela do Super delegável (D-PV11): veredito da delegação, sem licença. */
  delegatedSuper: boolean
  reason?: string
}

/**
 * Tabela de TODAS as rotas guardadas (módulo × verbo × caminho → privilégio) — montada da mesma fonte que a guarda usa.
 * Lança se um módulo guardado tiver sub-roteador próprio (a guarda não o enxergaria).
 */
export function listGatedRoutes(): GatedRoute[] {
  const out: GatedRoute[] = []
  for (const { moduleKey, subRouter, delegatedSuper } of gates) {
    for (const layer of stackOf(subRouter)) {
      if (!layer.route) {
        if (layer.name === 'router') throw new Error(`Módulo guardado ${moduleKey} tem sub-roteador — a guarda não o enxerga`)
        continue
      }
      for (const [m, on] of Object.entries(layer.route.methods)) {
        if (!on || m === '_all') continue
        const method = m.toUpperCase()
        const spec = actOf(layer, method)
        const i = spec?.interfaces
        out.push({
          moduleKey, method, path: layer.route.path,
          privilegeId: spec ? spec.privilegeId : (PRIVILEGE_BY_METHOD[method] ?? null),
          interfaces: isDynamic(i) ? i.possible : i === undefined ? [moduleKey] : typeof i === 'string' ? [i] : i as readonly string[],
          dynamic: isDynamic(i),
          delegatedSuper,
          reason: spec?.reason,
        })
      }
    }
  }
  return out
}

/** Módulos guardados (na ordem do gateway). */
export function listGatedModules(): string[] {
  return gates.map(g => g.moduleKey)
}

/**
 * D-PV36 (Valdo 2026-10-20): o módulo passa pela guarda por roteador? Para ele a flag técnica (`tb_feature_flag`) MORREU — o
 * vínculo `tb_institution_has_interface` é a ÚNICA licença (D-F37/D-PV2); o `featureFlagMiddleware` não o consulta e o
 * onboarding não cria flag para ele. Lê o MESMO registro das guardas (montado quando o gateway é importado).
 */
export function isGatedModule(moduleKey: string): boolean {
  return gates.some(g => g.moduleKey === moduleKey)
}
