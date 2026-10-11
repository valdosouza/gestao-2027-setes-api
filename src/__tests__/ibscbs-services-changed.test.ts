/// <reference types="jest" />
// D-IB30 (Rodada 3 da fase IBS/CBS, Valdo 2026-10-10 — precedente D-G34): o salvar do serviço
// reconfere só a NBS/classificação que MUDOU em relação ao gravado; a inalterada que venceu não
// bloqueia uma edição de preço (quem barra a vencida é o faturamento — D-IB8, IB-2).
import pool from '../shared/db/connection'
import * as svcRepo from '../modules/services/services.repository'
import { assertServiceClassification, nbsAcceptedSql } from '../shared/ibscbs-classification'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))
jest.mock('../shared/time-zone', () => ({ todayFor: jest.fn(async () => '2026-10-10') }))
jest.mock('../shared/ibscbs-classification', () => ({
  ...jest.requireActual('../shared/ibscbs-classification'),
  assertServiceClassification: jest.fn(async () => undefined),
}))

const mockAssert = assertServiceClassification as jest.Mock
const mockGetConnection = (pool as any).getConnection as jest.Mock

/** Conexão do PUT: serviço 7 existe; gravado = NBS 115022000 + 000001/100301. */
function conn(stored: { nbs: string | null; c?: string; p?: string }) {
  const c: any = {
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    query: jest.fn(async (sql: string) => {
      if (/SELECT identifier FROM/.test(sql)) return [[{ identifier: '7' }]]
      if (/SELECT 1 FROM/.test(sql)) return [[{ 1: 1 }]]
      if (/SELECT nbs FROM/.test(sql)) return [[{ nbs: stored.nbs }]]
      if (/SELECT classification_code AS c/.test(sql)) return [stored.c ? [{ c: stored.c, p: stored.p }] : []]
      return [{ affectedRows: 1 }]
    }),
  }
  mockGetConnection.mockResolvedValue(c)
  return c
}

const body = (over: Record<string, unknown> = {}) => ({
  description: 'Mensalidade', categoryId: 1, prices: [{ priceListId: 1, priceTag: 120 }],
  nbs: '115022000', ibscbs: { classificationCode: '000001', placeIndicatorCode: '100301' }, ...over,
}) as any

beforeEach(() => jest.clearAllMocks())

