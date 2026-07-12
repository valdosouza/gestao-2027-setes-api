import { HttpError } from '@shared/errors/http-error'
import { md5Password } from '@shared/auth/password'
import {
  UserListRow, UserRow, UserInput, UserCreateInput, UserScope,
  UserInstitutionGrant, UserInstitutionLink, UserInterfacePrivileges,
} from './users.interface'
import {
  listUsers, getUser, findLoginEmailOwner, insertUserCascade,
  updateUserCascade, userExists, deleteUser, userLinkedToInstitution,
  listInstitutionLinks, setInstitutionLinks,
  findInstitutionSchema, listUserPrivileges, setUserPrivileges,
  listInterfaceCatalogPrivilegeIds,
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

export async function fetchUsers(
  scope: UserScope, filter: string, institutionId: number | null
): Promise<UserListRow[]> {
  return listUsers(filter, scopeInstitution(scope, institutionId))
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
  await assertInScope(scope, id)
  await assertLoginEmailFree(input.email, id)
  const hash = input.password ? md5Password(input.password) : null
  await updateUserCascade(id, input, hash)
}

export async function removeUser(scope: UserScope, id: number): Promise<void> {
  if (!(await userExists(id))) throw new HttpError(404, 'Usuário não encontrado')
  await assertInScope(scope, id)
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

export async function fetchUserPrivileges(
  scope: UserScope, userId: number, institutionId: number | null
): Promise<UserInterfacePrivileges[]> {
  if (!(await userExists(userId))) throw new HttpError(404, 'Usuário não encontrado')
  const target = await resolvePrivilegeTarget(scope, institutionId)
  await assertUserLinkedTo(userId, target)
  return listUserPrivileges(target.schemaName, target.institutionId, userId)
}

export async function saveUserPrivileges(
  scope: UserScope, userId: number, interfaceId: number,
  privilegeIds: number[], institutionId: number | null
): Promise<void> {
  if (!(await userExists(userId))) throw new HttpError(404, 'Usuário não encontrado')
  const target = await resolvePrivilegeTarget(scope, institutionId)
  await assertUserLinkedTo(userId, target)

  // Só privilégios DEFINIDOS no catálogo da interface (tb_interface_has_privilege).
  const catalog = new Set(await listInterfaceCatalogPrivilegeIds(interfaceId))
  const invalid = privilegeIds.filter(id => !catalog.has(id))
  if (invalid.length > 0) {
    throw new HttpError(400, 'Privilégio não definido para esta interface',
      [{ field: 'privilegeIds', message: `Fora do catálogo da interface: ${invalid.join(', ')}` }])
  }

  await setUserPrivileges(target.schemaName, userId, interfaceId, privilegeIds)
}
