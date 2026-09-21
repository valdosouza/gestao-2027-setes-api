/// <reference types="jest" />
// Onda 2 (Banco Inter) — retrabalho dos gates (socrático 0.64 + adversarial +
// sondas ao vivo, 2026-09-19). Cada bloco fixa UM achado, para ninguém desfazer:
//  HIGH-1  efeito que falhou por causa TRANSITÓRIA (lock wait/deadlock/erro de
//          programa) NÃO vira "efeito recusado" permanente — a transação desfaz e a
//          próxima consulta tenta de novo; só recusa de REGRA (HttpError 4xx) grava.
//  HIGH-2  a consulta ativa marca `last_queried_at` mesmo sem novidade (rodízio).
//  HIGH-3  tentativa INTERROMPIDA há > 10 min é reconciliada no banco por seuNumero
//          ANTES de virar F — achou = 409 já registrado; banco fora = nada muda.
//  MED-1   reconciliação ignora códigos já conhecidos do boleto (tentativas antigas).
//  MED-2   cancelar CONSULTA o banco antes de pedir cancelamento (pago → 409).
//  MED-3   rotina com orçamento de tempo + parada antecipada nos órfãos + coalescência.
//  MED-5   webhook: teto de códigos por chamada e processamento SERIAL por institution.
//  A2      falha de TLS/certificado no handshake = credencial (409), não "indisponível".
//  LOW-1   401 do PRÓPRIO endpoint de token não dispara retentativa.
//  A1      chave privada PEM é validada de verdade (corpo lixo é recusado).
import request from 'supertest'
import { generateKeyPairSync } from 'crypto'
import app from '../app'
import pool from '../shared/db/connection'
import * as repo from '../shared/bank-slip-registration/registration.repository'
import * as slipPiece from '../shared/bank-slip'
import * as channel from '../shared/bank-channel'
import * as entity from '../shared/entity'
import {
  registerBankSlip, refreshRegistration, cancelRegisteredBankSlip, refreshOpenRegistrations, REFRESH_BUDGET_MS,
} from '../shared/bank-slip-registration/bank-slip-registration'
import { HttpError } from '../shared/errors/http-error'
import { BankHttpError, bankJson, transport } from '../shared/bank-channel/https-json'
import { interAdapter, resetInterTokenCache } from '../shared/bank-channel/adapters/inter'
import { validatePrivateKeyPem } from '../shared/secret-store'
import { setWebhookProcessor, extractRequestCodes, MAX_WEBHOOK_CODES } from '../modules/bank-channel-webhook/bank-channel-webhook.routes'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/db/deadlock-retry', () => ({ __esModule: true, withDeadlockRetry: (_l: any, _c: any, _n: any, fn: any) => fn() }))
// savepoint REAL (conn.query mockado resolve SAVEPOINT/ROLLBACK TO): o que se testa é quem engole o quê
jest.mock('../shared/bank-slip-registration/registration.repository', () => {
  const actual = jest.requireActual('../shared/bank-slip-registration/registration.repository')
  return {
    __esModule: true, ...actual,
    latestRegistration: jest.fn(), insertRegistration: jest.fn(), setRequestCode: jest.fn(), fillBankData: jest.fn(),
    insertRegistrationEvent: jest.fn(), setRegistrationEventEffect: jest.fn(), findRegistrationByRequestCode: jest.fn(),
    listLiveRegistrationsToRefresh: jest.fn(), listInFlightRegistrations: jest.fn(),
    touchQueriedAt: jest.fn(), listSlipRequestCodes: jest.fn(),
  }
})
jest.mock('../shared/bank-slip', () => {
  const actual = jest.requireActual('../shared/bank-slip')
  return { __esModule: true, ...actual, lockSlip: jest.fn(), settleBankSlip: jest.fn(), cancelBankSlip: jest.fn() }
})
jest.mock('../shared/bank-channel', () => {
  const actual = jest.requireActual('../shared/bank-channel')
  return { __esModule: true, ...actual, openBankChannel: jest.fn(), findBankChannelByInboundToken: jest.fn() }
})
jest.mock('../shared/entity', () => ({ __esModule: true, ...jest.requireActual('../shared/entity'), getEntityFiscalFull: jest.fn() }))

