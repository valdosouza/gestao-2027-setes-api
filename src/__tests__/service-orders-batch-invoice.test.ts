/// <reference types="jest" />
// LOTE da cobrança mensal — D6/D7 da fase Primeiro Cliente (Valdo 2026-09-13):
// o operador SELECIONA as ordens e o lote SEGUE E REPORTA (a ordem que falha
// não derruba as outras). O que estes testes fixam é a SEMÂNTICA do lote, não
// o faturamento em si (que já tem os seus): cada ordem fatura na própria
// transação, id repetido conta uma vez, e falha de negócio × falha técnica
// aparecem diferente no relatório.
import { invoiceOrderBatch } from '../modules/service-orders/service-orders.service'
import {
  generateInvoice, contractBillingReference, orderExists,
} from '../modules/service-orders/service-orders.repository'
import { HttpError } from '../shared/errors/http-error'
import logger from '../shared/logger/logger'

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

beforeEach(() => {
  jest.clearAllMocks()
  // default: toda ordem existe e veio de contrato com dia 10 na competência 2026-09
  mockExists.mockResolvedValue(true)
  mockRef.mockResolvedValue({ paymentDay: 10, paymentTypeId: 6, competence: '2026-09' })
})

describe('lote de faturamento da OS (D6/D7)', () => {
  it('fatura todas as ordens selecionadas e relata uma linha por ordem', async () => {
    mockInvoice.mockImplementation(async (orderId: number) =>
      ({ invoiceNumber: String(6000 + orderId), parcels: 1, totalValue: 250,
         autoSettled: 0, bankSlipsIssued: 1 }))

    const r = await invoiceOrderBatch(lote([10, 11, 12]) as any, scope)

    expect(r).toMatchObject({ requested: 3, invoiced: 3, failed: 0 })
    expect(r.results.map(x => x.orderId)).toEqual([10, 11, 12])
    expect(r.results.every(x => x.ok)).toBe(true)
    expect(r.results[0].invoiceNumber).toBe('6010')
    expect(mockInvoice).toHaveBeenCalledTimes(3)
  })

  it('D7: ordem que falha NÃO derruba o lote — sai no relatório com motivo e código', async () => {
    mockInvoice.mockImplementation(async (orderId: number) => {
      if (orderId === 11) {
        throw new HttpError(409, 'Ordem 11 já faturada', [], 'SERVICE_ORDER_ALREADY_INVOICED')
      }
      return { invoiceNumber: String(6000 + orderId), parcels: 1, totalValue: 250,
               autoSettled: 0, bankSlipsIssued: 1 }
    })

    const r = await invoiceOrderBatch(lote([10, 11, 12]) as any, scope)

    expect(r).toMatchObject({ requested: 3, invoiced: 2, failed: 1 })
    expect(r.results[1]).toMatchObject({
      orderId: 11, ok: false, code: 'SERVICE_ORDER_ALREADY_INVOICED',
      error: 'Ordem 11 já faturada',
    })
    // e as ordens DEPOIS da que falhou continuaram
    expect(r.results[2]).toMatchObject({ orderId: 12, ok: true })
  })

  it('falha TÉCNICA também não derruba o lote, mas vai a log e não vaza detalhe', async () => {
    mockInvoice.mockImplementation(async (orderId: number) => {
      if (orderId === 11) throw new Error('ER_LOCK_WAIT_TIMEOUT: detalhe interno do banco')
      return { invoiceNumber: String(6000 + orderId), parcels: 1, totalValue: 250,
               autoSettled: 0, bankSlipsIssued: 1 }
    })

    const r = await invoiceOrderBatch(lote([10, 11]) as any, scope)

    expect(r).toMatchObject({ requested: 2, invoiced: 1, failed: 1 })
    expect(r.results[1]).toMatchObject({ orderId: 11, ok: false, code: 'INTERNAL_ERROR' })
    expect(r.results[1].error).not.toMatch(/ER_LOCK_WAIT_TIMEOUT/)
    expect((logger.error as jest.Mock)).toHaveBeenCalled()
  })

  it('id repetido na seleção fatura UMA vez (o 2º viraria 409 que o operador não cometeu)', async () => {
    mockInvoice.mockResolvedValue({ invoiceNumber: '6010', parcels: 1, totalValue: 250 })

    const r = await invoiceOrderBatch(lote([10, 10, 10]) as any, scope)

    expect(r).toMatchObject({ requested: 1, invoiced: 1, failed: 0 })
    expect(mockInvoice).toHaveBeenCalledTimes(1)
  })

  it('lote inteiro que falha devolve relatório (nunca exceção) — a tela mostra ordem a ordem', async () => {
    mockInvoice.mockRejectedValue(new HttpError(422, 'Ordem sem cobrança', [], 'ORDER_NO_BILLING'))

    const r = await invoiceOrderBatch(lote([10, 11]) as any, scope)

    expect(r).toMatchObject({ requested: 2, invoiced: 0, failed: 2 })
    expect(r.results.every(x => x.code === 'ORDER_NO_BILLING')).toBe(true)
  })

  it('as condições do lote chegam iguais em TODAS as ordens', async () => {
    mockInvoice.mockResolvedValue({ invoiceNumber: '1', parcels: 1, totalValue: 1 })

    await invoiceOrderBatch(lote([10, 11]) as any, scope)

    for (const call of mockInvoice.mock.calls) {
      expect(call[1]).toMatchObject({ dtExpiration: '2026-10-05', paymentTypeId: 6, parcels: 1 })
      // override total do operador: NADA a reconferir na transação (M1)
      expect(call[1].termsFromContract).toEqual({ dtExpiration: false, paymentTypeId: false })
      expect(call[2]).toBe('setes_setes')
      expect(call[3]).toBe(1)
    }
  })

  // Gate adversarial da Onda 1, achado 2: o catch do lote e ANTES do
  // handleError, que e onde a contencao vira 409 RESOURCE_BUSY (D-A3).
  it('CONTENÇÃO vira RESOURCE_BUSY na linha, não "erro inesperado"', async () => {
    const lockWait: any = new Error('Lock wait timeout exceeded')
    lockWait.code = 'ER_LOCK_WAIT_TIMEOUT'
    mockInvoice.mockImplementation(async (orderId: number) => {
      if (orderId === 11) throw lockWait
      return { invoiceNumber: '1', parcels: 1, totalValue: 1, autoSettled: 1, bankSlipsIssued: 0 }
    })

    const r = await invoiceOrderBatch(lote([10, 11]) as any, scope)

    expect(r.results[1]).toMatchObject({ orderId: 11, ok: false, code: 'RESOURCE_BUSY' })
    expect(r.results[1].error).toMatch(/tente novamente/i)
    expect(logger.error).not.toHaveBeenCalled()   // contenção não é bug: não polui o log de erro
  })

  it('DEADLOCK esgotado também é contenção, não falha técnica', async () => {
    const deadlock: any = new Error('Deadlock found')
    deadlock.code = 'ER_LOCK_DEADLOCK'
    mockInvoice.mockRejectedValue(deadlock)

    const r = await invoiceOrderBatch(lote([10]) as any, scope)

    expect(r.results[0]).toMatchObject({ ok: false, code: 'RESOURCE_BUSY' })
  })

  // Gate adversarial, achado 5: "faturada" nao quer dizer "cobrada" — para a
  // Setes, cuja receita inteira e boleto, um lote pode sair 100% faturado e
  // zero cobrado (contencao pula a automacao, 0 ou 2 carteiras nao emitem).
  it('conta as faturadas que NÃO geraram baixa nem boleto (uncharged)', async () => {
    mockInvoice.mockImplementation(async (orderId: number) => ({
      invoiceNumber: String(orderId), parcels: 1, totalValue: 100,
      autoSettled: orderId === 10 ? 1 : 0,
      bankSlipsIssued: orderId === 11 ? 1 : 0,
    }))

    const r = await invoiceOrderBatch(lote([10, 11, 12]) as any, scope)

    expect(r.invoiced).toBe(3)
    expect(r.uncharged).toBe(1)                   // só a 12 saiu sem cobrança
    expect(r.results[2]).toMatchObject({ autoSettled: 0, bankSlipsIssued: 0 })
  })

  it('lote inteiro sem cobrança: faturado não esconde o não cobrado', async () => {
    mockInvoice.mockResolvedValue({
      invoiceNumber: '1', parcels: 1, totalValue: 1, autoSettled: 0, bankSlipsIssued: 0 })

    const r = await invoiceOrderBatch(lote([10, 11]) as any, scope)

    expect(r).toMatchObject({ invoiced: 2, failed: 0, uncharged: 2 })
  })
})

