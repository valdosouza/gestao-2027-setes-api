import {
  PRIVILEGE_INSERIR, PRIVILEGE_ALTERAR, PRIVILEGE_EXCLUIR, PRIVILEGE_IMPRIMIR, PRIVILEGE_FATURAR,
  PRIVILEGE_VISUALIZAR, PRIVILEGE_CANCELAR, PRIVILEGE_DESCONTO, PRIVILEGE_TRANSMITIR,
  PRIVILEGE_CATALOGAR, PRIVILEGE_CONFIGURAR, PRIVILEGE_CONSULTAR,
} from '@shared/auth/privileges'
import { listGatedRoutes, GatedRoute } from '@shared/auth/module-privilege-gate'
import { APP_INTERFACE_ROUTE_KEYS } from '@shared/auth/app-interface-routes'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'

/**
 * O que o CÓDIGO opera de cada interface — D-PV9 (= Q-PV9 (a), Valdo 2026-10-18) fundida com a guarda por roteador (D-PV2) pela
 * D-PV14, com a IGUALDADE da D-PV51 (Valdo 2026-10-27) — `Infra-IA/prompts/prompt_privilegios_interfaces.md`. Por quê: os botões e o
 * veredito vêm do REGISTRO (`setes_central.tb_interface_has_privilege` — a view `vw_user_access`, costura A1): par operado que falta no
 * registro esconde o botão e nega a ação até do admin (o C1: o "trocar a cobrança" da Baixa ficou invisível de 2026-09-13 a 2026-10-18
 * sem nenhum gate perceber); par registrado que nenhum código opera é promessa falsa na tela de permissões (D-PV51).
 *
 * O conjunto OPERADO (`consumedPrivileges()`) tem duas fontes, uma verdade por par:
 *  - a TABELA DO ROTEADOR (`listGatedRoutes()` — a MESMA que a guarda usa em produção, D-PV14): verbo HTTP → VISUALIZAR/INSERIR/
 *    ALTERAR/EXCLUIR, `privilegeAct` nas rotas de ato; interface dinâmica = todas as possíveis; `openRoute` fica fora;
 *  - a LISTA À MÃO (`CONSUMED_PRIVILEGES`): o que não se deriva — o RAMO do billing (`requirePrivilegeFor`), as políticas de controller
 *    (desconto, reaplicar), as guardas da nfse-api (o verbo pelo NOME — D-PV53) e os botões do setes-app (`CurrentInterface.can`). A
 *    cerca confere os consumidores EXATOS de cada entrada; a guarda por roteador NÃO entra aqui (ela se lê sozinha).
 * O conjunto REGISTRADO tem de ser IGUAL, por interface (D-PV51), a: operados (menos os "ausentes por decisão") ∪ REGRA do menu
 * (VISUALIZAR em toda tela) ∪ REGRA do CONFIGURAR (toda interface com config ou campo no catálogo + `general-configs` — D-PV25) ∪
 * RESERVADOS (`RESERVED_PRIVILEGES`, com motivo). Quem confere:
 *  - a CERCA (`src/__tests__/privilege-catalog-fence.test.ts`, predicado em `src/test-setup/privilege-fence.ts`): código ↔ lista;
 *  - o TESTE AO VIVO (`privilege-catalog-live.test.ts`, D-PV41) e o roteiro de publicação (D-PV16): lista ↔ registro, nos dois sentidos;
 *  - o BOOT (`assert-privilege-catalog.ts`): a mesma igualdade, só ALARMA — nunca recusa subir (D-PV52);
 *  - as telas do Super Interfaces/Privilégios (D-PV15/D-PV42): recusam o que quebraria um par operado ou uma chave usada.
 *
 * Tela nova: o seed dos pares vai ao banco ANTES do app (skill `setes-api/skills/novo-modulo.md`, "Interface e privilégios").
 */

/** Nome do privilégio = `tb_privilege.description` — o app compara POR ESTE NOME e a view também (D-PV53). */
export type PrivilegeName =
  | 'INSERIR' | 'ALTERAR' | 'EXCLUIR' | 'IMPRIMIR' | 'FATURAR' | 'VISUALIZAR' | 'CANCELAR' | 'DESCONTO' | 'TRANSMITIR'
  | 'CATALOGAR' | 'CONFIGURAR' | 'CONSULTAR'

/** Nome → id do catálogo (`@shared/auth/privileges`; ids estáveis desde o gestão desktop + seeds 51/55/59/66/68). */
export const PRIVILEGE_ID: Readonly<Record<PrivilegeName, number>> = Object.freeze({
  INSERIR:    PRIVILEGE_INSERIR,
  ALTERAR:    PRIVILEGE_ALTERAR,
  EXCLUIR:    PRIVILEGE_EXCLUIR,
  IMPRIMIR:   PRIVILEGE_IMPRIMIR,
  FATURAR:    PRIVILEGE_FATURAR,
  VISUALIZAR: PRIVILEGE_VISUALIZAR,
  CANCELAR:   PRIVILEGE_CANCELAR,
  DESCONTO:   PRIVILEGE_DESCONTO,
  TRANSMITIR: PRIVILEGE_TRANSMITIR,
  CATALOGAR:  PRIVILEGE_CATALOGAR,
  CONFIGURAR: PRIVILEGE_CONFIGURAR,
  CONSULTAR:  PRIVILEGE_CONSULTAR,
})

const NAME_BY_ID: ReadonlyMap<number, PrivilegeName> =
  new Map(Object.entries(PRIVILEGE_ID).map(([n, id]) => [id, n as PrivilegeName]))

/** O nome de um id do catálogo — `null` fora do vocabulário. */
export const privilegeNameById = (id: number): PrivilegeName | null => NAME_BY_ID.get(Number(id)) ?? null

/**
 * Interfaces que o RAMO de um pedido pode resolver — a view `vw_order_interface` (D-F32): o resolver do billing
 * (`billing.interface-resolver.ts`, tipo `OrderInterfaceKey`) e o `erp.orderInterface` das guardas da nfse-api. Guarda "pelo
 * ramo" consome o privilégio nas TRÊS (a cerca confere o tipo contra esta lista).
 */
