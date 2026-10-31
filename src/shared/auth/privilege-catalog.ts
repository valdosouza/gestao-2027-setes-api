import {
  PRIVILEGE_INSERIR, PRIVILEGE_ALTERAR, PRIVILEGE_EXCLUIR, PRIVILEGE_IMPRIMIR, PRIVILEGE_FATURAR,
  PRIVILEGE_VISUALIZAR, PRIVILEGE_CANCELAR, PRIVILEGE_DESCONTO, PRIVILEGE_TRANSMITIR,
} from '@shared/auth/privileges'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'

/**
 * LISTA ÚNICA dos pares (interface, privilégio) que o CÓDIGO consome — D-PV9 (= Q-PV9 (a), Valdo 2026-10-18,
 * `Infra-IA/prompts/prompt_privilegios_interfaces.md`). Por quê: os botões do admin e do super vêm do CATÁLOGO da interface
 * (`core.service` → `getAllInterfacePrivileges`), então par que falta em `setes_central.tb_interface_has_privilege` esconde o
 * botão até do admin e nunca pode ser concedido a um usuário regular. Foi o C1: o "trocar a cobrança" da Baixa (rota exige
 * ALTERAR em `settlements`) ficou invisível de 2026-09-13 a 2026-10-18 sem nenhum gate perceber — nada ligava rota/botão ao seed.
 *
 * Duas guardas leem esta lista:
 *  - a CERCA (`src/__tests__/privilege-catalog-fence.test.ts`, predicado em `src/test-setup/privilege-fence.ts`): varre as
 *    guardas de rota e as políticas do setes-api, as guardas da nfse-api e os `CurrentInterface.can('X')` do setes-app — par
 *    consumido fora desta lista, ou entrada daqui que nenhum código consome mais, reprova;
 *  - a CONFERÊNCIA NO BOOT (`assert-privilege-catalog.ts`): esta lista contra o catálogo VIVO e ATIVO — par faltando = alarme
 *    no log, sem recusar subir.
 *
 * Tela nova: o seed dos pares vai ao banco ANTES do app (skill `setes-api/skills/novo-modulo.md`, "Interface e privilégios").
 * O CRUD (INSERIR/ALTERAR/EXCLUIR/VISUALIZAR por roteador e na fábrica) entra aqui na onda da D-PV2, junto com o código que o
 * consome.
 */

/** Nome do privilégio = `tb_privilege.description` — o app compara POR ESTE NOME (`MenuInterface.can`, sem diferenciar caixa). */
export type PrivilegeName =
  | 'INSERIR' | 'ALTERAR' | 'EXCLUIR' | 'IMPRIMIR' | 'FATURAR' | 'VISUALIZAR' | 'CANCELAR' | 'DESCONTO' | 'TRANSMITIR'

/** Nome → id do catálogo (`@shared/auth/privileges`; ids estáveis desde o gestão desktop + seeds 51/55/59). */
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
})

/**
 * Interfaces que o RAMO de um pedido pode resolver — a view `vw_order_interface` (D-F32): o resolver do billing
 * (`billing.interface-resolver.ts`, tipo `OrderInterfaceKey`) e o `erp.orderInterface` das guardas da nfse-api. Guarda "pelo
 * ramo" consome o privilégio nas TRÊS (a cerca confere o tipo contra esta lista).
 */
export const ORDER_BRANCH_INTERFACES = ['orders', 'service-orders', 'order-returns'] as const

/**
 * O MENU do usuário regular consome VISUALIZAR em toda interface de TELA fora do grupo Super (`core.repository`:
 * `ONLY_SCREEN_KIND` + `NOT_SUPER_GROUP` + o filtro de VISUALIZAR — decisão 21 da Fase 1). Sem o par, a tela nunca entra no menu
 * de um regular (o C2 do prompt). Conferido no boot pela regra, não par a par.
 */
export const MENU_PRIVILEGE: PrivilegeName = 'VISUALIZAR'

