/// <reference types="jest" />
// Cadastro de Usuário — garantias exigidas pelo módulo auth (análise
// 2026-07-12): email de login único no grupo 2, MD5 UPPERCASE no service
// (mesma função do login), senha opcional no PUT (null mantém).
// INDEPENDÊNCIA de contexto (workflow 2026-07-12): super opera qualquer
// institution; admin do cliente tem o escopo FORÇADO à do JWT.
import { NO_CRITERIA } from '../shared/list'
import * as repo from '../modules/users/users.repository'
import {
  fetchUsers, fetchUser, createUser, editUser, saveInstitutionLinks,
  fetchUserPrivileges, saveUserPrivileges,
} from '../modules/users/users.service'
import { UserCreateInput, UserScope } from '../modules/users/users.interface'

jest.mock('../modules/users/users.repository')

const mockList       = repo.listUsers                       as jest.Mock
const mockFindOwner  = repo.findLoginEmailOwner             as jest.Mock
const mockInsert     = repo.insertUserCascade               as jest.Mock
const mockUpdate     = repo.updateUserCascade               as jest.Mock
const mockExists     = repo.userExists                      as jest.Mock
const mockLinked     = repo.userLinkedToInstitution         as jest.Mock
const mockSetLinks   = repo.setInstitutionLinks             as jest.Mock
const mockSchema     = repo.findInstitutionSchema           as jest.Mock
const mockListPrivs  = repo.listUserPrivileges              as jest.Mock
const mockSetPrivs   = repo.setUserPrivileges               as jest.Mock
const mockCatalogIds = repo.listInterfaceCatalogPrivilegeIds as jest.Mock
const mockIfaceKey   = repo.findInterfaceKey                 as jest.Mock
const mockDelegable  = repo.listDelegableSuperPrivileges     as jest.Mock
const mockLinks      = repo.listActiveUserLinks              as jest.Mock
const mockGetUser    = repo.getUser                          as jest.Mock

const superScope: UserScope =
  { isSuper: true,  institutionId: 1, schemaName: 'setes_setes' }
const adminScope: UserScope =
  { isSuper: false, institutionId: 5, schemaName: 'setes_acme' }

const input: UserCreateInput = {
  nameCompany: 'Valdo de Souza',
  nickTrade:   'Valdo',
  email:       'valdo@setes.com.br',
  password:    '12345',
  active:      'S',
}

/** Query paginada padrão (paginação D3/D5) usada nos cenários de lista. */
const listQuery = { filter: '', page: 1, pageSize: 25, offset: 0, criteria: NO_CRITERIA }

beforeEach(() => {
  jest.clearAllMocks()
  mockList.mockResolvedValue({ rows: [], total: 0 })
  mockFindOwner.mockResolvedValue(null)
  mockInsert.mockResolvedValue(9)
  mockExists.mockResolvedValue(true)
  mockLinked.mockResolvedValue(true)
  mockGetUser.mockResolvedValue({ id: 9, nameCompany: 'Valdo de Souza', nickTrade: 'Valdo', email: 'valdo@setes.com.br', active: 'S' })
  mockLinks.mockResolvedValue([{ institutionId: 5, kind: 'user', alive: true }])
})

describe('createUser', () => {
  it('grava com MD5 UPPERCASE aplicado no service (nunca na query)', async () => {
    const result = await createUser(superScope, input)

    expect(result).toEqual({ id: 9 })
    // MD5('12345') — mesmo hash que o login compara (seed da Fase 2);
    // sem institutionId no body → sem vínculo (fluxo da tela Usuários)
    expect(mockInsert).toHaveBeenCalledWith(input, '827CCB0EEA8A706C4C34A16891F84E7B', null)
  })

  it('super com institutionId cria o vínculo junto (aba Usuários do Estabelecimento)', async () => {
    await createUser(superScope, { ...input, institutionId: 7, kind: 'admin' })

    expect(mockInsert.mock.calls[0][2]).toEqual({ institutionId: 7, kind: 'admin' })
  })

  it('admin do cliente tem o alvo FORÇADO à institution do JWT', async () => {
    await createUser(adminScope, { ...input, institutionId: 999, kind: 'admin' })

    expect(mockInsert.mock.calls[0][2]).toEqual({ institutionId: 5, kind: 'admin' })
  })

  it("admin não cria perfil 'super' (400 por campo)", async () => {
    await expect(createUser(adminScope, { ...input, kind: 'super' }))
      .rejects.toMatchObject({
        statusCode: 400,
        fields: [{ field: 'kind', message: expect.stringContaining('Setes') }],
      })
  })

  it('409 com erro por campo quando o email já é login de outro usuário', async () => {
    mockFindOwner.mockResolvedValue(3)

    await expect(createUser(superScope, input)).rejects.toMatchObject({
      statusCode: 409,
      fields: [{ field: 'email', message: expect.stringContaining('login') }],
    })
    expect(mockInsert).not.toHaveBeenCalled()
  })
})