export const ORDER_BRANCH_INTERFACES = ['orders', 'service-orders', 'order-returns'] as const

/**
 * REGRA do menu: o menu (`core.service.getMenus`, costura A1) só mostra a tela com VISUALIZAR na `vw_user_access` — vale para TODA tela
 * (kind 'T'), inclusive as do grupo Super: o menu do super é o catálogo central inteiro filtrado pelo mesmo VISUALIZAR. Sem o par a tela
 * some do menu de todos (o C2 do prompt; para o grupo Super, some até do super). Conferida pela regra, não par a par.
 */
export const MENU_PRIVILEGE: PrivilegeName = 'VISUALIZAR'

/**
 * REGRA do CONFIGURAR (D-PV25/D-PV26): gravar o valor da institution de uma config, ou o required/caption/mask de um campo, da tela X
 * exige CONFIGURAR em X (`@shared/auth/configure-privilege`, dinâmica pela interface ALVO) — o par existe para TODA interface com config
 * ou campo no catálogo (`tb_interface_has_config`/`tb_interface_has_field` vivos) e para estas, que o têm SEMPRE (a "Configurações
 * Gerais" é a dona das configs sem tela). O mesmo critério do seed 68.
 */
export const CONFIGURE_PRIVILEGE: PrivilegeName = 'CONFIGURAR'
export const CONFIGURE_RULE_KEYS: readonly string[] = Object.freeze(['general-configs'])

/**
 * Quem consome: guarda/política do setes-api ('api'), guarda da API da NFS-e ('nfse' — ela lê o veredito pela view do schema do
 * cliente, D-F13/D-AU6), botão do setes-app ('app'). A cerca confere o conjunto EXATO. O rótulo é só o nome: o setes-api é PASSIVO e
 * nunca fala com a API fiscal (D-F4 — a cerca da F2a reprova URL/nome dela em literal do src/).
 */
export type PrivilegeConsumer = 'api' | 'nfse' | 'app'

export interface ConsumedPrivilege {
  /** `tb_interface.i18n_key`. */
  interface: string
  privilege: PrivilegeName
  consumers: readonly PrivilegeConsumer[]
  /** Onde (documentação para quem lê; a cerca confere o par e os consumidores, não este texto). */
  where: string
  /**
   * Consumido só porque a guarda resolve a interface pelo RAMO, mas AUSENTE do catálogo por decisão (o motivo). O boot não
   * grita por ele; se o par aparecer no catálogo, o boot avisa para tirar a marca.
   */
  absentBy?: string
}

/**
 * Par REGISTRADO que nenhum código opera hoje e que uma DECISÃO manda manter (D-PV51: "salvo marca 'reservado' com motivo") — a mesma
 * forma da marca `absentBy`, ao contrário: este TEM de estar no catálogo. A cerca reprova reservado que o código passou a operar
 * (tirar a marca) e o boot grita reservado que saiu do catálogo.
 */