/**
 * Quem consome: guarda/política do setes-api ('api'), guarda da API da NFS-e ('nfse' — ela lê a concessão no schema do cliente,
 * D-F13), botão do setes-app ('app'). A cerca confere o conjunto EXATO. O rótulo é só o nome: o setes-api é PASSIVO e nunca
 * fala com a API fiscal (D-F4 — a cerca da F2a reprova URL/nome dela em literal do src/).
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

const BRANCH_WHERE = 'guarda pelo RAMO do pedido (vw_order_interface)'

export const CONSUMED_PRIVILEGES: readonly ConsumedPrivilege[] = Object.freeze([
  // ── Pedido de venda (orders) ────────────────────────────────────────────────────────────────────────────────────────────
  { interface: 'orders', privilege: 'FATURAR', consumers: ['api', 'app'],
    where: `POST /api/billing/invoice (${BRANCH_WHERE}) · botão "Validar e Faturar" (order_page)` },
  { interface: 'orders', privilege: 'CANCELAR', consumers: ['api', 'nfse', 'app'],
    where: `POST /api/billing/cancel, /cancel-waiver, GET /:orderId/cancel-plan · API da NFS-e: reconferir/cancelar (${BRANCH_WHERE}) · ` +
      'botão "Cancelar nota" (order_page)' },
  { interface: 'orders', privilege: 'TRANSMITIR', consumers: ['nfse'],
    where: `API da NFS-e: transmitir/atualizar a nota e a passada do rodízio (${BRANCH_WHERE})` },

  // ── Ordem de serviço (service-orders) ───────────────────────────────────────────────────────────────────────────────────
  { interface: 'service-orders', privilege: 'FATURAR', consumers: ['api', 'app'],
    where: `POST /api/service-orders/:id/invoice, /batch-invoice · POST /api/billing/invoice (${BRANCH_WHERE}) · ` +
      'botões Faturar / Faturar em lote (service_order_page)' },
  { interface: 'service-orders', privilege: 'CANCELAR', consumers: ['api', 'nfse', 'app'],
    where: `POST /api/billing/cancel… · API da NFS-e: reconferir/cancelar (${BRANCH_WHERE}) · "Cancelar nota" (service_order_page, ` +
      'service_order_fiscal_section)' },
  { interface: 'service-orders', privilege: 'TRANSMITIR', consumers: ['nfse', 'app'],
    where: `API da NFS-e: transmitir/atualizar/passada (${BRANCH_WHERE}) · "Transmitir"/"Atualizar" no fisco (service_order_page, ` +
      'service_order_fiscal_section)' },

  // ── Devolução (order-returns) ───────────────────────────────────────────────────────────────────────────────────────────
  { interface: 'order-returns', privilege: 'FATURAR', consumers: ['api', 'app'],
    where: `POST /api/billing/invoice (${BRANCH_WHERE}) · botão Faturar (order_return_page)` },
  { interface: 'order-returns', privilege: 'CANCELAR', consumers: ['api', 'nfse'],
    where: `POST /api/billing/cancel… · API da NFS-e: reconferir/cancelar (${BRANCH_WHERE})`,
    absentBy: 'cancelar a devolução faturada é a Onda 2 do cancelamento (ramo adjust — billing.interface-resolver.ts); hoje o ' +
      'plano bloqueia e a tela não tem o botão (§3 do prompt_privilegios_interfaces.md: "cancelar = Onda 2")' },
  { interface: 'order-returns', privilege: 'TRANSMITIR', consumers: ['nfse'],
    where: `API da NFS-e: transmitir/atualizar/passada (${BRANCH_WHERE})`,
    absentBy: 'a devolução é NF-e de mercadoria (API da NF-e, sem código — D-F20): a tela não transmite e a API da NFS-e não emite por ela' },

  // ── Baixas (settlements) ────────────────────────────────────────────────────────────────────────────────────────────────
  { interface: 'settlements', privilege: 'ALTERAR', consumers: ['api', 'app'],
    where: 'PUT /api/settlements/bills/:orderId/:parcel/charge (trocar a cobrança — D17/D21) · ícone ⇄ da linha (settlement_page) — o C1' },
  { interface: 'settlements', privilege: 'DESCONTO', consumers: ['api', 'app'],
    where: 'política assertDiscountPolicy na baixa (D-G32) · campo de desconto (settlement_page)' },

  // ── Carteira de cobrança (bank-charge-agreements) ───────────────────────────────────────────────────────────────────────
  { interface: 'bank-charge-agreements', privilege: 'DESCONTO', consumers: ['api'],
    where: 'política assertDiscountAliquot no POST/PUT da carteira (D-G36)' },
] as ConsumedPrivilege[])

/** `interface|id` — a chave dos conjuntos da cerca e do boot. */
export const pairKey = (interfaceKey: string, privilegeId: number): string => `${interfaceKey}|${privilegeId}`

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Conferência (PURA — o boot só busca as linhas e entrega aqui; o teste prova sem banco)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Vínculo VIVO e ATIVO do catálogo (o mesmo predicado de `getAllInterfacePrivileges`, que dá os botões do admin/super). */
export interface CatalogPairRow { interfaceKey: string; privilegeId: number }
/** `tb_privilege` viva. */
export interface PrivilegeDefinitionRow { id: number; description: string | null }