const q = (pool as any).query as jest.Mock
const conn = { beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)

const adapter = {
  bankNumber: '077', register: jest.fn(), query: jest.fn(), cancel: jest.fn(), pdf: jest.fn(),
  findByReference: jest.fn(), webhookGet: jest.fn(), webhookPut: jest.fn(), webhookDelete: jest.fn(), paySandbox: jest.fn(),
}
const opened = { channel: { bankAccountId: 3, institutionId: 1, environment: 'S', clientId: 'c', inboundToken: 't', active: 'S', bankNumber: '077', accountNumber: '1', accountNumberDv: '2' }, adapter, ctx: {} }
const header = { id: 262, bankAccountId: 3, ourNumber: '262', value: 250, dtExpiration: '2026-10-10', aliqInterest: null, aliqFine: null, aliqDiscount: null, dtDiscountUntil: null, instruction: null }
const lockedOpen = { id: 262, bankAccountId: 3, ourNumber: '262', value: 250, discountValue: 0, aliqDiscount: 0, dtDiscountUntil: null, lastKind: 'E', lastEvent: 1, lastSettledCode: null }
const regLive = (over: any = {}) => ({
  institutionId: 1, slipId: 262, attempt: 1, environment: 'S', requestCode: 'uuid-1', bankOurNumber: null, digitableLine: null, barcode: null,
  pixCopyPaste: null, pixTxid: null, createdAt: '2026-09-19 10:00:00', lastQueriedAt: null, lastEvent: 1, lastKind: 'S', lastBankStatus: 'EM_PROCESSAMENTO', lastDtBankStatus: null, lastEventAt: '2026-09-19 10:00:00', ...over,
})
const S = { schema: 'setes_setes', inst: 1, user: 7 }
// hora LOCAL (a composição lê created_at como local, igual ao DATE_FORMAT do banco)
const fmtLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
const staleAt = () => fmtLocal(new Date(Date.now() - 30 * 60_000))
const regInFlightStale = (over: any = {}) => regLive({ requestCode: null, lastEvent: null, lastKind: null, lastBankStatus: null, lastEventAt: null, createdAt: staleAt(), ...over })
const status = (over: any = {}) => ({
  requestCode: 'uuid-1', reference: '262', status: 'RECEBIDO', statusAt: '2026-09-20T10:00:00', amount: 250, paidValue: 250,
  paidBy: 'PIX', bankOurNumber: '999', digitableLine: null, barcode: null, pixCopyPaste: null, pixTxid: null, cancelReason: null, ...over,
})

function poolDefaults() {
  q.mockImplementation(async (sql: string) => {
    if (/FROM `setes_setes`\.tb_bank_slip WHERE/.test(sql)) return [[header]]
    if (/tb_bank_slip_title t/.test(sql)) return [[{ entityId: 900 }]]
    if (/tb_state/.test(sql)) return [[{ abbreviation: 'PR' }]]
    return [[]]
  })
}
const fullEntity = () => ({
  id: 900, entity: { nameCompany: 'Cliente Ltda', nickTrade: null }, personType: 'J', person: null, company: { cnpj: '12.345.678/0001-99' }, noDoc: null,
  addresses: [{ kind: 'C', street: 'Rua A', nmbr: '10', complement: null, neighborhood: 'Centro', zipCode: '80.000-000', tbCountryId: 1, tbStateId: 16, tbCityId: 1, main: 'S', countryName: 'Brasil', stateName: 'Paraná', cityName: 'Curitiba' }],
  phones: [], socialMedia: [],
})

beforeEach(() => {
  jest.clearAllMocks()
  conn.query.mockResolvedValue([{}])
  poolDefaults()
  ;(entity.getEntityFiscalFull as jest.Mock).mockResolvedValue(fullEntity())
  ;(channel.openBankChannel as jest.Mock).mockResolvedValue(opened)
  ;(slipPiece.lockSlip as jest.Mock).mockResolvedValue({ ...lockedOpen })
  ;(repo.latestRegistration as jest.Mock).mockResolvedValue(null)
  ;(repo.insertRegistration as jest.Mock).mockResolvedValue(1)
  ;(repo.insertRegistrationEvent as jest.Mock).mockResolvedValue(1)
  ;(repo.listSlipRequestCodes as jest.Mock).mockResolvedValue([])
  ;(repo.listInFlightRegistrations as jest.Mock).mockResolvedValue([])
  ;(repo.listLiveRegistrationsToRefresh as jest.Mock).mockResolvedValue([])
})

