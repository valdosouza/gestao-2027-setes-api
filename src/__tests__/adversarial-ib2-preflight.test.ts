/// <reference types="jest" />
// GATE ADVERSARIAL da IB-2 (2026-10-15) — ADV-IB2-01 (MEDIUM): o PRÉ-VOO (scripts/preflight-ibscbs.ts, D-IB72) promete
// perguntar pelos "conjuntos REAIS por cliente — o que o lote de janeiro vai faturar (pega a divergência da D-IB63)". Mas a
// rotina mensal INJETA os itens do contrato NA OS ABERTA do cliente (trava D5 — service-orders.repository.ts monthlyRun:
// `open_lock = CONCAT(inst,'-',customer)` → insertServiceItem na MESMA ordem), então o conjunto faturado em janeiro é a UNIÃO
// (itens já na OS aberta + itens dos contratos vigentes). O pré-voo pergunta pelos dois conjuntos SEPARADOS (`os:<id>` e
// `ct:<cliente>`) e nunca pela união: OS aberta com um serviço avulso 100501 + contrato 100301 do mesmo cliente = pré-voo
// "0 recusas" e lote de janeiro com 422 INVOICE_SERVICE_MULTI_DECLARATION. Achado CONFIRMADO (vermelho) e CORRIGIDO na sessão:
// o pré-voo agrupa por CLIENTE (OS aberta ∪ contratos vigentes — prompt_fase_ibs_cbs.md §12.8). Fica como guarda de regressão.
const LICENCA = 1      // item avulso já na OS aberta (cIndOp 100501)
const SUPORTE = 2      // item do contrato, injetado em janeiro na MESMA OS (cIndOp 100301)

let finish!: () => void
const finished = new Promise<void>(r => { finish = r })

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: {
    query: jest.fn(async (sql: string) => {
      if (/FROM setes_central\.tb_institution/.test(sql)) return [[{ id: 1, s: 'setes_adv' }]]
      if (/p\.kind = 'S'/.test(sql)) return [[]]                                                   // (a) sem serviços sozinhos
      if (/tb_service_order/.test(sql)) return [[{ orderId: 7869, customerId: 252, productId: LICENCA }]]
      if (/tb_contract/.test(sql)) return [[{ customerId: 252, productId: SUPORTE }]]
      return [[]]
    }),
    end: jest.fn(async () => { finish() }),
  },
}))
jest.mock('../shared/time-zone', () => ({ __esModule: true, todayFor: jest.fn(async () => '2026-11-20') }))
jest.mock('../shared/entity-tax/entity-tax.repository', () => ({
  __esModule: true, emitterRegimeAt: jest.fn(async () => ({ simplesRegime: '3' })),
}))
jest.mock('../shared/ibscbs-classification', () => ({
  __esModule: true, MODEL_NFSE: 'SE',
  ibscbsObligationStart: jest.fn(() => '2027-01-01'),
  classificationAcceptance: jest.fn(async () => ({ classification: true, placeIndicator: true })),
  nbsExists: jest.fn(async () => true),
}))
// a REGRA real recusa a união (D-IB63); cada serviço sozinho declara — o mock reproduz exatamente isso
jest.mock('../shared/service-ibscbs-declaration', () => ({
  __esModule: true,
  evaluateServiceIbscbs: jest.fn(async (_q: unknown, _s: string, _i: number, input: { items: { productId: number }[] }) => {
    const ids = new Set(input.items.map(it => it.productId))
    const divergent = ids.has(LICENCA) && ids.has(SUPORTE)
    return divergent
      ? { declaration: { group: null, nbs: '115011000', omitted: ['divergent'] }, obligatory: true, obligationStart: '2027-01-01',
          refusal: { code: 'INVOICE_SERVICE_MULTI_DECLARATION', message: 'divergente', fields: [] } }
      : { declaration: { group: { classificationCode: '000001', placeIndicatorCode: ids.has(LICENCA) ? '100501' : '100301' }, nbs: '115011000', omitted: [] },
          obligatory: true, obligationStart: '2027-01-01', refusal: null }
  }),
}))

describe('ADV-IB2-01 — pré-voo × conjunto REAL do lote de janeiro (D-IB72/D-IB63)', () => {
  it('OS aberta (avulso 100501) + contrato do mesmo cliente (100301): o pré-voo pergunta pela UNIÃO e conta a recusa', async () => {
    const lines: string[] = []
    const log = jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any)
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      // o mock é lido DENTRO do registro isolado (fora dele é outra instância, sem as chamadas do script)
      let evaluateServiceIbscbs!: jest.Mock
      jest.isolateModules(() => {
        evaluateServiceIbscbs = require('../shared/service-ibscbs-declaration').evaluateServiceIbscbs
        require('../../scripts/preflight-ibscbs')
      })
      await finished
      const asked: number[][] = (evaluateServiceIbscbs as jest.Mock).mock.calls.map(c => c[3].items.map((it: any) => it.productId).sort())
      const total = lines.find(l => l.startsWith('\nRecusas') || l.includes('Recusas (422)')) ?? ''
      expect({ askedUnion: asked.some(ids => ids.includes(LICENCA) && ids.includes(SUPORTE)), total })
        .toEqual({ askedUnion: true, total: expect.stringContaining('Recusas (422) na data perguntada: 1') })
    } finally { log.mockRestore(); exit.mockRestore(); err.mockRestore() }
  })
})