export interface PrivilegeCatalogProblems {
  /** Par consumido sem vínculo vivo e ativo — o botão some até do admin e o par não pode ser concedido. */
  missing: { interface: string; privilege: PrivilegeName; id: number }[]
  /** Privilégio consumido sem linha viva, ou com descrição ≠ nome: o app compara pelo NOME e o botão some em silêncio. */
  misnamed: { privilege: PrivilegeName; id: number; description: string | null }[]
  /** OUTRA linha viva com o nome de um privilégio consumido: o app libera pelo nome (qualquer linha), a API decide pelo id. */
  duplicateNames: { privilege: PrivilegeName; id: number; otherIds: number[] }[]
  /** Tela do menu do cliente sem VISUALIZAR no catálogo — não entra no menu de nenhum regular (C2). */
  menuWithoutView: string[]
  /** Marcado `absentBy` mas o par já está no catálogo: tirar a marca (a lista mente). */
  absentButPresent: { interface: string; privilege: PrivilegeName }[]
  /**
   * `i18n_key` em mais de uma interface viva (pela regra do banco: sem caixa e sem espaço no fim): `require-privilege` resolve por
   * `LIMIT 1` sem ordem e o menu pelo id — o par pode estar numa linha e a guarda/botão olhar a outra.
   */
  duplicateKeys: string[]
  /**
   * `i18n_key` fora da forma canônica (minúsculas, sem espaço nas pontas): a guarda acha pela colação do banco, mas o app
   * (`interfaceRoutes`) e esta lista comparam EXATO — a tela nem abre e a conferência acusaria "falta o par" enganando.
   */
  nonCanonicalKeys: string[]
}

/**
 * A MESMA comparação do app (`MenuInterface.can`, `menu_entity.dart`): `toLowerCase` dos dois lados, SEM trim — um " ALTERAR"
 * salvo na tela Privilégios esconde o botão, então a conferência também tem de acusar.
 */
const sameName = (description: string | null, name: PrivilegeName): boolean =>
  description !== null && description.toLowerCase() === name.toLowerCase()

/**
 * A chave como o BANCO a compara (`utf8mb4_general_ci` + PAD SPACE): sem caixa, sem acento e sem espaço no fim — é assim que a
 * guarda acha (`'settlements' = 'séttlements'` no banco).
 */
export const canonicalKey = (k: string): string => String(k).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ +$/, '')

/** A marca `absentBy` não vale para par que um BOTÃO consome: botão sem o par no catálogo é o próprio C1 (some até do admin). */
export const absentMarkHolds = (c: ConsumedPrivilege): boolean => !!c.absentBy && !c.consumers.includes('app')

