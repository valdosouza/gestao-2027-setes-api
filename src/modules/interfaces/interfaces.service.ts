import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import {
  CatalogConfigRow, listCatalogConfigs, validateConfigContent,
  invalidateInterfaceConfigCatalog,
} from '@shared/interface-config'
import {
  interfaceCatalogViolations, assertNoCatalogViolation, CatalogViolation, requiredPairsOf, isMenuScreen,
} from '@shared/auth/privilege-catalog'
import { InterfaceRow, InterfaceInput, InterfaceConfigInput } from './interfaces.interface'
import {
  listInterfaces, getInterface, insertInterface, updateInterface,
  deleteInterface, syncInterfacePrivileges, liveInterfaceIdsWithKey,
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
  await assertCatalogKept(before, input, privilegeIds, id)   // D-PV15 (= Q-PV17 (a))
  await updateInterface(id, input)
  await syncInterfacePrivileges(id, privilegeIds)
}

export async function removeInterface(id: number): Promise<void> {
  const before = await fetchInterface(id)
  // D-PV15: interface que o código usa não sai — salvo a DUPLICATA, quando outra linha viva fica com a chave e os pares
  const keptElsewhere = await keyKeptElsewhere(before, id)
  assertNoCatalogViolation(interfaceCatalogViolations(keptElsewhere ? null : before, null))
  await deleteInterface(id)
}

/**
 * A chave consumida desta interface continua VIVA em outra linha que tem todos os pares que o código exige? Então esta é uma
 * DUPLICATA e pode sair ou trocar de chave — é o conserto do estado que a própria guarda proíbe criar (gate socrático do delta:
 * sem isso, duas linhas com a mesma chave consumida só saíam por SQL direto). A outra linha é quem a guarda passa a achar.
 */
async function keyKeptElsewhere(before: InterfaceRow, selfId: number): Promise<boolean> {
  if (!before.i18nKey) return false
  const menu = isMenuScreen(before.kind, before.groupDefault)
  // re-prova adversarial: a OUTRA linha tem de ser equivalente para quem a lê — chave EXATA (o app procura a rota exata), o MESMO
  // lugar no menu (tela do menu × recurso/Super) e TODOS os pares que esta segura (os do código + VISUALIZAR se vai ao menu)
  const needed = requiredPairsOf(before.i18nKey, menu).map(r => r.privilegeId)
  if (!requiredPairsOf(before.i18nKey, false).length) return false   // chave que o código não usa: a guarda nem bloqueia
  for (const otherId of (await liveInterfaceIdsWithKey(before.i18nKey)).filter(o => o !== selfId)) {
    const other = await getInterface(otherId)
    if (other && (other.i18nKey ?? '') === before.i18nKey && isMenuScreen(other.kind, other.groupDefault) === menu
      && needed.every(p => other.privilegeIds.map(Number).includes(p))) return true
  }
  return false
}

/**
 * D-PV15 (= Q-PV17 (a), Valdo 2026-10-18): a tela Interfaces recusa (409, nomeando o consumidor) o que recriaria o C1 na hora —
 * tirar do catálogo um par que o código consome (inclusive o PUT sem `privilegeIds`, que zera os vínculos), trocar a chave de uma
 * interface que o código usa, a tela do menu sem VISUALIZAR, ou a chave REPETIDA em outra interface viva (a guarda resolve a
 * interface por `i18n_key` com LIMIT 1 — com duas, o par pode estar numa e o botão olhar a outra). Integridade do catálogo, não
 * autorização: vale também para o super.
 */
async function assertCatalogKept(
  before: InterfaceRow | null, input: InterfaceInput, privilegeIds: number[], selfId: number | null,
): Promise<void> {
  const keyChanged = !before || (before.i18nKey ?? '') !== (input.i18nKey ?? '')   // exata — o app procura a rota pela chave exata
  // a DUPLICATA pode trocar de chave quando outra linha viva fica com a chave e os pares (conserto — ver keyKeptElsewhere)
  const keptElsewhere = before !== null && selfId !== null && keyChanged && await keyKeptElsewhere(before, selfId)
  const violations: CatalogViolation[] = interfaceCatalogViolations(keptElsewhere ? null : before, {
    i18nKey: input.i18nKey, kind: input.kind, groupDefault: input.groupDefault, privilegeIds,
  })
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
