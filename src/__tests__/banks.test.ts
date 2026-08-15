/// <reference types="jest" />
// Cadastro de Bancos (fecho da decisão 8 da Fase 3 — Valdo 2026-08-04):
// catálogo FEBRABAN GERAL da central, sem cadeia fiscal. id interno MAX+1;
// number digitado, ÚNICO mesmo contra excluído (o UNIQUE do DDL não enxerga
// soft delete); number editável no PUT (não é a PK — contas apontam pro id).
import pool from '../shared/db/connection'
import * as banksRepo from '../modules/banks/banks.repository'
import { bankCreateDto } from '../modules/banks/banks.dto'
import {
  createBank, editBank, fetchBank, removeBank,
} from '../modules/banks/banks.service'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockQuery = (pool as any).query as jest.Mock

beforeEach(() => jest.clearAllMocks())

// ---------------------------------------------------------------------
// Repositório
// ---------------------------------------------------------------------

describe('banks repository', () => {
  it('listBanks: página e COUNT usam a MESMA where (D2) com desempate por id (D8)', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 1, number: '001', description: 'Banco do Brasil' }]])
      .mockResolvedValueOnce([[{ total: 24 }]])

    const result = await banksRepo.listBanks(
      { filter: 'bra', page: 2, pageSize: 10, offset: 10 })

    expect(result.total).toBe(24)
    const pageSql  = mockQuery.mock.calls[0][0] as string
    const countSql = mockQuery.mock.calls[1][0] as string
    const whereOf = (sql: string) => sql.slice(sql.indexOf('FROM'))
    expect(countSql).toContain(whereOf(pageSql).split('ORDER BY')[0].trim().split('\n')[0])
    expect(pageSql).toContain('ORDER BY number, id')
    expect(mockQuery.mock.calls[0][1]).toEqual(
      ['%bra%', '%bra%', '%bra%', 10, 10])
    expect(mockQuery.mock.calls[1][1]).toEqual(['%bra%', '%bra%', '%bra%'])
  })

  it('bankNumberExists enxerga tambem deleted=S (sem filtro de soft delete)', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 9 }]])
    const exists = await banksRepo.bankNumberExists('341')
    expect(exists).toBe(true)
    expect(mockQuery.mock.calls[0][0]).not.toContain('deleted')
  })

  it('insertBank gera id MAX+1 em TRANSAÇÃO com FOR UPDATE (gate 2026-08-04)', async () => {
    const conn = {
      beginTransaction: jest.fn(), query: jest.fn(),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[{ nextId: 24 }]])
      .mockResolvedValueOnce([{}])

    const id = await banksRepo.insertBank('336', 'C6 Bank')

    expect(id).toBe(24)
    expect(conn.query.mock.calls[0][0]).toContain('FOR UPDATE')
    expect(conn.query.mock.calls[1][1]).toEqual([24, '336', 'C6 Bank'])
    expect(conn.commit).toHaveBeenCalled()
    expect(conn.release).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------
// DTO — achados do gate adversarial 2026-08-04 fixados como teste
// ---------------------------------------------------------------------

describe('banks dto', () => {
  it("number '000' rejeitado (não existe na FEBRABAN; number não se reaproveita)", () => {
    expect(bankCreateDto.safeParse({ number: '000', description: 'X' }).success).toBe(false)
  })

  it('description só de espaços rejeitada (trim antes do min)', () => {
    expect(bankCreateDto.safeParse({ number: '341', description: '   ' }).success).toBe(false)
  })

  it('description é aparada no parse (banco recebe sem bordas)', () => {
    const parsed = bankCreateDto.safeParse({ number: '341', description: '  Itaú  ' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.description).toBe('Itaú')
  })
})

// ---------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------

describe('banks service', () => {
  it('createBank: number VIVO → 409 com field number', async () => {
    const spy = jest.spyOn(banksRepo, 'getBankByNumber')
      .mockResolvedValue({ id: 14, deleted: 'N' })

    await expect(createBank('341', 'Itaú')).rejects.toMatchObject({
      statusCode: 409,
      fields: [{ field: 'number', message: 'Número já cadastrado' }],
    })
    spy.mockRestore()
  })

  it('createBank: number EXCLUÍDO revive a MESMA linha (id preservado — decisão Valdo 2026-08-04)', async () => {
    const spyGet = jest.spyOn(banksRepo, 'getBankByNumber')
      .mockResolvedValue({ id: 14, deleted: 'S' })
    const spyRevive = jest.spyOn(banksRepo, 'reviveBank').mockResolvedValue()
    const spyInsert = jest.spyOn(banksRepo, 'insertBank')

    await expect(createBank('341', 'Itaú Unibanco')).resolves.toEqual({ id: 14 })

    expect(spyRevive).toHaveBeenCalledWith(14, 'Itaú Unibanco')
    expect(spyInsert).not.toHaveBeenCalled()
    spyGet.mockRestore()
    spyRevive.mockRestore()
    spyInsert.mockRestore()
  })

  it('createBank: corrida ER_DUP_ENTRY entre a checagem e o INSERT vira 409', async () => {
    const spyGet = jest.spyOn(banksRepo, 'getBankByNumber').mockResolvedValue(null)
    const spyInsert = jest.spyOn(banksRepo, 'insertBank')
      .mockRejectedValue({ code: 'ER_DUP_ENTRY' })

    await expect(createBank('341', 'Itaú')).rejects.toMatchObject({ statusCode: 409 })
    spyGet.mockRestore()
    spyInsert.mockRestore()
  })

  it('createBank feliz devolve o id gerado', async () => {
    const spyGet = jest.spyOn(banksRepo, 'getBankByNumber').mockResolvedValue(null)
    const spyInsert = jest.spyOn(banksRepo, 'insertBank').mockResolvedValue(24)

    await expect(createBank('336', 'C6 Bank')).resolves.toEqual({ id: 24 })
    spyGet.mockRestore()
    spyInsert.mockRestore()
  })

  it('editBank: banco inexistente → 404 antes de validar o number', async () => {
    const spyGet = jest.spyOn(banksRepo, 'getBank').mockResolvedValue(null)
    const spyExists = jest.spyOn(banksRepo, 'bankNumberExists')

    await expect(editBank(99, '341', 'Itaú')).rejects.toMatchObject({ statusCode: 404 })
    expect(spyExists).not.toHaveBeenCalled()
    spyGet.mockRestore()
    spyExists.mockRestore()
  })

  it('editBank: unicidade do number IGNORA o próprio registro (excludeId)', async () => {
    const spyGet = jest.spyOn(banksRepo, 'getBank')
      .mockResolvedValue({ id: 14, number: '341', description: 'Itaú' })
    const spyExists = jest.spyOn(banksRepo, 'bankNumberExists').mockResolvedValue(false)
    const spyUpdate = jest.spyOn(banksRepo, 'updateBank').mockResolvedValue()

    await editBank(14, '341', 'Itaú Unibanco')

    expect(spyExists).toHaveBeenCalledWith('341', 14)
    expect(spyUpdate).toHaveBeenCalledWith(14, '341', 'Itaú Unibanco')
    spyGet.mockRestore()
    spyExists.mockRestore()
    spyUpdate.mockRestore()
  })

  it('editBank: number de OUTRO banco → 409', async () => {
    const spyGet = jest.spyOn(banksRepo, 'getBank')
      .mockResolvedValue({ id: 14, number: '341', description: 'Itaú' })
    const spyExists = jest.spyOn(banksRepo, 'bankNumberExists').mockResolvedValue(true)

    await expect(editBank(14, '001', 'Itaú')).rejects.toMatchObject({ statusCode: 409 })
    spyGet.mockRestore()
    spyExists.mockRestore()
  })

  it('fetchBank inexistente → 404', async () => {
    const spy = jest.spyOn(banksRepo, 'getBank').mockResolvedValue(null)
    await expect(fetchBank(99)).rejects.toMatchObject({ statusCode: 404 })
    spy.mockRestore()
  })

  it('removeBank exige existência (404) antes do soft delete', async () => {
    const spyGet = jest.spyOn(banksRepo, 'getBank').mockResolvedValue(null)
    const spyDel = jest.spyOn(banksRepo, 'deleteBank')

    await expect(removeBank(99)).rejects.toMatchObject({ statusCode: 404 })
    expect(spyDel).not.toHaveBeenCalled()
    spyGet.mockRestore()
    spyDel.mockRestore()
  })

  it('removeBank: banco EM USO por conta corrente → 409 BANK_IN_USE sem deletar (achado HIGH do gate)', async () => {
    const spyGet = jest.spyOn(banksRepo, 'getBank')
      .mockResolvedValue({ id: 14, number: '341', description: 'Itaú' })
    const spyUsage = jest.spyOn(banksRepo, 'listBankUsage')
      .mockResolvedValue(['setes_acme', 'setes_genio'])
    const spyDel = jest.spyOn(banksRepo, 'deleteBank')

    await expect(removeBank(14)).rejects.toMatchObject({
      statusCode: 409, code: 'BANK_IN_USE',
    })
    expect(spyDel).not.toHaveBeenCalled()
    spyGet.mockRestore()
    spyUsage.mockRestore()
    spyDel.mockRestore()
  })

  it('removeBank: banco sem uso soft-deleta normalmente', async () => {
    const spyGet = jest.spyOn(banksRepo, 'getBank')
      .mockResolvedValue({ id: 20, number: '655', description: 'BV' })
    const spyUsage = jest.spyOn(banksRepo, 'listBankUsage').mockResolvedValue([])
    const spyDel = jest.spyOn(banksRepo, 'deleteBank').mockResolvedValue()

    await removeBank(20)

    expect(spyDel).toHaveBeenCalledWith(20)
    spyGet.mockRestore()
    spyUsage.mockRestore()
    spyDel.mockRestore()
  })
})
