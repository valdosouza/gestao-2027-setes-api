/// <reference types="jest" />
// Rodada 5 da fase Primeiro Cliente (Valdo 2026-09-19, "siga as recomendações"):
// D24 (200/ok:true mesmo com tudo recusado — MANTER), D25 (contenção ganha UMA
// passada extra; o que sobra volta `retryable`), D26 (cobrança POR PARCELA — a
// parcial deixa de passar por "cobrada") e D27 (teto 50 por requisição). O que
// estes testes fixam é o CONTRATO do relatório, que a tela consome.
import { invoiceOrderBatch } from '../modules/service-orders/service-orders.service'
import {
  generateInvoice, contractBillingReference, orderExists,
} from '../modules/service-orders/service-orders.repository'
import { batchInvoiceDto, BATCH_INVOICE_MAX_ORDERS } from '../modules/service-orders/service-orders.dto'
import { HttpError } from '../shared/errors/http-error'

jest.mock('../modules/service-orders/service-orders.repository', () => ({
  __esModule: true, generateInvoice: jest.fn(), contractBillingReference: jest.fn(),
  orderExists: jest.fn(),
}))
jest.mock('../shared/logger/logger', () => ({
  __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

const mockInvoice = generateInvoice as jest.Mock
const mockRef    = contractBillingReference as jest.Mock
const mockExists = orderExists as jest.Mock
const scope = { schemaName: 'setes_setes', institutionId: 1, userId: 1 }
const lote = (orderIds: number[]) => ({
  orderIds, dtExpiration: '2026-10-05', paymentTypeId: 6, parcels: 1,
})
const lockWait = () => Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT' })
const faturada = (orderId: number, over: Record<string, any> = {}) => ({
  invoiceNumber: String(6000 + orderId), parcels: 1, totalValue: 250,
  autoSettled: 0, bankSlipsIssued: 1, chargeableParcels: 1, ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockExists.mockResolvedValue(true)
  mockRef.mockResolvedValue({ paymentDay: 10, paymentTypeId: 6, competence: '2026-09' })
})

describe('D25 — contenção: uma passada extra ao final, depois é do operador', () => {
  it('ordem ocupada na 1ª passada e livre na 2ª → sai FATURADA, na posição original do relatório', async () => {
    let tentativas11 = 0
    mockInvoice.mockImplementation(async (orderId: number) => {
      if (orderId === 11 && tentativas11++ === 0) throw lockWait()
      return faturada(orderId)
    })

    const r = await invoiceOrderBatch(lote([10, 11, 12]) as any, scope)

    expect(r).toMatchObject({ requested: 3, invoiced: 3, failed: 0, retryable: 0 })
    expect(r.results.map(x => x.orderId)).toEqual([10, 11, 12])   // a linha é substituída, não anexada
    expect(r.results[1]).toMatchObject({ orderId: 11, ok: true, invoiceNumber: '6011' })
    expect(r.results[1].retryable).toBeUndefined()
    expect(mockInvoice).toHaveBeenCalledTimes(4)                    // 3 + a repetição da 11
  })

  it('a passada extra roda DEPOIS de todas as ordens — quem segurava a 11 normalmente já soltou', async () => {
    const ordem: number[] = []
    let tentativas11 = 0
    mockInvoice.mockImplementation(async (orderId: number) => {
      ordem.push(orderId)
      if (orderId === 11 && tentativas11++ === 0) throw lockWait()
      return faturada(orderId)
    })

    await invoiceOrderBatch(lote([10, 11, 12]) as any, scope)

    expect(ordem).toEqual([10, 11, 12, 11])
  })

  it('ocupada nas DUAS passadas → recusada com RESOURCE_BUSY e retryable: true; o lote não insiste uma 3ª vez', async () => {
    mockInvoice.mockImplementation(async (orderId: number) => {
      if (orderId === 11) throw lockWait()
      return faturada(orderId)
    })

    const r = await invoiceOrderBatch(lote([10, 11]) as any, scope)

    expect(r).toMatchObject({ invoiced: 1, failed: 1, retryable: 1 })
    expect(r.results[1]).toMatchObject({ orderId: 11, ok: false, code: 'RESOURCE_BUSY', retryable: true })
    expect(mockInvoice.mock.calls.filter(c => c[0] === 11)).toHaveLength(2)
  })

  it('só CONTENÇÃO ganha a passada extra — recusa de negócio não é repetida', async () => {
    mockInvoice.mockImplementation(async (orderId: number) => {
      if (orderId === 11) throw new HttpError(409, 'Ordem 11 já faturada', [], 'SERVICE_ORDER_ALREADY_INVOICED')
      return faturada(orderId)
    })

    const r = await invoiceOrderBatch(lote([10, 11]) as any, scope)

    expect(r.results[1]).toMatchObject({ ok: false, code: 'SERVICE_ORDER_ALREADY_INVOICED' })
    expect(r.results[1].retryable).toBeUndefined()
    expect(r.retryable).toBe(0)
    expect(mockInvoice.mock.calls.filter(c => c[0] === 11)).toHaveLength(1)
  })

  it('a 2ª passada que falha por OUTRO motivo (ordem faturada por outra tela no intervalo) mostra esse motivo, sem retryable', async () => {
    let tentativas = 0
    mockInvoice.mockImplementation(async () => {
      if (tentativas++ === 0) throw lockWait()
      throw new HttpError(409, 'Ordem 10 já faturada', [], 'SERVICE_ORDER_ALREADY_INVOICED')
    })

    const r = await invoiceOrderBatch(lote([10]) as any, scope)

    expect(r.results[0]).toMatchObject({ ok: false, code: 'SERVICE_ORDER_ALREADY_INVOICED' })
    expect(r.results[0].retryable).toBeUndefined()
  })

  it('a repetição reusa as condições resolvidas do contrato (D13/D14) — o contrato é consultado de novo, não inventado', async () => {
    let tentativas = 0
    mockInvoice.mockImplementation(async (orderId: number) => {
      if (tentativas++ === 0) throw lockWait()
      return faturada(orderId)
    })

    const r = await invoiceOrderBatch({ orderIds: [10], parcels: 1 } as any, scope)

    expect(r.results[0]).toMatchObject({ ok: true, dtExpiration: '2026-10-10', paymentTypeId: 6 })
    expect(mockInvoice.mock.calls[1][1]).toMatchObject({ dtExpiration: '2026-10-10', paymentTypeId: 6 })
  })
})

describe('D26 — cobrança POR PARCELA: a parcial não passa por "cobrada"', () => {
  it('3 parcelas com 1 boleto → chargedParcels 1/3, conta em uncharged E em partiallyCharged', async () => {
    mockInvoice.mockResolvedValue(faturada(10, { parcels: 3, chargeableParcels: 3, autoSettled: 0, bankSlipsIssued: 1 }))

    const r = await invoiceOrderBatch({ ...lote([10]), parcels: 3 } as any, scope)

    expect(r.results[0]).toMatchObject({ ok: true, chargedParcels: 1, chargeableParcels: 3 })
    expect(r).toMatchObject({ invoiced: 1, uncharged: 1, partiallyCharged: 1 })
  })

  it('nada cobrado (0/n) conta em uncharged mas NÃO em partiallyCharged', async () => {
    mockInvoice.mockResolvedValue(faturada(10, { parcels: 2, chargeableParcels: 2, autoSettled: 0, bankSlipsIssued: 0 }))

    const r = await invoiceOrderBatch({ ...lote([10]), parcels: 2 } as any, scope)

    expect(r.results[0]).toMatchObject({ chargedParcels: 0, chargeableParcels: 2 })
    expect(r).toMatchObject({ uncharged: 1, partiallyCharged: 0 })
  })

  it('tudo cobrado (baixa + boleto em parcelas distintas) → n/n, fora de uncharged', async () => {
    mockInvoice.mockResolvedValue(faturada(10, { parcels: 2, chargeableParcels: 2, autoSettled: 1, bankSlipsIssued: 1 }))

    const r = await invoiceOrderBatch({ ...lote([10]), parcels: 2 } as any, scope)

    expect(r.results[0]).toMatchObject({ chargedParcels: 2, chargeableParcels: 2 })
    expect(r).toMatchObject({ uncharged: 0, partiallyCharged: 0 })
  })

  it('o denominador é o de parcelas COM valor (rateio 0,01 em 3 = 1 cobrável): 1 boleto é cobrança INTEIRA', async () => {
    mockInvoice.mockResolvedValue(faturada(10, { parcels: 3, chargeableParcels: 1, autoSettled: 0, bankSlipsIssued: 1 }))

    const r = await invoiceOrderBatch({ ...lote([10]), parcels: 3 } as any, scope)

    expect(r.results[0]).toMatchObject({ chargedParcels: 1, chargeableParcels: 1 })
    expect(r).toMatchObject({ uncharged: 0, partiallyCharged: 0 })
  })

  it('cinto: produtor que somasse mais cobranças do que parcelas é limitado ao denominador', async () => {
    mockInvoice.mockResolvedValue(faturada(10, { parcels: 1, chargeableParcels: 1, autoSettled: 1, bankSlipsIssued: 1 }))

    const r = await invoiceOrderBatch(lote([10]) as any, scope)

    expect(r.results[0]).toMatchObject({ chargedParcels: 1, chargeableParcels: 1 })
  })

  it('resultado antigo sem chargeableParcels cai no nº de parcelas (compatibilidade do contrato)', async () => {
    mockInvoice.mockResolvedValue({ invoiceNumber: '1', parcels: 2, totalValue: 10, autoSettled: 1, bankSlipsIssued: 0 })

    const r = await invoiceOrderBatch({ ...lote([10]), parcels: 2 } as any, scope)

    expect(r.results[0]).toMatchObject({ chargedParcels: 1, chargeableParcels: 2 })
    expect(r).toMatchObject({ uncharged: 1, partiallyCharged: 1 })
  })
})

describe('D24 — o relatório é a resposta, mesmo quando nada faturou (MANTER)', () => {
  it('todas recusadas → relatório completo, sem exceção; o controller responde 200 com ok: true', async () => {
    mockInvoice.mockRejectedValue(new HttpError(409, 'Ordem já faturada', [], 'SERVICE_ORDER_ALREADY_INVOICED'))

    const r = await invoiceOrderBatch(lote([10, 11, 12]) as any, scope)

    expect(r).toMatchObject({ requested: 3, invoiced: 0, failed: 3, uncharged: 0, partiallyCharged: 0, retryable: 0 })
    expect(r.results).toHaveLength(3)
    expect(r.results.every(x => x.ok === false && x.code === 'SERVICE_ORDER_ALREADY_INVOICED')).toBe(true)
  })
})

describe('D30 — cobrança recorrente não tem parcelas', () => {
  const base = { orderIds: [1, 2], paymentTypeId: 6 }

  it('parcels omitido vale 1; 1 explícito passa', () => {
    const r = batchInvoiceDto.safeParse(base)
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.parcels).toBe(1)
    expect(batchInvoiceDto.safeParse({ ...base, parcels: 1 }).success).toBe(true)
  })

  it('parcels 2 (ou 0) é RECUSADO com a mensagem que aponta a porta certa — nunca silenciado', () => {
    for (const parcels of [2, 12, 0]) {
      const r = batchInvoiceDto.safeParse({ ...base, parcels })
      expect(r.success).toBe(false)
      if (!r.success) {
        expect(r.error.issues[0].path).toEqual(['parcels'])
        expect(r.error.issues[0].message).toMatch(/faturamento individual/)
      }
    }
  })

  it('cinto no service: mesmo que o chamador passe parcels 3, o faturamento sai em 1', async () => {
    mockInvoice.mockResolvedValue(faturada(10))
    await invoiceOrderBatch({ ...lote([10]), parcels: 3 } as any, scope)
    expect(mockInvoice.mock.calls[0][1]).toMatchObject({ parcels: 1 })
  })
})

describe('D27 — teto de 50 ordens por requisição', () => {
  const base = { paymentTypeId: 6, parcels: 1 }
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

  it('50 passa, 51 é recusado com mensagem que cita o teto', () => {
    expect(BATCH_INVOICE_MAX_ORDERS).toBe(50)
    expect(batchInvoiceDto.safeParse({ ...base, orderIds: ids(50) }).success).toBe(true)
    const r = batchInvoiceDto.safeParse({ ...base, orderIds: ids(51) })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toMatch(/50 ordens/)
  })
})