// ---------------------------------------------------------------------------
describe('HIGH-1 — efeito transitório não vira recusa permanente', () => {
  it('lock wait no título ao liquidar: a transação é desfeita (rollback), nada gravado como "Efeito recusado"', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G', lastBankStatus: 'A_RECEBER' }))
    adapter.query.mockResolvedValue(status())
    const lockWait = Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 })
    ;(slipPiece.settleBankSlip as jest.Mock).mockRejectedValue(lockWait)

    await expect(refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' })
    expect(conn.rollback).toHaveBeenCalled()
    expect(conn.commit).not.toHaveBeenCalled()
    expect(repo.setRegistrationEventEffect).not.toHaveBeenCalled()
  })

  it('erro de PROGRAMA no efeito (TypeError) também não é recusa: falha alto', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
    adapter.query.mockResolvedValue(status())
    ;(slipPiece.settleBankSlip as jest.Mock).mockRejectedValue(new TypeError('x is not a function'))
    await expect(refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')).rejects.toBeInstanceOf(TypeError)
    expect(repo.setRegistrationEventEffect).not.toHaveBeenCalled()
  })

  it('recusa de REGRA (409 do boleto cancelado aqui) continua fato + pendência (D-I10)', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
    ;(slipPiece.lockSlip as jest.Mock).mockResolvedValue({ ...lockedOpen, lastKind: 'C', lastEvent: 2 })
    adapter.query.mockResolvedValue(status())
    const r = await refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')
    expect(r.changed).toBe(true)
    expect(r.slipEvent).toBeNull()
    expect(r.effectRefused).toMatch(/cancelled/)
    expect(repo.setRegistrationEventEffect).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, 1, null, expect.stringMatching(/^Efeito recusado/))
    expect(conn.commit).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
