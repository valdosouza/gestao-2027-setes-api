/// <reference types="jest" />
// Gate adversarial — delta Q-ADV2a/Q-ADV2b + rodízio sem nota cancelada (Valdo 2026-09-30, "siga as recomendações").
//
// Achados CONFIRMADOS ficam como `it.failing` (código de produção NÃO alterado pelo gate; ao corrigir,
// trocar por `it`). Os demais `it` fixam a semântica atual (para ninguém "consertar" sem decidir).
//   - MEDIUM (Q-ADV2d): a reconferência acha a chave no 1º GET /dps e delega ao refresh, que PERGUNTA DE
//     NOVO; se a 2ª resposta vier 404 (réplica atrasada/gateway), o refresh só "olha" e a reconferência
//     retorna em silêncio — o cancelamento LOCAL segue com uma NFS-e que o fisco já mostrou existir.
//   - LOW (Q-ADV2e): `code` numérico é aceito como resposta ESTRUTURADA do fisco — um 404 JSON de gateway no
//     formato `{"code":404,"message":"Not Found"}` ainda vira "DPS sem NFS-e" (conclusivo).
jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(async () => [[]]), getConnection: jest.fn(), on: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }))
jest.mock('../shared/invoice-transmission/transmission.repository', () => {
  const actual = jest.requireActual('../shared/invoice-transmission/transmission.repository')
  return {
    __esModule: true, ...actual,
    latestTransmission: jest.fn(), listServiceTransmissions: jest.fn(), getTransmission: jest.fn(),
    findTransmissionByDpsId: jest.fn(), insertTransmissionEvent: jest.fn(), touchQueriedAt: jest.fn(),
  }
})
jest.mock('../shared/tax-authority', () => {
  const actual = jest.requireActual('../shared/tax-authority')
  return { __esModule: true, ...actual, adapterFor: jest.fn() }
})
jest.mock('../shared/fiscal-issuer', () => {
  const actual = jest.requireActual('../shared/fiscal-issuer')
  return { __esModule: true, ...actual, openIssuer: jest.fn() }
})

import { transport, AuthorityHttpError } from '../shared/tax-authority/https-json'
import * as repo from '../shared/invoice-transmission/transmission.repository'
import * as authority from '../shared/tax-authority'
import * as issuer from '../shared/fiscal-issuer'
import { reconfirmBeforeLocalCancel } from '../shared/invoice-transmission'

const actualAuthority = jest.requireActual('../shared/tax-authority')
const INVOICE = 6400
const DPS_ID = 'DPS410690221234567800019900001000000000000043'
const KEY = '41069022112345678000199000000000000042609300000001'
const txRow = (over: any = {}) => ({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, environment: 'P', dpsId: DPS_ID, accessKey: null, nfseNumber: null,
  dhProc: null, createdAt: '2026-09-30 09:00:00', ageMinutes: 30, lastQueriedAt: null, invoiceEvent: 1,
  lastEvent: 1, lastKind: 'F', lastCode: null, lastMessage: null, lastSource: 'Q', lastDh: null, lastEventAt: null, lastEventAgeMinutes: 20, ...over,
})
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }

describe('Q-ADV2d — reconferência × 2ª pergunta do refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(authority.adapterFor as jest.Mock).mockReturnValue(adapter)
    ;(issuer.openIssuer as jest.Mock).mockResolvedValue({
      issuer: { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null },
      cert: Buffer.from('CERT'), key: Buffer.from('KEY'), info: { expired: false, cnpj: '12345678000199' },
    })
    const f1 = txRow()
    ;(repo.listServiceTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f1], events: [] })
    ;(repo.getTransmission as jest.Mock).mockResolvedValue(f1)
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f1)
    ;(repo.findTransmissionByDpsId as jest.Mock).mockResolvedValue(f1)
  })

  it('controle: nas duas perguntas o fisco diz "não existe" → segue sem gravar nada', async () => {
    adapter.queryDpsAccessKey.mockResolvedValue(null)
    await reconfirmBeforeLocalCancel('setes_setes', 1, 7, INVOICE)
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
  })

  it.failing('MEDIUM: 1º GET /dps ACHA a chave, 2º (dentro do refresh) volta 404 → a reconferência deveria recusar (fail-closed), não liberar o cancelamento local', async () => {
    adapter.queryDpsAccessKey.mockResolvedValueOnce(KEY).mockResolvedValueOnce(null)
    await expect(reconfirmBeforeLocalCancel('setes_setes', 1, 7, INVOICE)).rejects.toBeDefined()
  })
})

describe('Q-ADV2b — 404 do GET /dps: forma do corpo × conclusivo', () => {
  const realAdn = actualAuthority.adapterFor('ADN')
  const ctx = { environment: 'P', cert: Buffer.from('c'), key: Buffer.from('k') } as any
  const orig = transport.request
  afterAll(() => { transport.request = orig })
  const reply404 = (text: string) => { transport.request = jest.fn().mockResolvedValue({ status: 404, headers: { 'content-type': 'application/json' }, text }) }
  const outcome = async () => realAdn.queryDpsAccessKey(ctx, DPS_ID).catch((e: any) => e)

  it('semântica fixada: erros[] VAZIO ainda é conclusivo (null)', async () => {
    reply404('{"erros":[]}')
    expect(await outcome()).toBeNull()
  })
  it('semântica fixada: lista de itens com codigo → conclusivo (null)', async () => {
    reply404('[{"codigo":"E404","descricao":"não encontrada"}]')
    expect(await outcome()).toBeNull()
  })
  it('semântica fixada (fail-closed): chave com CAIXA diferente ("Erros") ou erro SINGULAR ("erro":{…}) → 502 em voo', async () => {
    for (const body of ['{"Erros":[{"Codigo":"E404"}]}', '{"erro":{"codigo":"E404","descricao":"x"}}', '{"message":"no Route matched with those values"}', '{}', '[]']) {
      reply404(body)
      const out = await outcome()
      expect(out).toBeInstanceOf(AuthorityHttpError)
      expect(out).toMatchObject({ statusCode: 502 })
    }
  })
  it.failing('LOW: 404 JSON de gateway com `code` numérico ({"code":404,"message":"Not Found"}) deveria ser 502, não "DPS sem NFS-e"', async () => {
    reply404('{"code":404,"message":"Not Found"}')
    const out = await outcome()
    expect(out).toBeInstanceOf(AuthorityHttpError)
  })
})