export function privilegeCatalogProblems(
  catalog: readonly CatalogPairRow[],
  privileges: readonly PrivilegeDefinitionRow[],
  menuInterfaces: readonly string[],
  consumed: readonly ConsumedPrivilege[] = CONSUMED_PRIVILEGES,
  interfaceKeys: readonly string[] = [],
): PrivilegeCatalogProblems {
  const present = new Set(catalog.map(r => pairKey(canonicalKey(r.interfaceKey), Number(r.privilegeId))))
  const rows = privileges.map(p => ({ id: Number(p.id), description: p.description == null ? null : String(p.description) }))
  const byId = new Map(rows.map(p => [p.id, p.description]))
  const out: PrivilegeCatalogProblems = {
    missing: [], misnamed: [], duplicateNames: [], menuWithoutView: [], absentButPresent: [], duplicateKeys: [], nonCanonicalKeys: [],
  }

  const used = new Set<PrivilegeName>([MENU_PRIVILEGE])
  for (const c of consumed) {
    const id = PRIVILEGE_ID[c.privilege]
    used.add(c.privilege)
    const has = present.has(pairKey(canonicalKey(c.interface), id))
    if (absentMarkHolds(c)) { if (has) out.absentButPresent.push({ interface: c.interface, privilege: c.privilege }) }
    else if (!has) out.missing.push({ interface: c.interface, privilege: c.privilege, id })
  }
  for (const name of used) {
    const id = PRIVILEGE_ID[name]
    const description = byId.has(id) ? byId.get(id)! : null
    if (!sameName(description, name)) out.misnamed.push({ privilege: name, id, description })
    const otherIds = rows.filter(r => r.id !== id && sameName(r.description, name)).map(r => r.id).sort((a, b) => a - b)
    if (otherIds.length) out.duplicateNames.push({ privilege: name, id, otherIds })
  }
  const viewId = PRIVILEGE_ID[MENU_PRIVILEGE]
  for (const k of new Set(menuInterfaces.map(canonicalKey))) if (!present.has(pairKey(k, viewId))) out.menuWithoutView.push(k)
  out.menuWithoutView.sort()

  const seen = new Map<string, number>()
  for (const raw of interfaceKeys) {
    const k = String(raw)
    seen.set(canonicalKey(k), (seen.get(canonicalKey(k)) ?? 0) + 1)
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(k)) out.nonCanonicalKeys.push(JSON.stringify(k))   // a forma das rotas do app
  }
  out.duplicateKeys = [...seen].filter(([, n]) => n > 1).map(([k]) => k).sort()
  out.nonCanonicalKeys.sort()
  return out
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Guarda do CATÁLOGO em tempo de execução — D-PV15 (= Q-PV17 (a), Valdo 2026-10-18): as telas do Super Interfaces e Privilégios
// RECUSAM (409, nomeando o consumidor) a mudança que recriaria o C1 na hora — tirar do catálogo um par que o código consome, mudar
// ou apagar a chave de uma interface que o código usa, renomear/apagar um privilégio que o app consome pelo NOME, ou repetir esse
// nome em outra linha. É integridade do catálogo, não autorização: vale também para o super (D-PV3 trata das verificações de
// PERMISSÃO). O boot e o teste ao vivo continuam como segunda e terceira linha.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Tela que o menu do cliente mostra: o MESMO predicado do `core.repository` (`ONLY_SCREEN_KIND` + `NOT_SUPER_GROUP`) e do
 * `MENU_INTERFACES_SQL` do boot — comparado como o banco compara (sem caixa, sem espaço no fim).
 */
export const isMenuScreen = (kind: string | null | undefined, groupDefault: string | null | undefined): boolean =>
  canonicalKey(kind ?? 'T') === 't' && canonicalKey(groupDefault ?? '') !== 'super'

export interface RequiredPair { privilegeId: number; privilege: PrivilegeName; by: string }

const MENU_BY = 'menu do usuário regular (só entra a tela com VISUALIZAR)'

/** O que o catálogo NÃO pode perder nesta interface: os pares que o código consome (fora os ausentes por decisão) + VISUALIZAR se
 *  ela é tela do menu do cliente. */
export function requiredPairsOf(
  interfaceKey: string | null | undefined, menuScreen: boolean, consumed: readonly ConsumedPrivilege[] = CONSUMED_PRIVILEGES,
): RequiredPair[] {
  const out: RequiredPair[] = []
  const k = interfaceKey == null ? null : canonicalKey(interfaceKey)
  if (k !== null) {
    for (const c of consumed) {
      if (absentMarkHolds(c) || canonicalKey(c.interface) !== k) continue
      out.push({ privilegeId: PRIVILEGE_ID[c.privilege], privilege: c.privilege, by: c.where })
    }
  }
  if (menuScreen && !out.some(r => r.privilege === MENU_PRIVILEGE)) {
    out.push({ privilegeId: PRIVILEGE_ID[MENU_PRIVILEGE], privilege: MENU_PRIVILEGE, by: MENU_BY })
  }
  return out
}

/** Quem consome o privilégio PELO NOME (o app compara a descrição) — vazio = livre para renomear/apagar. */
export function privilegeConsumersOf(privilegeId: number, consumed: readonly ConsumedPrivilege[] = CONSUMED_PRIVILEGES): string[] {
  const out = consumed.filter(c => !absentMarkHolds(c) && PRIVILEGE_ID[c.privilege] === privilegeId).map(c => `${c.interface}: ${c.where}`)
  if (PRIVILEGE_ID[MENU_PRIVILEGE] === privilegeId) out.push(MENU_BY)
  return out
}