// D13 (Valdo 2026-09-13): "cada ordem vencer no dia do seu contrato". O
// vencimento deixou de ser condição ÚNICA do lote — é o dia combinado com cada
// cliente. Informar a data no corpo continua valendo como OVERRIDE do operador.
describe('vencimento por ordem no lote (D13)', () => {
  it('sem data no corpo: cada ordem vence no dia do SEU contrato', async () => {
    mockRef
      .mockResolvedValueOnce({ paymentDay: 10, paymentTypeId: 6, competence: '2026-09' })
      .mockResolvedValueOnce({ paymentDay: 25, paymentTypeId: 6, competence: '2026-09' })
    mockInvoice.mockResolvedValue({ invoiceNumber: '1', parcels: 1, totalValue: 100, autoSettled: 0, bankSlipsIssued: 1 })

    const r = await invoiceOrderBatch(
      { orderIds: [10, 11], paymentTypeId: 6, parcels: 1 } as any, scope)

    expect(mockInvoice.mock.calls[0][1].dtExpiration).toBe('2026-10-10')
    expect(mockInvoice.mock.calls[1][1].dtExpiration).toBe('2026-10-25')
    // o relatório diz a data que CADA ordem recebeu — agora elas divergem
    expect(r.results.map(x => x.dtExpiration)).toEqual(['2026-10-10', '2026-10-25'])
  })

  it('data no corpo: OVERRIDE explícito do operador, vale para todas', async () => {
    mockInvoice.mockResolvedValue({ invoiceNumber: '1', parcels: 1, totalValue: 100, autoSettled: 0, bankSlipsIssued: 0 })

    await invoiceOrderBatch(
      { orderIds: [10, 11], dtExpiration: '2026-12-01', paymentTypeId: 6, parcels: 1 } as any, scope)

    expect(mockRef).not.toHaveBeenCalled()          // nem consulta o contrato
    for (const call of mockInvoice.mock.calls) {
      expect(call[1].dtExpiration).toBe('2026-12-01')
    }
  })

  it('a competência mais RECENTE manda (OS que acumulou dois meses)', async () => {
    mockRef.mockResolvedValue({ paymentDay: 5, paymentTypeId: 6, competence: '2026-10' })
    mockInvoice.mockResolvedValue({ invoiceNumber: '1', parcels: 1, totalValue: 100, autoSettled: 0, bankSlipsIssued: 0 })

    await invoiceOrderBatch({ orderIds: [10], paymentTypeId: 6, parcels: 1 } as any, scope)

    expect(mockInvoice.mock.calls[0][1].dtExpiration).toBe('2026-11-05')
  })

  it('ordem SEM dia de contrato é recusada — o lote não inventa data', async () => {
    mockRef.mockResolvedValue(null)   // OS avulsa (nenhuma competência de contrato)
    mockInvoice.mockResolvedValue({ invoiceNumber: '1', parcels: 1, totalValue: 100, autoSettled: 0, bankSlipsIssued: 0 })

    const r = await invoiceOrderBatch({ orderIds: [10], paymentTypeId: 6, parcels: 1 } as any, scope)

    expect(mockInvoice).not.toHaveBeenCalled()
    expect(r).toMatchObject({ requested: 1, invoiced: 0, failed: 1 })
    expect(r.results[0]).toMatchObject({ ok: false, code: 'ORDER_NO_CONTRACT_DUE_DAY' })
    // M2 (gate R5): avulsa recebe a mensagem da AVULSA — sem mandar "acertar o contrato"
    expect(r.results[0].error).toMatch(/Ordem avulsa[\s\S]*informe o vencimento do lote/i)
  })

  // Achado 1 do gate adversarial R5 (efeito da D23): contrato editado entre dois
  // meses não faturados deixa fatos DIVERGENTES na mesma OS — "acerte o contrato"
  // não resolve mais (o fato é imutável); a mensagem aponta as saídas reais.
  it('fatos que DIVERGEM no dia → recusa aponta lote / item / cancelar a OS, nunca "acerte o contrato"', async () => {
    mockRef.mockResolvedValue({ paymentDay: null, paymentTypeId: 6, competence: '2026-08' })

    const r = await invoiceOrderBatch({ orderIds: [10], parcels: 1 } as any, scope)

    expect(r.results[0]).toMatchObject({ ok: false, code: 'ORDER_NO_CONTRACT_DUE_DAY' })
    expect(r.results[0].error).not.toMatch(/acerte o contrato|combine a forma no contrato/i)
    expect(r.results[0].error).toMatch(/informe o vencimento do lote[\s\S]*(remova o item|cancele a OS)/i)
  })

  it('recusa por falta de dia NÃO derruba as outras ordens (D7 continua valendo)', async () => {
    mockRef
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ paymentDay: 15, paymentTypeId: 6, competence: '2026-09' })
    mockInvoice.mockResolvedValue({ invoiceNumber: '9', parcels: 1, totalValue: 100, autoSettled: 0, bankSlipsIssued: 1 })

    const r = await invoiceOrderBatch({ orderIds: [10, 11], paymentTypeId: 6, parcels: 1 } as any, scope)

    expect(r).toMatchObject({ requested: 2, invoiced: 1, failed: 1 })
    expect(r.results[1]).toMatchObject({ orderId: 11, ok: true, dtExpiration: '2026-10-15' })
  })

  it('sem data no corpo, a ordem que falha ainda reporta a data que teria usado', async () => {
    mockInvoice.mockRejectedValue(new HttpError(409, 'Ordem já faturada', [], 'ORDER_INVOICED'))

    const r = await invoiceOrderBatch({ orderIds: [10], paymentTypeId: 6, parcels: 1 } as any, scope)

    expect(r.results[0]).toMatchObject({ ok: false, code: 'ORDER_INVOICED', dtExpiration: '2026-10-10' })
  })
})