describe('HIGH-2 — a consulta marca last_queried_at mesmo sem novidade', () => {
  it('mesma situação e data → changed:false, e ainda assim touchQueriedAt', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G', lastBankStatus: 'A_RECEBER', lastDtBankStatus: '2026-09-19 10:00:00' }))
    adapter.query.mockResolvedValue(status({ status: 'A_RECEBER', statusAt: '2026-09-19T10:00:00', paidValue: null }))
    const r = await refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')
    expect(r.changed).toBe(false)
    expect(repo.touchQueriedAt).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1)
    expect(repo.insertRegistrationEvent).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
describe('HIGH-3 — tentativa interrompida reconcilia ANTES de virar F', () => {
  it('banco não tem cobrança com o seuNumero → F (source Q) e a nova tentativa segue', async () => {
    ;(repo.latestRegistration as jest.Mock)
      .mockResolvedValueOnce(regInFlightStale())                         // pré-checagem (pool)
      .mockResolvedValueOnce(regInFlightStale({ lastKind: 'F', lastEvent: 1 })) // dentro da reserva, já reconciliada
    adapter.findByReference.mockResolvedValue([])
    adapter.register.mockResolvedValue({ requestCode: 'uuid-2' })
    ;(repo.insertRegistration as jest.Mock).mockResolvedValue(2)

    const r = await registerBankSlip(S.schema, S.inst, S.user, 262)
    expect(r.attempt).toBe(2)
    expect(adapter.findByReference).toHaveBeenCalledWith(opened.ctx, '262', expect.any(String), expect.any(String))
    expect(repo.insertRegistrationEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, S.user,
      expect.objectContaining({ kind: 'F', source: 'Q' }))
    expect(adapter.register).toHaveBeenCalledTimes(1)
  })

  it('banco TEM a cobrança → apresentação retroativa (código + S) e 409 já registrado; nenhum novo envio', async () => {
    ;(repo.latestRegistration as jest.Mock)
      .mockResolvedValueOnce(regInFlightStale())
      .mockResolvedValueOnce(regLive({ requestCode: 'found-1', lastKind: 'S' }))   // reconciliada, viva
      .mockResolvedValue(regLive({ requestCode: 'found-1', lastKind: 'S' }))
    adapter.findByReference.mockResolvedValue([status({ requestCode: 'found-1', status: 'A_RECEBER', paidValue: null })])
    adapter.query.mockResolvedValue(status({ requestCode: 'found-1', status: 'A_RECEBER', paidValue: null }))

    await expect(registerBankSlip(S.schema, S.inst, S.user, 262)).rejects.toMatchObject({ statusCode: 409, code: 'BANK_SLIP_ALREADY_REGISTERED' })
    expect(repo.setRequestCode).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, 'found-1')
    expect(adapter.register).not.toHaveBeenCalled()
    expect(repo.insertRegistration).not.toHaveBeenCalled()
  })

  it('banco FORA na reconciliação → o registro falha (503) sem F e sem novo envio (fail-closed, D-I8)', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regInFlightStale())
    adapter.findByReference.mockRejectedValue(new BankHttpError(503, 'fora', 'BANK_UNAVAILABLE', 0, ''))
    await expect(registerBankSlip(S.schema, S.inst, S.user, 262)).rejects.toMatchObject({ code: 'BANK_UNAVAILABLE' })
    expect(repo.insertRegistrationEvent).not.toHaveBeenCalled()
    expect(repo.insertRegistration).not.toHaveBeenCalled()
    expect(adapter.register).not.toHaveBeenCalled()
  })

  it('tentativa em andamento há MENOS de 10 min continua 409 IN_PROGRESS sem ir ao banco', async () => {
    const fresh = regInFlightStale({ createdAt: fmtLocal(new Date()) })
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(fresh)
    await expect(registerBankSlip(S.schema, S.inst, S.user, 262)).rejects.toMatchObject({ code: 'BANK_SLIP_REGISTRATION_IN_PROGRESS' })
    expect(adapter.findByReference).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
describe('MED-1 — reconciliação ignora códigos já conhecidos do boleto', () => {
  it('cobrança da tentativa 1 (FALHA_EMISSAO, código conhecido) não é adotada pela tentativa 2; a nova é', async () => {
    ;(repo.listInFlightRegistrations as jest.Mock).mockResolvedValue([regInFlightStale({ attempt: 2 })])
    ;(repo.listSlipRequestCodes as jest.Mock).mockResolvedValue(['old-1'])
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ attempt: 2, requestCode: 'new-2', lastKind: 'S' }))
    adapter.findByReference.mockResolvedValue([
      status({ requestCode: 'old-1', status: 'FALHA_EMISSAO', statusAt: '2026-09-19T09:00:00' }),
      status({ requestCode: 'new-2', status: 'A_RECEBER', statusAt: '2026-09-19T11:00:00', paidValue: null }),
    ])
    const report = await refreshOpenRegistrations(S.schema, S.inst, S.user)
    expect(report.reconciled).toBe(1)
    expect(repo.setRequestCode).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 2, 'new-2')
  })

  it('só códigos já conhecidos → F (não adota o código velho, que daria ER_DUP_ENTRY)', async () => {
    ;(repo.listInFlightRegistrations as jest.Mock).mockResolvedValue([regInFlightStale({ attempt: 2 })])
    ;(repo.listSlipRequestCodes as jest.Mock).mockResolvedValue(['old-1'])
    adapter.findByReference.mockResolvedValue([status({ requestCode: 'old-1', status: 'FALHA_EMISSAO' })])
    const report = await refreshOpenRegistrations(S.schema, S.inst, S.user)
    expect(report.reconciled).toBe(0)
    expect(repo.setRequestCode).not.toHaveBeenCalled()
    expect(repo.insertRegistrationEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 2, S.user, expect.objectContaining({ kind: 'F', source: 'Q' }))
  })
})