describe('D-IB30 — o salvar reconfere só o que mudou', () => {
  it('PUT que só mexe no preço (NBS e classificação iguais ao gravado) NÃO reconfere o catálogo', async () => {
    conn({ nbs: '115022000', c: '000001', p: '100301' })
    expect(await svcRepo.updateService(7, body(), 'setes_setes', 1, 1)).toBe(true)
    expect(mockAssert).not.toHaveBeenCalled()
  })

  // gate adversarial do delta: por COMPONENTE — trocar só o cIndOp não reconfere o cClassTrib inalterado
  it('PUT que troca só o cIndOp reconfere só o cIndOp (nem o cClassTrib nem a NBS inalterados)', async () => {
    const c = conn({ nbs: '115022000', c: '000001', p: '100301' })
    await svcRepo.updateService(7, body({ ibscbs: { classificationCode: '000001', placeIndicatorCode: '100302' } }), 'setes_setes', 1, 1)
    expect(mockAssert).toHaveBeenCalledTimes(1)
    expect(mockAssert).toHaveBeenCalledWith(c,
      { nbs: undefined, ibscbs: { classificationCode: '000001', placeIndicatorCode: '100302' } }, '2026-10-10',
      undefined, { classification: false, placeIndicator: true })
  })

  it('PUT que troca a NBS reconfere só a NBS; serviço sem classificação gravada reconfere o par', async () => {
    const c = conn({ nbs: '115021000' })
    await svcRepo.updateService(7, body(), 'setes_setes', 1, 1)
    expect(mockAssert).toHaveBeenCalledWith(c, {
      nbs: '115022000', ibscbs: { classificationCode: '000001', placeIndicatorCode: '100301' },
    }, '2026-10-10', undefined, { classification: true, placeIndicator: true })
  })

  // gate adversarial do delta R5 (caso não testado): limpar a NBS e reenviar a MESMA = mudou → reconfere
  it('PUT que devolve a NBS a um serviço que estava sem NBS reconfere a NBS (limpar e reenviar não contorna)', async () => {
    const c = conn({ nbs: null, c: '000001', p: '100301' })
    await svcRepo.updateService(7, body(), 'setes_setes', 1, 1)
    expect(mockAssert).toHaveBeenCalledTimes(1)
    // par inalterado: não vai ao assert (ibscbs undefined) e o checks do par nem é montado
    expect(mockAssert).toHaveBeenCalledWith(c, { nbs: '115022000', ibscbs: undefined }, '2026-10-10', undefined, undefined)
  })

  it('POST (serviço novo) confere tudo o que veio', async () => {
    const c: any = {
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        if (/SELECT 1 FROM/.test(sql)) return [[{ 1: 1 }]]
        if (/MAX\(id\)/.test(sql)) return [[{ nextId: 50 }]]
        return [{ affectedRows: 1 }]
      }),
    }
    mockGetConnection.mockResolvedValue(c)
    await svcRepo.insertService(body(), 'setes_setes', 1, 1)
    // serviço novo: sem checks = confere os dois códigos
    expect(mockAssert).toHaveBeenCalledWith(c, {
      nbs: '115022000', ibscbs: { classificationCode: '000001', placeIndicatorCode: '100301' },
    }, '2026-10-10', undefined, undefined)
  })
})

// D-IB40 (Rodada 5, Valdo 2026-10-10): o GET diz se a NBS gravada segue na lista oficial (selo na aba)
describe('D-IB40 — nbsAcceptedToday no GET', () => {
  const mockQuery = (pool as any).query as jest.Mock
  const row = (over: Record<string, unknown>) => ({
    id: 7, identifier: '7', description: 'Mensalidade', categoryId: 1, active: 'S',
    nbs: '115022000', nbsDescription: 'Desenvolvimento', ibsClassificationCode: null, ...over,
  })
  it('NBS fora da lista oficial = false (a descrição segue exibida); presente = true; sem NBS = null', async () => {
    for (const [flag, expected] of [[0, false], [1, true], [null, null]] as const) {
      mockQuery.mockReset()
      mockQuery.mockResolvedValueOnce([[row({ nbsAcceptedToday: flag, ...(flag === null ? { nbs: null } : {}) })]])
      mockQuery.mockResolvedValueOnce([[]])   // grade de preços
      const s = await svcRepo.getService(7, 'setes_setes', 1, '2026-10-10')
      expect(s?.nbsAcceptedToday).toBe(expected)
      if (flag === 0) expect(s?.nbsDescription).toBe('Desenvolvimento')
    }
  })

  // gate socrático do delta R5: o SQL do GET é o que decide — o teste acima só lê a coluna pronta
  it('SQL: o JOIN com tb_nbs NÃO filtra deleted (descrição da NBS que saiu segue) e o selo usa a regra da peça', async () => {
    mockQuery.mockReset()
    mockQuery.mockResolvedValueOnce([[row({ nbsAcceptedToday: 0 })]])
    mockQuery.mockResolvedValueOnce([[]])
    await svcRepo.getService(7, 'setes_setes', 1, '2026-10-10')
    const sql = String(mockQuery.mock.calls[0][0])
    const join = sql.match(/LEFT JOIN setes_central\.tb_nbs nb ON ([\s\S]*?)\n\s*LEFT JOIN/)
    expect(join?.[1].trim()).toBe('nb.code = sv.nbs')
    expect(sql).toContain(`WHEN ${nbsAcceptedSql('nb')} THEN 1 ELSE 0 END AS nbsAcceptedToday`)
  })
})