// D14 (Valdo 2026-09-13): a FORMA de pagamento também é do contrato — mesmo
// desenho da data. Antes, o lote impunha uma forma única para todas as ordens.
describe('forma de pagamento por ordem no lote (D14)', () => {
  it('sem forma no corpo: cada ordem usa a forma do SEU contrato', async () => {
    mockRef
      .mockResolvedValueOnce({ paymentDay: 10, paymentTypeId: 6, competence: '2026-09' })
      .mockResolvedValueOnce({ paymentDay: 10, paymentTypeId: 2, competence: '2026-09' })
    mockInvoice.mockResolvedValue({ invoiceNumber: '1', parcels: 1, totalValue: 100, autoSettled: 0, bankSlipsIssued: 0 })

    const r = await invoiceOrderBatch({ orderIds: [10, 11], parcels: 1 } as any, scope)

    expect(mockInvoice.mock.calls[0][1].paymentTypeId).toBe(6)
    expect(mockInvoice.mock.calls[1][1].paymentTypeId).toBe(2)
    expect(r.results.map(x => x.paymentTypeId)).toEqual([6, 2])
  })

  it('forma no corpo: override do operador para o lote inteiro', async () => {
    mockInvoice.mockResolvedValue({ invoiceNumber: '1', parcels: 1, totalValue: 100, autoSettled: 0, bankSlipsIssued: 0 })

    await invoiceOrderBatch(
      { orderIds: [10, 11], dtExpiration: '2026-12-01', paymentTypeId: 9, parcels: 1 } as any, scope)

    expect(mockRef).not.toHaveBeenCalled()      // com data E forma, nem lê contrato
    for (const call of mockInvoice.mock.calls) expect(call[1].paymentTypeId).toBe(9)
  })

  it('contrato sem forma combinada → ordem recusada, o lote não escolhe forma', async () => {
    mockRef.mockResolvedValue({ paymentDay: 10, paymentTypeId: null, competence: '2026-09' })
    mockInvoice.mockResolvedValue({ invoiceNumber: '1', parcels: 1, totalValue: 100, autoSettled: 0, bankSlipsIssued: 0 })

    const r = await invoiceOrderBatch({ orderIds: [10], parcels: 1 } as any, scope)

    expect(mockInvoice).not.toHaveBeenCalled()
    expect(r.results[0]).toMatchObject({
      ok: false, code: 'ORDER_NO_CONTRACT_PAYMENT_TYPE', dtExpiration: '2026-10-10',
    })
  })

  it('só a forma no corpo: data vem do contrato, forma é a informada', async () => {
    mockInvoice.mockResolvedValue({ invoiceNumber: '1', parcels: 1, totalValue: 100, autoSettled: 0, bankSlipsIssued: 0 })

    await invoiceOrderBatch({ orderIds: [10], paymentTypeId: 9, parcels: 1 } as any, scope)

    expect(mockRef).toHaveBeenCalledTimes(1)    // precisou do contrato só para a data
    expect(mockInvoice.mock.calls[0][1]).toMatchObject({
      dtExpiration: '2026-10-10', paymentTypeId: 9,
    })
  })

  it('o contrato é consultado UMA vez por ordem, mesmo faltando as duas condições', async () => {
    mockInvoice.mockResolvedValue({ invoiceNumber: '1', parcels: 1, totalValue: 100, autoSettled: 0, bankSlipsIssued: 0 })

    await invoiceOrderBatch({ orderIds: [10, 11], parcels: 1 } as any, scope)

    expect(mockRef).toHaveBeenCalledTimes(2)
  })
})

