import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { SETES_INSTITUTION_ID } from '@shared/auth/roles'
import { DELEGABLE_SUPER_INTERFACES, isDelegableSuperInterface } from '@shared/auth/super-delegation'
import { ListQuery, PagedRows, PublicSearchCriterion, SearchCriterion, publicCriteria } from '@shared/list'
import { md5Password } from '@shared/auth/password'
import {
  UserListRow, UserRow, UserInput, UserCreateInput, UserScope,
  UserInstitutionGrant, UserInstitutionLink, UserInterfacePrivileges,
  InstitutionLookupRow,
} from './users.interface'
import {
  listUsers, getUser, findLoginEmailOwner, insertUserCascade,
  updateUserCascade, userExists, deleteUser, userLinkedToInstitution,
  listInstitutionLinks, setInstitutionLinks,
  findInstitutionSchema, listUserPrivileges, setUserPrivileges,
  listInterfaceCatalogPrivilegeIds, findInterfaceKey, listDelegableSuperPrivileges, listActiveUserLinks,
  USER_SEARCH_CRITERIA, listInstitutionLookup,
} from './users.repository'

/**
 * Regra do cadastro de Usuário. Garantias exigidas pelo módulo auth
 * (análise 2026-07-12): email de login ÚNICO no grupo 2, senha MD5
 * aplicada AQUI (@shared/auth/password), id = MAX+1 da tb_entity.
 *
 * INDEPENDÊNCIA de contexto (workflow do Valdo 2026-07-12): o MESMO
 * cadastro serve o Super (aba Usuários do Estabelecimento — alvo explícito)
 * e o admin do cliente (módulo Sistema — alvo FORÇADO para a institution
 * do JWT; ele nunca escolhe nem enxerga outros institutions).
 */

/** Escopo do não-super: sempre a própria institution. */
function scopeInstitution(scope: UserScope, requested: number | null): number | null {
  return scope.isSuper ? requested : scope.institutionId
}

async function assertInScope(scope: UserScope, userId: number): Promise<void> {
  if (scope.isSuper) return
  // 404 (não 403) para não vazar a existência de usuários de outros clientes.
  if (!(await userLinkedToInstitution(userId, scope.institutionId))) {
    throw new HttpError(404, 'Usuário não encontrado')
  }
}

/**
 * Editar/desativar/excluir a CONTA (login global): gate adversarial da D-PV11 (HIGH, 2026-10-18 — prompt_privilegios_interfaces.md
 * §11.9). O admin da Setes editava a conta do SUPER (senha, e-mail, exclusão) e, com ela, concedia a si a delegação — furando a
 * D-PV10 ("só o super tem tudo") e a D-PV11 (b); o admin de OUTRO cliente trocava a senha de usuário vinculado também à Setes.
 * D-PV12 (Valdo, fecha a Q-PV37): trocar senha é ROTINA do admin — ele mexe na conta de todos do próprio estabelecimento, MENOS a do
 * super (o super é um só; o usuário liberado pelo Super segue editável pelo admin da Setes — a liberação não muda quem gere a conta).
 * Quem não é super só mexe na conta cujos vínculos — TODOS, vivos ou adormecidos — são com o próprio estabelecimento e nenhum de perfil
 * super; A-PV13 (a ratificar): a conta com vínculo com OUTRO estabelecimento também fica com o Super (o HIGH 2 do gate — o admin de um
 * cliente tomaria a conta que outro cliente, ou a Setes, usa; vínculo com vários estabelecimentos já é ato exclusivo do super —
 * `saveInstitutionLinks`).
 */
async function assertAccountManageable(scope: UserScope, userId: number): Promise<void> {
  if (scope.isSuper) return
  const links = await listActiveUserLinks(userId)
  // escopo: vínculo VIVO com o próprio estabelecimento; a barreira conta TODO vínculo (vivo ou adormecido — re-prova do gate)
  if (!links.some(l => l.alive && l.institutionId === scope.institutionId)) {
    throw new HttpError(404, 'Usuário não encontrado')
  }
  if (links.some(l => l.kind === 'super' || l.institutionId !== scope.institutionId)) {
    throw new HttpError(403, 'Esta conta tem vínculo de super ou com outro estabelecimento — só o Super altera', [],
      ErrorCodes.USER_MANAGED_BY_SUPER)
  }
}

export { USER_SEARCH_CRITERIA }

/**
 * Critérios servidos ao app (D-BA2). D-BA24: "instituição" só para o Super. Parecer do
 * guardião (Onda 2): `kind` é atributo de VÍNCULO — sem vínculo em foco (Super sem
 * institutionId) não tem significado e não é servido; a rota recebe o MESMO
 * institutionId da lista (espelho da D-BA15).
 */