export interface ReservedPrivilege {
  interface: string
  privilege: PrivilegeName
  reason: string
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A LISTA À MÃO (o que não se deriva do roteador)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const BRANCH_WHERE = 'guarda pelo RAMO do pedido (vw_order_interface)'
const FACTORY = 'app: fábrica de cadastros (CrudPrivileges — "Novo"/salvar o novo = INSERIR, salvar a edição = ALTERAR, excluir = EXCLUIR)'
const GEAR = 'app: engrenagem da tela (RegisterConfigButton — só aparece com configs no catálogo; D-PV25)'

/** Cadastros da FÁBRICA (lista + ficha `RegisterFormPage`/`RegisterFormShell` + engrenagem): os pares do app vêm do grafo de import. */
const FACTORY_SCREENS: readonly string[] = [
  'bank-accounts', 'bank-charge-agreements', 'banks', 'carriers', 'categories', 'cfop', 'cities', 'collaborators', 'contracts',
  'countries', 'customers', 'financial-plans', 'interfaces', 'modules', 'payment-types', 'price-lists', 'privileges', 'providers',
  'salesmen', 'service-list', 'service-tax-rules', 'services', 'settlement-rules', 'states', 'tax-rules',
]

const app = (k: string, privilege: PrivilegeName, where: string): ConsumedPrivilege =>
  ({ interface: k, privilege, consumers: ['app'], where })

const factoryPairs = (k: string): ConsumedPrivilege[] => [
  app(k, 'INSERIR', k === 'categories' || k === 'financial-plans' ? `${FACTORY} · "Novo"/"adicionar filho" da árvore` : FACTORY),
  app(k, 'ALTERAR', FACTORY),
  app(k, 'EXCLUIR', FACTORY),
  app(k, 'CONFIGURAR', GEAR),
]

export const CONSUMED_PRIVILEGES: readonly ConsumedPrivilege[] = Object.freeze([
  // ── Pedido de venda (orders) ────────────────────────────────────────────────────────────────────────────────────────────
  { interface: 'orders', privilege: 'FATURAR', consumers: ['api', 'app'],
    where: `POST /api/billing/validate, /invoice (${BRANCH_WHERE}) · botão "Validar e Faturar" (order_page)` },
  { interface: 'orders', privilege: 'CANCELAR', consumers: ['api', 'nfse', 'app'],
    where: `POST /api/billing/cancel, /cancel-waiver, GET /:orderId/cancel-plan · API da NFS-e: reconferir/cancelar (${BRANCH_WHERE}) · ` +
      'botão "Cancelar nota" (order_page)' },
  { interface: 'orders', privilege: 'TRANSMITIR', consumers: ['nfse'],
    where: `API da NFS-e: transmitir a nota (${BRANCH_WHERE})` },
  { interface: 'orders', privilege: 'CONSULTAR', consumers: ['nfse'],
    where: `API da NFS-e: atualizar a nota no fisco e a passada do rodízio (${BRANCH_WHERE} — D-PV40)` },
  app('orders', 'INSERIR', 'app: "Novo pedido" (order_page)'),
  app('orders', 'ALTERAR', 'app: itens, edição e negociação do pedido (order_page, order_negotiation_section — D-PV21)'),
  app('orders', 'EXCLUIR', 'app: excluir o pedido aberto (order_page)'),
  app('orders', 'CONFIGURAR', GEAR),

  // ── Ordem de serviço (service-orders) ───────────────────────────────────────────────────────────────────────────────────
  { interface: 'service-orders', privilege: 'FATURAR', consumers: ['api', 'app'],
    where: `POST /api/billing/validate, /invoice (${BRANCH_WHERE}) · botões Faturar / Faturar em lote / rotina mensal (service_order_page)` },
  { interface: 'service-orders', privilege: 'CANCELAR', consumers: ['api', 'nfse', 'app'],
    where: `POST /api/billing/cancel… · API da NFS-e: reconferir/cancelar (${BRANCH_WHERE}) · "Cancelar nota" (service_order_page, ` +
      'service_order_fiscal_section)' },
  { interface: 'service-orders', privilege: 'TRANSMITIR', consumers: ['nfse', 'app'],
    where: `API da NFS-e: transmitir (${BRANCH_WHERE}) · "Transmitir" no fisco (service_order_page, service_order_fiscal_section)` },
  { interface: 'service-orders', privilege: 'CONSULTAR', consumers: ['nfse', 'app'],
    where: `API da NFS-e: atualizar a nota e a passada do rodízio (${BRANCH_WHERE} — D-PV40) · "Consultar" no fisco ` +
      '(service_order_fiscal_section)' },
  app('service-orders', 'INSERIR', 'app: "Nova OS" (service_order_page)'),
  app('service-orders', 'ALTERAR', 'app: itens e edição da OS (service_order_page — D-PV21)'),
  app('service-orders', 'EXCLUIR', 'app: excluir a OS aberta (service_order_page)'),
  app('service-orders', 'CONFIGURAR', GEAR),

  // ── Devolução (order-returns) ───────────────────────────────────────────────────────────────────────────────────────────
  { interface: 'order-returns', privilege: 'FATURAR', consumers: ['api', 'app'],
    where: `POST /api/billing/validate, /invoice (${BRANCH_WHERE}) · botão Faturar (order_return_page)` },
  { interface: 'order-returns', privilege: 'CANCELAR', consumers: ['api', 'nfse'],
    where: `POST /api/billing/cancel… · API da NFS-e: reconferir/cancelar (${BRANCH_WHERE})`,
    absentBy: 'cancelar a devolução faturada é a Onda 2 do cancelamento (ramo adjust — billing.interface-resolver.ts); hoje o ' +
      'plano bloqueia e a tela não tem o botão (§3 do prompt_privilegios_interfaces.md: "cancelar = Onda 2"; A-PV12)' },
  { interface: 'order-returns', privilege: 'TRANSMITIR', consumers: ['nfse'],
    where: `API da NFS-e: transmitir (${BRANCH_WHERE})`,
    absentBy: 'a devolução é NF-e de mercadoria (API da NF-e, sem código — D-F20): a tela não transmite e a API da NFS-e não emite ' +
      'por ela (A-PV12)' },
  { interface: 'order-returns', privilege: 'CONSULTAR', consumers: ['nfse'],
    where: `API da NFS-e: atualizar a nota e a passada do rodízio (${BRANCH_WHERE})`,
    absentBy: 'pelo mesmo motivo do TRANSMITIR: a devolução é NF-e e a API da NFS-e não emite por ela — A-PV12 ratificada com o ' +
      'CONSULTAR (Valdo 2026-10-20, D-PV40)' },
  app('order-returns', 'ALTERAR', 'app: itens e edição da devolução (order_return_page — D-PV21)'),
  app('order-returns', 'EXCLUIR', 'app: excluir a devolução aberta (order_return_page)'),
  app('order-returns', 'CONFIGURAR', GEAR),

  // ── Baixas (settlements) ────────────────────────────────────────────────────────────────────────────────────────────────
  app('settlements', 'ALTERAR', 'app: ícone ⇄ "trocar a cobrança" da linha (settlement_page) — o C1'),
  app('settlements', 'INSERIR', 'app: baixar os títulos selecionados (settlement_page)'),
  app('settlements', 'EXCLUIR', 'app: estornar a baixa (settlement_page)'),
  { interface: 'settlements', privilege: 'DESCONTO', consumers: ['api', 'app'],
    where: 'política assertDiscountPolicy na baixa (D-G32) · campo de desconto (settlement_page)' },
  app('settlements', 'CONFIGURAR', GEAR),

  // ── Carteira de cobrança (bank-charge-agreements) — além da fábrica ─────────────────────────────────────────────────────
  { interface: 'bank-charge-agreements', privilege: 'DESCONTO', consumers: ['api'],
    where: 'política assertDiscountAliquot no POST/PUT da carteira (D-G36)' },

  // ── Boletos (bank-slips) ────────────────────────────────────────────────────────────────────────────────────────────────
  { interface: 'bank-slips', privilege: 'ALTERAR', consumers: ['api', 'app'],
    where: 'política do reaplicar a voz R = liquidação (bank-slips.reapply-policy — D-PV27) · "Liquidar"/"Reaplicar" (bank_slip_detail_view)' },
  { interface: 'bank-slips', privilege: 'CANCELAR', consumers: ['api', 'app'],
    where: 'política do reaplicar a voz C/V = cancelamento (D-PV27) · "Cancelar"/"Estornar"/"Reaplicar" (bank_slip_detail_view)' },
  app('bank-slips', 'INSERIR', 'app: "Emitir boleto" (bank_slip_page)'),
  app('bank-slips', 'TRANSMITIR', 'app: "Registrar no banco" (bank_slip_detail_view — D-PV40)'),
  app('bank-slips', 'CONSULTAR', 'app: consulta ao abrir, "Atualizar com o banco" e "Consultar" (bank_slip_page, bank_slip_detail_view — D-PV40)'),
  app('bank-slips', 'IMPRIMIR', 'app: PDF do boleto (bank_slip_detail_view)'),
  app('bank-slips', 'CONFIGURAR', GEAR),

  // ── Cheques, Caixa, Estabelecimento ─────────────────────────────────────────────────────────────────────────────────────
  app('checks', 'ALTERAR', 'app: depositar/descontar/retornar/pagar/devolver (check_detail_view)'),
  app('checks', 'CANCELAR', 'app: estornar o cheque (check_detail_view)'),
  app('checks', 'CONFIGURAR', GEAR),
  app('cashier', 'INSERIR', 'app: abrir o caixa (cashier_page)'),
  app('cashier', 'ALTERAR', 'app: sangria/transferência e fechar o caixa (cashier_page)'),
  app('establishment', 'CONFIGURAR', GEAR),

  // ── Telas do Super com consumo próprio ──────────────────────────────────────────────────────────────────────────────────
  app('institution-interfaces', 'ALTERAR', 'app: marcar/desmarcar a interface do cliente (institution_interfaces_page — D-PV11/D-PV34)'),
  app('institution-interfaces', 'CONFIGURAR', GEAR),
  app('institutions', 'INSERIR', 'app: "Novo" da lista de estabelecimentos (fábrica — RegisterSearchPage)'),
  app('institutions', 'CONFIGURAR', GEAR),
  app('users', 'INSERIR', FACTORY),
  app('users', 'ALTERAR', FACTORY),
  app('users', 'CONFIGURAR', GEAR),

  // ── Cadastros da fábrica ────────────────────────────────────────────────────────────────────────────────────────────────
  ...FACTORY_SCREENS.flatMap(factoryPairs),
] as ConsumedPrivilege[])

/**
 * RESERVADOS (D-PV51): registrados por DECISÃO sem código que os opere hoje — o motivo diz qual. Marca nova só com decisão citada;
 * nunca para o teste passar.
 */
export const RESERVED_PRIVILEGES: readonly ReservedPrivilege[] = Object.freeze([
  { interface: 'institutions', privilege: 'ALTERAR',
    reason: 'D-PV3/A-PV3 (Valdo 2026-10-18): as telas do Super têm o CRUD no catálogo — servem aos botões do super e ao dia em que a ' +
      'tela for vendida/delegada; em institutions, emitir a chave do sync = ALTERAR. A ficha do Estabelecimento não pergunta o verbo ' +
      '(superGuard) — a fábrica só dá o "Novo" da lista' },
  { interface: 'institutions', privilege: 'EXCLUIR',
    reason: 'D-PV3/A-PV3 (Valdo 2026-10-18): o CRUD das telas do Super fica no catálogo para os botões do super e a futura ' +
      'delegação — a ficha do Estabelecimento não pergunta o verbo (superGuard)' },
] as ReservedPrivilege[])

/** `interface|id` — a chave dos conjuntos da cerca, do boot e da guarda. */
export const pairKey = (interfaceKey: string, privilegeId: number): string => `${interfaceKey}|${privilegeId}`

/**
 * A chave como o BANCO a compara (`utf8mb4_general_ci` + PAD SPACE): sem caixa, sem acento e sem espaço no fim — é assim que a
 * guarda acha (`'settlements' = 'séttlements'` no banco).
 */
export const canonicalKey = (k: string): string => String(k).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ +$/, '')

