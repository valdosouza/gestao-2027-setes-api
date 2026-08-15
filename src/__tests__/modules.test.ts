/// <reference types="jest" />
// Módulos de Menu do cliente (prompt_modulo_menus.md, D1–D4 — Valdo
// 2026-08-04): camada 2 do menu ganha CRUD. Invariantes fixadas aqui:
// vínculo ORDENADO (position = índice do array — D3), sync transacional
// revoga+upsert, 422 de interface não elegível, exclusão graciosa em
// transação, id MAX+1 FOR UPDATE por schema.
import pool from '../shared/db/connection'
import * as repo from '../modules/modules/modules.repository'
import { moduleBodyDto } from '../modules/modules/modules.dto'
import {
  createModule, editModule, fetchModule, removeModule,
} from '../modules/modules/modules.service'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockQuery   = (pool as any).query as jest.Mock
const mockGetConn = (pool as any).getConnection as jest.Mock

function fakeConn() {
  const conn = {
    beginTransaction: jest.fn(), query: jest.fn(),
    commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
  mockGetConn.mockResolvedValue(conn)
  return conn
}

beforeEach(() => jest.clearAllMocks())

const SCHEMA = 'setes_acme'

// ---------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------

describe('modules dto', () => {
  it('interface repetida no vínculo é rejeitada', () => {
    const parsed = moduleBodyDto.safeParse(
      { description: 'Rotina', interfaceIds: [9, 12, 9] })
    expect(parsed.success).toBe(false)
  })

  it('interfaceIds omitido vira lista vazia (módulo pode nascer sem telas)', () => {
    const parsed = moduleBodyDto.safeParse({ description: 'Rotina' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.interfaceIds).toEqual([])
  })

  it('bordas do gate adversarial: position acima do INT e array gigante são 400 de validação', () => {
    expect(moduleBodyDto.safeParse(
      { description: 'X', position: 1e21 }).success).toBe(false)
    expect(moduleBodyDto.safeParse(
      { description: 'X', position: 3_000_000_000 }).success).toBe(false)
    const ids = Array.from({ length: 201 }, (_, i) => i + 1)
    expect(moduleBodyDto.safeParse(
      { description: 'X', interfaceIds: ids }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------
// Repositório
// ---------------------------------------------------------------------

describe('modules repository', () => {
  it('getModule devolve interfaceIds NA ORDEM do GROUP_CONCAT (D3)', async () => {
    mockQuery.mockResolvedValueOnce([[
      { id: 3, description: 'Rotina', position: 1, imageIcon: 'store', interfaceIds: '12,9,17' },
    ]])

    const row = await repo.getModule(SCHEMA, 3)

    expect(row!.interfaceIds).toEqual([12, 9, 17]) // ordem preservada, não ordenada
  })

  it('insertModuleCascade: MAX+1 FOR UPDATE + position default fim da fila + sync na MESMA transação', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ nextId: 4 }]])   // MAX+1 id
      .mockResolvedValueOnce([[{ nextPos: 2 }]])  // MAX+1 position
      .mockResolvedValueOnce([{}])                // INSERT módulo
      .mockResolvedValueOnce([{}])                // revoga vínculos
      .mockResolvedValueOnce([{}])                // upsert vínculo 0
      .mockResolvedValueOnce([{}])                // upsert vínculo 1

    const id = await repo.insertModuleCascade(SCHEMA,
      { description: 'Rotina', interfaceIds: [12, 9] } as any)

    expect(id).toBe(4)
    expect(conn.query.mock.calls[0][0]).toContain('FOR UPDATE')
    expect(conn.query.mock.calls[2][1]).toEqual([4, 'Rotina', 2, null])
    // sync: revoga tudo, depois upserta com position = índice do array
    expect(conn.query.mock.calls[3][0]).toContain(`deleted = 'S'`)
    expect(conn.query.mock.calls[4][1]).toEqual([4, 12, 0])
    expect(conn.query.mock.calls[5][1]).toEqual([4, 9, 1])
    expect(conn.commit).toHaveBeenCalledTimes(1)
  })

  it('updateModuleCascade ressincroniza na ordem NOVA do array', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE do módulo (vivo)
      .mockResolvedValue([{}])

    await repo.updateModuleCascade(SCHEMA, 3,
      { description: 'Rotina', position: 5, imageIcon: 'store', interfaceIds: [9, 12] } as any)

    const upsert1 = conn.query.mock.calls[2][1]
    const upsert2 = conn.query.mock.calls[3][1]
    expect(upsert1).toEqual([3, 9, 0])
    expect(upsert2).toEqual([3, 12, 1])
    expect(conn.query.mock.calls[2][0]).toContain('ON DUPLICATE KEY UPDATE')
    expect(conn.commit).toHaveBeenCalledTimes(1)
  })

  it('PUT que cruza com DELETE: módulo morto → 404 DENTRO da transação, sem ressuscitar vínculos (gate 2026-08-04)', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([{ affectedRows: 0 }]) // UPDATE não achou vivo

    await expect(repo.updateModuleCascade(SCHEMA, 3,
      { description: 'Rotina', interfaceIds: [9] } as any))
      .rejects.toMatchObject({ statusCode: 404 })

    expect(conn.query).toHaveBeenCalledTimes(1) // sync nunca rodou
    expect(conn.rollback).toHaveBeenCalled()
    expect(conn.commit).not.toHaveBeenCalled()
  })

  it('deleteModuleCascade soft-deleta módulo E vínculos na mesma transação, na MESMA ordem de locks do PUT', async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValue([{}])

    await repo.deleteModuleCascade(SCHEMA, 3)

    expect(conn.query.mock.calls[0][0]).toContain('tb_module ')
    expect(conn.query.mock.calls[1][0]).toContain('tb_module_has_interface')
    expect(conn.commit).toHaveBeenCalledTimes(1)
  })

  it('findIneligibleInterfaceIds aponta só os ids fora da elegibilidade', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 12 }]]) // só a 12 é elegível

    const invalid = await repo.findIneligibleInterfaceIds(SCHEMA, [12, 4, 99])

    expect(invalid).toEqual([4, 99])
  })

  it('schemaName inválido é barrado antes de qualquer SQL', async () => {
    await expect(repo.getModule('central; DROP', 1)).rejects.toMatchObject({ statusCode: 400 })
    expect(mockQuery).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------

describe('modules service', () => {
  it('vínculo com interface não elegível → 422 com os ids em fields[]', async () => {
    const spy = jest.spyOn(repo, 'findIneligibleInterfaceIds').mockResolvedValue([4, 99])

    await expect(createModule(SCHEMA, { description: 'X', interfaceIds: [12, 4, 99] } as any))
      .rejects.toMatchObject({
        statusCode: 422,
        fields: [
          { field: 'interfaceIds', message: '4' },
          { field: 'interfaceIds', message: '99' },
        ],
      })
    spy.mockRestore()
  })

  // Q5 (Valdo, 2026-08-15): contrato revogado DEPOIS do vínculo não pode
  // travar a edição do módulo — o 422 é só para o que o admin adiciona agora.
  it('PUT preserva id JÁ vinculado que perdeu a elegibilidade (só o NOVO é checado)', async () => {
    const spyGet = jest.spyOn(repo, 'getModule')
      .mockResolvedValue({ id: 3, description: 'R', position: 1, imageIcon: null, interfaceIds: [4, 12] })
    const spyInvalid = jest.spyOn(repo, 'findIneligibleInterfaceIds').mockResolvedValue([])
    const spyUpdate = jest.spyOn(repo, 'updateModuleCascade').mockResolvedValue()

    // 4 = vinculada e hoje inelegível (contrato revogado); 7 = tela nova
    await editModule(SCHEMA, 3, { description: 'R', interfaceIds: [4, 12, 7] } as any)

    expect(spyInvalid).toHaveBeenCalledWith(SCHEMA, [7])
    expect(spyUpdate).toHaveBeenCalledWith(SCHEMA, 3,
      expect.objectContaining({ interfaceIds: [4, 12, 7] }))
    spyGet.mockRestore(); spyInvalid.mockRestore(); spyUpdate.mockRestore()
  })

  it('PUT ainda dá 422 quando o id NOVO é inelegível', async () => {
    const spyGet = jest.spyOn(repo, 'getModule')
      .mockResolvedValue({ id: 3, description: 'R', position: 1, imageIcon: null, interfaceIds: [4] })
    const spyInvalid = jest.spyOn(repo, 'findIneligibleInterfaceIds').mockResolvedValue([7])
    const spyUpdate = jest.spyOn(repo, 'updateModuleCascade').mockResolvedValue()

    await expect(editModule(SCHEMA, 3, { description: 'R', interfaceIds: [4, 7] } as any))
      .rejects.toMatchObject({ statusCode: 422, fields: [{ field: 'interfaceIds', message: '7' }] })
    expect(spyUpdate).not.toHaveBeenCalled()
    spyGet.mockRestore(); spyInvalid.mockRestore(); spyUpdate.mockRestore()
  })

  it('POST não herda nada: módulo novo checa TODOS os ids', async () => {
    const spyInvalid = jest.spyOn(repo, 'findIneligibleInterfaceIds').mockResolvedValue([])
    const spyInsert = jest.spyOn(repo, 'insertModuleCascade').mockResolvedValue(9)

    await createModule(SCHEMA, { description: 'N', interfaceIds: [4, 12] } as any)

    expect(spyInvalid).toHaveBeenCalledWith(SCHEMA, [4, 12])
    spyInvalid.mockRestore(); spyInsert.mockRestore()
  })

  it('GET :id inexistente → 404', async () => {
    const spy = jest.spyOn(repo, 'getModule').mockResolvedValue(null)
    await expect(fetchModule(SCHEMA, 77)).rejects.toMatchObject({ statusCode: 404 })
    spy.mockRestore()
  })

  it('editModule valida existência E elegibilidade antes do cascade', async () => {
    const spyGet = jest.spyOn(repo, 'getModule')
      .mockResolvedValue({ id: 3, description: 'R', position: 1, imageIcon: null, interfaceIds: [] })
    const spyInvalid = jest.spyOn(repo, 'findIneligibleInterfaceIds').mockResolvedValue([])
    const spyUpdate = jest.spyOn(repo, 'updateModuleCascade').mockResolvedValue()

    await editModule(SCHEMA, 3, { description: 'R2', interfaceIds: [12] } as any)

    expect(spyUpdate).toHaveBeenCalledWith(SCHEMA, 3,
      expect.objectContaining({ description: 'R2' }))
    spyGet.mockRestore()
    spyInvalid.mockRestore()
    spyUpdate.mockRestore()
  })

  it('removeModule é gracioso: sem checagem de uso — as telas voltam ao group_default', async () => {
    const spyGet = jest.spyOn(repo, 'getModule')
      .mockResolvedValue({ id: 3, description: 'R', position: 1, imageIcon: null, interfaceIds: [12] })
    const spyDel = jest.spyOn(repo, 'deleteModuleCascade').mockResolvedValue()

    await removeModule(SCHEMA, 3)

    expect(spyDel).toHaveBeenCalledWith(SCHEMA, 3)
    spyGet.mockRestore()
    spyDel.mockRestore()
  })
})
