/// <reference types="jest" />
// Onda 2 (Banco Inter) — GATE ADVERSARIAL (skill testar-adversarial.md, 2026-09-19).
//
// Dois blocos:
//  * ACHADOS — cada teste afirma o comportamento que a spec/decisões prometem
//    (prompt_onda2_banco_inter.md §3/§7 D-I8, D-I10, D-I13) e FALHA no código
//    atual: é a prova do bug. Corrigir o código de produção faz o teste passar —
//    o teste fica como cinto permanente. NÃO corrigir o teste para passar.
//  * PROVAS POSITIVAS — ataques que NÃO reproduziram bug (ficam como regressão).
//
// Harness: mesmo molde dos testes da onda — pool/peças mockados na fronteira,
// transporte HTTPS injetável, supertest para as rotas com JWT assinado.
import fs from 'fs'
import os from 'os'
import path from 'path'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { createPrivateKey } from 'crypto'

const SECRETS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-onda2-adv-'))
process.env.SECRETS_PATH = SECRETS_ROOT
const JWT_SECRET = 'onda2-adversarial'
process.env.JWT_SECRET = JWT_SECRET

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADV01'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../shared/db/deadlock-retry', () => ({ __esModule: true, withDeadlockRetry: (_l: any, _c: any, _n: any, fn: any) => fn() }))
jest.mock('../shared/db/savepoint', () => ({
  __esModule: true,
  runIsolated: async (_c: any, _n: any, _l: any, fn: any) => { try { return await fn() } catch { return null } },
}))
jest.mock('../shared/bank-slip-registration/registration.repository', () => {
  const actual = jest.requireActual('../shared/bank-slip-registration/registration.repository')
  return {
    __esModule: true, ...actual,
    latestRegistration: jest.fn(), insertRegistration: jest.fn(), setRequestCode: jest.fn(), fillBankData: jest.fn(),
    insertRegistrationEvent: jest.fn(), setRegistrationEventEffect: jest.fn(), findRegistrationByRequestCode: jest.fn(),
    listLiveRegistrationsToRefresh: jest.fn(), listInFlightRegistrations: jest.fn(),
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
jest.mock('../shared/entity', () => {
  const actual = jest.requireActual('../shared/entity')
  return { __esModule: true, ...actual, getEntityFiscalFull: jest.fn() }
})

import app from '../app'
import pool from '../shared/db/connection'
import * as repo from '../shared/bank-slip-registration/registration.repository'
import * as slipPiece from '../shared/bank-slip'
import * as channel from '../shared/bank-channel'
import * as entity from '../shared/entity'
import {
  registerBankSlip, refreshRegistration, cancelRegisteredBankSlip, refreshOpenRegistrations,
} from '../shared/bank-slip-registration/bank-slip-registration'
import { HttpError } from '../shared/errors/http-error'
import { BankHttpError, bankJson, transport } from '../shared/bank-channel/https-json'
import { interAdapter, resetInterTokenCache } from '../shared/bank-channel/adapters/inter'
import { secretFilePath, looksLikePrivateKeyPem, certificateInfo } from '../shared/secret-store'
import { extractRequestCodes, setWebhookProcessor, MAX_WEBHOOK_CODES } from '../modules/bank-channel-webhook/bank-channel-webhook.routes'

const q = (pool as any).query as jest.Mock
const conn = { beginTransaction: jest.fn(), query: jest.fn().mockResolvedValue([{}]), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)

const realTransport = transport.request
const mockHttp = jest.fn()
transport.request = mockHttp as any

const adapter = {
  bankNumber: '077', register: jest.fn(), query: jest.fn(), cancel: jest.fn(), pdf: jest.fn(),
  findByReference: jest.fn(), webhookGet: jest.fn(), webhookPut: jest.fn(), webhookDelete: jest.fn(), paySandbox: jest.fn(),
}
const opened = { channel: { bankAccountId: 3, institutionId: 1, environment: 'S', clientId: 'c', inboundToken: 't', active: 'S', bankNumber: '077', accountNumber: '1', accountNumberDv: '2' }, adapter, ctx: {} }
const header = { id: 262, bankAccountId: 3, ourNumber: '262', value: 250, dtExpiration: '2026-10-10', aliqInterest: null, aliqFine: null, aliqDiscount: null, dtDiscountUntil: null, instruction: null }
const lockedOpen = { id: 262, bankAccountId: 3, ourNumber: '262', value: 250, discountValue: 0, aliqDiscount: 0, dtDiscountUntil: null, lastKind: 'E', lastEvent: 1, lastSettledCode: null }
const regLive = (over: any = {}) => ({
  institutionId: 1, slipId: 262, attempt: 1, environment: 'S', requestCode: 'uuid-1', bankOurNumber: null, digitableLine: null, barcode: null,
  pixCopyPaste: null, pixTxid: null, createdAt: '2026-09-19 10:00:00', lastEvent: 1, lastKind: 'S', lastBankStatus: 'EM_PROCESSAMENTO', lastDtBankStatus: null, lastEventAt: '2026-09-19 10:00:00', ...over,
})
const S = { schema: 'setes_setes', inst: 1, user: 7 }
const fmtLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`
const bankStatus = (over: any = {}) => ({
  requestCode: 'uuid-1', reference: '262', status: 'A_RECEBER', statusAt: '2026-09-19', amount: 250, paidValue: null, paidBy: null,
  bankOurNumber: null, digitableLine: null, barcode: null, pixCopyPaste: null, pixTxid: null, cancelReason: null, ...over,
})
const fullEntity = () => ({
  id: 900, entity: { nameCompany: 'Cliente Ltda', nickTrade: null }, personType: 'J', person: null, company: { cnpj: '12.345.678/0001-99' }, noDoc: null,
  addresses: [{ kind: 'C', street: 'Rua A', nmbr: '10', complement: null, neighborhood: 'Centro', zipCode: '80.000-000', tbCountryId: 1, tbStateId: 16, tbCityId: 1, main: 'S', countryName: 'Brasil', stateName: 'Paraná', cityName: 'Curitiba' }],
  phones: [], socialMedia: [],
})
const TOKEN = 'A'.repeat(24) + 'b'.repeat(24)
const channelRow = { bankAccountId: 1, institutionId: 1, environment: 'S', clientId: 'cid', inboundToken: TOKEN, active: 'S', bankNumber: '077', accountNumber: '12345', accountNumberDv: '6' }
const accountRow = { id: 1, bankId: 77, bankNumber: '077', bankName: 'Inter', agency: '0001', number: '12345', numberDv: '6', active: 'S' }

function poolDefaults() {
  q.mockImplementation(async (sql: string, params: any[]) => {
    if (/FROM `setes_setes`\.tb_bank_slip WHERE/.test(sql)) return [[header]]
    if (/tb_bank_slip_title t/.test(sql)) return [[{ entityId: 900 }]]
    if (/tb_state WHERE/.test(sql)) return [[{ abbreviation: 'PR' }]]
    if (/tb_institution WHERE/.test(sql)) return params?.[0] === 1 ? [[{ schemaName: 'setes_setes' }]] : [[]]
    if (/tb_bank_account_channel c/.test(sql)) return [[channelRow]]
    if (/tb_bank_account a/.test(sql)) return [[accountRow]]
    return [[]]
  })
}
const tokenFor = (role: string, institutionId = 1) =>
  jwt.sign({ institutionId, userId: 7, role, schemaName: 'setes_setes' }, JWT_SECRET)
const asUser  = () => `Bearer ${tokenFor('user')}`
const asAdmin = () => `Bearer ${tokenFor('admin')}`
const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: obj == null ? '' : JSON.stringify(obj) })
const tokenResp = ok({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 })
const adapterCtx = { channel: { ...channelRow, bankAccountId: 3 } as any, secrets: { cert: Buffer.from('c'), key: Buffer.from('k'), clientSecret: 's' } }

beforeEach(() => {
  jest.clearAllMocks()
  resetInterTokenCache()
  conn.query.mockResolvedValue([{}])
  poolDefaults()
  ;(entity.getEntityFiscalFull as jest.Mock).mockResolvedValue(fullEntity())
  ;(channel.openBankChannel as jest.Mock).mockResolvedValue(opened)
  ;(channel.findBankChannelByInboundToken as jest.Mock).mockResolvedValue(channelRow)
  ;(slipPiece.lockSlip as jest.Mock).mockResolvedValue({ ...lockedOpen })
  ;(repo.latestRegistration as jest.Mock).mockResolvedValue(null)
  ;(repo.insertRegistration as jest.Mock).mockResolvedValue(1)
  ;(repo.insertRegistrationEvent as jest.Mock).mockResolvedValue(1)
  ;(repo.listInFlightRegistrations as jest.Mock).mockResolvedValue([])
  ;(repo.listLiveRegistrationsToRefresh as jest.Mock).mockResolvedValue([])
})
afterAll(() => {
  transport.request = realTransport
  fs.rmSync(SECRETS_ROOT, { recursive: true, force: true })
  delete process.env.SECRETS_PATH
})

// ===========================================================================
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO A1 (HIGH) — resultado AMBÍGUO do banco no emitir vira F e libera attempt 2 sem reconciliar por seuNumero (D-I13)', () => {
  // Timeout/5xx/200-sem-JSON = o Inter PODE ter registrado a cobrança. Marcar F
  // (final) e deixar o operador registrar de novo produz DUAS cobranças vivas no
  // banco com o mesmo seuNumero; o cliente paga a órfã e ninguém aqui fica sabendo
  // (webhook cai em `unknown`, findByReference nunca roda para F). A
  // reconciliação da D-I13 só olha reservas SEM evento — F a torna invisível.
  const secondRegistrationNeedsReconciliation = async () => {
    // 2ª chamada: a 1ª tentativa está encerrada (F) e o boleto continua aberto
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'F', requestCode: null, lastEvent: 1 }))
    ;(repo.insertRegistration as jest.Mock).mockResolvedValue(2)
    adapter.register.mockResolvedValue({ requestCode: 'uuid-NOVO' })
    let outcome: any
    try { outcome = await registerBankSlip(S.schema, S.inst, S.user, 262) } catch (e) { outcome = e }
    const emittedAgain = adapter.register.mock.calls.length === 2
    if (emittedAgain) {
      // só pode apresentar de novo depois de perguntar ao banco por seuNumero
      expect(adapter.findByReference).toHaveBeenCalledWith(expect.anything(), '262', expect.any(String), expect.any(String))
      expect(adapter.findByReference.mock.invocationCallOrder[0]).toBeLessThan(adapter.register.mock.invocationCallOrder[1])
    } else {
      expect(outcome).toMatchObject({ statusCode: 409 })   // ou recusa até reconciliar
    }
  }

  it('timeout (BANK_UNAVAILABLE) no POST /cobrancas', async () => {
    adapter.register.mockRejectedValueOnce(new BankHttpError(503, 'Banco indisponível', 'BANK_UNAVAILABLE', 0, ''))
    await expect(registerBankSlip(S.schema, S.inst, S.user, 262)).rejects.toMatchObject({ code: 'BANK_UNAVAILABLE' })
    await secondRegistrationNeedsReconciliation()
  })

  it('banco respondeu 200 sem JSON legível (BANK_REJECTED com bankStatus 200)', async () => {
    adapter.register.mockRejectedValueOnce(new BankHttpError(422, 'Banco aceitou sem devolver codigoSolicitacao', 'BANK_REJECTED', 200, 'garbage'))
    await expect(registerBankSlip(S.schema, S.inst, S.user, 262)).rejects.toMatchObject({ code: 'BANK_REJECTED' })
    await secondRegistrationNeedsReconciliation()
  })

  it('reserva interrompida há > 10 min: registerBankSlip fecha em F e apresenta de novo SEM consultar o banco', async () => {
    const old = new Date(Date.now() - 30 * 60_000)
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: null, lastEvent: null, requestCode: null, createdAt: fmtLocal(old) }))
    ;(repo.insertRegistration as jest.Mock).mockResolvedValue(2)
    adapter.register.mockResolvedValue({ requestCode: 'uuid-2' })
    let outcome: any
    try { outcome = await registerBankSlip(S.schema, S.inst, S.user, 262) } catch (e) { outcome = e }
    if (adapter.register.mock.calls.length === 1) {
      expect(adapter.findByReference).toHaveBeenCalled()
      expect(adapter.findByReference.mock.invocationCallOrder[0]).toBeLessThan(adapter.register.mock.invocationCallOrder[0])
    } else {
      expect(outcome).toMatchObject({ statusCode: 409 })
    }
  })
})

describe('ACHADO A2 (MEDIUM) — corrida registrar × cancelar deixa cobrança VIVA no banco para boleto cancelado aqui', () => {
  it('cancelar com reserva EM ANDAMENTO (POST ao banco em voo) deve recusar 409, não cancelar localmente às cegas', async () => {
    const now = new Date()
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: null, lastEvent: null, requestCode: null, createdAt: fmtLocal(now) }))
    ;(slipPiece.cancelBankSlip as jest.Mock).mockResolvedValue(9)
    // hoje: resolve com bankNotified=false e o boleto vira C enquanto o banco
    // ainda pode responder "sim" ao registro em voo (o passo 3b grava S depois)
    await expect(cancelRegisteredBankSlip(S.schema, S.inst, S.user, 262, null))
      .rejects.toMatchObject({ statusCode: 409, code: 'BANK_SLIP_REGISTRATION_IN_PROGRESS' })
    expect(slipPiece.cancelBankSlip).not.toHaveBeenCalled()
  })

  it('passo 3b do registro (código + S) não reconfere o estado do boleto: boleto cancelado entre a reserva e o aceite fica com apresentação viva', async () => {
    ;(slipPiece.lockSlip as jest.Mock)
      .mockResolvedValueOnce({ ...lockedOpen })                       // reserva: aberto
      .mockResolvedValueOnce({ ...lockedOpen, lastKind: 'C', lastEvent: 2 })   // aceite: já cancelado por outro fluxo
    adapter.register.mockResolvedValue({ requestCode: 'uuid-1' })
    adapter.cancel.mockResolvedValue(undefined)
    try { await registerBankSlip(S.schema, S.inst, S.user, 262) } catch { /* recusar também é aceitável */ }
    const sWritten = (repo.insertRegistrationEvent as jest.Mock).mock.calls.some(c => c[6]?.kind === 'S')
    const bankToldToCancel = adapter.cancel.mock.calls.length > 0
    // invariante: não pode sobrar apresentação S viva sem o banco ter sido avisado
    expect(sWritten && !bankToldToCancel).toBe(false)
  })
})

describe('ACHADO A3 (MEDIUM) — voz ATRASADA do banco não é ignorada: regressão de estado passa pela composição e só o UNIQUE barra (→ 500)', () => {
  it('apresentação já em R (liquidada) e uma consulta antiga devolve A_RECEBER → nenhum evento novo, changed=false', async () => {
    // Dois refreshes concorrentes (webhook × tela): o que consultou primeiro
    // (A_RECEBER) grava por último. A idempotência compara só com o ÚLTIMO
    // evento; o cinto UNIQUE (kind, dt) então estoura ER_DUP_ENTRY = 500
    // (crashlytics) — ou, se (kind, dt) ainda não existia, grava G DEPOIS de R e
    // a próxima consulta do estado real passa a violar o UNIQUE até o banco mudar.
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'R', lastBankStatus: 'RECEBIDO', lastDtBankStatus: '2026-09-21 00:00:00', lastEvent: 3 }))
    ;(slipPiece.lockSlip as jest.Mock).mockResolvedValue({ ...lockedOpen, lastKind: 'L', lastEvent: 5 })
    adapter.query.mockResolvedValue(bankStatus({ status: 'A_RECEBER', statusAt: '2026-09-19' }))
    const r = await refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')
    expect(r.changed).toBe(false)
    expect(repo.insertRegistrationEvent).not.toHaveBeenCalled()
  })
})

describe('ACHADO A4 (MEDIUM) — cancelar valida o estado LOCAL só depois de já ter pedido cancelamento ao banco', () => {
  it('boleto já LIQUIDADO aqui com apresentação viva: 409 BANK_SLIP_NOT_OPEN SEM chamar o banco', async () => {
    // "banco primeiro" (D-I8) = não gravar antes do aceite; não significa disparar
    // um ato irreversível no banco para uma requisição que vai falhar aqui. Hoje
    // o cancel chega ao Inter, o usuário recebe 409 e nenhum K registra o pedido.
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
    ;(slipPiece.lockSlip as jest.Mock).mockResolvedValue({ ...lockedOpen, lastKind: 'L', lastEvent: 5 })
    ;(slipPiece.cancelBankSlip as jest.Mock).mockRejectedValue(new HttpError(409, 'não está em aberto', undefined, 'BANK_SLIP_NOT_OPEN'))
    adapter.cancel.mockResolvedValue(undefined)
    await expect(cancelRegisteredBankSlip(S.schema, S.inst, S.user, 262, 'x')).rejects.toMatchObject({ code: 'BANK_SLIP_NOT_OPEN' })
    expect(adapter.cancel).not.toHaveBeenCalled()
  })

  it('boleto já cancelado aqui (apresentação em K aguardando confirmação): 2º cancelar não pede ao banco de novo', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'K' }))
    ;(slipPiece.lockSlip as jest.Mock).mockResolvedValue({ ...lockedOpen, lastKind: 'C', lastEvent: 4 })
    ;(slipPiece.cancelBankSlip as jest.Mock).mockRejectedValue(new HttpError(409, 'não está em aberto', undefined, 'BANK_SLIP_NOT_OPEN'))
    adapter.cancel.mockResolvedValue(undefined)
    await expect(cancelRegisteredBankSlip(S.schema, S.inst, S.user, 262, null)).rejects.toMatchObject({ code: 'BANK_SLIP_NOT_OPEN' })
    expect(adapter.cancel).not.toHaveBeenCalled()
  })
})

describe('ACHADO A5 (MEDIUM) — a voz do banco sobre a apresentação N é gravada na apresentação N+1 (TOCTOU reg0 × reg)', () => {
  it('consulta feita para o código da tentativa 1; ao travar, a tentativa 2 já existe → o evento tem que ficar na 1 (ou não ser gravado)', async () => {
    ;(repo.latestRegistration as jest.Mock)
      .mockResolvedValueOnce(regLive({ attempt: 1, requestCode: 'uuid-1', lastKind: 'S' }))                      // fora do lock
      .mockResolvedValueOnce(regLive({ attempt: 2, requestCode: null, lastKind: null, lastEvent: null }))       // sob o lock
    adapter.query.mockResolvedValue(bankStatus({ status: 'FALHA_EMISSAO', statusAt: '2026-09-19T10:05:00', digitableLine: '7'.repeat(47) }))
    await refreshRegistration(S.schema, S.inst, S.user, 262, 'W')
    for (const call of (repo.insertRegistrationEvent as jest.Mock).mock.calls) expect(call[4]).toBe(1)
    for (const call of (repo.fillBankData as jest.Mock).mock.calls) expect(call[4]).toBe(1)
  })
})

describe('ACHADO A6 (MEDIUM) — GET /channel devolve o inbound_token (credencial do webhook) a usuário NÃO admin', () => {
  it('perfil comum lê o canal: recebe presença/validade, mas NÃO a chave que autentica o banco', async () => {
    const res = await request(app).get('/api/bank-accounts/1/channel').set('Authorization', asUser())
    expect(res.status).toBe(200)
    const body = JSON.stringify(res.body)
    expect(body).not.toContain(TOKEN)
  })
})

describe('ACHADO A7 (MEDIUM) — upload aceita chave privada ilegível; depois todo erro vira "Banco indisponível"', () => {
  it('PUT /channel/secrets com PEM de chave que o Node não interpreta → 400 BANK_CHANNEL_SECRET_INVALID (não gravar)', async () => {
    const garbageKey = '-----BEGIN PRIVATE KEY-----\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----'
    expect(looksLikePrivateKeyPem(garbageKey)).toBe(true)                 // a forma passa...
    expect(() => createPrivateKey(garbageKey)).toThrow()                  // ...o conteúdo não
    const res = await request(app).put('/api/bank-accounts/1/channel/secrets').set('Authorization', asAdmin()).send({ privateKeyPem: garbageKey })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('BANK_CHANNEL_SECRET_INVALID')
    expect(fs.existsSync(secretFilePath({ schemaName: 'setes_setes', owner: 'bank-account', ownerId: 1, environment: 'S', name: 'client.key' }))).toBe(false)
  })
})

// ===========================================================================
// PROVAS POSITIVAS — ataques que NÃO reproduziram bug (regressão)
// ===========================================================================

describe('secret-store — caminho derivado resiste a traversal e a componentes fora da forma', () => {
  const ref = (over: Record<string, any> = {}) => ({ schemaName: 'setes_setes', owner: 'bank-account' as const, ownerId: 1, environment: 'S' as const, name: 'client.crt', ...over })
  it.each([
    ['..'], ['../x'], ['a/../b'], ['a\\b'], [''], ['ção.crt'], ['CLIENT.CRT'], ['a'.repeat(65)], ['/etc/passwd'], ['C:\\x'], ['a b'], ['.hidden'],
  ])('name %p é recusado', (name) => {
    expect(() => secretFilePath(ref({ name }))).toThrow()
  })
  it.each([[0], [-1], [1.5], [NaN], ['1' as any], [Infinity]])('ownerId %p é recusado', (ownerId) => {
    expect(() => secretFilePath(ref({ ownerId }))).toThrow()
  })
  it('schema de OUTRO cliente só por ref explícito — e ref com schema fora da forma é recusado', () => {
    const a = secretFilePath(ref({ schemaName: 'setes_alpha' }))
    const b = secretFilePath(ref({ schemaName: 'setes_beta' }))
    expect(a).not.toBe(b)
    expect(() => secretFilePath(ref({ schemaName: 'setes_alpha/../setes_beta' }))).toThrow()
    expect(() => secretFilePath(ref({ schemaName: 'mysql' }))).toThrow()
  })
  it('nome válido mas esquisito ("a..", "x.-_") nunca sai da raiz', () => {
    for (const name of ['a..', 'x.-_', '0']) {
      const p = secretFilePath(ref({ name }))
      expect(path.relative(SECRETS_ROOT, p).startsWith('..')).toBe(false)
    }
  })
  it('certificateInfo com PEM inválido lança (o upload traduz para 400)', () => {
    expect(() => certificateInfo('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----')).toThrow()
  })
  it('A7 corrigido: com cert/chave ilegíveis o transporte real responde 409 BANK_AUTH_FAILED (credencial), não "banco fora"', async () => {
    transport.request = realTransport
    try {
      await expect(bankJson({ url: 'https://127.0.0.1:9/x', method: 'GET', cert: Buffer.from('nope'), key: Buffer.from('nope'), timeoutMs: 2000 }, 'adv'))
        .rejects.toMatchObject({ statusCode: 409, code: 'BANK_AUTH_FAILED' })
    } finally { transport.request = mockHttp as any }
  })
})

describe('adaptador Inter — bordas do transporte', () => {
  it('401 duas vezes seguidas → BANK_AUTH_FAILED em 4 chamadas (sem loop)', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce({ status: 401, headers: {}, text: '' })
      .mockResolvedValueOnce(tokenResp).mockResolvedValueOnce({ status: 401, headers: {}, text: '' })
    await expect(interAdapter.query(adapterCtx, 'c')).rejects.toMatchObject({ statusCode: 409, code: 'BANK_AUTH_FAILED' })
    expect(mockHttp).toHaveBeenCalledTimes(4)
  })
  it('500 com HTML → 503 BANK_UNAVAILABLE e o HTML não vaza na mensagem ao usuário', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce({ status: 500, headers: {}, text: '<html><body>Bad Gateway</body></html>' })
    const err: any = await interAdapter.query(adapterCtx, 'c').catch(e => e)
    expect(err).toMatchObject({ statusCode: 503, code: 'BANK_UNAVAILABLE' })
    expect(err.message).not.toContain('<html>')
  })
  it('429 sem Retry-After → 503 BANK_RATE_LIMITED', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce({ status: 429, headers: {}, text: '' })
    await expect(interAdapter.query(adapterCtx, 'c')).rejects.toMatchObject({ statusCode: 503, code: 'BANK_RATE_LIMITED' })
  })
  it('200 com JSON inválido na consulta → situação vazia → a composição responde 502 BANK_STATUS_UNKNOWN sem gravar NADA (nem write-once)', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce({ status: 200, headers: {}, text: '{not json' })
    const st = await interAdapter.query(adapterCtx, 'uuid-1')
    expect(st.status).toBe('')
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive())
    adapter.query.mockResolvedValue(st)
    await expect(refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')).rejects.toMatchObject({ statusCode: 502, code: 'BANK_STATUS_UNKNOWN' })
    expect(conn.beginTransaction).not.toHaveBeenCalled()
    expect(repo.fillBankData).not.toHaveBeenCalled()
  })
  it('situação desconhecida ("NOVO_STATUS") na consulta → 502 sem gravar', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive())
    adapter.query.mockResolvedValue(bankStatus({ status: 'NOVO_STATUS' }))
    await expect(refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')).rejects.toMatchObject({ code: 'BANK_STATUS_UNKNOWN' })
    expect(repo.insertRegistrationEvent).not.toHaveBeenCalled()
  })
  it('token: expires_in ausente → cache 59 min; expires_in não numérico → cai no default de 1 h e CACHEIA (LOW corrigido)', async () => {
    mockHttp.mockResolvedValueOnce(ok({ access_token: 't1' })).mockResolvedValueOnce(ok({ cobranca: { situacao: 'A_RECEBER' } }))
      .mockResolvedValueOnce(ok({ cobranca: { situacao: 'A_RECEBER' } }))
    await interAdapter.query(adapterCtx, 'a'); await interAdapter.query(adapterCtx, 'a')
    expect(mockHttp).toHaveBeenCalledTimes(3)                                   // 1 token
    jest.clearAllMocks(); resetInterTokenCache()
    mockHttp.mockResolvedValueOnce(ok({ access_token: 't2', expires_in: 'abc' })).mockResolvedValueOnce(ok({ cobranca: { situacao: 'A_RECEBER' } }))
      .mockResolvedValueOnce(ok({ cobranca: { situacao: 'A_RECEBER' } }))
    await interAdapter.query(adapterCtx, 'a'); await interAdapter.query(adapterCtx, 'a')
    const tokenCalls = mockHttp.mock.calls.filter(c => /oauth\/v2\/token/.test(c[0].url)).length
    expect(tokenCalls).toBe(1)                                                  // LOW corrigido: 'abc' → default 1 h, cacheado
  })
  it('seuNumero > 15 é cortado no adaptador (a composição já recusa antes com 422 — defesa em profundidade)', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce(ok({ codigoSolicitacao: 'x' }))
    await interAdapter.register(adapterCtx, { reference: '1234567890123456', amount: 10.005, dueDate: '2026-10-10', payer: { document: '12345678901', personType: 'F', name: 'n', street: 's', neighborhood: null, city: 'c', state: 'PR', zipCode: '80000000' } })
    const body = JSON.parse(mockHttp.mock.calls[1][0].body)
    expect(body.seuNumero).toHaveLength(15)
    expect(body.valorNominal).toBe(10.01)                                      // 3 casas → 2 (toFixed)
    // e a composição recusa ANTES de reservar
    q.mockImplementation(async (sql: string) => /tb_bank_slip WHERE/.test(sql) ? [[{ ...header, ourNumber: '1234567890123456' }]] : /tb_bank_slip_title/.test(sql) ? [[{ entityId: 900 }]] : /tb_state/.test(sql) ? [[{ abbreviation: 'PR' }]] : [[]])
    await expect(registerBankSlip(S.schema, S.inst, S.user, 262)).rejects.toMatchObject({ statusCode: 422, code: 'BANK_SLIP_REFERENCE_TOO_LONG' })
    expect(repo.insertRegistration).not.toHaveBeenCalled()
  })
  it('conta sem número → header x-conta-corrente omitido (spec: opcional quando a aplicação tem 1 conta)', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce(ok({ cobranca: { situacao: 'A_RECEBER' } }))
    await interAdapter.query({ ...adapterCtx, channel: { ...adapterCtx.channel, accountNumber: null, accountNumberDv: null } }, 'a')
    expect(mockHttp.mock.calls[1][0].headers['x-conta-corrente']).toBeUndefined()
  })
  it('pagador com CPF/CNPJ e CEP mascarados → só dígitos chegam ao banco', async () => {
    adapter.register.mockResolvedValue({ requestCode: 'u' })
    const e = fullEntity(); e.company = { cnpj: '12.345.678/0001-99' }; e.addresses[0].zipCode = '80.000-000'
    ;(entity.getEntityFiscalFull as jest.Mock).mockResolvedValue(e)
    await registerBankSlip(S.schema, S.inst, S.user, 262)
    expect(adapter.register.mock.calls[0][1].payer).toMatchObject({ document: '12345678000199', zipCode: '80000000' })
  })
})

describe('composição — concorrência e idempotência', () => {
  it('dois registros SIMULTÂNEOS do mesmo boleto sob lock serializado → um apresenta, o outro 409 IN_PROGRESS (uma cobrança só)', async () => {
    // mutex simula o FOR UPDATE do lockSlip; latestRegistration reflete a reserva
    let chain = Promise.resolve(); const releases: (() => void)[] = []
    const acquire = () => { let rel!: () => void; const p = new Promise<void>(r => (rel = r)); const prev = chain; chain = chain.then(() => p); return prev.then(() => rel) }
    let reserved: any = null
    ;(slipPiece.lockSlip as jest.Mock).mockImplementation(async () => { releases.push(await acquire()); return { ...lockedOpen } })
    conn.commit.mockImplementation(async () => { releases.shift()?.() })
    conn.rollback.mockImplementation(async () => { releases.shift()?.() })
    ;(repo.latestRegistration as jest.Mock).mockImplementation(async () => reserved)
    ;(repo.insertRegistration as jest.Mock).mockImplementation(async () => { reserved = regLive({ lastKind: null, lastEvent: null, requestCode: null, createdAt: fmtLocal(new Date()) }); return 1 })
    adapter.register.mockResolvedValue({ requestCode: 'uuid-1' })
    const results = await Promise.allSettled([registerBankSlip(S.schema, S.inst, S.user, 262), registerBankSlip(S.schema, S.inst, S.user, 262)])
    const okCount = results.filter(r => r.status === 'fulfilled').length
    const busy = results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason)
    expect(okCount).toBe(1)
    expect(busy).toHaveLength(1)
    expect(busy[0]).toMatchObject({ statusCode: 409, code: 'BANK_SLIP_REGISTRATION_IN_PROGRESS' })
    expect(adapter.register).toHaveBeenCalledTimes(1)
  })

  it('refresh idempotente: mesmo (kind, dt) duas vezes → 1 evento; dt NULL === NULL também não duplica', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G', lastDtBankStatus: '2026-09-19 00:00:00' }))
    adapter.query.mockResolvedValue(bankStatus({ status: 'A_RECEBER', statusAt: '2026-09-19' }))
    expect((await refreshRegistration(S.schema, S.inst, S.user, 262, 'W')).changed).toBe(false)
    expect((await refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')).changed).toBe(false)
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'M', lastDtBankStatus: null }))
    adapter.query.mockResolvedValue(bankStatus({ status: 'MARCADO_RECEBIDO', statusAt: null }))
    expect((await refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')).changed).toBe(false)
    expect(repo.insertRegistrationEvent).not.toHaveBeenCalled()
  })

  it('RECEBIDO para boleto liquidado MANUALMENTE (source M) → fato R gravado ligado ao L existente, sem 2ª baixa', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
    ;(repo.insertRegistrationEvent as jest.Mock).mockResolvedValue(2)
    ;(slipPiece.lockSlip as jest.Mock).mockResolvedValue({ ...lockedOpen, lastKind: 'L', lastEvent: 5 })
    adapter.query.mockResolvedValue(bankStatus({ status: 'RECEBIDO', statusAt: '2026-09-21', paidValue: 250 }))
    const r = await refreshRegistration(S.schema, S.inst, S.user, 262, 'W')
    expect(r).toMatchObject({ changed: true, kind: 'R', slipEvent: 5, effectRefused: null })
    expect(slipPiece.settleBankSlip).not.toHaveBeenCalled()
  })

  it('CANCELADO no banco para boleto já cancelado aqui → fato C ligado ao C existente (link), sem novo evento no boleto', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'K' }))
    ;(repo.insertRegistrationEvent as jest.Mock).mockResolvedValue(3)
    ;(slipPiece.lockSlip as jest.Mock).mockResolvedValue({ ...lockedOpen, lastKind: 'C', lastEvent: 4 })
    adapter.query.mockResolvedValue(bankStatus({ status: 'CANCELADO', statusAt: '2026-09-22' }))
    const r = await refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')
    expect(r).toMatchObject({ kind: 'C', slipEvent: 4 })
    expect(slipPiece.cancelBankSlip).not.toHaveBeenCalled()
  })

  it('RECEBIDO com valor ABAIXO da face → peça recusa → fato gravado com pendência (D-I10), boleto continua aberto', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G' }))
    ;(repo.insertRegistrationEvent as jest.Mock).mockResolvedValue(2)
    ;(slipPiece.settleBankSlip as jest.Mock).mockRejectedValue(new HttpError(409, 'abaixo', undefined, 'BANK_SLIP_BELOW_MINIMUM'))
    adapter.query.mockResolvedValue(bankStatus({ status: 'RECEBIDO', statusAt: '2026-09-21', paidValue: 1 }))
    const r = await refreshRegistration(S.schema, S.inst, S.user, 262, 'Q')
    expect(r).toMatchObject({ slipEvent: null, effectRefused: 'abaixo' })
    expect(repo.setRegistrationEventEffect).toHaveBeenCalledWith(conn, S.schema, S.inst, 262, 1, 2, null, expect.stringMatching(/Efeito recusado/))
  })

  it('cancelar: banco responde 4xx (BANK_REJECTED) → fail-closed, nada gravado (D-I8); a consulta prévia (MED-2) não conta como ato', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G', lastBankStatus: 'A_RECEBER', lastDtBankStatus: null }))
    adapter.query.mockResolvedValue(bankStatus({ status: 'A_RECEBER', statusAt: null }))
    adapter.cancel.mockRejectedValue(new BankHttpError(422, 'já cancelada', 'BANK_REJECTED', 400, '{}'))
    await expect(cancelRegisteredBankSlip(S.schema, S.inst, S.user, 262, null)).rejects.toMatchObject({ code: 'BANK_REJECTED' })
    expect(slipPiece.cancelBankSlip).not.toHaveBeenCalled(); expect(repo.insertRegistrationEvent).not.toHaveBeenCalled()
  })

  it('cancelar: banco 202 mas a gravação local falha → erro sobe, transação desfeita (K não fica sem C)', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ lastKind: 'G', lastBankStatus: 'A_RECEBER', lastDtBankStatus: null }))
    adapter.query.mockResolvedValue(bankStatus({ status: 'A_RECEBER', statusAt: null }))
    adapter.cancel.mockResolvedValue(undefined)
    ;(slipPiece.cancelBankSlip as jest.Mock).mockRejectedValue(Object.assign(new Error('lock'), { code: 'ER_LOCK_WAIT_TIMEOUT' }))
    await expect(cancelRegisteredBankSlip(S.schema, S.inst, S.user, 262, null)).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' })
    expect(conn.rollback).toHaveBeenCalled(); expect(repo.insertRegistrationEvent).not.toHaveBeenCalled()
  })

  it('consulta ativa: minMinutes/limit vindos do body chegam crus à peça (throttle é do CLIENTE — ver relatório, LOW)', async () => {
    await refreshOpenRegistrations(S.schema, S.inst, S.user, { minMinutes: 0, limit: 50 })
    expect(repo.listLiveRegistrationsToRefresh).toHaveBeenCalledWith(S.schema, S.inst, 0, 50)
  })
})

describe('rotas — autorização, escopo e bordas de entrada', () => {
  it('PUT /channel, DELETE /channel, PUT/DELETE /channel/secrets, rotate-token e PUT/DELETE /channel/webhook: perfil comum → 403', async () => {
    const calls = [
      request(app).put('/api/bank-accounts/1/channel').set('Authorization', asUser()).send({ environment: 'S', clientId: 'x' }),
      request(app).delete('/api/bank-accounts/1/channel').set('Authorization', asUser()),
      request(app).put('/api/bank-accounts/1/channel/secrets').set('Authorization', asUser()).send({ clientSecret: 'x' }),
      request(app).delete('/api/bank-accounts/1/channel/secrets').set('Authorization', asUser()),
      request(app).post('/api/bank-accounts/1/channel/rotate-token').set('Authorization', asUser()),
      request(app).put('/api/bank-accounts/1/channel/webhook').set('Authorization', asUser()).send({ url: 'https://x' }),
      request(app).delete('/api/bank-accounts/1/channel/webhook').set('Authorization', asUser()),
    ]
    for (const res of await Promise.all(calls)) expect(res.status).toBe(403)
  })
  it('sem JWT → 401 em todas as rotas do sub-recurso e do registro', async () => {
    for (const [m, u] of [['get', '/api/bank-accounts/1/channel'], ['post', '/api/bank-slips/1/register'], ['post', '/api/bank-slips/refresh'], ['get', '/api/bank-slips/1/pdf'], ['post', '/api/bank-slips/1/pay-sandbox']] as const) {
      const res = await (request(app) as any)[m](u)
      expect(res.status).toBe(401)
    }
  })
  it('PUT /channel/secrets: PEM sem BEGIN → 400 BANK_CHANNEL_SECRET_INVALID; body vazio → 400 VALIDATION_FAILED; certificado ilegível → 400', async () => {
    let res = await request(app).put('/api/bank-accounts/1/channel/secrets').set('Authorization', asAdmin()).send({ certificatePem: 'MIIB...' })
    expect(res.status).toBe(400); expect(res.body.code).toBe('BANK_CHANNEL_SECRET_INVALID')
    res = await request(app).put('/api/bank-accounts/1/channel/secrets').set('Authorization', asAdmin()).send({})
    expect(res.status).toBe(400); expect(res.body.code).toBe('VALIDATION_FAILED')
    res = await request(app).put('/api/bank-accounts/1/channel/secrets').set('Authorization', asAdmin()).send({ certificatePem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----' })
    expect(res.status).toBe(400); expect(res.body.code).toBe('BANK_CHANNEL_SECRET_INVALID')
  })
  it('PUT /channel/secrets: campo acima de 64 KB → 400 (DTO) — antes do limite de 2 MB do body parser', async () => {
    const res = await request(app).put('/api/bank-accounts/1/channel/secrets').set('Authorization', asAdmin()).send({ clientSecret: 'x'.repeat(5000) })
    expect(res.status).toBe(400); expect(res.body.code).toBe('VALIDATION_FAILED')
  })
  it('GET /channel de conta de OUTRO institution → 404 sem vazar', async () => {
    q.mockImplementation(async () => [[]])
    const res = await request(app).get('/api/bank-accounts/77/channel').set('Authorization', asUser())
    expect(res.status).toBe(404); expect(res.body.code).toBe('BANK_ACCOUNT_NOT_FOUND')
  })
  it('POST /:id/register para boleto de OUTRO institution → 404 BANK_SLIP_NOT_FOUND, banco nunca chamado', async () => {
    q.mockImplementation(async () => [[]])
    const res = await request(app).post('/api/bank-slips/999/register').set('Authorization', asUser())
    expect(res.status).toBe(404); expect(res.body.code).toBe('BANK_SLIP_NOT_FOUND')
    expect(adapter.register).not.toHaveBeenCalled()
  })
  it('GET /:id/pdf sem apresentação → 409 BANK_SLIP_NOT_REGISTERED', async () => {
    const res = await request(app).get('/api/bank-slips/262/pdf').set('Authorization', asUser())
    expect(res.status).toBe(409); expect(res.body.code).toBe('BANK_SLIP_NOT_REGISTERED')
  })
  it('POST /:id/pay-sandbox com apresentação em PRODUÇÃO → 409 antes de tocar o banco', async () => {
    ;(repo.latestRegistration as jest.Mock).mockResolvedValue(regLive({ environment: 'P', lastKind: 'G' }))
    const res = await request(app).post('/api/bank-slips/262/pay-sandbox').set('Authorization', asUser()).send({ via: 'PIX' })
    expect(res.status).toBe(409); expect(res.body.code).toBe('BANK_REJECTED')
    expect(adapter.paySandbox).not.toHaveBeenCalled()
  })
  it('POST /refresh: minMinutes negativo / limit 51 → 400; :id não numérico → 400 INVALID_ID', async () => {
    let res = await request(app).post('/api/bank-slips/refresh').set('Authorization', asUser()).send({ minMinutes: -1 })
    expect(res.status).toBe(400)
    res = await request(app).post('/api/bank-slips/refresh').set('Authorization', asUser()).send({ limit: 51 })
    expect(res.status).toBe(400)
    res = await request(app).post('/api/bank-slips/abc/register').set('Authorization', asUser())
    expect(res.status).toBe(400); expect(res.body.code).toBe('INVALID_ID')
  })
})

describe('webhook público — bordas', () => {
  const processed: any[] = []
  beforeAll(() => setWebhookProcessor(async (schema, inst, codes) => { processed.push({ schema, inst, codes }); return { ok: 1 } }))
  afterAll(() => setWebhookProcessor(null))
  beforeEach(() => { processed.length = 0 })
  const flush = () => new Promise(r => setImmediate(r))

  it('GET → 404; body não-JSON → 200 received 0; array vazio → 200 received 0; objeto sem código → 200 received 0', async () => {
    expect((await request(app).get(`/hooks/bank-channel/1/${TOKEN}`)).status).toBe(404)
    const r1 = await request(app).post(`/hooks/bank-channel/1/${TOKEN}`).set('Content-Type', 'text/plain').send('RECEBIDO')
    expect(r1.status).toBe(200); expect(r1.body.received).toBe(0)
    const r2 = await request(app).post(`/hooks/bank-channel/1/${TOKEN}`).send([])
    expect(r2.status).toBe(200); expect(r2.body.received).toBe(0)
    await flush(); expect(processed).toEqual([])
  })
  it('token com formato inválido (curto, com "/", unicode) → 404 sem consultar o canal', async () => {
    ;(channel.findBankChannelByInboundToken as jest.Mock).mockResolvedValue(null)
    for (const t of ['abc', 'a'.repeat(19), 'ção'.repeat(10), 'x'.repeat(65)]) {
      const res = await request(app).post(`/hooks/bank-channel/1/${encodeURIComponent(t)}`).send([{ codigoSolicitacao: 'uuid-0001-aaaa' }])
      expect(res.status).toBe(404)
    }
  })
  it('institution existente mas token de OUTRO institution → 404 (o token é procurado só no schema do path)', async () => {
    ;(channel.findBankChannelByInboundToken as jest.Mock).mockResolvedValue(null)
    const res = await request(app).post(`/hooks/bank-channel/1/${TOKEN}`).send([{ codigoSolicitacao: 'uuid-0001-aaaa' }])
    expect(res.status).toBe(404)
    expect(channel.findBankChannelByInboundToken).toHaveBeenCalledWith('setes_setes', TOKEN)
  })
  it('10.000 itens: extractRequestCodes tem TETO (LOW corrigido — MAX_WEBHOOK_CODES) e a rota responde 200 antes de processar', async () => {
    const body = Array.from({ length: 10_000 }, (_, i) => ({ codigoSolicitacao: `uuid-${String(i).padStart(8, '0')}` }))
    expect(extractRequestCodes(body)).toHaveLength(MAX_WEBHOOK_CODES)
    const res = await request(app).post(`/hooks/bank-channel/1/${TOKEN}`).send(body)
    expect(res.status).toBe(200); expect(res.body.received).toBe(MAX_WEBHOOK_CODES)
    await flush(); expect(processed[0].codes).toHaveLength(MAX_WEBHOOK_CODES)
  })
  it('DB fora ao identificar o canal → 500 (o Inter reenvia); nada processado', async () => {
    q.mockImplementation(async () => { throw new Error('db down') })
    const res = await request(app).post(`/hooks/bank-channel/1/${TOKEN}`).send([{ codigoSolicitacao: 'uuid-0001-aaaa' }])
    expect(res.status).toBe(500); await flush(); expect(processed).toEqual([])
  })
})
