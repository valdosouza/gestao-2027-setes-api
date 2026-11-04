/// <reference types="jest" />
// Fase IBS/CBS, IB-3 no ERP (prompt_fase_ibs_cbs.md §13.3 — D-IB76): a declaração PREVISTA antes de faturar (a MESMA composição da IB-2,
// só-pergunta, na data de hoje do estabelecimento) e a CONGELADA lida do ramo da nota faturada. Nada aqui decide o faturamento.
import { previewServiceIbscbs } from '../shared/service-ibscbs-declaration'
import { readFrozenIbscbs } from '../shared/invoice'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn() } }))

/** Banco simulado: presunção (3 leituras) → enquadramento → catálogo (o fuso vem do mock global do `todayFor`). */
function fakeDb(presumption: { nbs?: string | null; c?: string; p?: string }, regime: string | null = '3') {
  return {
    query: jest.fn(async (sql: string, params: any = []) => {
      if (/tb_service_ibscbs si/.test(sql)) return [presumption.c ? [{ id: 40, c: presumption.c, p: presumption.p }] : []]
      if (/tb_service sv/.test(sql)) return [[{ id: 40, nbs: presumption.nbs ?? null }]]
      if (/tb_product p/.test(sql)) return [[{ productId: 40, description: 'Suporte mensal' }]]
      if (/simples_regime/.test(sql)) return [[{ simplesRegime: regime }]]
      if (/tb_tax_ibscbs_classification_validity/.test(sql)) {
        return [[{ code: params[1][0], cst: '000', name: 'x', validFrom: '2026-01-01', validUntil: null, requiresRegular: 'N', absentSince: null, applicable: 1, requiresGroup: 'S' }]]
      }
      if (/tb_ibscbs_place_indicator/.test(sql)) return [[{ code: params[1], description: 'oneroso', applicable: 1 }]]
      if (/tb_nbs/.test(sql)) return [[{ ok: 1 }]]
      throw new Error(`SQL inesperado: ${sql}`)
    }),
  }
}
// o "hoje" do estabelecimento: o setup global do jest simula `todayFor` (test-setup/time-zone.mock.ts) — a data é fixada por ele
const at = <T>(isoDay: string, fn: () => Promise<T>) => {
  ;(jest.requireMock('@shared/time-zone') as any).todayFor.mockResolvedValueOnce(isoDay)
  return fn()
}

describe('previewServiceIbscbs (D-IB76) — a prévia pela MESMA composição do faturamento', () => {
  it('sem serviço = null e NENHUMA consulta (nem o fuso)', async () => {
    const q = fakeDb({})
    const tz = jest.requireMock('@shared/time-zone') as any
    tz.todayFor.mockClear()
    expect(await previewServiceIbscbs(q, 'setes_setes', 1, [])).toBeNull()
    expect(q.query).not.toHaveBeenCalled()
    expect(tz.todayFor).not.toHaveBeenCalled()
  })

  it('dezembro, serviço sem classificação: AVISO (a nota sairia sem o grupo), sem recusa — na data de HOJE do estabelecimento', async () => {
    const p = await at('2026-12-20', () => previewServiceIbscbs(fakeDb({ nbs: '115021000' }), 'setes_setes', 1, [40, 40]))
    expect(p).toMatchObject({ competenceDate: '2026-12-20', obligationStart: '2027-01-01', obligatory: false, declared: false,
      omitted: ['not-classified'], refusal: null })
  })

  it('D-IB89: antes da obrigação a prévia traz o veredito NA DATA DA OBRIGAÇÃO (o que o lote de janeiro vai encontrar)', async () => {
    const p = await at('2026-12-20', () => previewServiceIbscbs(fakeDb({ nbs: '115021000' }), 'setes_setes', 1, [40]))
    expect(p?.atObligation).toEqual({ declared: false, omitted: ['not-classified'],
      refusal: { code: 'INVOICE_SERVICE_IBSCBS_REQUIRED', message: expect.stringMatching(/obrigatória desde 2027-01-01/) } })
    const ok = await at('2026-12-20', () => previewServiceIbscbs(fakeDb({ nbs: '115021000', c: '000001', p: '100301' }), 'setes_setes', 1, [40]))
    expect(ok?.atObligation).toEqual({ declared: true, omitted: [], refusal: null })
  })

  it('D-IB89: depois da obrigação não há 2º veredito (o de hoje já é ele)', async () => {
    const p = await at('2027-01-05', () => previewServiceIbscbs(fakeDb({ nbs: '115021000' }), 'setes_setes', 1, [40]))
    expect(p?.atObligation).toBeNull()
  })

  it('janeiro, o mesmo serviço: a recusa que o faturamento daria (mesmo código/texto do 422)', async () => {
    const p = await at('2027-01-05', () => previewServiceIbscbs(fakeDb({ nbs: '115021000' }), 'setes_setes', 1, [40]))
    expect(p?.obligatory).toBe(true)
    expect(p?.refusal).toEqual({ code: 'INVOICE_SERVICE_IBSCBS_REQUIRED', message: expect.stringMatching(/obrigatória desde 2027-01-01/) })
  })

  it('serviço classificado + NBS: declarado; a prévia NÃO trava (só-pergunta)', async () => {
    const q = fakeDb({ nbs: '115021000', c: '000001', p: '100301' })
    const p = await at('2027-01-05', () => previewServiceIbscbs(q, 'setes_setes', 1, [40]))
    expect(p).toMatchObject({ declared: true, omitted: [], refusal: null })
    for (const c of q.query.mock.calls) expect(String(c[0])).not.toMatch(/LOCK IN SHARE MODE|FOR UPDATE/)
  })
})

describe('readFrozenIbscbs (D-IB76) — a declaração CONGELADA no ramo da nota faturada', () => {
  it('lê as 3 colunas do ramo VIVO; sem ramo = null; nunca recalcula', async () => {
    const q = { query: jest.fn()
      .mockResolvedValueOnce([[{ classificationCode: '000001', placeIndicatorCode: '100301', nbs: '115021000' }]])
      .mockResolvedValueOnce([[{ classificationCode: null, placeIndicatorCode: null, nbs: '115021000' }]])
      .mockResolvedValueOnce([[]]) }
    expect(await readFrozenIbscbs(q, 'setes_setes', 1, 7000, 3)).toEqual({ classificationCode: '000001', placeIndicatorCode: '100301', nbs: '115021000' })
    expect(q.query.mock.calls[0][0]).toMatch(/FROM `setes_setes`\.tb_invoice_service[\s\S]*terminal = \?[\s\S]*deleted = 'N'/)
    expect(q.query.mock.calls[0][1]).toEqual([7000, 1, 3])                // L6: o terminal do ramo, nunca 0 fixo
    expect(await readFrozenIbscbs(q, 'setes_setes', 1, 7000, 0)).toEqual({ classificationCode: null, placeIndicatorCode: null, nbs: '115021000' })
    expect(await readFrozenIbscbs(q, 'setes_setes', 1, 7000, 0)).toBeNull()
    await expect(readFrozenIbscbs(q, 'x`; DROP', 1, 1, 0)).rejects.toThrow(/schema/)
  })
})