/** O nome canônico de um id consumido (VISUALIZAR/FATURAR/…) — null se o id não é consumido. */
function consumedNameOf(privilegeId: number, consumed: readonly ConsumedPrivilege[]): PrivilegeName | null {
  if (!privilegeConsumersOf(privilegeId, consumed).length) return null
  return (Object.keys(PRIVILEGE_ID) as PrivilegeName[]).find(n => PRIVILEGE_ID[n] === privilegeId) ?? null
}

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
}

/**
 * A mudança numa interface (`before` null = criação; `after` null = exclusão) recria o C1? Recusa: (1) excluir ou trocar a chave
 * de uma interface que o CÓDIGO usa; (2) o estado novo sem um par exigido (o par consumido pela chave nova + VISUALIZAR se a tela
 * vai ao menu). A chave REPETIDA em outra interface viva é conferida pelo service (precisa do banco).
 */
export function interfaceCatalogViolations(
  before: InterfaceCatalogState | null, after: InterfaceCatalogState | null,
  consumed: readonly ConsumedPrivilege[] = CONSUMED_PRIVILEGES,
): CatalogViolation[] {
  const out: CatalogViolation[] = []
  const usedByCode = (key: string | null | undefined): RequiredPair[] => requiredPairsOf(key, false, consumed)
  if (before) {
    const code = usedByCode(before.i18nKey)
    // EXATA (gate adversarial do delta): o app procura a rota com a chave exata (`interfaceRoutes[item.i18nKey]`) — trocar só a
    // caixa, o acento ou o espaço do fim já esconde a tela de todos; a colação do banco fica para a chave REPETIDA
    const keyChanged = !after || (before.i18nKey ?? '') !== (after.i18nKey ?? '')
    if (code.length && keyChanged) {
      out.push({
        code: 'INTERFACE_KEY_IN_USE', field: after ? 'i18nKey' : 'id',
        message: `A interface "${before.i18nKey}" é usada pelo código — ${after ? 'a chave não pode mudar' : 'não pode ser excluída'}: ` +
          code.map(r => `${r.privilege} (${r.by})`).join(' · '),
      })
    }
    // tela do menu que o código usa não vira recurso (R) nem vai ao grupo Super: o botão ficaria inalcançável para todos os clientes
    if (code.length && after && isMenuScreen(before.kind, before.groupDefault) && !isMenuScreen(after.kind, after.groupDefault)) {
      out.push({
        code: 'INTERFACE_KEY_IN_USE', field: canonicalKey(after.kind ?? 'T') === 't' ? 'groupDefault' : 'kind',
        message: `A interface "${before.i18nKey}" é tela do menu e o código a usa — não pode virar recurso (R) nem ir ao grupo Super: ` +
          code.map(r => `${r.privilege} (${r.by})`).join(' · '),
      })
    }
  }
  if (after) {
    const have = new Set(after.privilegeIds.map(Number))
    for (const r of requiredPairsOf(after.i18nKey, isMenuScreen(after.kind, after.groupDefault), consumed)) {
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
 * privilégio que o app consome pelo NOME (comparação do app: `toLowerCase`, sem trim) e dar a OUTRA linha o nome de um privilégio
 * consumido (o app liberaria o botão por qualquer das duas, a API decide pelo id).
 */
export function privilegeCatalogViolations(
  id: number | null, description: string | null, consumed: readonly ConsumedPrivilege[] = CONSUMED_PRIVILEGES,
): CatalogViolation[] {
  const out: CatalogViolation[] = []
  const own = id === null ? null : consumedNameOf(id, consumed)
  if (own && (description === null || !sameName(description, own))) {
    out.push({
      code: 'PRIVILEGE_IN_USE', field: description === null ? 'id' : 'description',
      message: `O privilégio ${own} (${id}) é consumido pelo NOME — ${description === null ? 'não pode ser excluído' : `o nome tem de ser "${own}"`}: ` +
        privilegeConsumersOf(id!, consumed).join(' · '),
    })
  }
  if (description !== null) {
    for (const name of Object.keys(PRIVILEGE_ID) as PrivilegeName[]) {
      const pid = PRIVILEGE_ID[name]
      if (pid === id || !sameName(description, name) || !privilegeConsumersOf(pid, consumed).length) continue
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