// ---------------------------------------------------------------------------
describe('MED-2 — cancelar consulta o banco antes de pedir cancelamento', () => {
  it('banco diz RECEBIDO na consulta prévia → liquida aqui (source A) e recusa o cancelamento com 409; cancel() nunca é chamado', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
    adapter.query.mockResolvedValue(status())
    ;(slipPiece.settleBankSlip as jest.Mock).mockResolvedValue({ event: 5, settledCode: 9, statementId: 1, titles: 1 })
    await expect(cancelRegisteredBankSlip(S.schema, S.inst, S.user, 262, 'x')).rejects.toMatchObject({ statusCode: 409, code: 'BANK_SLIP_NOT_OPEN' })
    expect(slipPiece.settleBankSlip).toHaveBeenCalled()
    expect(adapter.cancel).not.toHaveBeenCalled()
    expect(slipPiece.cancelBankSlip).not.toHaveBeenCalled()
  })

  it('banco diz A_RECEBER → pede o cancelamento (202) e grava C + K, como antes', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G', lastBankStatus: 'A_RECEBER', lastDtBankStatus: '2026-09-19 10:00:00' }))
    adapter.query.mockResolvedValue(status({ status: 'A_RECEBER', statusAt: '2026-09-19T10:00:00', paidValue: null }))
    adapter.cancel.mockResolvedValue(undefined)
    ;(slipPiece.cancelBankSlip as jest.Mock).mockResolvedValue(3)
    const r = await cancelRegisteredBankSlip(S.schema, S.inst, S.user, 262, 'x')
    expect(r).toEqual({ slipEvent: 3, bankNotified: true, attempt: 1 })
    expect(adapter.query.mock.invocationCallOrder[0]).toBeLessThan(adapter.cancel.mock.invocationCallOrder[0])
  })
})

// ---------------------------------------------------------------------------
describe('MED-3 — rotina de consulta ativa com orçamento e coalescência', () => {
  it('estoura o orçamento de tempo → para com stoppedEarly, sem varrer a lista inteira', async () => {
    ;(repo.listLiveRegistrationsToRefresh as jest.Mock).mockResolvedValue([regLive({ slipId: 1 }), regLive({ slipId: 2 }), regLive({ slipId: 3 })])
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G', lastBankStatus: 'A_RECEBER', lastDtBankStatus: '2026-09-19 10:00:00' }))
    adapter.query.mockImplementation(() => new Promise(r => setTimeout(() => r(status({ status: 'A_RECEBER', statusAt: '2026-09-19T10:00:00', paidValue: null })), 30)))
    const report = await refreshOpenRegistrations(S.schema, S.inst, S.user, { budgetMs: 20 })
    expect(report.stoppedEarly).toBe(true)
    expect(report.checked).toBeLessThan(3)
    expect(REFRESH_BUDGET_MS).toBeGreaterThanOrEqual(10_000)
  })

  it('órfãos: banco FORA no primeiro → não insiste nos outros (stoppedEarly)', async () => {
    ;(repo.listInFlightRegistrations as jest.Mock).mockResolvedValue([regInFlightStale({ slipId: 1 }), regInFlightStale({ slipId: 2 }), regInFlightStale({ slipId: 3 })])
    adapter.findByReference.mockRejectedValue(new BankHttpError(503, 'fora', 'BANK_UNAVAILABLE', 0, ''))
    const report = await refreshOpenRegistrations(S.schema, S.inst, S.user)
    expect(adapter.findByReference).toHaveBeenCalledTimes(1)
    expect(report.stoppedEarly).toBe(true)
    expect(repo.listLiveRegistrationsToRefresh).not.toHaveBeenCalled()
  })

  it('duas chamadas simultâneas da MESMA institution coalescem numa só varredura', async () => {
    ;(repo.listLiveRegistrationsToRefresh as jest.Mock).mockImplementation(() => new Promise(r => setTimeout(() => r([]), 20)))
    const [a, b] = await Promise.all([
      refreshOpenRegistrations(S.schema, S.inst, S.user),
      refreshOpenRegistrations(S.schema, S.inst, S.user),
    ])
    expect(repo.listLiveRegistrationsToRefresh).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })
})

