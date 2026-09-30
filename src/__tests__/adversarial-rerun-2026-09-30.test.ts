/// <reference types="jest" />
// Gate adversarial — RE-RUN do delta 4c38f39 (api) + df1379c (app), 2026-09-30.
//
// (1) Travas de REGRESSÃO do HIGH corrigido (Q-ADV1a — keep-alive): provado também num servidor TLS
//     local real (TLS 1.2 e 1.3, proxy injetando registro inválido DEPOIS do corpo enviado) — socket
//     novo, socket REUSADO e socket novo com sessão em cache → 503 ambíguo; par PEM trocado → 409
//     FISCAL_CERT_INVALID; ECONNREFUSED/ENOTFOUND → 503. Aqui o mesmo contrato fica fixado com mock.
// (2) Achados novos documentados com `it.failing` (código de produção NÃO alterado; ao corrigir,
//     trocar por `it`):
//     - MEDIUM: a reconferência Q-ADV1b só olha a tentativa VIGENTE. O Id do DPS é o MESMO em todas
//       as tentativas da vida (nDPS write-once — D-N3); se a tentativa 1 fechou F "envio interrompido"
//       por consulta e a 2 (mesmo Id) fechou R/F-P, o cancelamento local não reconfere o fisco.
//     - LOW: o 404 "conclusivo" do GET /dps aceita QUALQUER JSON — um 404 JSON de gateway/rota
//       (`{"message":"no Route matched…"}`) vira "DPS sem NFS-e" (F) em vez de 502 (em voo).
import { EventEmitter } from 'events'

jest.mock('https', () => ({ request: jest.fn() }))
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

import https from 'https'
import { authorityJson, transport, httpsRequest, AuthorityHttpError } from '../shared/tax-authority/https-json'
import * as repo from '../shared/invoice-transmission/transmission.repository'
import * as authority from '../shared/tax-authority'
import * as issuer from '../shared/fiscal-issuer'
import { reconfirmBeforeLocalCancel } from '../shared/invoice-transmission'
import { classifyAuthorityError } from '../shared/invoice-transmission/branches/service'

const actualAuthority = jest.requireActual('../shared/tax-authority')

// ---------------------------------------------------------------------------
// (1) Transporte — regressão do HIGH e das bordas do "antes/depois do handshake"
// ---------------------------------------------------------------------------

type Step = 'socket' | 'secureConnect' | 'error'
function fakeHttps(steps: Step[], opts: { reused?: boolean; err?: any; throwSync?: any } = {}) {
  ;(https.request as jest.Mock).mockImplementation(() => {
    if (opts.throwSync) throw opts.throwSync
    const req: any = new EventEmitter()
    req.reusedSocket = !!opts.reused
    req.write = jest.fn()
    req.destroy = jest.fn()
    req.end = jest.fn(() => setImmediate(() => {
      const socket = new EventEmitter()
      for (const s of steps) {
        if (s === 'socket') req.emit('socket', socket)
        if (s === 'secureConnect') socket.emit('secureConnect')
        if (s === 'error') req.emit('error', opts.err)
      }
    }))
    return req
  })
}
const tlsErr = (code: string, message: string) => Object.assign(new Error(message), { code })
const call = { url: 'https://sefin.example/SefinNacional/nfse', method: 'POST', headers: {}, body: '{}', cert: Buffer.from('c'), key: Buffer.from('k') } as any

describe('Q-ADV1a — re-prova do HIGH (keep-alive) e bordas do handshake', () => {
  beforeEach(() => { transport.request = httpsRequest })
  const badMac = () => tlsErr('ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC', 'SSL routines:ssl3_get_record:decryption failed or bad record mac')

  it('socket REUSADO + erro TLS depois do corpo → 503 ambíguo (nunca 409 AUTH_FAILED / F)', async () => {
    fakeHttps(['socket', 'error'], { reused: true, err: badMac() })
    const e = await authorityJson(call, 'nfse').catch(x => x)
    expect(e).toMatchObject({ statusCode: 503, code: 'FISCAL_AUTHORITY_UNAVAILABLE' })
    expect(classifyAuthorityError(e)).toBe('ambiguous')
  })

  it('socket NOVO com secureConnect (inclui sessão retomada) + erro TLS depois → 503 ambíguo', async () => {
    fakeHttps(['socket', 'secureConnect', 'error'], { err: badMac() })
    expect(classifyAuthorityError(await authorityJson(call, 'nfse').catch(x => x))).toBe('ambiguous')
  })

  it('socket NOVO, erro TLS ANTES do secureConnect → continua credencial (409 AUTH_FAILED → F)', async () => {
    fakeHttps(['socket', 'error'], { err: tlsErr('EPROTO', 'SSL routines:tlsv1 alert unknown ca') })
    const e = await authorityJson(call, 'nfse').catch(x => x)
    expect(e).toMatchObject({ statusCode: 409, code: 'FISCAL_AUTHORITY_AUTH_FAILED' })
    expect(classifyAuthorityError(e)).toBe('auth_failed')
  })

  it('erro emitido ANTES do evento socket (DNS/ECONNREFUSED) → 503 ambíguo', async () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED']) {
      fakeHttps(['error'], { err: tlsErr(code, code) })
      expect(await authorityJson(call, 'nfse').catch(x => x)).toMatchObject({ statusCode: 503 })
    }
  })

  it('par PEM trocado lança SÍNCRONO no https.request → 409 FISCAL_CERT_INVALID (local, nada saiu)', async () => {
    fakeHttps([], { throwSync: tlsErr('ERR_OSSL_X509_KEY_VALUES_MISMATCH', 'x509 certificate routines::key values mismatch') })
    const e = await authorityJson(call, 'nfse').catch(x => x)
    expect(e).toMatchObject({ statusCode: 409, code: 'FISCAL_CERT_INVALID' })
    expect(classifyAuthorityError(e)).toBe('local')
  })
})