/**
 * D-PV42 (Valdo 2026-10-20): a `i18n_key` é identificador TÉCNICO, em inglês, no formato da rota do app (`/home/<chave>/`):
 * `^[a-z][a-z0-9-]*$` — aqui sem hífen repetido nem no fim (a forma que o DTO já exigia desde a D-PV15).
 */
export const INTERFACE_KEY_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/** A marca `absentBy` não vale para par que um BOTÃO consome: botão sem o par no catálogo é o próprio C1 (some até do admin). */
export const absentMarkHolds = (c: ConsumedPrivilege): boolean => !!c.absentBy && !c.consumers.includes('app')

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// D-PV14 — o adaptador da guarda por roteador + a fusão
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const MAX_ROUTES_IN_WHERE = 4

/**
 * Os pares da guarda POR ROTEADOR (D-PV2), lidos da MESMA tabela que ela usa (`listGatedRoutes()` — D-PV14): cada rota com privilégio
 * dá (interface, verbo) para cada interface que ela pode conferir (dinâmica = todas as possíveis); `openRoute` (privilégio null) fica
 * fora. Consumidor 'api'. Id fora do vocabulário não vira par (a cerca reprova a rota).
 */
export function routerConsumedPrivileges(routes: readonly GatedRoute[] = listGatedRoutes()): ConsumedPrivilege[] {
  const byPair = new Map<string, { interface: string; privilege: PrivilegeName; routes: string[] }>()
  for (const r of routes) {
    if (r.privilegeId === null) continue
    const privilege = privilegeNameById(r.privilegeId)
    if (!privilege) continue
    const route = `${r.method} /api/${r.moduleKey}${r.path === '/' ? '' : r.path}`
    for (const k of r.interfaces) {
      const key = pairKey(k, PRIVILEGE_ID[privilege])
      if (!byPair.has(key)) byPair.set(key, { interface: k, privilege, routes: [] })
      const entry = byPair.get(key)!
      if (!entry.routes.includes(route)) entry.routes.push(route)
    }
  }
  return [...byPair.values()].map(p => ({
    interface: p.interface, privilege: p.privilege, consumers: ['api'] as const,
    where: `guarda por roteador (D-PV2): ${p.routes.slice(0, MAX_ROUTES_IN_WHERE).join(', ')}` +
      (p.routes.length > MAX_ROUTES_IN_WHERE ? ` (+${p.routes.length - MAX_ROUTES_IN_WHERE})` : ''),
  }))
}