describe('fetchUsers (escopo)', () => {
  it('super sem institutionId lista todos; com institutionId filtra', async () => {
    await fetchUsers(superScope, listQuery, null)
    expect(mockList).toHaveBeenCalledWith(listQuery, null)

    await fetchUsers(superScope, listQuery, 7)
    expect(mockList).toHaveBeenCalledWith(listQuery, 7)
  })

  it('admin do cliente é sempre limitado à própria institution', async () => {
    await fetchUsers(adminScope, listQuery, 999)

    expect(mockList).toHaveBeenCalledWith(listQuery, 5)
  })
})

describe('editUser — D-PV19 (D-UC1…D-UC3): e-mail imutável, ativo = vínculo, sem exclusão, A-PV13 morta', () => {
  it('senha null/ausente mantém a atual (hash null no repository); o ativo vai ao vínculo do estabelecimento alvo', async () => {
    await editUser(adminScope, 9, { ...input, password: null })
    expect(mockUpdate).toHaveBeenCalledWith(9, expect.anything(), null, 5)
  })

  it('o e-mail IGUAL ao de login passa (comparação sem caixa/espaços); e-mail DIFERENTE → 409 LOGIN_EMAIL_IMMUTABLE no campo, nada gravado', async () => {
    await expect(editUser(adminScope, 9, { ...input, email: ' VALDO@setes.com.br ' })).resolves.toBeUndefined()
    await expect(editUser(adminScope, 9, { ...input, email: 'outro@setes.com.br' })).rejects.toMatchObject({
      statusCode: 409, code: 'LOGIN_EMAIL_IMMUTABLE', fields: [{ field: 'email', message: expect.any(String) }],
    })
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })

  it('super: o alvo do "ativo" é o institutionId do corpo; sem ele com `active` presente → 400; sem `active` o PUT nem precisa de alvo', async () => {
    await expect(editUser(superScope, 9, { ...input, institutionId: null })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_FAILED' })
    mockLinks.mockResolvedValue([{ institutionId: 7, kind: 'user', alive: true }])
    await editUser(superScope, 9, { ...input, institutionId: 7, active: 'N' })
    expect(mockUpdate).toHaveBeenLastCalledWith(9, expect.objectContaining({ active: 'N' }), expect.anything(), 7)
    const { active: _a, ...noActive } = input
    void _a
    await editUser(superScope, 9, noActive as any)
    expect(mockUpdate).toHaveBeenLastCalledWith(9, expect.not.objectContaining({ active: expect.anything() }), expect.anything(), null)
  })

  it('ativar/inativar um estabelecimento com que o usuário NÃO tem vínculo → 400 (vincule antes)', async () => {
    mockLinks.mockResolvedValue([{ institutionId: 1, kind: 'user', alive: true }])
    await expect(editUser(superScope, 9, { ...input, institutionId: 7, active: 'S' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('admin NÃO edita usuário de outra institution (404 — sem vazar existência)', async () => {
    mockLinks.mockResolvedValue([{ institutionId: 77, kind: 'user', alive: true }])
    await expect(editUser(adminScope, 9, input)).rejects.toMatchObject({ statusCode: 404 })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('D-PV12: a conta com vínculo SUPER (vivo ou adormecido) só o Super altera; D-PV19: vínculo com OUTRO estabelecimento NÃO barra mais (A-PV13 morreu)', async () => {
    for (const links of [[{ institutionId: 5, kind: 'super', alive: true }], [{ institutionId: 5, kind: 'user', alive: true }, { institutionId: 1, kind: 'super', alive: false }]]) {
      mockLinks.mockResolvedValue(links)
      await expect(editUser(adminScope, 9, input)).rejects.toMatchObject({ statusCode: 403, code: 'USER_MANAGED_BY_SUPER' })
    }
    expect(mockUpdate).not.toHaveBeenCalled()
    mockLinks.mockResolvedValue([{ institutionId: 5, kind: 'user', alive: true }, { institutionId: 1, kind: 'admin', alive: true }])
    await editUser(adminScope, 9, input)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })

  it('a exclusão de usuário não existe mais no service (D-UC1: a credencial nunca é excluída)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const svc = require('../modules/users/users.service')
    expect(svc.removeUser).toBeUndefined()
    expect((repo as any).deleteUser).toBeUndefined()
  })

  it('fetchUser: o ativo é o do vínculo em foco — admin forçado ao JWT; super escolhe (ou nenhum)', async () => {
    await fetchUser(adminScope, 9, 999)
    expect(mockGetUser).toHaveBeenLastCalledWith(9, 5)
    await fetchUser(superScope, 9, 7)
    expect(mockGetUser).toHaveBeenLastCalledWith(9, 7)
    await fetchUser(superScope, 9)
    expect(mockGetUser).toHaveBeenLastCalledWith(9, null)
  })
})

describe('privilégios de acesso (ACL — workflow 2026-07-12)', () => {
  beforeEach(() => {
    mockSchema.mockResolvedValue('setes_cliente')
    mockListPrivs.mockResolvedValue([])
    mockCatalogIds.mockResolvedValue([1, 2, 3, 6])
    mockIfaceKey.mockResolvedValue({ key: 'customers', deleted: false })
  })

  it('super informa o institution alvo; schema resolvido na central', async () => {
    await fetchUserPrivileges(superScope, 9, 7)

    expect(mockListPrivs).toHaveBeenCalledWith('setes_cliente', 7, 9, ['users', 'establishment', 'institution-interfaces'])
  })

  it('super sem institutionId → 400 por campo', async () => {
    await expect(fetchUserPrivileges(superScope, 9, null)).rejects.toMatchObject({
      statusCode: 400,
      fields: [{ field: 'institutionId', message: expect.any(String) }],
    })
  })

  it('admin do cliente é FORÇADO ao próprio institution/schema', async () => {
    await fetchUserPrivileges(adminScope, 9, 999)

    expect(mockListPrivs).toHaveBeenCalledWith('setes_acme', 5, 9, ['users', 'establishment', 'institution-interfaces'])
    expect(mockSchema).not.toHaveBeenCalled()
  })

  it('usuário sem vínculo com o alvo → 400 (vincule antes)', async () => {
    mockLinked.mockResolvedValue(false)

    await expect(fetchUserPrivileges(adminScope, 9, null))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('PUT sincroniza somente privilégios do catálogo da interface', async () => {
    await saveUserPrivileges(adminScope, 9, 4, [6, 1], null)
    expect(mockSetPrivs).toHaveBeenCalledWith('setes_acme', 9, 4, [6, 1])

    await expect(saveUserPrivileges(adminScope, 9, 4, [5], null))
      .rejects.toMatchObject({
        statusCode: 400,
        fields: [{ field: 'privilegeIds', message: expect.stringContaining('5') }],
      })
  })
})

describe('D-PV5 — telas do perfil admin não se concedem por privilégio', () => {
  beforeEach(() => {
    mockCatalogIds.mockResolvedValue([1, 2, 3, 6])
  })

  it.each(['users', 'establishment'])('PUT de privilégio na tela %s → 400 no campo privilegeIds, nada gravado', async (key) => {
    mockIfaceKey.mockResolvedValue({ key, deleted: false })
    await expect(saveUserPrivileges(adminScope, 9, 8, [6], null)).rejects.toMatchObject({
      statusCode: 400,
      fields: [{ field: 'privilegeIds', message: expect.stringContaining(key) }],
    })
    expect(mockSetPrivs).not.toHaveBeenCalled()
  })

  it('a tela Módulos (D-GE20) e as demais seguem concedíveis', async () => {
    mockIfaceKey.mockResolvedValue({ key: 'modules', deleted: false })
    await saveUserPrivileges(adminScope, 9, 26, [6, 2], null)
    expect(mockSetPrivs).toHaveBeenCalledWith('setes_acme', 9, 26, [6, 2])
  })
})

describe('D-PV11 — tela do Super delegável: só o Super libera, e só para usuário da Setes', () => {
  const setesAdmin: UserScope = { isSuper: false, institutionId: 1, schemaName: 'setes_setes' }
  beforeEach(() => {
    mockCatalogIds.mockResolvedValue([2, 6])
    mockListPrivs.mockResolvedValue([{ interfaceId: 20 }])
    mockDelegable.mockResolvedValue([{ interfaceId: 41 }])
  })

  it('a listagem do SUPER para usuário da Setes acrescenta a tela delegável; para outro estabelecimento, não', async () => {
    mockSchema.mockResolvedValue('setes_setes')
    expect(await fetchUserPrivileges(superScope, 9, 1)).toEqual([{ interfaceId: 20 }, { interfaceId: 41 }])
    expect(mockDelegable).toHaveBeenCalledWith('setes_setes', 9, ['institution-interfaces'])
    mockDelegable.mockClear(); mockSchema.mockResolvedValue('setes_cliente')
    expect(await fetchUserPrivileges(superScope, 9, 7)).toEqual([{ interfaceId: 20 }])
    expect(mockDelegable).not.toHaveBeenCalled()
  })

  it('o ADMIN da Setes não vê a tela delegável no cadastro de privilégios (nunca concede, nem a si)', async () => {
    expect(await fetchUserPrivileges(setesAdmin, 2, null)).toEqual([{ interfaceId: 20 }])
    expect(mockDelegable).not.toHaveBeenCalled()
  })

  it('gate socrático: tela EXCLUÍDA do catálogo (o Super "desligou" a delegação) ou id inexistente → 400, nada gravado — a trava não é pulada', async () => {
    mockIfaceKey.mockResolvedValue({ key: 'institution-interfaces', deleted: true })
    await expect(saveUserPrivileges(setesAdmin, 2, 41, [6], null))
      .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_FAILED' })
    mockIfaceKey.mockResolvedValue(null)
    await expect(saveUserPrivileges(setesAdmin, 2, 999, [6], null))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(mockSetPrivs).not.toHaveBeenCalled()
  })

  it('a listagem do contrato NUNCA traz a tela delegável (nem para o admin, nem duplicada para o super)', async () => {
    await fetchUserPrivileges(setesAdmin, 2, null)
    expect(mockListPrivs.mock.calls[0][3]).toEqual(['users', 'establishment', 'institution-interfaces'])
  })

  it('gravar a tela delegável: admin da Setes → 403 SUPER_DELEGATION_SUPER_ONLY; super para outro estabelecimento → 403; super para a Setes → grava', async () => {
    mockIfaceKey.mockResolvedValue({ key: 'institution-interfaces', deleted: false })
    await expect(saveUserPrivileges(setesAdmin, 2, 41, [6], null))
      .rejects.toMatchObject({ statusCode: 403, code: 'SUPER_DELEGATION_SUPER_ONLY' })
    mockSchema.mockResolvedValue('setes_cliente')
    await expect(saveUserPrivileges(superScope, 30, 41, [6], 7))
      .rejects.toMatchObject({ statusCode: 403, code: 'SUPER_DELEGATION_SUPER_ONLY' })
    expect(mockSetPrivs).not.toHaveBeenCalled()
    mockSchema.mockResolvedValue('setes_setes')
    await saveUserPrivileges(superScope, 2, 41, [6, 2], 1)
    expect(mockSetPrivs).toHaveBeenCalledWith('setes_setes', 2, 41, [6, 2])
  })
})

describe('saveInstitutionLinks (exclusivo do super)', () => {
  it('super sincroniza vínculos com kind', async () => {
    const links = [{ institutionId: 1, kind: 'super' }]
    await saveInstitutionLinks(superScope, 9, links)

    expect(mockSetLinks).toHaveBeenCalledWith(9, links)
  })

  it('admin do cliente recebe 403 (vínculo dele é implícito no POST)', async () => {
    await expect(saveInstitutionLinks(adminScope, 9, []))
      .rejects.toMatchObject({ statusCode: 403 })
  })
})
