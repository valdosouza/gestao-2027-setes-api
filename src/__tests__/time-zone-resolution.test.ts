/// <reference types="jest" />
// C1 do gate socrático da onda TZ-1 (2026-09-30): a zona do estabelecimento é lida
// pela CONEXÃO DA TRANSAÇÃO quando ela é passada — nunca por uma 2ª conexão do pool
// (padrão que já travou a API: 20 transações segurando as 20 conexões à espera de
// uma 21ª). O mock global (test-setup) substitui exatamente estas funções; aqui a
// implementação REAL é exercitada.
import pool from '../shared/db/connection'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const real = jest.requireActual('../shared/time-zone') as typeof import('../shared/time-zone')
const poolQuery = (pool as any).query as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  real.invalidateInstitutionZone()
})

describe('resolução real da zona (C1)', () => {
  it('com a conexão da transação: UMA consulta por ela e ZERO no pool', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[{ zone: 'America/Manaus' }]]) }
    const today = await real.todayFor('setes_acme', 7, conn, new Date('2026-10-01T03:30:00Z'))
    expect(today).toBe('2026-09-30')                       // 23h30 em Manaus
    expect(conn.query).toHaveBeenCalledTimes(1)
    expect(String(conn.query.mock.calls[0][0])).toMatch(/tb_institution_has_config/)
    expect(conn.query.mock.calls[0][1]).toEqual([7])
    expect(poolQuery).not.toHaveBeenCalled()
  })

  it('cache por institution: a 2ª leitura não vai ao banco', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[{ zone: 'America/Rio_Branco' }]]) }
    await real.institutionZoneFor('setes_acme', 7, conn)
    expect(await real.institutionZoneFor('setes_acme', 7, conn)).toBe('America/Rio_Branco')
    expect(conn.query).toHaveBeenCalledTimes(1)
    real.invalidateInstitutionZone('setes_acme', 7)
    await real.institutionZoneFor('setes_acme', 7, conn)
    expect(conn.query).toHaveBeenCalledTimes(2)
  })

  it('sem conexão (fora de transação) usa o pool', async () => {
    poolQuery.mockResolvedValue([[{ zone: 'America/Noronha' }]])
    expect(await real.institutionZoneFor('setes_acme', 8)).toBe('America/Noronha')
    expect(poolQuery).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['vazia', ''], ['inválida', 'Marte/Olympus'], ['nula', null], ['injeção', "x'; DROP TABLE t; --"],
  ])('config %s → default America/Sao_Paulo', async (_l, zone) => {
    const conn = { query: jest.fn().mockResolvedValue([[{ zone }]]) }
    expect(await real.institutionZoneFor('setes_acme', 9, conn)).toBe('America/Sao_Paulo')
  })

  it('catálogo sem a config (seed 60 não aplicado) → default, sem erro', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[]]) }
    expect(await real.institutionZoneFor('setes_acme', 10, conn)).toBe('America/Sao_Paulo')
  })

  it('schema inválido nunca vira SQL', async () => {
    const conn = { query: jest.fn() }
    expect(await real.institutionZoneFor('x`; DROP', 11, conn)).toBe('America/Sao_Paulo')
    expect(conn.query).not.toHaveBeenCalled()
  })
})

describe('Q-TZ8 — relógio ÚNICO por operação', () => {
  it('todo "hoje" da operação usa o instante capturado na entrada, mesmo após awaits', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[{ zone: 'America/Sao_Paulo' }]]) }
    const entrada = new Date('2026-10-01T02:59:59Z')          // 30/09 23:59:59 em Brasília
    const dias = await real.runWithOperationClock(entrada, async () => {
      const a = await real.todayFor('setes_acme', 20, conn)
      await new Promise(r => setTimeout(r, 5))                  // o relógio real anda…
      const b = await real.todayFor('setes_acme', 20, conn)
      return [a, b, real.operationNow()?.toISOString()]
    })
    expect(dias).toEqual(['2026-09-30', '2026-09-30', '2026-10-01T02:59:59.000Z'])
  })

  it('operações concorrentes não vazam relógio uma para a outra', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[{ zone: 'America/Sao_Paulo' }]]) }
    const [x, y] = await Promise.all([
      real.runWithOperationClock(new Date('2026-10-01T02:59:59Z'), async () => {
        await new Promise(r => setTimeout(r, 10)); return real.todayFor('setes_acme', 21, conn)
      }),
      real.runWithOperationClock(new Date('2026-10-01T03:00:01Z'), async () => real.todayFor('setes_acme', 21, conn)),
    ])
    expect([x, y]).toEqual(['2026-09-30', '2026-10-01'])
  })

  it('fora de operação (rotina/script) usa o agora real', () => {
    expect(real.operationNow()).toBeNull()
  })
})

describe('Q-TZ9 — relógio POR ORDEM dentro do lote', () => {
  it('o relógio de cada ordem sobrepõe o da requisição; ao sair, volta o da requisição', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[{ zone: 'America/Sao_Paulo' }]]) }
    const requisicao = new Date('2026-10-01T02:50:00Z')        // 30/09 23:50 em Brasília
    const r = await real.runWithOperationClock(requisicao, async () => {
      const ordem1 = await real.runWithOperationClock(new Date('2026-10-01T02:55:00Z'), () => real.todayFor('setes_acme', 30, conn))
      const ordem2 = await real.runWithOperationClock(new Date('2026-10-01T03:05:00Z'), () => real.todayFor('setes_acme', 30, conn))
      const depois = await real.todayFor('setes_acme', 30, conn)
      return [ordem1, ordem2, depois]
    })
    expect(r).toEqual(['2026-09-30', '2026-10-01', '2026-09-30'])
  })

  it('guarda contra o mundo externo passa o AGORA real e ignora o relógio congelado', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[{ zone: 'America/Sao_Paulo' }]]) }
    const real0 = new Date('2026-10-01T03:30:00Z')            // já é 01/10 em Brasília
    const d = await real.runWithOperationClock(new Date('2026-10-01T02:50:00Z'),
      () => real.todayFor('setes_acme', 31, conn, real0))
    expect(d).toBe('2026-10-01')
  })
})
