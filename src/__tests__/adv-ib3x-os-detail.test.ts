/// <reference types="jest" />
// GATE ADVERSARIAL da IB-3 (D-IB76 — prompt_fase_ibs_cbs.md §13.3; skill testar-adversarial.md): a COMPOSIÇÃO do bloco `ibscbs` no
// GET /api/service-orders/:id (`fetchOrder` → `ibscbsOfOrder`) não tinha teste — só as duas peças isoladas. Este arquivo fixa as
// invariantes que a sonda em schema descartável (setes_adv_ib3x_*) confirmou no banco real:
//   - OS ABERTA com itens = só a PREVISTA (nunca lê o ramo da nota) — pedida com os produtos dos itens;
//   - OS faturada/cancelada = só a CONGELADA (a prévia NUNCA roda: a faturada nunca é recalculada — D-IB41/D-IB76);
//   - sem itens, sem nota ou peça sem nada a mostrar = `ibscbs: null` (o app não mostra cartão);
//   - OS de outra institution = 404 antes de qualquer leitura IBS/CBS.
import { fetchOrder } from '../modules/service-orders/service-orders.service'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn() } }))
jest.mock('../modules/service-orders/service-orders.repository', () => ({
  __esModule: true,
  ...jest.requireActual('../modules/service-orders/service-orders.repository'),
  getOrder: jest.fn(),
}))
jest.mock('../shared/service-ibscbs-declaration', () => ({ __esModule: true, previewServiceIbscbs: jest.fn() }))
jest.mock('../shared/invoice', () => ({
  __esModule: true,
  ...jest.requireActual('../shared/invoice'),
  readFrozenIbscbs: jest.fn(),
}))

const repo = jest.requireMock('../modules/service-orders/service-orders.repository') as any
const decl = jest.requireMock('../shared/service-ibscbs-declaration') as any
const inv = jest.requireMock('../shared/invoice') as any

const scope = { schemaName: 'setes_setes', institutionId: 1, userId: 1 }
const PREVIEW = { competenceDate: '2026-10-15', obligationStart: '2027-01-01', obligatory: false, declared: true, omitted: [], refusal: null }
const FROZEN = { classificationCode: '000001', placeIndicatorCode: '100301', nbs: '115021000' }
const order = (status: string, items: number[], invoiceNumber: string | null) => ({
  id: 500, number: 9500, customerId: 7, customerName: 'x', status, dtRecord: '2026-10-01',
  items: items.map((productId, i) => ({ id: i + 1, productId, productDescription: 's', quantity: 1, unitValue: 10, discountValue: 0, total: 10 })),
  totalValue: 10, invoiceNumber, dtEmission: invoiceNumber ? '2026-10-15' : null, terminal: 0,
})

beforeEach(() => {
  repo.getOrder.mockReset(); decl.previewServiceIbscbs.mockReset(); inv.readFrozenIbscbs.mockReset()
  decl.previewServiceIbscbs.mockResolvedValue(PREVIEW)
  inv.readFrozenIbscbs.mockResolvedValue(FROZEN)
})

