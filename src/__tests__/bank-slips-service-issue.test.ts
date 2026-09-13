/// <reference types="jest" />
// HIGH do gate adversarial: a D15 validava `paymentTypeId` no DTO e o SERVICE o
// DESCARTAVA ao montar o input da peça — forma explícita ignorada em silêncio e,
// com 2+ formas kind='B', a API virava beco sem saída (pedia "informe qual" e
// informar dava o mesmo 422). Os testes passavam porque chamavam a PEÇA direto.
// Este teste mora na CAMADA onde o contrato estava quebrado.
import { issueSlip } from '../modules/bank-slips/bank-slips.service'
import { issue } from '../modules/bank-slips/bank-slips.repository'

// O service chama o REPOSITÓRIO (que abre a transação e delega à peça): é este
// o ponto onde o campo se perdia.
jest.mock('../modules/bank-slips/bank-slips.repository', () => ({
  __esModule: true,
  issue: jest.fn().mockResolvedValue({ id: 1, ourNumber: '1', documentNumber: '1-1', value: 10, dtExpiration: '2026-10-10', titles: 1 }),
  settle: jest.fn(), cancel: jest.fn(), reverse: jest.fn(),
  listBankSlips: jest.fn(), getBankSlip: jest.fn(),
  listAgreementsLookup: jest.fn(), listOpenTitles: jest.fn(),
}))

const mockIssue = issue as jest.Mock
const scope = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }

beforeEach(() => jest.clearAllMocks())

describe('issueSlip (service) — a forma explícita CHEGA à peça', () => {
  it('paymentTypeId informado viaja no input da emissão', async () => {
    await issueSlip({
      agreementId: 3, titles: [{ orderId: 10, parcel: 1 }], paymentTypeId: 6,
    } as any, scope)

    expect(mockIssue.mock.calls[0][0]).toMatchObject({
      agreementId: 3, source: 'M', paymentTypeId: 6,
    })
  })

  it('sem paymentTypeId, o campo vai undefined (a peça resolve pela única forma B)', async () => {
    await issueSlip({ agreementId: 3, titles: [{ orderId: 10, parcel: 1 }] } as any, scope)

    expect(mockIssue.mock.calls[0][0].paymentTypeId).toBeUndefined()
  })

  it('o escopo do JWT manda — schema, institution e usuário', async () => {
    await issueSlip({ agreementId: 3, titles: [{ orderId: 10, parcel: 1 }] } as any, scope)

    const [, schema, institutionId, userId] = mockIssue.mock.calls[0]
    expect([schema, institutionId, userId]).toEqual(['setes_setes', 1, 7])
  })
})