// ---------------------------------------------------------------------------
// (2a) MEDIUM — reconferência só olha a tentativa vigente
// ---------------------------------------------------------------------------

const INVOICE = 6300
const DPS_ID = 'DPS410690221234567800019900001000000000000042'   // o MESMO nas duas tentativas (nDPS write-once)
const txRow = (over: any = {}) => ({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, environment: 'P', dpsId: DPS_ID, accessKey: null, nfseNumber: null,
  dhProc: null, createdAt: '2026-09-30 09:00:00', ageMinutes: 30, lastQueriedAt: null, invoiceEvent: 1,
  lastEvent: 1, lastKind: 'F', lastCode: null, lastMessage: null, lastSource: 'Q', lastDh: null, lastEventAt: null, lastEventAgeMinutes: 20, ...over,
})
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }

describe('Q-ADV1b — F "envio interrompido" de tentativa ANTERIOR da mesma vida', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(authority.adapterFor as jest.Mock).mockReturnValue(adapter)
    ;(issuer.openIssuer as jest.Mock).mockResolvedValue({
      issuer: { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null },
      cert: Buffer.from('CERT'), key: Buffer.from('KEY'), info: { expired: false, cnpj: '12345678000199' },
    })
    const f1 = txRow({ attempt: 1, lastKind: 'F', lastSource: 'Q' })
    const r2 = txRow({ attempt: 2, lastKind: 'R', lastSource: 'P', lastCode: 'E0000', lastMessage: 'rejeitada', ageMinutes: 1 })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(r2)
    ;(repo.listServiceTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f1, r2], events: [] })
    ;(repo.getTransmission as jest.Mock).mockImplementation(async (_q: any, _s: any, _i: any, _inv: any, attempt: number) => (attempt === 1 ? f1 : r2))
    ;(repo.findTransmissionByDpsId as jest.Mock).mockResolvedValue(f1)
    adapter.queryDpsAccessKey.mockResolvedValue(null)
  })

  it('controle: o Id do DPS é o mesmo nas tentativas (vida única) — a reconferência pela vigente seria a mesma pergunta', () => {
    expect(txRow({ attempt: 1 }).dpsId).toBe(txRow({ attempt: 2 }).dpsId)
  })

  it('controle do harness: quando a F por consulta É a vigente, a reconferência consulta o fisco', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(txRow({ attempt: 1, lastKind: 'F', lastSource: 'Q' }))
    await reconfirmBeforeLocalCancel('setes_setes', 1, 7, INVOICE)
    expect(adapter.queryDpsAccessKey).toHaveBeenCalledWith(expect.anything(), DPS_ID)
  })

  it('MEDIUM: tentativa 1 fechou F por consulta, tentativa 2 (mesmo Id) R → o cancelamento local deve reconferir GET /dps', async () => {
    await reconfirmBeforeLocalCancel('setes_setes', 1, 7, INVOICE)
    expect(adapter.queryDpsAccessKey).toHaveBeenCalledWith(expect.anything(), DPS_ID)
  })
})

// ---------------------------------------------------------------------------
// (2b) LOW — 404 JSON genérico (gateway/rota) aceito como "DPS sem NFS-e"
// ---------------------------------------------------------------------------

describe('Q-ADV1a — 404 do GET /dps: só a resposta ESTRUTURADA do fisco é conclusiva', () => {
  const realAdn = actualAuthority.adapterFor('ADN')
  const ctx = { environment: 'P', cert: Buffer.from('c'), key: Buffer.from('k') } as any
  const orig = transport.request
  afterAll(() => { transport.request = orig })

  it('controle: 404 REAL do fisco (erro.codigo E2404 — Q-ADV2f) → null (conclusivo)', async () => {
    transport.request = jest.fn().mockResolvedValue({ status: 404, headers: {}, text: '{"tipoAmbiente":0,"dataHoraProcessamento":"2026-09-30T09:42:39.5553657-03:00","erro":{"codigo":"E2404","descricao":"Não foi gerada uma NFS-e com o identificador de DPS informado"}}' })
    expect(await realAdn.queryDpsAccessKey(ctx, DPS_ID)).toBeNull()
  })

  it('LOW: 404 JSON de gateway sem erros[]/codigo ({"message":"no Route matched…"}) → deveria ser 502 (em voo), não null (F)', async () => {
    transport.request = jest.fn().mockResolvedValue({ status: 404, headers: { 'content-type': 'application/json' }, text: '{"message":"no Route matched with those values"}' })
    const out = await realAdn.queryDpsAccessKey(ctx, DPS_ID).catch((e: any) => e)
    expect(out).toBeInstanceOf(AuthorityHttpError)
    expect(out).toMatchObject({ statusCode: 502 })
  })
})
