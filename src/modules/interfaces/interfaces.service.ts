import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import {
  CatalogConfigRow, listCatalogConfigs, validateConfigContent,
  invalidateInterfaceConfigCatalog,
} from '@shared/interface-config'
import {
  interfaceCatalogViolations, assertNoCatalogViolation, CatalogViolation, requiredPairsOf, isMenuScreen, isScreen,
  interfaceKeyUses, consumedPrivileges, ConsumedPrivilege, InterfaceCatalogState,
} from '@shared/auth/privilege-catalog'
import { InterfaceRow, InterfaceInput, InterfaceConfigInput } from './interfaces.interface'
import {
  listInterfaces, getInterface, insertInterface, updateInterface,
  deleteInterface, syncInterfacePrivileges, liveInterfaceIdsWithKey, interfaceHasConfigOrField,
  upsertInterfaceConfig, interfaceConfigExists, softDeleteInterfaceConfig,
  INTERFACE_SEARCH_CRITERIA,
} from './interfaces.repository'

export { INTERFACE_SEARCH_CRITERIA }

/** Critérios da pesquisa avançada servidos ao app (D-BA2) — sem expressão SQL. */
export async function fetchInterfaceSearchCriteria(): Promise<PublicSearchCriterion[]> {
  return publicCriteria(INTERFACE_SEARCH_CRITERIA)
}

export async function fetchInterfaces(query: ListQuery): Promise<PagedRows<InterfaceRow>> {
  return listInterfaces(query)
}

export async function fetchInterface(id: number): Promise<InterfaceRow> {
  const row = await getInterface(id)
  if (!row) throw new HttpError(404, `Interface ${id} não encontrada`)
  return row
}

/**
 * Cria interface com id gerado automaticamente (MAX+1 — sem padrão externo
 * tipo BACEN/IBGE, decisão do Valdo 2026-07-11) e grava os vínculos de
 * privilégio em tb_interface_has_privilege.
 */
export async function createInterface(
  input: InterfaceInput,
  privilegeIds: number[]
): Promise<{ id: number }> {
  await assertCatalogKept(null, input, privilegeIds, null)   // D-PV15: a tela nasce com os pares que o código/menu exigem
  const id = await insertInterface(input)
  if (privilegeIds.length > 0) {
    await syncInterfacePrivileges(id, privilegeIds)
  }
  return { id }
}

/** Atualiza os campos (id nunca muda) e sincroniza os vínculos de privilégio. */
export async function editInterface(
  id: number,
  input: InterfaceInput,
  privilegeIds: number[]
): Promise<void> {
  const before = await fetchInterface(id) // garante existência
  await assertCatalogKept(before, input, privilegeIds, id)   // D-PV15 (= Q-PV17 (a)) + D-PV42 (a chave não se renomeia)
  await updateInterface(id, input)
  await syncInterfacePrivileges(id, privilegeIds)
}

export async function removeInterface(id: number): Promise<void> {
  const before = await fetchInterface(id)
  const consumed = consumedPrivileges()   // D-PV14: a lista à mão ∪ a tabela do roteador (montado antes de qualquer requisição)
  const state = await catalogStateOf(before)
  // D-PV15/D-PV42: interface que o código usa não sai — salvo a DUPLICATA, quando outra linha viva fica com a chave e os pares
  const keptElsewhere = await keyKeptElsewhere(state, id, consumed)
  assertNoCatalogViolation(interfaceCatalogViolations(keptElsewhere ? null : state, null, consumed))
  await deleteInterface(id)
}

/** O estado da linha para a guarda — com o fato "tem config/campo no catálogo" (REGRA do CONFIGURAR e chave presa — D-PV25/D-PV42). */
async function catalogStateOf(row: InterfaceRow): Promise<InterfaceCatalogState & { id: number }> {
  return { ...row, configurable: await interfaceHasConfigOrField(row.id) }
}

/**
 * A chave usada desta interface continua VIVA em outra linha que tem todos os pares exigidos? Então esta é uma DUPLICATA e pode SAIR —
 * é o conserto do estado que a própria guarda proíbe criar (gate socrático do delta da D-PV15: sem isso, duas linhas com a mesma chave
 * usada só saíam por SQL direto). A outra linha é quem a resolução por chave passa a achar. Trocar a chave da duplicata NÃO é mais
 * conserto: a chave não se renomeia (D-PV42) — a duplicata sai por exclusão.
 */