// Gate adversarial: a consulta do contrato roda ANTES do faturamento, então
// ordem inexistente saía mandando o operador "acertar o contrato do cliente"
// quando o corpo não trazia as condições — e "não encontrada" quando trazia.
describe('ordem inexistente no lote', () => {
  it('diz que a ordem não existe, não manda acertar contrato', async () => {
    mockExists.mockResolvedValue(false)

    const r = await invoiceOrderBatch({ orderIds: [99999999], parcels: 1 } as any, scope)

    expect(r.results[0]).toMatchObject({ ok: false, code: 'ORDER_NOT_FOUND' })
    expect(r.results[0].error).toMatch(/não encontrada/i)
    expect(mockRef).not.toHaveBeenCalled()
    expect(mockInvoice).not.toHaveBeenCalled()
  })

  it('o motivo é o MESMO com e sem override das condições', async () => {
    mockExists.mockResolvedValue(false)

    const semOverride = await invoiceOrderBatch({ orderIds: [99999999], parcels: 1 } as any, scope)
    const comOverride = await invoiceOrderBatch(
      { orderIds: [99999999], dtExpiration: '2026-12-01', paymentTypeId: 6, parcels: 1 } as any, scope)

    expect(semOverride.results[0].code).toBe(comOverride.results[0].code)
  })
})