describe('ADV-IB3X — composição do bloco ibscbs no detalhe da OS', () => {
  it('aberta com itens: só a PREVISTA, pedida com os produtos dos itens; o ramo da nota nunca é lido', async () => {
    repo.getOrder.mockResolvedValue(order('A', [40, 41, 40], null))
    const r = await fetchOrder(500, scope)
    expect(r.ibscbs).toEqual({ preview: PREVIEW, frozen: null })
    expect(r).not.toHaveProperty('terminal')                        // o terminal liga a OS à nota — não vai ao JSON
    expect(decl.previewServiceIbscbs).toHaveBeenCalledWith(expect.anything(), 'setes_setes', 1, [40, 41, 40])
    expect(inv.readFrozenIbscbs).not.toHaveBeenCalled()
  })

  it('aberta sem itens: null e NENHUMA leitura IBS/CBS', async () => {
    repo.getOrder.mockResolvedValue(order('A', [], null))
    expect((await fetchOrder(500, scope)).ibscbs).toBeNull()
    expect(decl.previewServiceIbscbs).not.toHaveBeenCalled()
    expect(inv.readFrozenIbscbs).not.toHaveBeenCalled()
  })

  it.each(['F', 'C'])('status %s: só a CONGELADA (a faturada nunca é recalculada pela prévia)', async (status) => {
    repo.getOrder.mockResolvedValue(order(status, [40], '77'))
    const r = await fetchOrder(500, scope)
    expect(r.ibscbs).toEqual({ preview: null, frozen: FROZEN })
    expect(inv.readFrozenIbscbs).toHaveBeenCalledWith(expect.anything(), 'setes_setes', 1, 500, 0)   // L6: o terminal do ramo
    expect(decl.previewServiceIbscbs).not.toHaveBeenCalled()
  })

  it('não aberta sem nota viva (ou nota sem ramo de serviço): null', async () => {
    repo.getOrder.mockResolvedValue(order('F', [40], null))
    expect((await fetchOrder(500, scope)).ibscbs).toBeNull()
    repo.getOrder.mockResolvedValue(order('F', [40], '77'))
    inv.readFrozenIbscbs.mockResolvedValueOnce(null)
    expect((await fetchOrder(500, scope)).ibscbs).toBeNull()
    expect(decl.previewServiceIbscbs).not.toHaveBeenCalled()
  })

  it('OS de outra institution (getOrder null): 404 antes de qualquer leitura IBS/CBS', async () => {
    repo.getOrder.mockResolvedValue(null)
    await expect(fetchOrder(999, { ...scope, institutionId: 2 })).rejects.toMatchObject({ statusCode: 404 })
    expect(decl.previewServiceIbscbs).not.toHaveBeenCalled()
    expect(inv.readFrozenIbscbs).not.toHaveBeenCalled()
  })

  it('D-IB87: a leitura IBS/CBS que falha DEGRADA TIPADA (unavailable) — o detalhe da OS nunca vira 500', async () => {
    const logger = (jest.requireActual('../shared/logger/logger') as any).default
    const spy = jest.spyOn(logger, 'error').mockImplementation(() => undefined as any)
    try {
      repo.getOrder.mockResolvedValue(order('A', [40], null))
      decl.previewServiceIbscbs.mockRejectedValueOnce(Object.assign(new Error("Table 'setes_central.tb_nbs' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' }))
      const aberta = await fetchOrder(500, scope)
      expect(aberta.ibscbs).toEqual({ preview: null, frozen: null, unavailable: true })
      expect(aberta.items).toHaveLength(1)                           // o resto do detalhe segue intacto
      repo.getOrder.mockResolvedValue(order('F', [40], '77'))
      inv.readFrozenIbscbs.mockRejectedValueOnce(new Error('falha'))
      expect((await fetchOrder(500, scope)).ibscbs).toEqual({ preview: null, frozen: null, unavailable: true })
      expect(spy.mock.calls.map(c => c[0])).toEqual([expect.stringMatching(/indisponível[\s\S]*D-IB87/), expect.stringMatching(/D-IB87/)])
      expect(spy.mock.calls[0][1]).toEqual({ institutionId: 1, orderId: 500, status: 'A', code: 'ER_NO_SUCH_TABLE', kind: 'Error' })   // sem mensagem do banco
    } finally { spy.mockRestore() }
  })

  it('schema hostil nunca chega às peças (assertSchema recusa)', async () => {
    repo.getOrder.mockResolvedValue(order('A', [40], null))
    await expect(fetchOrder(500, { ...scope, schemaName: 'setes_x`; DROP DATABASE setes_central; --' })).rejects.toThrow()
    expect(decl.previewServiceIbscbs).not.toHaveBeenCalled()
  })
})