export function userSearchCriteriaFor(
  scope: UserScope, institutionId: number | null
): readonly SearchCriterion[] {
  const focus = scopeInstitution(scope, institutionId)
  return USER_SEARCH_CRITERIA.filter(c =>
    !(c.key === 'institution' && !scope.isSuper) && !(c.key === 'kind' && focus === null))
}

/** Gate adversarial (2026-10-03): o catálogo SERVIDO é o catálogo ACEITO — a lista compila
 *  contra a mesma lista branca filtrada; chave não servida = 400 "não existe nesta tela"
 *  (um admin não pesquisa "meus usuários também vinculados à instituição X"). */
export async function fetchUserSearchCriteria(
  scope: UserScope, institutionId: number | null
): Promise<PublicSearchCriterion[]> {
  return publicCriteria(userSearchCriteriaFor(scope, institutionId))
}

/** Lookup do critério "instituição" — só Super (D-BA24); admin recebe 403 explícito. */
export async function fetchInstitutionLookup(
  scope: UserScope, filter: string
): Promise<InstitutionLookupRow[]> {
  if (!scope.isSuper) throw new HttpError(403, 'Pesquisa por instituição é exclusiva do Super')
  return listInstitutionLookup(filter)
}

export async function fetchUsers(
  scope: UserScope, query: ListQuery, institutionId: number | null
): Promise<PagedRows<UserListRow>> {
  return listUsers(query, scopeInstitution(scope, institutionId))
}

export async function fetchUser(scope: UserScope, id: number): Promise<UserRow> {
  await assertInScope(scope, id)
  const user = await getUser(id)
  if (!user) throw new HttpError(404, 'Usuário não encontrado')
  return user
}

async function assertLoginEmailFree(email: string, ignoreId: number | null): Promise<void> {
  const owner = await findLoginEmailOwner(email)
  if (owner !== null && owner !== ignoreId) {
    throw new HttpError(409, 'E-mail já usado como login de outro usuário',
      [{ field: 'email', message: 'E-mail já usado como login de outro usuário' }])
  }
}

export async function createUser(
  scope: UserScope, input: UserCreateInput
): Promise<{ id: number }> {
  const kind = input.kind ?? 'user'
  if (!scope.isSuper && kind === 'super') {
    throw new HttpError(400, 'Perfil não permitido',
      [{ field: 'kind', message: "Perfil 'super' é exclusivo da equipe Setes" }])
  }
  const institutionId = scopeInstitution(scope, input.institutionId ?? null)
  const link: UserInstitutionLink | null =
    institutionId !== null ? { institutionId, kind } : null

  await assertLoginEmailFree(input.email, null)
  const id = await insertUserCascade(input, md5Password(input.password!), link)
  return { id }
}

export async function editUser(
  scope: UserScope, id: number, input: UserInput
): Promise<void> {
  if (!(await userExists(id))) throw new HttpError(404, 'Usuário não encontrado')
  await assertAccountManageable(scope, id)
  await assertLoginEmailFree(input.email, id)
  const hash = input.password ? md5Password(input.password) : null
  await updateUserCascade(id, input, hash)
}

export async function removeUser(scope: UserScope, id: number): Promise<void> {
  if (!(await userExists(id))) throw new HttpError(404, 'Usuário não encontrado')
  await assertAccountManageable(scope, id)
  await deleteUser(id)
}

// ---------------------------------------------------------------------
// Vínculos multi-institution: EXCLUSIVOS do Super (o admin do cliente não
// enxerga outros institutions — o vínculo dele é implícito no POST).
// ---------------------------------------------------------------------

function assertSuper(scope: UserScope): void {
  if (!scope.isSuper) {
    throw new HttpError(403, 'Gestão de vínculos multi-institution é exclusiva da equipe Setes')
  }
}

export async function fetchInstitutionLinks(
  scope: UserScope, userId: number
): Promise<UserInstitutionGrant[]> {
  assertSuper(scope)
  if (!(await userExists(userId))) throw new HttpError(404, 'Usuário não encontrado')
  return listInstitutionLinks(userId)
}

export async function saveInstitutionLinks(
  scope: UserScope, userId: number, links: UserInstitutionLink[]
): Promise<void> {
  assertSuper(scope)
  if (!(await userExists(userId))) throw new HttpError(404, 'Usuário não encontrado')
  await setInstitutionLinks(userId, links)
}

// ---------------------------------------------------------------------
// Privilégios de acesso (workflow ACL 2026-07-12): definidos POR
// INSTITUTION (tb_user_has_privilege vive no schema do cliente).
// Perfis: super/admin operam sem ACL (menu por perfil); o REGULAR só
// enxerga (VISUALIZAR) e opera o que for concedido aqui.
// ---------------------------------------------------------------------

interface PrivilegeTarget { institutionId: number; schemaName: string }

