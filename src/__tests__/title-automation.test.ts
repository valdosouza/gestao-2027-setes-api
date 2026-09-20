/// <reference types="jest" />
// COMPOSIÇÃO @shared/title-automation — o desfecho que a FORMA dá à parcela
// recém-nascida (Onda 1 da fase Primeiro Cliente, 2026-09-13; parecer do
// guardião conceitual). Aqui se fixa a POLÍTICA que antes vivia inline no
// billing e que a OS não tinha: o que é silêncio, o que é aviso, o que é
// isolado por savepoint e o que derruba a transação.
import {
  applyTitleAutomation, localIsoDate, resolveTitleAutomationConfig,
} from '../shared/title-automation'
import { tryAutoSettleByContract } from '../shared/financial-settlement'
import { tryIssueBankSlipsOnBilling } from '../shared/bank-slip'
import { getConfigContentFor } from '../shared/interface-config'
import logger from '../shared/logger/logger'

jest.mock('../shared/financial-settlement', () => ({
  __esModule: true,
  tryAutoSettleByContract: jest.fn().mockResolvedValue({ settled: false, reason: 'NO_CONTRACT' }),
}))
jest.mock('../shared/bank-slip', () => ({
  __esModule: true,
  tryIssueBankSlipsOnBilling: jest.fn().mockResolvedValue({ issued: 0, slipIds: [] }),
}))
jest.mock('../shared/interface-config', () => ({
  __esModule: true,
  getConfigContentFor: jest.fn().mockResolvedValue(null),
}))
jest.mock('../shared/logger/logger', () => ({
  __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

const mockSettle = tryAutoSettleByContract as jest.Mock
const mockSlips  = tryIssueBankSlipsOnBilling as jest.Mock
const mockConfig = getConfigContentFor as jest.Mock

function conn() {
  return { query: jest.fn().mockResolvedValue([{}]) } as any
}
const parcelas = [
  { parcel: 1, paymentTypeId: 1, amount: 100 },
  { parcel: 2, paymentTypeId: 1, amount: 100 },
]
const entrada = (parcels = parcelas) => ({ orderId: 7000, dtPayment: '2026-09-13', parcels })

/** Config resolvida FORA da transacao (gate adversarial, achado 1): o chamador
 *  le antes do beginTransaction e passa — a composicao nao vai ao pool com a
 *  transacao aberta. */
const cfg = (autoBankSlip = false) => ({ autoBankSlip })

beforeEach(() => {
  jest.clearAllMocks()
  mockSettle.mockResolvedValue({ settled: false, reason: 'NO_CONTRACT' })
  mockSlips.mockResolvedValue({ issued: 0, slipIds: [] })
  mockConfig.mockResolvedValue(null)
})

describe('automatismos do nascimento do título', () => {
  it('chama a baixa por contrato UMA vez por parcela, com o valor e a data do fato gerador', async () => {
    mockSettle.mockResolvedValue({ settled: true, settledCode: 1 })

    const r = await applyTitleAutomation(conn(), 'setes_setes', 1, 9, entrada(), cfg())

    expect(mockSettle).toHaveBeenCalledTimes(2)
    expect(mockSettle.mock.calls[0][4]).toMatchObject({
      orderId: 7000, parcel: 1, paidValue: 100,
      dtPayment: '2026-09-13', paymentTypeId: 1,
    })
    expect(r.autoSettled).toBe(2)
  })

  it('NO_CONTRACT e KIND_FIXED são SILÊNCIO — título aberto é rotina, não problema', async () => {
    mockSettle
      .mockResolvedValueOnce({ settled: false, reason: 'NO_CONTRACT' })
      .mockResolvedValueOnce({ settled: false, reason: 'KIND_FIXED' })

    const r = await applyTitleAutomation(conn(), 'setes_setes', 1, 9, entrada(), cfg())

    expect(r.autoSettled).toBe(0)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('motivo de CONFIGURAÇÃO incompleta vira aviso — alguém precisa ver', async () => {
    mockSettle.mockResolvedValue({ settled: false, reason: 'NO_OPEN_CASHIER' })

    await applyTitleAutomation(conn(), 'setes_setes', 1, 9, entrada([parcelas[0]]), cfg())

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Baixa automática não realizada'),
      expect.objectContaining({ reason: 'NO_OPEN_CASHIER' }))
  })

  it('falha TÉCNICA na baixa de uma parcela é isolada por SAVEPOINT e as outras seguem', async () => {
    const c = conn()
    mockSettle
      .mockRejectedValueOnce(new Error('bug qualquer'))
      .mockResolvedValueOnce({ settled: true, settledCode: 2 })

    const r = await applyTitleAutomation(c, 'setes_setes', 1, 9, entrada(), cfg())

    const sqls = c.query.mock.calls.map((x: any[]) => String(x[0]))
    expect(sqls).toContain('SAVEPOINT auto_settle')
    expect(sqls).toContain('ROLLBACK TO SAVEPOINT auto_settle')
    expect(r.autoSettled).toBe(1)                 // a 2ª parcela baixou
    expect(logger.error).toHaveBeenCalled()
  })

  it('ROLLBACK impossível (deadlock matou a transação) PROPAGA o erro original', async () => {
    const c = conn()
    c.query.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('ROLLBACK TO SAVEPOINT')) throw new Error('savepoint sumiu')
      return [{}]
    })
    mockSettle.mockRejectedValue(new Error('ER_LOCK_DEADLOCK'))

    await expect(applyTitleAutomation(c, 'setes_setes', 1, 9, entrada(), cfg()))
      .rejects.toThrow('ER_LOCK_DEADLOCK')
  })

  it('auto_bank_slip DESLIGADA: a peça do boleto nem é consultada', async () => {
    const r = await applyTitleAutomation(conn(), 'setes_setes', 1, 9, entrada(), cfg(false))

    expect(mockSlips).not.toHaveBeenCalled()
    expect(r.bankSlipsIssued).toBe(0)
  })

  it('auto_bank_slip LIGADA: emite em bloco, resolvendo a carteira uma vez', async () => {
    mockSlips.mockResolvedValue({ issued: 2, slipIds: [10, 11] })

    const r = await applyTitleAutomation(conn(), 'setes_setes', 1, 9, entrada(), cfg(true))

    expect(mockSlips).toHaveBeenCalledTimes(1)
    expect(mockSlips.mock.calls[0][4]).toMatchObject({
      orderId: 7000,
      parcels: [{ parcel: 1, paymentTypeId: 1 }, { parcel: 2, paymentTypeId: 1 }],
    })
    expect(r.bankSlipsIssued).toBe(2)
  })

  it('várias carteiras ativas: avisa e não emite (a tela de Boletos emite depois)', async () => {
    mockSlips.mockResolvedValue({ issued: 0, reason: 'MULTIPLE_AGREEMENTS', slipIds: [] })

    const r = await applyTitleAutomation(conn(), 'setes_setes', 1, 9, entrada(), cfg(true))

    expect(r.bankSlipsIssued).toBe(0)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('várias carteiras ativas'), expect.anything())
  })

  it('falha técnica na emissão do boleto NÃO derruba a nota', async () => {
    const c = conn()
    mockSlips.mockRejectedValue(new Error('carteira inconsistente'))

    const r = await applyTitleAutomation(c, 'setes_setes', 1, 9, entrada(), cfg(true))

    expect(c.query.mock.calls.map((x: any[]) => String(x[0])))
      .toContain('ROLLBACK TO SAVEPOINT auto_bank_slip')
    expect(r.bankSlipsIssued).toBe(0)
  })

  it('sem parcelas nao toca em nada', async () => {
    const c = conn()
    const r = await applyTitleAutomation(c, 'setes_setes', 1, 9, entrada([]), cfg(true))

    expect(r).toEqual({ autoSettled: 0, bankSlipsIssued: 0, chargeable: 0 })
    expect(mockSettle).not.toHaveBeenCalled()
    expect(mockSlips).not.toHaveBeenCalled()
    expect(c.query).not.toHaveBeenCalled()
  })

  // Gate adversarial da Onda 1, achado 4: parcelQuotas(0,01 em 3) = [0, 0, 0,01].
  // O boleto da parcela zerada era recusado com 409 TITLE_SETTLED e o erro subia
  // pelo savepoint do BLOCO inteiro — a ordem ficava sem boleto NENHUM, calada.
  it('parcela de valor ZERO nao baixa nem cobra, e nao derruba as outras', async () => {
    mockSettle.mockResolvedValue({ settled: true, settledCode: 1 })
    mockSlips.mockResolvedValue({ issued: 1, slipIds: [10] })
    const zeradas = [
      { parcel: 1, paymentTypeId: 6, amount: 0 },
      { parcel: 2, paymentTypeId: 6, amount: 0 },
      { parcel: 3, paymentTypeId: 6, amount: 0.01 },
    ]

    const r = await applyTitleAutomation(
      conn(), 'setes_setes', 1, 9, entrada(zeradas), cfg(true))

    expect(mockSettle).toHaveBeenCalledTimes(1)
    expect(mockSettle.mock.calls[0][4]).toMatchObject({ parcel: 3, paidValue: 0.01 })
    expect(mockSlips.mock.calls[0][4].parcels).toEqual([{ parcel: 3, paymentTypeId: 6 }])
    // D26: o denominador da cobrança conta só a parcela COM valor
    expect(r).toEqual({ autoSettled: 1, bankSlipsIssued: 1, chargeable: 1 })
  })

  it('ordem TODA zerada nao chama nada (nao ha o que cobrar)', async () => {
    const c = conn()
    const r = await applyTitleAutomation(c, 'setes_setes', 1, 9,
      entrada([{ parcel: 1, paymentTypeId: 6, amount: 0 }]), cfg(true))

    expect(r).toEqual({ autoSettled: 0, bankSlipsIssued: 0, chargeable: 0 })
    expect(c.query).not.toHaveBeenCalled()
  })
})

