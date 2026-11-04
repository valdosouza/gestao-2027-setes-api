/// <reference types="jest" />
// Correções do gate do DELTA FINAL do item 0 (2026-11-04 — prompt_endurecer_autenticacao.md §P.9): (1) a leitura da zona do aviso ao Super
// tem teto próprio (roda depois do COMMIT e antes do aviso — com o banco travado segurava a senha sem limite, fora do teto da D-EA24);
// (2) a lista dos Supers recusa a lista de e-mails CORTADA pelo group_concat_max_len (MySQL 8 padrão = 1024), nunca a lê pela metade.
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))

import { setesInstitutionZone, listSuperAccounts } from '../modules/auth/super-password-reset'
import { DEFAULT_TIME_ZONE } from '../shared/time-zone'
import logger from '../shared/logger/logger'

describe('teto da leitura da zona do aviso ao Super', () => {
  it('banco que não responde: devolve a zona padrão no teto, com aviso no log, sem rejeição solta', async () => {
    const hang = { query: jest.fn(() => new Promise<never>(() => undefined)) }
    const t0 = Date.now()
    await expect(setesInstitutionZone(hang as any, 50)).resolves.toBe(DEFAULT_TIME_ZONE)
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/sem resposta em/))
  })

  it('banco que falha: zona padrão (como antes)', async () => {
    const boom = { query: jest.fn(async () => { throw new Error('ECONNRESET') }) }
    await expect(setesInstitutionZone(boom as any, 1_000)).resolves.toBe(DEFAULT_TIME_ZONE)
  })
})

describe('lista dos Supers × group_concat_max_len', () => {
  const conn = (rows: any[]) => ({ query: jest.fn(async () => [rows]) })

  it('lista que atinge o limite do servidor = recusa alta (nunca o e-mail truncado que ainda passa no validador)', async () => {
    const cut = 'x'.repeat(1012) + '\nana@setes.co'                    // 1024 bytes = o limite — "ana@setes.com.br" cortado
    await expect(listSuperAccounts(conn([{ id: 7, active: 'S', gcMax: 1024, loginEmails: cut }]) as any))
      .rejects.toThrow(/CORTADA pelo group_concat_max_len \(1024\)/)
  })

  it('abaixo do limite: escolhe pela peça, como sempre', async () => {
    const rows = [{ id: 7, active: 'S', gcMax: 1024, loginEmails: 'lixo; x@y.com\nvaldo@setes.com.br' }]
    await expect(listSuperAccounts(conn(rows) as any)).resolves.toEqual([{ id: 7, active: 'S', loginEmail: 'valdo@setes.com.br' }])
  })
})