// ---------------------------------------------------------------------------
describe('MED-5 — webhook público: teto por chamada e processamento serial por institution', () => {
  const TOKEN = 'a'.repeat(48)
  const liveChannel = { bankAccountId: 3, institutionId: 1, environment: 'S', clientId: 'c', inboundToken: TOKEN, active: 'S', bankNumber: '077', accountNumber: '1', accountNumberDv: null }
  const findChannel = channel.findBankChannelByInboundToken as jest.Mock
  const flush = () => new Promise(r => setTimeout(r, 5))
  afterAll(() => setWebhookProcessor(null))

  it(`mais de ${MAX_WEBHOOK_CODES} códigos numa chamada → só os primeiros são aceitos (received = teto)`, async () => {
    const seen: string[][] = []
    setWebhookProcessor(async (_s, _i, codes) => { seen.push(codes); return {} })
    findChannel.mockResolvedValue(liveChannel)
    q.mockImplementation(async (sql: string) => /tb_institution/.test(sql) ? [[{ schemaName: 'setes_setes' }]] : [[]])
    const body = Array.from({ length: MAX_WEBHOOK_CODES + 50 }, (_, i) => ({ codigoSolicitacao: `code-${String(i).padStart(8, '0')}` }))
    const res = await request(app).post(`/hooks/bank-channel/1/${TOKEN}`).send(body)
    expect(res.status).toBe(200)
    expect(res.body.received).toBe(MAX_WEBHOOK_CODES)
    await flush()
    expect(seen[0]).toHaveLength(MAX_WEBHOOK_CODES)
    expect(extractRequestCodes(body)).toHaveLength(MAX_WEBHOOK_CODES)
  })

  it('duas chamadas seguidas → o 2º processamento só começa quando o 1º termina', async () => {
    const log: string[] = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    setWebhookProcessor(async (_s, _i, codes) => {
      log.push(`start:${codes[0]}`)
      if (codes[0] === 'first-00000001') await gate
      log.push(`end:${codes[0]}`)
      return {}
    })
    findChannel.mockResolvedValue(liveChannel)
    q.mockImplementation(async (sql: string) => /tb_institution/.test(sql) ? [[{ schemaName: 'setes_setes' }]] : [[]])
    await request(app).post(`/hooks/bank-channel/1/${TOKEN}`).send([{ codigoSolicitacao: 'first-00000001' }])
    await request(app).post(`/hooks/bank-channel/1/${TOKEN}`).send([{ codigoSolicitacao: 'second-0000002' }])
    await flush()
    expect(log).toEqual(['start:first-00000001'])
    release(); await flush(); await flush()
    expect(log).toEqual(['start:first-00000001', 'end:first-00000001', 'start:second-0000002', 'end:second-0000002'])
  })
})

// ---------------------------------------------------------------------------
describe('A2 — falha de TLS/certificado no handshake é credencial, não indisponibilidade', () => {
  const original = transport.request
  afterEach(() => { transport.request = original })

  it.each([
    ['EPROTO', 'write EPROTO ... tlsv1 alert unknown ca'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'self signed certificate'],
    ['ERR_OSSL_PEM_NO_START_LINE', 'no start line'],
    ['CERT_HAS_EXPIRED', 'certificate has expired'],
  ])('%s → 409 BANK_AUTH_FAILED com mensagem de certificado', async (code, message) => {
    transport.request = jest.fn().mockRejectedValue(Object.assign(new Error(message), { code }))
    await expect(bankJson({ url: 'https://x/y', method: 'GET' }, 't')).rejects.toMatchObject({ statusCode: 409, code: 'BANK_AUTH_FAILED', message: expect.stringMatching(/certificado|chave/i) })
  })

  it('ECONNREFUSED / timeout continuam 503 BANK_UNAVAILABLE', async () => {
    transport.request = jest.fn().mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    await expect(bankJson({ url: 'https://x/y', method: 'GET' }, 't')).rejects.toMatchObject({ statusCode: 503, code: 'BANK_UNAVAILABLE' })
    transport.request = jest.fn().mockRejectedValue(new Error('timeout'))
    await expect(bankJson({ url: 'https://x/y', method: 'GET' }, 't')).rejects.toMatchObject({ statusCode: 503, code: 'BANK_UNAVAILABLE' })
  })
})