// TRIPWIRE da invariante mais cara desta onda (gate adversarial: config lida
// dentro da transação = 2ª conexão do pool com a 1ª presa = API travada
// permanentemente, 0 de 40 faturamentos em 45 s). Se alguém mover a leitura
// de volta para dentro da composição, ESTE teste cai — não o comentário.
describe('a composição NÃO lê configuração (quem resolve é o chamador, fora da transação)', () => {
  it('com boleto LIGADO, nenhuma consulta de config acontece durante a aplicação', async () => {
    mockSlips.mockResolvedValue({ issued: 1, slipIds: [1] })

    await applyTitleAutomation(conn(), 'setes_setes', 1, 9, entrada(), cfg(true))

    expect(mockConfig).not.toHaveBeenCalled()
  })
  it('com boleto DESLIGADO idem', async () => {
    await applyTitleAutomation(conn(), 'setes_setes', 1, 9, entrada(), cfg(false))

    expect(mockConfig).not.toHaveBeenCalled()
  })
})

describe('resolveTitleAutomationConfig', () => {
  it('le auto_bank_slip da interface billing — fonte UNICA de qual chave governa', async () => {
    mockConfig.mockResolvedValue('S')

    const config = await resolveTitleAutomationConfig('setes_setes', 7, 9)

    expect(mockConfig).toHaveBeenCalledWith('setes_setes', 7, 9, 'billing', 'auto_bank_slip')
    expect(config).toEqual({ autoBankSlip: true })
  })
  it('qualquer valor diferente de S e DESLIGADO (inclusive ausente)', async () => {
    mockConfig.mockResolvedValue(null)
    expect(await resolveTitleAutomationConfig('setes_setes', 1, 1))
      .toEqual({ autoBankSlip: false })
  })
})

describe('localIsoDate', () => {
  it('usa a data LOCAL — 23h em Brasília não vira o dia seguinte (UTC viraria)', () => {
    expect(localIsoDate(new Date(2026, 8, 13, 23, 30))).toBe('2026-09-13')
  })
  it('preenche mês e dia com zero à esquerda', () => {
    expect(localIsoDate(new Date(2026, 0, 5, 10, 0))).toBe('2026-01-05')
  })
})
