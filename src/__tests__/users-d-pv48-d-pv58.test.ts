/// <reference types="jest" />
// D-PV48 (Valdo 2026-10-27 — Infra-IA/prompts/prompt_privilegios_interfaces.md): depois de criada a credencial, NINGUÉM troca a senha
// pelo cadastro (nem o admin, nem o Super) — só o titular, pela recuperação. A-PV23 (ratificada 2026-10-31): conta SEM senha (vinda do
// setes-sync) recebe a 1ª UMA vez — é a criação da credencial; a gravação é condicional (`password IS NULL`), a corrida perde com 409.
// D-PV57/D-PV58 (Valdo 2026-10-31): todo verbo escolhido para o usuário numa interface leva o VISUALIZAR da mesma interface.
import pool from '../shared/db/connection'
import * as repo from '../modules/users/users.repository'
import { editUser, saveUserPrivileges, withVisualizar } from '../modules/users/users.service'
import { UserScope } from '../modules/users/users.interface'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn() } }))

const adminScope: UserScope = { isSuper: false, institutionId: 5, schemaName: 'setes_acme' }
const superScope: UserScope = { isSuper: true, institutionId: 1, schemaName: 'setes_setes' }
const body = { nameCompany: 'Fulano', nickTrade: 'Ful', email: 'ful@x.com', password: 'novaSenha1' } as any

describe('D-PV48 — senha só na criação da credencial', () => {
  let getUser: jest.SpyInstance, update: jest.SpyInstance
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.spyOn(repo, 'listActiveUserLinks').mockResolvedValue([{ institutionId: 5, kind: 'user', alive: true, deleted: false }] as any)
    update = jest.spyOn(repo, 'updateUserCascade').mockResolvedValue()
    getUser = jest.spyOn(repo, 'getUser')
  })

  it.each([['admin', adminScope], ['Super', superScope]])('%s: credencial existente + senha no PUT → 409 PASSWORD_OWNER_ONLY, nada gravado', async (_n, scope) => {
    getUser.mockResolvedValue({ id: 9, nameCompany: 'F', nickTrade: 'F', email: 'ful@x.com', active: 'S', hasCredential: true })
    await expect(editUser(scope, 9, body)).rejects.toMatchObject({ statusCode: 409, code: 'PASSWORD_OWNER_ONLY',
      fields: [expect.objectContaining({ field: 'password' })] })
    expect(update).not.toHaveBeenCalled()
  })

  it('credencial existente SEM senha no corpo: edita o resto normalmente (senha intocada)', async () => {
    getUser.mockResolvedValue({ id: 9, nameCompany: 'F', nickTrade: 'F', email: 'ful@x.com', active: 'S', hasCredential: true })
    await editUser(adminScope, 9, { ...body, password: null })
    expect(update).toHaveBeenCalledWith(9, expect.anything(), null, null)
  })

  it('A-PV23: conta SEM credencial (vinda do sync) recebe a 1ª senha — o hash vai ao repositório', async () => {
    getUser.mockResolvedValue({ id: 9, nameCompany: 'F', nickTrade: 'F', email: 'ful@x.com', active: 'S', hasCredential: false })
    await editUser(adminScope, 9, body)
    expect(update).toHaveBeenCalledWith(9, expect.anything(), expect.stringMatching(/^[0-9A-F]{32}$/), null)
  })
})

describe('D-PV48 — a 1ª senha é CONDICIONAL no banco (a corrida de duas edições perde com 409, a transação volta)', () => {
  const conn = { beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(), query: jest.fn() }
  beforeEach(() => {
    jest.restoreAllMocks()
    ;(pool.getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockReset()
    conn.rollback.mockReset(); conn.commit.mockReset()
  })

  it('UPDATE só onde a senha é NULL/vazia; 1 linha = ok', async () => {
    conn.query.mockImplementation(async (sql: string) => [/SET password/.test(sql) ? { affectedRows: 1 } : { affectedRows: 1 }])
    await repo.updateUserCascade(9, body, 'HASH', null)
    const pw = conn.query.mock.calls.find(c => /SET password/.test(String(c[0])))!
    expect(String(pw[0]).replace(/\s+/g, ' ')).toMatch(/WHERE id = \? AND \(password IS NULL OR password = ''\)/)
    expect(conn.commit).toHaveBeenCalled()
  })

  it('0 linha (outra edição já criou a credencial) → 409 PASSWORD_OWNER_ONLY e ROLLBACK', async () => {
    conn.query.mockImplementation(async (sql: string) => [/SET password/.test(sql) ? { affectedRows: 0 } : { affectedRows: 1 }])
    await expect(repo.updateUserCascade(9, body, 'HASH', null)).rejects.toMatchObject({ statusCode: 409, code: 'PASSWORD_OWNER_ONLY' })
    expect(conn.rollback).toHaveBeenCalled()
    expect(conn.commit).not.toHaveBeenCalled()
  })
})

describe('D-PV58 — todo verbo leva o VISUALIZAR (regra ÚNICA da escrita da concessão)', () => {
  const catalog = new Set([1, 2, 3, 6, 11])
  it('verbo sem VISUALIZAR → o VISUALIZAR entra; lista vazia = sem a tela (D-PV59); com ele, nada muda; repetido sai', () => {
    expect(withVisualizar([2], catalog).sort()).toEqual([2, 6])
    expect(withVisualizar([11], catalog).sort((a, b) => a - b)).toEqual([6, 11])                    // inclusive o CONFIGURAR ("Todos")
    expect(withVisualizar([], catalog)).toEqual([])
    expect(withVisualizar([6, 2, 2], catalog).sort()).toEqual([2, 6])
  })
  it('interface sem VISUALIZAR no catálogo: nada a levar', () => {
    expect(withVisualizar([2], new Set([2, 3]))).toEqual([2])
  })

  it('o salvar grava a lista JÁ com o VISUALIZAR', async () => {
    jest.restoreAllMocks()
    jest.spyOn(repo, 'userExists').mockResolvedValue(true)
    jest.spyOn(repo, 'userLinkedToInstitution').mockResolvedValue(true)
    jest.spyOn(repo, 'findInterfaceKey').mockResolvedValue({ key: 'orders', deleted: false } as any)
    jest.spyOn(repo, 'listInterfaceCatalogPrivilegeIds').mockResolvedValue([1, 2, 3, 6])
    const set = jest.spyOn(repo, 'setUserPrivileges').mockResolvedValue()
    await saveUserPrivileges(adminScope, 9, 30, [3], null)
    expect(set).toHaveBeenCalledWith('setes_acme', 9, 30, [3, 6])
  })
})
