/// <reference types="jest" />
// D15 (BOL-02 do legado) + parecer do guardião (2026-09-13): emitir boleto é o
// caso PARTICULAR de redirecionar a cobrança (D17). O UPDATE inline saiu daqui e
// virou a peça `@shared/title-charge`; o que FICA no boleto é a política de QUAL
// forma — isso é do instrumento, não do título. Estes testes provam a delegação
// e a política; o ato em si tem os seus em title-charge.test.ts.
import { issueBankSlip } from '../shared/bank-slip'
import { retargetTitleCharge } from '../shared/title-charge'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn() },
}))
jest.mock('../shared/title-charge', () => ({
  __esModule: true,
  retargetTitleCharge: jest.fn().mockResolvedValue({ changed: true }),
}))
jest.mock('../shared/logger/logger', () => ({
  __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

const mockRetarget = retargetTitleCharge as jest.Mock

const CARTEIRA = {
  id: 1, bankAccountId: 9, chargeKindId: 1, accept: 'S',
  aliqDiscount: 0, aliqInterest: 0, aliqLate: 0, valueLateMin: 0,
  valueFine: 0, aliqFine: 0, valueRate: 0, instruction: null,
  protest: 'N', dayProtest: 0, ourNumberNext: 100, active: 'S',
}
const TITULO = (paymentTypeId: number) => ({
  orderId: 700, parcel: 1, tagValue: 100, paymentTypeId,
  dtExpiration: '2026-10-10', operation: 'C', customerId: 55, principalPaid: 0,
})

function mockConn(opts: { formasBoleto: number[]; titulos: any[]; formasParaResolver?: any[] }) {
  const conn: any = { query: jest.fn() }
  const fila: any[] = [
    [[CARTEIRA]],                              // carteira FOR UPDATE
    [[{ 1: 1 }]],                              // conta da carteira existe
    [opts.formasBoleto.map(id => ({ id }))],   // formas kind='B' habilitadas
  ]
  for (const t of opts.titulos) {
    fila.push([[t]])                           // lockTitle
    fila.push([[]])                            // hasOpenSlip: nenhum
  }
  if (opts.formasParaResolver) fila.push([opts.formasParaResolver])
  let i = 0
  conn.query.mockImplementation(async () => fila[i++] ?? [[]])
  return conn
}

beforeEach(() => jest.clearAllMocks())

describe('emitir boleto DESTINA o título (D15) — pela peça do ato geral', () => {
  it('título em outra forma é redirecionado PELA PEÇA, não por SQL local', async () => {
    const conn = mockConn({
      formasBoleto: [6], titulos: [TITULO(1)],       // 1 = dinheiro
      formasParaResolver: [{ id: 6, description: '6 - BOLETO' }],
    })

    await issueBankSlip(conn, 'setes_setes', 1, 7, {
      agreementId: 1, titles: [{ orderId: 700, parcel: 1 }],
    }).catch(() => undefined)

    expect(mockRetarget).toHaveBeenCalledTimes(1)
    expect(mockRetarget.mock.calls[0][3]).toEqual({
      orderId: 700, parcel: 1, paymentTypeId: 6,
    })
    // nenhum UPDATE de forma escrito aqui — a peça é a dona
    expect(conn.query.mock.calls.some((c: any[]) =>
      /SET tb_payment_types_id/.test(String(c[0])))).toBe(false)
  })

  it('título que JÁ nasceu em boleto não é redirecionado (o faturamento escolheu)', async () => {
    const conn = mockConn({ formasBoleto: [6], titulos: [TITULO(6)] })

    await issueBankSlip(conn, 'setes_setes', 1, 7, {
      agreementId: 1, titles: [{ orderId: 700, parcel: 1 }],
    }).catch(() => undefined)

    expect(mockRetarget).not.toHaveBeenCalled()
  })

  it('sem NENHUMA forma de boleto habilitada, recusa e não emite', async () => {
    const conn = mockConn({ formasBoleto: [], titulos: [TITULO(1)], formasParaResolver: [] })

    await expect(issueBankSlip(conn, 'setes_setes', 1, 7, {
      agreementId: 1, titles: [{ orderId: 700, parcel: 1 }],
    })).rejects.toMatchObject({ statusCode: 422, code: 'BANK_SLIP_NO_PAYMENT_TYPE' })
    expect(mockRetarget).not.toHaveBeenCalled()
  })

  it('com 2+ formas de boleto, exige que quem emite informe qual', async () => {
    const conn = mockConn({
      formasBoleto: [6, 8], titulos: [TITULO(1)],
      formasParaResolver: [
        { id: 6, description: '6 - BOLETO' }, { id: 8, description: '8 - BOLETO INTER' },
      ],
    })

    await expect(issueBankSlip(conn, 'setes_setes', 1, 7, {
      agreementId: 1, titles: [{ orderId: 700, parcel: 1 }],
    })).rejects.toMatchObject({ statusCode: 422, code: 'BANK_SLIP_PAYMENT_TYPE_AMBIGUOUS' })
  })

  // O HIGH do gate adversarial: informar a forma tinha que RESOLVER o impasse —
  // e não resolvia, porque o service descartava o campo. Aqui, na peça, a forma
  // explícita tem que passar pela validação e destinar.
  it('com 2+ formas, a forma INFORMADA resolve o impasse', async () => {
    const conn = mockConn({
      formasBoleto: [6, 8], titulos: [TITULO(1)],
      formasParaResolver: [{ id: 8 }],          // validação da forma explícita
    })

    await issueBankSlip(conn, 'setes_setes', 1, 7, {
      agreementId: 1, titles: [{ orderId: 700, parcel: 1 }], paymentTypeId: 8,
    }).catch(() => undefined)

    expect(mockRetarget.mock.calls[0][3]).toMatchObject({ paymentTypeId: 8 })
  })

  it('forma informada que NÃO é de boleto é recusada', async () => {
    const conn = mockConn({ formasBoleto: [6], titulos: [TITULO(1)], formasParaResolver: [] })

    await expect(issueBankSlip(conn, 'setes_setes', 1, 7, {
      agreementId: 1, titles: [{ orderId: 700, parcel: 1 }], paymentTypeId: 1,
    })).rejects.toMatchObject({ statusCode: 422, code: 'BANK_SLIP_PAYMENT_TYPE_INVALID' })
  })
})
