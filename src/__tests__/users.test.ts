/// <reference types="jest" />
// Cadastro de Usuário — garantias exigidas pelo módulo auth (análise
// 2026-07-12): email de login único no grupo 2, MD5 UPPERCASE no service
// (mesma função do login), senha opcional no PUT (null mantém).
// INDEPENDÊNCIA de contexto (workflow 2026-07-12): super opera qualquer
// institution; admin do cliente tem o escopo FORÇADO à do JWT.
import * as repo from '../modules/users/users.repository'
import {
  fetchUsers, createUser, editUser, saveInstitutionLinks,
} from '../modules/users/users.service'
import { UserCreateInput, UserScope } from '../modules/users/users.interface'

jest.mock('../modules/users/users.repository')

const mockList      = repo.listUsers                as jest.Mock
const mockFindOwner = repo.findLoginEmailOwner      as jest.Mock
const mockInsert    = repo.insertUserCascade        as jest.Mock
const mockUpdate    = repo.updateUserCascade        as jest.Mock
const mockExists    = repo.userExists               as jest.Mock
const mockLinked    = repo.userLinkedToInstitution  as jest.Mock
const mockSetLinks  = repo.setInstitutionLinks      as jest.Mock

const superScope: UserScope = { isSuper: true,  institutionId: 1 }
const adminScope: UserScope = { isSuper: false, institutionId: 5 }

const input: UserCreateInput = {
  nameCompany: 'Valdo de Souza',
  nickTrade:   'Valdo',
  email:       'valdo@setes.com.br',
  password:    '12345',
  active:      'S',
}

beforeEach(() => {
  jest.clearAllMocks()
  mockList.mockResolvedValue([])
  mockFindOwner.mockResolvedValue(null)
  mockInsert.mockResolvedValue(9)
  mockExists.mockResolvedValue(true)
  mockLinked.mockResolvedValue(true)
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
    await fetchUsers(superScope, '', null)
    expect(mockList).toHaveBeenCalledWith('', null)

    await fetchUsers(superScope, '', 7)
    expect(mockList).toHaveBeenCalledWith('', 7)
  })

  it('admin do cliente é sempre limitado à própria institution', async () => {
    await fetchUsers(adminScope, '', 999)

    expect(mockList).toHaveBeenCalledWith('', 5)
  })
})

describe('editUser', () => {
  it('senha null/ausente mantém a atual (hash null no repository)', async () => {
    await editUser(superScope, 9, { ...input, password: null })

    expect(mockUpdate).toHaveBeenCalledWith(9, expect.anything(), null)
  })

  it('o PRÓPRIO email do usuário não conta como duplicado', async () => {
    mockFindOwner.mockResolvedValue(9)

    await expect(editUser(superScope, 9, input)).resolves.toBeUndefined()
  })

  it('admin NÃO edita usuário de outra institution (404 — sem vazar existência)', async () => {
    mockLinked.mockResolvedValue(false)

    await expect(editUser(adminScope, 9, input))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(mockUpdate).not.toHaveBeenCalled()
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