/**
 * O conjunto OPERADO pelo código (D-PV14): a lista à mão ∪ a tabela do roteador, com os consumidores FUNDIDOS por par. Em execução o
 * roteador já está montado (o gateway é importado antes de qualquer requisição e do boot); o script e o teste ao vivo importam o
 * gateway antes de chamar. Lista nova a cada chamada (a tabela é estática depois do boot; nada de cache que envelheça nos testes).
 */
export function consumedPrivileges(routes: readonly GatedRoute[] = listGatedRoutes()): ConsumedPrivilege[] {
  const out = new Map<string, ConsumedPrivilege>()
  for (const c of CONSUMED_PRIVILEGES) out.set(pairKey(canonicalKey(c.interface), PRIVILEGE_ID[c.privilege]), { ...c, consumers: [...c.consumers] })
  for (const r of routerConsumedPrivileges(routes)) {
    const key = pairKey(canonicalKey(r.interface), PRIVILEGE_ID[r.privilege])
    const prev = out.get(key)
    if (!prev) { out.set(key, r); continue }
    out.set(key, {
      ...prev,
      consumers: prev.consumers.includes('api') ? prev.consumers : [...prev.consumers, 'api'],
      where: `${prev.where} · ${r.where}`,
    })
  }
  return [...out.values()]
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Conferência — IGUALDADE por interface (D-PV51). PURA: o boot e o teste ao vivo só buscam as linhas e entregam aqui.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Tela (kind 'T', qualquer grupo): o menu a mostra só com VISUALIZAR — a REGRA do menu (comparado como o banco: sem caixa). */
export const isScreen = (kind: string | null | undefined): boolean => canonicalKey(kind ?? 'T') === 't'

/**
 * Tela do menu do CLIENTE: kind 'T' fora do grupo Super — o MESMO predicado do `core.repository` (`ONLY_SCREEN_KIND` +
 * `NOT_SUPER_GROUP`). Usado pela guarda: tela do cliente que o código usa não vira recurso nem vai ao grupo Super.
 */
export const isMenuScreen = (kind: string | null | undefined, groupDefault: string | null | undefined): boolean =>
  isScreen(kind) && canonicalKey(groupDefault ?? '') !== 'super'

/** Vínculo VIVO e ATIVO do catálogo — o MESMO predicado da view `vw_user_access` (vínculo ativo/vivo + `tb_privilege` viva). */
export interface CatalogPairRow { interfaceKey: string; privilegeId: number }
/** `tb_privilege` viva. */
export interface PrivilegeDefinitionRow { id: number; description: string | null }

/** O que o boot/teste ao vivo lê do banco. */
export interface CatalogFacts {
  /** Pares registrados (vivos e ativos). */
  catalog: readonly CatalogPairRow[]
  privileges: readonly PrivilegeDefinitionRow[]
  /** Telas vivas (kind 'T', inclusive o grupo Super) — a REGRA do menu. */
  screens: readonly string[]
  /** Interfaces vivas com config ou campo no catálogo — a REGRA do CONFIGURAR (+ `CONFIGURE_RULE_KEYS`). */
  configurable: readonly string[]
  /** Todas as `i18n_key` vivas (repetição e forma). */
  interfaceKeys?: readonly string[]
}

export interface PrivilegeCatalogProblems {
  /** Par OPERADO pelo código sem vínculo vivo e ativo — o botão some e a ação é negada até do admin. */
  missing: { interface: string; privilege: PrivilegeName; id: number }[]
  /** Privilégio consumido sem linha viva, ou com descrição ≠ nome: app e view comparam pelo NOME — o par some em silêncio. */
  misnamed: { privilege: PrivilegeName; id: number; description: string | null }[]
  /** OUTRA linha viva com o nome de um privilégio consumido: o app libera pelo nome (qualquer linha), a API decide pelo id. */
  duplicateNames: { privilege: PrivilegeName; id: number; otherIds: number[] }[]
  /** Tela sem VISUALIZAR no catálogo — não entra no menu de ninguém (C2; no grupo Super, nem no do super). */
  menuWithoutView: string[]
  /** Interface da REGRA do CONFIGURAR sem o par — a engrenagem some e o valor da institution não se grava (D-PV25). */
  configureMissing: string[]
  /** Par REGISTRADO que nenhum código opera, fora das regras e sem a marca "reservado" — promessa falsa na tela de permissões (D-PV51). */
  surplus: { interface: string; privilegeId: number; privilege: PrivilegeName | null; description: string | null }[]
  /** Marcado "reservado" mas fora do catálogo: a decisão manda manter — o seed falta ou a marca apodreceu. */
  reservedAbsent: { interface: string; privilege: PrivilegeName }[]
  /** Marcado `absentBy` mas o par já está no catálogo: tirar a marca (a lista mente) ou o par. */
  absentButPresent: { interface: string; privilege: PrivilegeName }[]
  /**
   * `i18n_key` em mais de uma interface viva (pela regra do banco: sem caixa e sem espaço no fim): a resolução por chave pega uma
   * linha sem ordem e o menu pelo id — o par pode estar numa linha e a guarda/botão olhar a outra.
   */
  duplicateKeys: string[]
  /**
   * `i18n_key` fora da forma canônica (D-PV42 — `INTERFACE_KEY_PATTERN`): a guarda acha pela colação do banco, mas o app
   * (`interfaceRoutes`) e esta lista comparam EXATO — a tela nem abre e a conferência acusaria "falta o par" enganando.
   */
  nonCanonicalKeys: string[]
}

/**
 * O nome do privilégio consumido é EXATO (A-PV26, gate adversarial da costura A1): quem DECIDE é a `vw_user_access` + a biblioteca
 * `fiscal-api/access` — binário, sem PAD SPACE (migration 075) e o vocabulário fechado `PRIVILEGE_NAMES` (D-PV53). O app só recebe o que
 * passou por esse filtro (`accessRows`). Antes da A1 a API decidia pelo ID e o app comparava sem caixa — por isso a regra antiga aceitava
 * 'faturar'; hoje 'faturar' tiraria o FATURAR de todos, inclusive do super.
 */
const exactName = (description: string | null, name: PrivilegeName): boolean => description === name

/**
 * OUTRA linha "com o nome" de um consumido — a comparação MAIS FROUXA de qualquer leitor (caixa e espaços das pontas não contam): uma
 * 2ª 'FATURAR ' (PAD SPACE) ou 'faturar' é sempre recusada/acusada, mesmo que a view de hoje já a ignore (A-PV26).
 */
const collidesWith = (description: string | null, name: PrivilegeName): boolean =>
  description !== null && description.trim().toUpperCase() === name

export function privilegeCatalogProblems(
  facts: CatalogFacts,
  consumed: readonly ConsumedPrivilege[] = consumedPrivileges(),
  reserved: readonly ReservedPrivilege[] = RESERVED_PRIVILEGES,
): PrivilegeCatalogProblems {
  const present = new Set(facts.catalog.map(r => pairKey(canonicalKey(r.interfaceKey), Number(r.privilegeId))))
  const rows = facts.privileges.map(p => ({ id: Number(p.id), description: p.description == null ? null : String(p.description) }))
  const byId = new Map(rows.map(p => [p.id, p.description]))
  const out: PrivilegeCatalogProblems = {
    missing: [], misnamed: [], duplicateNames: [], menuWithoutView: [], configureMissing: [], surplus: [], reservedAbsent: [],
    absentButPresent: [], duplicateKeys: [], nonCanonicalKeys: [],
  }
  /** O conjunto ESPERADO no registro (D-PV51) e os pares "ausentes por decisão" (relatados à parte). */
  const expected = new Set<string>()
  const absent = new Set<string>()

  // REGRA do menu: VISUALIZAR em toda tela
  const viewId = PRIVILEGE_ID[MENU_PRIVILEGE]
  for (const k of new Set(facts.screens.map(canonicalKey))) {
    expected.add(pairKey(k, viewId))
    if (!present.has(pairKey(k, viewId))) out.menuWithoutView.push(k)
  }
  // REGRA do CONFIGURAR: toda interface com config/campo + as que o têm sempre (se vivas)
  const configureId = PRIVILEGE_ID[CONFIGURE_PRIVILEGE]
  const live = facts.interfaceKeys ? new Set(facts.interfaceKeys.map(canonicalKey)) : null
  const configurable = new Set([
    ...facts.configurable.map(canonicalKey),
    ...CONFIGURE_RULE_KEYS.map(canonicalKey).filter(k => live === null || live.has(k)),
  ])
  for (const k of configurable) {
    expected.add(pairKey(k, configureId))
    if (!present.has(pairKey(k, configureId))) out.configureMissing.push(k)
  }
  // OPERADOS pelo código (cada par faltando relatado UMA vez: o que a regra já acusa não se repete aqui)
  for (const c of consumed) {
    const id = PRIVILEGE_ID[c.privilege]
    const key = pairKey(canonicalKey(c.interface), id)
    const has = present.has(key)
    if (absentMarkHolds(c)) { absent.add(key); if (has) out.absentButPresent.push({ interface: c.interface, privilege: c.privilege }); continue }
    const ruleTold = expected.has(key)
    expected.add(key)
    if (!has && !ruleTold) out.missing.push({ interface: c.interface, privilege: c.privilege, id })
  }
  // RESERVADOS
  for (const r of reserved) {
    const key = pairKey(canonicalKey(r.interface), PRIVILEGE_ID[r.privilege])
    expected.add(key)
    if (!present.has(key)) out.reservedAbsent.push({ interface: r.interface, privilege: r.privilege })
  }
  // SOBRANDO: registrado fora do esperado (o par "ausente por decisão" já foi relatado à parte)
  const seenSurplus = new Set<string>()
  for (const r of facts.catalog) {
    const k = canonicalKey(r.interfaceKey)
    const id = Number(r.privilegeId)
    const key = pairKey(k, id)
    if (expected.has(key) || absent.has(key) || seenSurplus.has(key)) continue
    seenSurplus.add(key)
    out.surplus.push({ interface: k, privilegeId: id, privilege: privilegeNameById(id), description: byId.get(id) ?? null })
  }
  out.surplus.sort((a, b) => a.interface.localeCompare(b.interface) || a.privilegeId - b.privilegeId)

  // os NOMES que o código consome (app e view comparam pelo nome — D-PV53)
  const used = new Set<PrivilegeName>([MENU_PRIVILEGE, ...consumed.map(c => c.privilege)])
  if (configurable.size) used.add(CONFIGURE_PRIVILEGE)
  for (const name of used) {
    const id = PRIVILEGE_ID[name]
    const description = byId.has(id) ? byId.get(id)! : null
    if (!exactName(description, name)) out.misnamed.push({ privilege: name, id, description })
    const otherIds = rows.filter(r => r.id !== id && collidesWith(r.description, name)).map(r => r.id).sort((a, b) => a - b)
    if (otherIds.length) out.duplicateNames.push({ privilege: name, id, otherIds })
  }
  out.misnamed.sort((a, b) => a.id - b.id)
  out.menuWithoutView.sort()
  out.configureMissing.sort()

  const seen = new Map<string, number>()
  for (const raw of facts.interfaceKeys ?? []) {
    const k = String(raw)
    seen.set(canonicalKey(k), (seen.get(canonicalKey(k)) ?? 0) + 1)
    if (!INTERFACE_KEY_PATTERN.test(k)) out.nonCanonicalKeys.push(JSON.stringify(k))   // a forma das rotas do app (D-PV42)
  }
  out.duplicateKeys = [...seen].filter(([, n]) => n > 1).map(([k]) => k).sort()
  out.nonCanonicalKeys.sort()
  return out
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Guarda do CATÁLOGO em tempo de execução — D-PV15 (= Q-PV17 (a), Valdo 2026-10-18) + D-PV42 (= Q-PV50 (a), Valdo 2026-10-20): as telas
// do Super Interfaces e Privilégios RECUSAM (409, nomeando o consumidor) a mudança que recriaria o C1 na hora — tirar do catálogo um par
// que o código opera (ou que uma regra/reserva exige), renomear QUALQUER chave de interface existente (D-PV42: identificador técnico, não
// se renomeia — mudar é código + seed), excluir/tirar do menu a interface cuja chave o código usa para abrir ou montar uma tela,
// renomear/apagar um privilégio consumido pelo NOME, ou repetir esse nome em outra linha. É integridade do catálogo, não autorização:
// vale também para o super (A-PV14; a D-PV3 trata das verificações de PERMISSÃO). O boot e o teste ao vivo continuam como 2ª e 3ª linha.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RequiredPair { privilegeId: number; privilege: PrivilegeName; by: string }

const MENU_BY = 'menu (só entra a tela com VISUALIZAR — de todos, inclusive o super no grupo Super)'
const CONFIGURE_BY = 'regra do CONFIGURAR (config/campo da tela no catálogo ou Configurações Gerais — D-PV25)'

/** A interface é da REGRA do menu e/ou do CONFIGURAR (o service lê `configurable` do banco). */
export interface InterfaceRules { screen: boolean; configurable?: boolean }

/**
 * O que o catálogo NÃO pode perder nesta interface: os pares que o código opera (fora os ausentes por decisão) + VISUALIZAR se é tela +
 * CONFIGURAR se tem config/campo (ou é das que o têm sempre) + os reservados.
 */
export function requiredPairsOf(
  interfaceKey: string | null | undefined, rules: InterfaceRules,
  consumed: readonly ConsumedPrivilege[] = consumedPrivileges(), reserved: readonly ReservedPrivilege[] = RESERVED_PRIVILEGES,
): RequiredPair[] {
  const out: RequiredPair[] = []
  const k = interfaceKey == null ? null : canonicalKey(interfaceKey)
  const add = (privilege: PrivilegeName, by: string): void => {
    if (!out.some(r => r.privilege === privilege)) out.push({ privilegeId: PRIVILEGE_ID[privilege], privilege, by })
  }
  if (k !== null) {
    for (const c of consumed) if (!absentMarkHolds(c) && canonicalKey(c.interface) === k) add(c.privilege, c.where)
  }
  if (rules.screen) add(MENU_PRIVILEGE, MENU_BY)
  if (rules.configurable || (k !== null && CONFIGURE_RULE_KEYS.map(canonicalKey).includes(k))) add(CONFIGURE_PRIVILEGE, CONFIGURE_BY)
  if (k !== null) for (const r of reserved) if (canonicalKey(r.interface) === k) add(r.privilege, `reservado: ${r.reason}`)
  return out
}

/**
 * D-PV42 (1): os usos que CONGELAM a chave — a rota do app (`APP_INTERFACE_ROUTE_KEYS`, comparada EXATA como o app procura),
 * configs/campos presos à chave, a "Configurações Gerais", os pares que o código opera e os reservados. Vazio = nenhum código usa.
 */
export function interfaceKeyUses(
  interfaceKey: string | null | undefined, configurable: boolean,
  consumed: readonly ConsumedPrivilege[] = consumedPrivileges(), reserved: readonly ReservedPrivilege[] = RESERVED_PRIVILEGES,
): string[] {
  if (interfaceKey == null || interfaceKey === '') return []
  const k = canonicalKey(interfaceKey)
  const out: string[] = []
  if (APP_INTERFACE_ROUTE_KEYS.includes(interfaceKey)) out.push(`o app abre a tela por /home/${interfaceKey}/`)
  if (CONFIGURE_RULE_KEYS.includes(interfaceKey)) out.push('o menu abre o painel de configurações nela (Configurações Gerais)')
  if (configurable) out.push('configurações/campos do catálogo presos à chave')
  const pairs = consumed.filter(c => !absentMarkHolds(c) && canonicalKey(c.interface) === k).map(c => c.privilege)
  if (pairs.length) out.push(`o código opera ${[...new Set(pairs)].join(', ')}`)
  const kept = reserved.filter(r => canonicalKey(r.interface) === k).map(r => r.privilege)
  if (kept.length) out.push(`reservados por decisão: ${kept.join(', ')}`)
  return out
}

/** Quem consome o privilégio PELO NOME (app e view comparam a descrição) — vazio = livre para renomear/apagar. */
export function privilegeConsumersOf(privilegeId: number, consumed: readonly ConsumedPrivilege[] = consumedPrivileges()): string[] {
  const out = consumed.filter(c => !absentMarkHolds(c) && PRIVILEGE_ID[c.privilege] === privilegeId).map(c => `${c.interface}: ${c.where}`)
  if (PRIVILEGE_ID[MENU_PRIVILEGE] === privilegeId) out.push(MENU_BY)
  if (PRIVILEGE_ID[CONFIGURE_PRIVILEGE] === privilegeId) out.push(CONFIGURE_BY)
  return out
}

/** O nome canônico de um id consumido (VISUALIZAR/FATURAR/…) — null se o id não é consumido. */
function consumedNameOf(privilegeId: number, consumed: readonly ConsumedPrivilege[]): PrivilegeName | null {
  if (!privilegeConsumersOf(privilegeId, consumed).length) return null
  return privilegeNameById(privilegeId)
}

/** Os primeiros consumidores (a mensagem do 409 não vira um livro: o roteador põe dezenas por verbo). */
const brief = (items: readonly string[], max = 3): string =>
  items.slice(0, max).join(' · ') + (items.length > max ? ` (e mais ${items.length - max})` : '')

export interface CatalogViolation {
  code: 'CATALOG_PAIR_IN_USE' | 'INTERFACE_KEY_IN_USE' | 'PRIVILEGE_IN_USE'
  field: string
  message: string
}

/** O estado de uma interface no catálogo (antes ou depois da mudança). */
export interface InterfaceCatalogState {
  i18nKey: string | null | undefined
  kind: string | null | undefined
  groupDefault: string | null | undefined
  privilegeIds: readonly number[]
  /** Tem config ou campo no catálogo (o service lê do banco; ausente = não). */
  configurable?: boolean
}

/**
 * A mudança numa interface (`before` null = criação; `after` null = exclusão) recria o C1 ou quebra uma chave usada? Recusa:
 * (1) trocar a chave de uma interface que JÁ TEM chave — sempre (D-PV42 (2): identificador técnico, não se renomeia; dar a 1ª chave a
 * uma interface sem chave é o nascimento dela, não renomear); (2) excluir a interface cuja chave o código usa (D-PV42 (1)); (3) tela
 * do menu do cliente que o código usa virar recurso (R) ou ir ao grupo Super; (4) o estado novo sem um par exigido. A chave REPETIDA
 * em outra interface viva é conferida pelo service (precisa do banco).
 */
export function interfaceCatalogViolations(
  before: InterfaceCatalogState | null, after: InterfaceCatalogState | null,
  consumed: readonly ConsumedPrivilege[] = consumedPrivileges(), reserved: readonly ReservedPrivilege[] = RESERVED_PRIVILEGES,
): CatalogViolation[] {
  const out: CatalogViolation[] = []
  if (before) {
    const beforeKey = before.i18nKey ?? ''
    const uses = interfaceKeyUses(before.i18nKey, before.configurable ?? false, consumed, reserved)
    const usedBy = uses.length ? `: ${brief(uses)}` : ''
    // EXATA (gate adversarial do delta da D-PV15): o app procura a rota com a chave exata — trocar só a caixa, o acento ou o espaço do
    // fim já esconde a tela; a colação do banco fica para a chave REPETIDA
    if (after && beforeKey !== '' && beforeKey !== (after.i18nKey ?? '')) {
      out.push({
        code: 'INTERFACE_KEY_IN_USE', field: 'i18nKey',
        message: `A chave "${beforeKey}" é identificador técnico e não se renomeia (D-PV42) — mudar uma chave é código + seed ` +
          `coordenados${usedBy}`,
      })
    }
    if (!after && uses.length) {
      out.push({ code: 'INTERFACE_KEY_IN_USE', field: 'id', message: `A interface "${beforeKey}" é usada pelo código — não pode ser excluída${usedBy}` })
    }
    // tela do menu que o código usa não vira recurso (R) nem vai ao grupo Super: ficaria inalcançável para todos os clientes
    if (uses.length && after && isMenuScreen(before.kind, before.groupDefault) && !isMenuScreen(after.kind, after.groupDefault)) {
      out.push({
        code: 'INTERFACE_KEY_IN_USE', field: isScreen(after.kind) ? 'groupDefault' : 'kind',
        message: `A interface "${beforeKey}" é tela do menu e o código a usa — não pode virar recurso (R) nem ir ao grupo Super${usedBy}`,
      })
    }
  }
  if (after) {
    const have = new Set(after.privilegeIds.map(Number))
    const rules: InterfaceRules = { screen: isScreen(after.kind), configurable: after.configurable ?? false }
    for (const r of requiredPairsOf(after.i18nKey, rules, consumed, reserved)) {
      if (have.has(r.privilegeId)) continue
      out.push({
        code: 'CATALOG_PAIR_IN_USE', field: 'privilegeIds',
        message: `${r.privilege} (${r.privilegeId}) não pode sair do catálogo de "${after.i18nKey ?? '(sem chave)'}" — usado por: ${r.by}`,
      })
    }
  }
  return out
}

/**
 * A mudança num privilégio (`id` null = criação; `description` null = exclusão) recria o C1? Recusa: apagar ou renomear um
 * privilégio que o código consome pelo NOME — EXATO, nem a caixa muda (view + biblioteca — D-PV53/A-PV26) — e dar a OUTRA linha o nome
 * de um privilégio consumido, na comparação mais frouxa (caixa e espaços das pontas não contam — um 2º verbo confundido com o 1º).
 */
export function privilegeCatalogViolations(
  id: number | null, description: string | null, consumed: readonly ConsumedPrivilege[] = consumedPrivileges(),
): CatalogViolation[] {
  const out: CatalogViolation[] = []
  const own = id === null ? null : consumedNameOf(id, consumed)
  if (own && (description === null || !exactName(description, own))) {
    out.push({
      code: 'PRIVILEGE_IN_USE', field: description === null ? 'id' : 'description',
      message: `O privilégio ${own} (${id}) é consumido pelo NOME — ${description === null ? 'não pode ser excluído' : `o nome tem de ser "${own}"`}: ` +
        brief(privilegeConsumersOf(id!, consumed)),
    })
  }
  if (description !== null) {
    for (const name of Object.keys(PRIVILEGE_ID) as PrivilegeName[]) {
      const pid = PRIVILEGE_ID[name]
      if (pid === id || !collidesWith(description, name) || !privilegeConsumersOf(pid, consumed).length) continue
      out.push({
        code: 'PRIVILEGE_IN_USE', field: 'description',
        message: `"${description}" é o nome do privilégio ${name} (${pid}), consumido pelo código — outra linha com o mesmo nome faria o app ` +
          'liberar o botão pela linha errada',
      })
    }
  }
  return out
}

const VIOLATION_PRIORITY: readonly CatalogViolation['code'][] = ['INTERFACE_KEY_IN_USE', 'PRIVILEGE_IN_USE', 'CATALOG_PAIR_IN_USE']

/** 409 com TODAS as violações em `fields[]` (a tela mostra a primeira; o código do erro é o da mais grave). */
export function assertNoCatalogViolation(violations: readonly CatalogViolation[]): void {
  if (!violations.length) return
  const code = VIOLATION_PRIORITY.find(c => violations.some(v => v.code === c))!
  const first = violations.find(v => v.code === code)!
  throw new HttpError(409, violations.length === 1 ? first.message : `${first.message} (e mais ${violations.length - 1})`,
    violations.map(v => ({ field: v.field, message: v.message })), ErrorCodes[code])
}