// ---------------------------------------------------------------------------
describe('LOW-1 — 401 do PRÓPRIO endpoint de token não dispara retentativa', () => {
  const original = transport.request
  afterEach(() => { transport.request = original; resetInterTokenCache() })

  it('secret errado: UMA chamada ao /oauth/v2/token e 409 BANK_AUTH_FAILED', async () => {
    const http = jest.fn().mockResolvedValue({ status: 401, headers: {}, text: '{"error":"invalid_client"}' })
    transport.request = http
    const ctx = {
      channel: { bankAccountId: 3, institutionId: 1, environment: 'S' as const, clientId: 'cid', inboundToken: 't'.repeat(48), active: 'S' as const, bankNumber: '077', accountNumber: '12345', accountNumberDv: '6' },
      secrets: { cert: Buffer.from('c'), key: Buffer.from('k'), clientSecret: 'errado' },
    }
    await expect(interAdapter.query(ctx, 'abc-123')).rejects.toMatchObject({ code: 'BANK_AUTH_FAILED' })
    expect(http).toHaveBeenCalledTimes(1)
    expect(http.mock.calls[0][0].url).toMatch(/\/oauth\/v2\/token$/)
  })
})

// ---------------------------------------------------------------------------
describe('A1 — chave privada PEM validada de verdade', () => {
  it('chave RSA real passa; PEM com corpo lixo e cabeçalho certo é recusado', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    expect(validatePrivateKeyPem(pem)).toBeNull()
    expect(validatePrivateKeyPem('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----')).toEqual(expect.any(String))
    expect(validatePrivateKeyPem('nao-e-pem')).toEqual(expect.any(String))
  })
})

// ---------------------------------------------------------------------------
describe('re-score 0.76 — M2 e L1 corrigidos em sessão', () => {
  it('M2: consulta que falha ANTES da voz do banco por causa PERSISTENTE marca last_queried_at (não monopoliza o rodízio)', async () => {
    ;(repo.listLiveRegistrationsToRefresh as jest.Mock).mockResolvedValue([regLive({ slipId: 1 }), regLive({ slipId: 2 })])
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
    ;(channel.openBankChannel as jest.Mock).mockRejectedValue(new HttpError(409, 'Canal inativo', undefined, 'BANK_CHANNEL_MISSING'))
    const report = await refreshOpenRegistrations(S.schema, S.inst, S.user)
    expect(report.errors).toHaveLength(2)
    expect(report.stoppedEarly).toBe(false)
    expect(repo.touchQueriedAt).toHaveBeenCalledTimes(2)
    expect((repo.touchQueriedAt as jest.Mock).mock.calls[0][0]).toBe(pool)   // fora da transação (não há tx)
  })

  it('M2: contenção (lock wait) NÃO marca — a próxima corrida deve tentar de novo', async () => {
    ;(repo.listLiveRegistrationsToRefresh as jest.Mock).mockResolvedValue([regLive({ slipId: 1 })])
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
    adapter.query.mockResolvedValue(status({ status: 'A_RECEBER', paidValue: null }))
    ;(slipPiece.lockSlip as jest.Mock).mockRejectedValue(Object.assign(new Error('lock'), { code: 'ER_LOCK_WAIT_TIMEOUT' }))
    const report = await refreshOpenRegistrations(S.schema, S.inst, S.user)
    expect(report.errors).toHaveLength(1)
    expect(repo.touchQueriedAt).not.toHaveBeenCalled()
  })

  it('L1: consulta prévia diz CANCELADO → o C do próprio efeito (source A) é a resposta; sem 2º cancelBankSlip nem pedido ao banco', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
    adapter.query.mockResolvedValue(status({ status: 'CANCELADO', statusAt: '2026-09-20T09:00:00', paidValue: null, cancelReason: 'PAGADOR' }))
    ;(slipPiece.cancelBankSlip as jest.Mock).mockResolvedValue(7)
    const r = await cancelRegisteredBankSlip(S.schema, S.inst, S.user, 262, 'x')
    expect(r).toEqual({ slipEvent: 7, bankNotified: false, attempt: 1 })
    expect(slipPiece.cancelBankSlip).toHaveBeenCalledTimes(1)                 // só o do efeito (source 'A')
    expect((slipPiece.cancelBankSlip as jest.Mock).mock.calls[0][6]).toBe('A')
    expect(adapter.cancel).not.toHaveBeenCalled()
  })
})