async function keyKeptElsewhere(before: InterfaceCatalogState & { id: number }, selfId: number, consumed: readonly ConsumedPrivilege[])
  : Promise<boolean> {
  if (!before.i18nKey) return false
  if (!interfaceKeyUses(before.i18nKey, before.configurable ?? false, consumed).length) return false   // chave sem uso: a guarda nem bloqueia
  const menu = isMenuScreen(before.kind, before.groupDefault)
  const screen = isScreen(before.kind)
  // re-prova adversarial: a OUTRA linha tem de ser equivalente para quem a lê — chave EXATA (o app procura a rota exata), o MESMO
  // lugar no menu (tela do cliente × recurso/Super), as configs/campos (presos à linha pelo id — D-PV42) e TODOS os pares que esta
  // segura (os do código + VISUALIZAR se é tela + CONFIGURAR se tem config/campo + os reservados)
  const needed = requiredPairsOf(before.i18nKey, { screen, configurable: before.configurable ?? false }, consumed).map(r => r.privilegeId)
  for (const otherId of (await liveInterfaceIdsWithKey(before.i18nKey)).filter(o => o !== selfId)) {
    const other = await getInterface(otherId)
    if (!other || (other.i18nKey ?? '') !== before.i18nKey || isMenuScreen(other.kind, other.groupDefault) !== menu
      || isScreen(other.kind) !== screen) continue
    if (before.configurable && !(await interfaceHasConfigOrField(otherId))) continue
    if (needed.every(p => other.privilegeIds.map(Number).includes(p))) return true
  }
  return false
}

/**
 * D-PV15 (= Q-PV17 (a), Valdo 2026-10-18) + D-PV42 (= Q-PV50 (a), Valdo 2026-10-20): a tela Interfaces recusa (409, nomeando o
 * consumidor) o que recriaria o C1 na hora — tirar do catálogo um par que o código opera ou que uma regra/reserva exige (inclusive o PUT
 * sem `privilegeIds`, que zera os vínculos), trocar a chave de uma interface que JÁ TEM chave (identificador técnico — não se renomeia),
 * a tela sem VISUALIZAR, ou a chave REPETIDA em outra interface viva (a resolução por `i18n_key` pega uma linha só — com duas, o par pode
 * estar numa e o botão olhar a outra). Integridade do catálogo, não autorização: vale também para o super (A-PV14).
 */
async function assertCatalogKept(
  before: InterfaceRow | null, input: InterfaceInput, privilegeIds: number[], selfId: number | null,
): Promise<void> {
  const consumed = consumedPrivileges()
  const beforeState = before ? await catalogStateOf(before) : null
  const keyChanged = !before || (before.i18nKey ?? '') !== (input.i18nKey ?? '')   // exata — o app procura a rota pela chave exata
  const violations: CatalogViolation[] = interfaceCatalogViolations(beforeState, {
    i18nKey: input.i18nKey, kind: input.kind, groupDefault: input.groupDefault, privilegeIds,
    configurable: beforeState?.configurable ?? false,                 // as configs/campos são da linha (pelo id); na criação, nenhum
  }, consumed)
  // chave repetida só se confere quando a chave é NOVA nesta linha — editar a descrição de uma duplicata existente não piora nada
  if (input.i18nKey && keyChanged) {
    const others = (await liveInterfaceIdsWithKey(input.i18nKey)).filter(other => other !== selfId)
    if (others.length) {
      violations.push({
        code: 'INTERFACE_KEY_IN_USE', field: 'i18nKey',
        message: `Já existe outra interface viva com a chave "${input.i18nKey}" (id ${others.join(', ')}) — a chave tem de ser única`,
      })
    }
  }
  assertNoCatalogViolation(violations)
}

// ---------------------------------------------------------------------
// Catálogo de CONFIGURAÇÕES da interface (Framework de Configurações,
// decisões 6 e 7): cadastrado pelo Super na seção "Configurações" da tela
// de Interfaces; o painel do cliente nasce dele sem tela artesanal.
// ---------------------------------------------------------------------

export async function fetchInterfaceConfigs(id: number): Promise<CatalogConfigRow[]> {
  await fetchInterface(id) // garante existência
  return listCatalogConfigs(id)
}

export async function saveInterfaceConfig(
  id: number, name: string, input: InterfaceConfigInput
): Promise<void> {
  await fetchInterface(id)

  if (input.kind === 'Options' && !input.options) {
    throw new HttpError(400, 'Configuração inválida',
      [{ field: 'options', message: 'kind Options exige a lista de opções' }])
  }
  const error = validateConfigContent(input.kind, input.options ?? null, input.defaultContent)
  if (error !== null) {
    throw new HttpError(400, 'Default incompatível com o kind',
      [{ field: 'defaultContent', message: error }])
  }

  await upsertInterfaceConfig(id, name, input)
  invalidateInterfaceConfigCatalog(id)
}

export async function removeInterfaceConfig(id: number, name: string): Promise<void> {
  await fetchInterface(id)
  if (!(await interfaceConfigExists(id, name))) {
    throw new HttpError(404, 'Configuração não encontrada no catálogo desta interface')
  }
  await softDeleteInterfaceConfig(id, name)
  invalidateInterfaceConfigCatalog(id)
}
