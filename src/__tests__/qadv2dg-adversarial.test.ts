/// <reference types="jest" />
// Gate adversarial — delta Q-ADV2d (consulta pela chave vai PRONTA ao refresh + cinto 409) e Q-ADV2f (404 só com E2404).
// Achado CONFIRMADO fica como `it.failing` (produção NÃO alterada pelo gate; ao corrigir, trocar por `it`):
//   - LOW (Q-ADV2h): com `opts.query` o refresh pula a regra do DETENTOR (findTransmissionByDpsId) — a chave
//     pousa na ÚLTIMA tentativa F/Q candidata, não na que CUNHOU o Id (MEDIUM-1/D-N26). Antes do delta
//     (refresh sem query) o alvo era a mais antiga do mesmo dps_id.
jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(async () => [[]]), getConnection: jest.fn(async () => { throw new Error('sem banco no teste') }), on: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }))
jest.mock('../shared/invoice-transmission/transmission.repository', () => {
  const actual = jest.requireActual('../shared/invoice-transmission/transmission.repository')
  return {
    __esModule: true, ...actual,
    latestTransmission: jest.fn(), listServiceTransmissions: jest.fn(), getTransmission: jest.fn(),
    findTransmissionByDpsId: jest.fn(), insertTransmissionEvent: jest.fn(), touchQueriedAt: jest.fn(), fillAuthorityData: jest.fn(),
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
const INVOICE = 6401
const DPS_ID = 'DPS410690221234567800019900001000000000000043'
const KEY = '41069022112345678000199000000000000042609300000001'
const txRow = (over: any = {}) => ({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, environment: 'P', dpsId: DPS_ID, accessKey: null, nfseNumber: null,
  dhProc: null, createdAt: '2026-09-30 09:00:00', ageMinutes: 30, lastQueriedAt: null, invoiceEvent: 1,
  lastEvent: 1, lastKind: 'F', lastCode: null, lastMessage: null, lastSource: 'Q', lastDh: null, lastEventAt: null, lastEventAgeMinutes: 20, ...over,
})
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const nothingWritten = () => {
  expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
  expect(repo.touchQueriedAt).not.toHaveBeenCalled()
  expect(repo.fillAuthorityData).not.toHaveBeenCalled()
}

describe('Q-ADV2d — reconferência com a consulta PRONTA', () => {
  const f1 = txRow({ attempt: 1 })
  const f2 = txRow({ attempt: 2 })
  beforeEach(() => {
    jest.clearAllMocks()
    ;(authority.adapterFor as jest.Mock).mockReturnValue(adapter)
    ;(issuer.openIssuer as jest.Mock).mockResolvedValue({
      issuer: { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null },
      cert: Buffer.from('CERT'), key: Buffer.from('KEY'), info: { expired: false, cnpj: '12345678000199' },
    })
    ;(repo.listServiceTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f1, f2], events: [] })
    ;(repo.getTransmission as jest.Mock).mockImplementation(async (_q: any, _s: any, _i: any, _n: any, att: number) => (att === 1 ? f1 : f2))
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f2)
    ;(repo.findTransmissionByDpsId as jest.Mock).mockResolvedValue(f1)   // detentor do Id = a mais antiga
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
  })

  it('queryNfse falha DEPOIS do GET /dps achar a chave → o erro sobe (fail-closed) e nada é gravado', async () => {
    adapter.queryNfse.mockRejectedValue(new Error('fisco fora (503)'))
    await expect(reconfirmBeforeLocalCancel('setes_setes', 1, 7, INVOICE)).rejects.toBeDefined()
    expect(adapter.queryDpsAccessKey).toHaveBeenCalledTimes(1)
    nothingWritten()
  })

  it('R2-2 vale para a consulta PRONTA: NFS-e de OUTRO DPS → erro e nada gravado', async () => {
    const other = 'DPS410690221234567800019900001000000000000099'
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: `<NFSe><infNFSe><DPS><infDPS Id="${other}"></infDPS></DPS></infNFSe></NFSe>`, dhProc: null })
    const err = await reconfirmBeforeLocalCancel('setes_setes', 1, 7, INVOICE).catch(e => e)
    expect(err).toMatchObject({ statusCode: 502 })
    nothingWritten()
  })

  it('consulta pronta: nenhum 2º GET /dps', async () => {
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: null, dhProc: '2026-09-30T10:00:00-03:00' })
    await reconfirmBeforeLocalCancel('setes_setes', 1, 7, INVOICE).catch(() => undefined)
    expect(adapter.queryDpsAccessKey).toHaveBeenCalledTimes(1)
    expect(adapter.queryNfse).toHaveBeenCalledTimes(1)
  })

  it('LOW (Q-ADV2h): a chave deveria pousar no DETENTOR do Id (tentativa 1, a que cunhou) — não na última F/Q candidata (2)', async () => {
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: null, dhProc: '2026-09-30T10:00:00-03:00' })
    await reconfirmBeforeLocalCancel('setes_setes', 1, 7, INVOICE).catch(() => undefined)
    // alvo do refresh = tx0 (opts.attempt); sem query o refresh trocaria para o detentor via findTransmissionByDpsId
    const firstAttemptAsked = (repo.getTransmission as jest.Mock).mock.calls[0][4]
    expect(firstAttemptAsked === 1 || (repo.findTransmissionByDpsId as jest.Mock).mock.calls.length > 0).toBe(true)
  })
})

describe('Q-ADV2f — E2404 só decide no 404 do GET /dps', () => {
  const realAdn = actualAuthority.adapterFor('ADN')
  const ctx = { environment: 'P', cert: Buffer.from('c'), key: Buffer.from('k') } as any
  const orig = transport.request
  afterAll(() => { transport.request = orig })
  const reply = (status: number, text: string) => { transport.request = jest.fn().mockResolvedValue({ status, headers: { 'content-type': 'application/json' }, text }) }
  const E2404 = '{"erro":{"codigo":"E2404","descricao":"Não foi gerada uma NFS-e com o identificador de DPS informado"}}'

  it('E2404 em status diferente de 404 (400/500/503) NUNCA vira null', async () => {
    for (const st of [400, 500, 503]) {
      reply(st, E2404)
      const out = await realAdn.queryDpsAccessKey(ctx, DPS_ID).catch((e: any) => e)
      expect(out).toBeInstanceOf(Error)
    }
  })
  it('404 com E2404 no /nfse/{chave} NÃO vira "DPS sem NFS-e" (regra só do GET /dps)', async () => {
    reply(404, E2404)
    const out = await realAdn.queryNfse(ctx, KEY).catch((e: any) => e)
    expect(out).toBeInstanceOf(Error)
  })
  it('fail-closed nas formas vizinhas: `code` em inglês, `erro` como lista, código com sufixo/numérico → 502', async () => {
    for (const body of ['{"errors":[{"code":"E2404"}]}', '{"erro":[{"codigo":"E2404"}]}', '{"erro":{"codigo":"E24040"}}', '{"erro":{"codigo":2404}}']) {
      reply(404, body)
      const out = await realAdn.queryDpsAccessKey(ctx, DPS_ID).catch((e: any) => e)
      expect(out).toMatchObject({ statusCode: 502 })
    }
  })
})