/** Alvo: super escolhe o institution; admin é FORÇADO ao do JWT. */
async function resolvePrivilegeTarget(
  scope: UserScope, requested: number | null
): Promise<PrivilegeTarget> {
  if (!scope.isSuper) {
    return { institutionId: scope.institutionId, schemaName: scope.schemaName }
  }
  if (requested === null) {
    throw new HttpError(400, 'Informe o estabelecimento (institutionId)',
      [{ field: 'institutionId', message: 'Obrigatório para o super' }])
  }
  const schemaName = await findInstitutionSchema(requested)
  if (schemaName === null) throw new HttpError(404, 'Estabelecimento não encontrado')
  return { institutionId: requested, schemaName }
}

async function assertUserLinkedTo(
  userId: number, target: PrivilegeTarget
): Promise<void> {
  if (!(await userLinkedToInstitution(userId, target.institutionId))) {
    throw new HttpError(400,
      'Usuário sem vínculo ativo com este estabelecimento — vincule antes de definir privilégios')
  }
}

/**
 * D-PV5 (Valdo 2026-10-18 — prompt_privilegios_interfaces.md): telas do PERFIL admin — `users` (quem tem a tela concede
 * privilégio a si mesmo: escalada) e `establishment` (regime e configuração fiscal — D41 "só Admin"). Seguem no
 * `adminGuard`; o catálogo delas (A-PV4) serve só aos botões do admin/super — o cadastro de privilégios NUNCA as oferece.
 */
export const ADMIN_PROFILE_INTERFACE_KEYS: readonly string[] = ['users', 'establishment']

export async function fetchUserPrivileges(
  scope: UserScope, userId: number, institutionId: number | null
): Promise<UserInterfacePrivileges[]> {
  if (!(await userExists(userId))) throw new HttpError(404, 'Usuário não encontrado')
  const target = await resolvePrivilegeTarget(scope, institutionId)
  await assertUserLinkedTo(userId, target)
  const rows = await listUserPrivileges(target.schemaName, target.institutionId, userId,
    [...ADMIN_PROFILE_INTERFACE_KEYS, ...DELEGABLE_SUPER_INTERFACES])
  // D-PV11 (b): a tela do Super delegável só aparece quando quem edita é o SUPER e o usuário é da Setes
  if (!scope.isSuper || target.institutionId !== SETES_INSTITUTION_ID) return rows
  return rows.concat(await listDelegableSuperPrivileges(target.schemaName, userId, DELEGABLE_SUPER_INTERFACES))
}

export async function saveUserPrivileges(
  scope: UserScope, userId: number, interfaceId: number,
  privilegeIds: number[], institutionId: number | null
): Promise<void> {
  if (!(await userExists(userId))) throw new HttpError(404, 'Usuário não encontrado')
  const target = await resolvePrivilegeTarget(scope, institutionId)
  await assertUserLinkedTo(userId, target)

  // Interface inexistente ou EXCLUÍDA do catálogo não se concede (falha fechado — gate socrático da D-PV11: soft-deletar a tela
  // delegável não pode abrir a trava abaixo)
  const found = await findInterfaceKey(interfaceId)
  if (!found || found.deleted) {
    throw new HttpError(400, 'Interface inexistente ou excluída do catálogo',
      [{ field: 'privilegeIds', message: `Interface ${interfaceId} fora do catálogo` }], ErrorCodes.VALIDATION_FAILED)
  }
  const key = found.key
  // D-PV5: as telas do perfil admin (Usuários, Meu Estabelecimento) não se concedem — nem a listagem as mostra.
  if (key !== null && ADMIN_PROFILE_INTERFACE_KEYS.includes(key)) {
    throw new HttpError(400, 'Esta tela é do perfil administrador — não se concede por privilégio',
      [{ field: 'privilegeIds', message: `A tela ${key} segue o perfil admin (não tem privilégio por usuário)` }],
      ErrorCodes.PRIVILEGE_ADMIN_PROFILE)
  }

  // D-PV11 (b)/(c): tela do Super delegável — SÓ o Super libera, e só para usuário da Setes (o admin nunca concede, nem a si)
  if (isDelegableSuperInterface(key) && (!scope.isSuper || target.institutionId !== SETES_INSTITUTION_ID)) {
    throw new HttpError(403, 'Esta tela do Super só o Super libera, e só para usuário da Setes',
      [{ field: 'privilegeIds', message: `A tela ${key} é delegável só pelo Super` }], ErrorCodes.SUPER_DELEGATION_SUPER_ONLY)
  }

  // Só privilégios DEFINIDOS no catálogo da interface (tb_interface_has_privilege).
  const catalog = new Set(await listInterfaceCatalogPrivilegeIds(interfaceId))
  const invalid = privilegeIds.filter(id => !catalog.has(id))
  if (invalid.length > 0) {
    throw new HttpError(400, 'Privilégio não definido para esta interface',
      [{ field: 'privilegeIds', message: `Fora do catálogo da interface: ${invalid.join(', ')}` }])
  }

  await setUserPrivileges(target.schemaName, userId, interfaceId, privilegeIds)
}
