/// <reference types="jest" />
// Onda 3 (NFS-e pelo Padrão Nacional) — GATE ADVERSARIAL (skill testar-adversarial.md, 2026-09-22).
//
// Dois blocos, como na Onda 2 (onda2-adversarial.test.ts é o molde):
//  * ACHADOS — cada teste afirma o que a spec promete (prompt_onda3_nfse_adn.md §8
//    D-N3/D-N7/D-N12, §1 "séries do aplicativo próprio 00001–49999", lições §10.3/§10.4
//    da Onda 2) e FALHA no código atual: é a prova do bug. A correção é da sessão
//    principal — NUNCA corrigir o teste para passar.
//  * PROVAS POSITIVAS — ataques que NÃO reproduziram bug (ficam como regressão).
//
// Harness: pool/repositório da transmissão mockados na fronteira (loja de eventos em
// memória para provar idempotência), `adapterFor` injetável (adaptador falso OU o ADN
// REAL com `transport.request` mockado — nenhum socket), `signXml`/cofre/`openIssuer`/
// `runIsolated`/`buildCancelPlan` REAIS, certificado autoassinado gerado no teste.
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import forge from 'node-forge'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { gzipSync } from 'zlib'

const SECRETS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-onda3-adv-secrets-'))
const STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-onda3-adv-storage-'))
process.env.SECRETS_PATH = SECRETS_ROOT
process.env.STORAGE_PATH = STORAGE_ROOT
const JWT_SECRET = 'onda3-adversarial'
process.env.JWT_SECRET = JWT_SECRET

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADV03'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../shared/db/deadlock-retry', () => ({ __esModule: true, withDeadlockRetry: (_l: any, _c: any, _n: any, fn: any) => fn() }))
jest.mock('../shared/db/counters', () => ({ __esModule: true, lockInstitutionCounters: jest.fn(), setLockWaitSupported: jest.fn(), isLockWaitSupported: () => false, detectLockWaitSupport: jest.fn() }))
jest.mock('../shared/invoice-transmission/transmission.repository', () => {
  const actual = jest.requireActual('../shared/invoice-transmission/transmission.repository')
  return {
    __esModule: true, ...actual,
    latestTransmission: jest.fn(), insertTransmission: jest.fn(), setDpsId: jest.fn(), fillAuthorityData: jest.fn(),
    insertTransmissionEvent: jest.fn(), setTransmissionEventEffect: jest.fn(), hasTransmissionEvent: jest.fn(),
    findTransmissionEvent: jest.fn(), findTransmissionEventByKind: jest.fn(), getTransmission: jest.fn(), findTransmissionByDpsId: jest.fn(),
    touchQueriedAt: jest.fn(), listServiceTransmissions: jest.fn(),
    listLiveTransmissionsToRefresh: jest.fn(), nextDpsNumber: jest.fn(), setDpsNumber: jest.fn(), countPendingEffects: jest.fn(),
    listPendingServiceInvoices: jest.fn(),
  }
})
jest.mock('../shared/tax-authority', () => {
  const actual = jest.requireActual('../shared/tax-authority')
  return { __esModule: true, ...actual, adapterFor: jest.fn() }
})
jest.mock('../shared/fiscal-issuer/fiscal-issuer.repository', () => {
  const actual = jest.requireActual('../shared/fiscal-issuer/fiscal-issuer.repository')
  return { __esModule: true, ...actual, getIssuer: jest.fn() }
})
jest.mock('../shared/entity', () => {
  const actual = jest.requireActual('../shared/entity')
  return { __esModule: true, ...actual, getEntityFiscalFull: jest.fn() }
})
jest.mock('../shared/entity-tax/entity-tax.repository', () => {
  const actual = jest.requireActual('../shared/entity-tax/entity-tax.repository')
  return { __esModule: true, ...actual, getEntityTax: jest.fn() }
})
jest.mock('../shared/invoice', () => {
  const actual = jest.requireActual('../shared/invoice')
  return { __esModule: true, ...actual, lockInvoice: jest.fn(), buildCancelPlan: jest.fn(), cancelInvoice: jest.fn() }
})
jest.mock('../modules/billing/billing.interface-resolver', () => {
  const resolveOrderInterface = jest.fn(async (_s: string, _i: number, _o: number) => 'orders')
  return {
    __esModule: true, resolveOrderInterface,
    resolveFromBody: (req: any) => resolveOrderInterface(req.institution.schemaName, req.institution.institutionId, Number(req.body?.orderId)),
    resolveFromParam: (req: any) => resolveOrderInterface(req.institution.schemaName, req.institution.institutionId, Number(req.params?.orderId)),
  }
})

import app from '../app'
import pool from '../shared/db/connection'
import * as repo from '../shared/invoice-transmission/transmission.repository'
import * as authority from '../shared/tax-authority'
import * as issuerRepo from '../shared/fiscal-issuer/fiscal-issuer.repository'
import * as entity from '../shared/entity'
import * as entityTax from '../shared/entity-tax/entity-tax.repository'
import * as invoice from '../shared/invoice'
import * as counters from '../shared/db/counters'
import * as resolver from '../modules/billing/billing.interface-resolver'
import { HttpError } from '../shared/errors/http-error'
import { AuthorityHttpError, transport, authorityRejections } from '../shared/tax-authority/https-json'
import { adnAdapter } from '../shared/tax-authority/adapters/adn'
import { buildDpsId, buildDpsXml, signXml, verifyXml, DpsInput, unescapeXml } from '../shared/tax-authority'
import {
  transmitServiceInvoice, refreshServiceTransmission, cancelServiceInvoiceAtAuthority, refreshOpenServiceTransmissions, toDbDateTime,
} from '../shared/invoice-transmission'
import { resetMunicipalTermsCache } from '../shared/invoice-transmission/branches/service'
import { issuerSecretRef, ISSUER_SECRET_NAMES, pkcs12ToPem, storeIssuerCertificate } from '../shared/fiscal-issuer'
import { writeSecret, deleteSecret, hasSecret } from '../shared/secret-store'
import { issuerDto } from '../modules/establishment/establishment.issuer.dto'
import { resetPrivilegeCache } from '../shared/auth/require-privilege'

const actualInvoice = jest.requireActual('../shared/invoice')

// ---------------------------------------------------------------------------
// certificado autoassinado REAL (par RSA 2048) — nunca um e-CNPJ de verdade
// ---------------------------------------------------------------------------
const CNPJ = '12345678000199'
function selfSigned(cn: string, notAfter: Date, notBefore = new Date(Date.now() - 60_000), keyPem?: string) {
  const kp = keyPem ?? (crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) as string)
  const fk = forge.pki.privateKeyFromPem(kp)
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.setRsaPublicKey(fk.n, fk.e)
  cert.serialNumber = String(Date.now() + Math.floor(Math.random() * 1000))
  cert.validity.notBefore = notBefore
  cert.validity.notAfter = notAfter
  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }]
  cert.setSubject(attrs); cert.setIssuer(attrs)
  cert.sign(fk, forge.md.sha256.create())
  return { cert, certPem: forge.pki.certificateToPem(cert), keyPem: kp, forgeKey: fk }
}
function toPfx(keyPem: string, certs: forge.pki.Certificate[], password: string | null): Buffer {
  const asn1 = forge.pkcs12.toPkcs12Asn1(forge.pki.privateKeyFromPem(keyPem), certs, password, { algorithm: '3des' })
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary')
}
const PAIR = selfSigned(`SETES TESTE:${CNPJ}`, new Date(Date.now() + 365 * 86_400_000))
const EXPIRED = selfSigned(`SETES VENCIDA:${CNPJ}`, new Date(Date.now() - 86_400_000), new Date(Date.now() - 2 * 86_400_000))

const S = { schema: 'setes_setes', inst: 1, user: 7 }
const INVOICE = 6200
const KEY = '4106902212345678000199000000000012320260921000012345'.slice(0, 50)
const DPS_ID = 'DPS410690221234567800019900001000000000000042'
const NFSE_XML = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${KEY}"><nNFSe>123</nNFSe><dhProc>2026-09-21T10:15:30-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS Id="${DPS_ID}"></infDPS></DPS></infNFSe></NFSe>`
const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')

const vault = (env: 'H' | 'P' = 'H') => ({
  cert: issuerSecretRef(S.schema, S.inst, ISSUER_SECRET_NAMES.cert),
  key:  issuerSecretRef(S.schema, S.inst, ISSUER_SECRET_NAMES.key),
})
function installVault(certPem = PAIR.certPem, keyPem = PAIR.keyPem, env: 'H' | 'P' = 'H') {
  writeSecret(vault(env).cert, certPem); writeSecret(vault(env).key, keyPem)
}
function clearVault(env: 'H' | 'P' = 'H') { deleteSecret(vault(env).cert); deleteSecret(vault(env).key) }

const q = (pool as any).query as jest.Mock
const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)

const realTransport = transport.request
const mockHttp = jest.fn()
transport.request = mockHttp as any

const adapter = { authority: 'ADN' as const, transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const useRealAdn = () => (authority.adapterFor as jest.Mock).mockReturnValue(adnAdapter)

const BRANCH_AT = '2026-09-21 09:00:00'
const header = (over: any = {}) => ({
  id: INVOICE, number: '17', serie: '1', model: 'SE', value: 1234.5, dtEmission: '2026-09-21', entityId: 900, status: '0', lastKind: 'E',
  lastEvent: 1, branchUpdatedAt: BRANCH_AT, branchId: INVOICE, serviceListId: '1.02', nationalCode: '010201', municipalCode: null, cityId: 1, baseIss: 1234.5, aliqIss: 2,
  issValue: 24.69, issWithheld: 'N', liability: '1', dpsNumber: null, description: 'Licença mensal ERP', totalValue: 1234.5, ...over,
})
const fullEntity = (id: number): any => ({
  id, entity: { nameCompany: id === 1 ? 'SETES SISTEMAS LTDA' : 'Cliente Ltda', nickTrade: null }, personType: 'J', person: null,
  company: { cnpj: id === 1 ? '12.345.678/0001-99' : '98.765.432/0001-88', ie: null, im: id === 1 ? '777' : null, dtFoundation: null }, noDoc: null,
  addresses: [{ kind: 'C', street: 'Rua A', nmbr: '10', complement: null, neighborhood: 'Centro', zipCode: '80.010-000', tbCountryId: 1, tbStateId: 16, tbCityId: 1, main: 'S', countryName: 'Brasil', stateName: 'Paraná', cityName: 'Curitiba' }],
  phones: [], socialMedia: [],
})
const issuerRow = (over: any = {}) => ({ institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: null, ...over })
const fmtLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
const tx = (over: any = {}) => ({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, environment: 'H', dpsId: DPS_ID, accessKey: KEY, nfseNumber: '123',
  dhProc: '2026-09-21 10:15:30', createdAt: '2026-09-21 10:15:00', ageMinutes: 0, lastQueriedAt: null,
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastDh: '2026-09-21 10:15:30', lastEventAt: null, ...over,
})
const inFlightNow = (over: any = {}) => tx({ lastKind: null, lastEvent: null, accessKey: null, nfseNumber: null, dhProc: null, createdAt: fmtLocal(new Date()), ageMinutes: 0, ...over })
const interrupted = () => inFlightNow({ ageMinutes: 30, createdAt: fmtLocal(new Date(Date.now() - 30 * 60_000)) })
/** Transmissão "corrente" vista pelo repositório: latestTransmission, getTransmission(attempt) e findTransmissionByDpsId. */
let currentTx: any = null
const setTx = (row: any) => { currentTx = row; (repo.latestTransmission as jest.Mock).mockResolvedValue(row) }
const unavailable = () => new AuthorityHttpError(503, 'Fisco indisponível', 'FISCAL_AUTHORITY_UNAVAILABLE', 0, '')
const authFailed = () => new AuthorityHttpError(409, 'Fisco recusou o certificado (mTLS)', 'FISCAL_AUTHORITY_AUTH_FAILED', 0, 'EPROTO')
const planOk = (blocks: any[] = []) => ({
  orderId: INVOICE, invoice: { id: INVOICE, lastKind: 'E', lastEvent: 1 }, blocks, bankSlipsToCancel: [], releasedTitles: [],
  serviceOrder: null, checksToReverse: [], commissionEntries: [], touchesCash: false,
})
const cancelled = { orderId: INVOICE, invoiceNumber: '17', event: 2, checksReversed: [], bankSlipsCancelled: [], releasedTitles: [], commissionsCompensated: 0 }
const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: obj == null ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj) })
const tokenFor = (role: string, userId = 7) => jwt.sign({ institutionId: 1, userId, role, schemaName: 'setes_setes' }, JWT_SECRET)
const asAdmin = () => `Bearer ${tokenFor('admin')}`
const asUser  = () => `Bearer ${tokenFor('user')}`

// loja de eventos em memória: idempotência por (kind, dh) só se prova com memória entre chamadas
type Ev = { attempt: number; event: number; kind: string; dh: string | null; source: string; message: string | null; authorityCode: string | null; invoiceEvent: number | null }
let events: Ev[] = []
const evMatch = (attempt: number, kind: string, dh: string | null) => events.filter(e => e.attempt === attempt && e.kind === kind && (e.dh ?? null) === (dh ?? null))

// roteamento do pool: notas por id, IBGE por cidade, privilégios por interface
let headerRows: Map<number, any>
let ibgeByCity: Map<number, string | null>
let privilegeInterfaces: Set<number>
let contractedInterfaces = true
const INTERFACE_IDS: Record<string, number> = { 'service-orders': 40, orders: 30, 'order-returns': 31 }
function poolDefaults() {
  q.mockImplementation(async (sql: string, params: any[]) => {
    if (/FROM `setes_setes`\.tb_invoice i/.test(sql)) { const r = Number(params?.[1]) === S.inst ? headerRows.get(Number(params?.[0])) : null; return [r ? [r] : []] }
    if (/setes_central\.tb_city/.test(sql)) { const ib = ibgeByCity.has(Number(params?.[0])) ? ibgeByCity.get(Number(params?.[0])) : '4106902'; return [ib ? [{ ibge: ib }] : []] }
    if (/setes_central\.tb_interface WHERE i18n_key/.test(sql)) { const id = INTERFACE_IDS[String(params?.[0])]; return [id ? [{ id }] : []] }
    if (/tb_user_has_privilege/.test(sql)) return [privilegeInterfaces.has(Number(params?.[1])) ? [{ 1: 1 }] : []]
    if (/tb_institution_has_interface/.test(sql)) return [contractedInterfaces ? [{ 1: 1 }] : []]      // D-N32: leituras fiscais exigem a interface do ramo no contrato
    return [[]]
  })
}
function connDefaults() {
  conn.query.mockImplementation(async (sql: string, params: any[]) => {
    if (/dps_number AS dpsNumber/.test(sql)) { const r = headerRows.get(Number(params?.[0])); return [r ? [{ dpsNumber: r.dpsNumber, updatedAt: r.branchUpdatedAt }] : []] }
    return [{}]
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  resetMunicipalTermsCache()
  resetPrivilegeCache()
  events = []
  headerRows = new Map([[INVOICE, header()]])
  ibgeByCity = new Map()
  privilegeInterfaces = new Set()
  contractedInterfaces = true
  poolDefaults(); connDefaults()
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
  installVault()
  ;(authority.adapterFor as jest.Mock).mockReturnValue(adapter)
  ;(issuerRepo.getIssuer as jest.Mock).mockResolvedValue(issuerRow())
  ;(entity.getEntityFiscalFull as jest.Mock).mockImplementation(async (id: number) => fullEntity(id))
  ;(entityTax.getEntityTax as jest.Mock).mockResolvedValue({ simplesRegime: '3', simplesAssessment: '1', simplesTotalTaxAliquot: 6, specialTaxRegime: '0' })
  ;(invoice.lockInvoice as jest.Mock).mockReset().mockResolvedValue({ id: INVOICE, number: '17', serie: '1', model: 'SE', value: 1234.5, status: '0', lastEvent: 1, lastKind: 'E' })
  ;(invoice.buildCancelPlan as jest.Mock).mockReset().mockResolvedValue(planOk([{ field: 'fiscal', ref: '1', message: 'NFS-e autorizada' }]))
  ;(invoice.cancelInvoice as jest.Mock).mockReset().mockResolvedValue(cancelled)
  ;(resolver.resolveOrderInterface as jest.Mock).mockReset().mockResolvedValue('orders')
  currentTx = null
  ;(repo.latestTransmission as jest.Mock).mockReset().mockResolvedValue(null)
  ;(repo.getTransmission as jest.Mock).mockReset().mockImplementation(async (_q: any, _s: any, _i: any, _inv: any, attempt: number) => currentTx && currentTx.attempt === attempt ? currentTx : null)
  ;(repo.findTransmissionByDpsId as jest.Mock).mockReset().mockImplementation(async () => currentTx)
  ;(repo.findTransmissionEventByKind as jest.Mock).mockReset().mockImplementation(async (_q: any, _s: any, _i: any, _inv: any, attempt: number, kind: string) => {
    const m = events.filter(e => e.attempt === attempt && e.kind === kind).sort((a, b) => b.event - a.event); return m[0] ? { ...m[0] } : null
  })
  ;(repo.insertTransmission as jest.Mock).mockReset().mockResolvedValue(1)
  ;(repo.nextDpsNumber as jest.Mock).mockReset().mockResolvedValue(42)
  ;(repo.listServiceTransmissions as jest.Mock).mockReset().mockResolvedValue({ transmissions: [], events: [] })
  ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockReset().mockResolvedValue([])
  ;(repo.insertTransmissionEvent as jest.Mock).mockReset().mockImplementation(async (_c: any, _s: any, _i: any, _inv: any, attempt: number, _u: any, e: any) => {
    const ev: Ev = { attempt, event: events.filter(x => x.attempt === attempt).length + 1, kind: e.kind, dh: e.dh ?? null, source: e.source, message: e.message ?? null, authorityCode: e.authorityCode ?? null, invoiceEvent: e.invoiceEvent ?? null }
    events.push(ev); return ev.event
  })
  ;(repo.hasTransmissionEvent as jest.Mock).mockReset().mockImplementation(async (_q: any, _s: any, _i: any, _inv: any, attempt: number, kind: string, dh: string | null) => evMatch(attempt, kind, dh).length > 0)
  ;(repo.findTransmissionEvent as jest.Mock).mockReset().mockImplementation(async (_q: any, _s: any, _i: any, _inv: any, attempt: number, kind: string, dh: string | null) => {
    const m = evMatch(attempt, kind, dh).sort((a, b) => b.event - a.event); return m[0] ? { ...m[0] } : null
  })
  ;(repo.setTransmissionEventEffect as jest.Mock).mockReset().mockImplementation(async (_c: any, _s: any, _i: any, _inv: any, attempt: number, event: number, invoiceEvent: number | null, message: string | null) => {
    const ev = events.find(x => x.attempt === attempt && x.event === event); if (ev) { ev.invoiceEvent = invoiceEvent; if (message) ev.message = message }
  })
  ;(repo.countPendingEffects as jest.Mock).mockReset().mockImplementation(async () => events.filter(x => x.kind === 'C' && x.invoiceEvent == null).length)
  ;(repo.setDpsId as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(repo.setDpsNumber as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(repo.fillAuthorityData as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(repo.touchQueriedAt as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(repo.listPendingServiceInvoices as jest.Mock).mockReset().mockResolvedValue([])
  ;(counters.lockInstitutionCounters as jest.Mock).mockReset().mockResolvedValue(undefined)
  adapter.transmit.mockReset(); adapter.queryNfse.mockReset(); adapter.queryDpsAccessKey.mockReset(); adapter.registerEvent.mockReset()
  adapter.municipalTerms.mockReset().mockResolvedValue({ cancelDays: null, raw: {} })
  adapter.registerEvent.mockResolvedValue({ dhEvento: '2026-09-22T09:00:00-03:00', protocol: 'EVT1', raw: {} })
})
afterAll(() => {
  transport.request = realTransport
  fs.rmSync(SECRETS_ROOT, { recursive: true, force: true })
  fs.rmSync(STORAGE_ROOT, { recursive: true, force: true })
  delete process.env.SECRETS_PATH; delete process.env.STORAGE_PATH
})

const authorized = () => ({ accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21T10:15:30-03:00', nfseXml: NFSE_XML, raw: {} })
const withAuthorizedTx = () => setTx(tx({ lastKind: 'A' }))

// ===========================================================================
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO 1 (HIGH) — registerEvent trata 2xx SEM envelope legível como ACEITE: voz C + cancelamento local nascem sem voz do fisco (D-N7)', () => {
  // O adaptador ADN traduz 2xx ilegível em 502 no `transmit` (unknownResponse), mas
  // `registerEvent` devolve `{ dhEvento: null }` e a composição segue para (5): grava
  // "Cancelada no fisco" e desfaz a nota localmente. Se o 2xx veio de proxy/WAF/corpo
  // vazio, a NFS-e continua VÁLIDA no fisco e cancelada aqui — e a consulta seguinte
  // nem olha o fisco (C sem pendência = "fim da história"). D-N7: "C local só com a voz;
  // ambíguo = K em voo bloqueante". Bypass do caminho K que existe para isso.
  it.each([
    ['200 corpo vazio', ok(null, 200)],
    ['200 JSON sem XML', ok({ ok: true }, 200)],
    ['201 HTML de proxy', ok('<html>OK</html>', 201)],
    ['204 sem corpo', ok(null, 204)],
  ])('%s no POST /nfse/{chave}/eventos → 5xx ambíguo + K em voo, NUNCA C nem cancelInvoice', async (_l, resp) => {
    useRealAdn()
    withAuthorizedTx()
    mockHttp.mockImplementation(async (call: any) => /convenio/.test(call.url) ? ok({}) : resp)
    let outcome: any
    try { outcome = await cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço') } catch (e) { outcome = e }
    // harness: a prova é "HttpError ≥ 502 + K + nada cancelado" — instanceOf como no teste (3); o NOME do
    // construtor (AuthorityHttpError é subclasse) não fazia parte do achado (ajuste de 2026-09-28)
    expect(outcome).toBeInstanceOf(HttpError)
    expect(describeOutcome(outcome).message).toMatch(/sem envelope legível/)
    expect(outcome.statusCode).toBeGreaterThanOrEqual(502)
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
    expect(events.some(e => e.kind === 'C')).toBe(false)
    expect(events.some(e => e.kind === 'K')).toBe(true)
  })
})

describe('ACHADO 2 (MEDIUM) — dado do RAMO/emissor fora da forma estoura Error cru no leiaute → 500 com crashlytics, não 422 com o campo', () => {
  // `buildSignedDps` no passo (c) roda o validador do leiaute (dps-builder lança
  // Error genérico). A composição só traduz para HttpError o que ela mesma confere
  // (CNPJ, IBGE, código nacional); o resto (cTribMun < 3 dígitos, pAliq ≥ 10, série
  // não numérica/0 na linha do emissor, vServ negativo) vira 500 "Erro interno" — a
  // regra da casa é 500 só para erro de PROGRAMA; dado que o usuário corrige é 4xx.
  const cases: [string, () => void][] = [
    ['municipal_code com 2 dígitos', () => { headerRows.set(INVOICE, header({ municipalCode: '12' })) }],
    ['aliq_iss 10 % (TSDec1V2 0–9.99)', () => { headerRows.set(INVOICE, header({ aliqIss: 10 })); (entityTax.getEntityTax as jest.Mock).mockResolvedValue({ simplesRegime: '1', specialTaxRegime: '0' }) }],   // não optante: a alíquota vai no DPS
    ['total_value negativo', () => { headerRows.set(INVOICE, header({ totalValue: -1 })) }],
    ['série "0" na linha do emissor', () => { (issuerRepo.getIssuer as jest.Mock).mockResolvedValue(issuerRow({ serie: '0' })) }],
    ['série não numérica na linha do emissor', () => { (issuerRepo.getIssuer as jest.Mock).mockResolvedValue(issuerRow({ serie: 'A1' })) }],
  ]
  it.each(cases)('%s → 422 legível ANTES de reservar (nunca Error cru)', async (_l, arrange) => {
    arrange()
    let outcome: any
    try { outcome = await transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE) } catch (e) { outcome = e }
    expect(describeOutcome(outcome)).toEqual(expect.objectContaining({ ctor: 'HttpError' }))
    expect(outcome.statusCode).toBe(422)
    expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(adapter.transmit).not.toHaveBeenCalled()
  })
})
/** O que veio (resultado ou erro), legível no relatório do jest: construtor, mensagem e as 4 primeiras linhas do stack. */
function describeOutcome(o: any) {
  return { ctor: o?.constructor?.name ?? typeof o, message: String(o?.message ?? ''), stack: String(o?.stack ?? '').split('\n').slice(0, 5).map(l => l.trim()).join(' | ') }
}

describe('ACHADO 3 (MEDIUM) — série fora de 00001–49999 aceita na porta e no Id (§1 do prompt: 50000+ é do emissor nacional)', () => {
  it('DTO do emissor recusa "0", "00000" e "50000"; aceita "1" e "49999"', () => {
    expect(issuerDto.safeParse({ environment: 'H', serie: '0' }).success).toBe(false)
    expect(issuerDto.safeParse({ environment: 'H', serie: '00000' }).success).toBe(false)
    expect(issuerDto.safeParse({ environment: 'H', serie: '50000' }).success).toBe(false)
    expect(issuerDto.safeParse({ environment: 'H', serie: '1' }).success).toBe(true)
    expect(issuerDto.safeParse({ environment: 'H', serie: '49999' }).success).toBe(true)
  })
  it('buildDpsId recusa série 50000 e 99999 (defesa em profundidade — a linha pode ter vindo por SQL)', () => {
    expect(() => buildDpsId('4106902', '2', CNPJ, 0, 1)).toThrow()
    expect(() => buildDpsId('4106902', '2', CNPJ, 50000, 1)).toThrow()
    expect(() => buildDpsId('4106902', '2', CNPJ, 99999, 1)).toThrow()
    expect(buildDpsId('4106902', '2', CNPJ, 49999, 1)).toHaveLength(45)
  })
})

describe('ACHADO 4 (MEDIUM) — lote continua após credencial recusada no HANDSHAKE: 1 F por nota e N tentativas ao fisco com o mesmo A1 quebrado', () => {
  // Lição §10.4 da Onda 2: credencial ≠ indisponibilidade, "tente de novo só empilha
  // tentativas". AUTH_FAILED com authorityStatus 0 (TLS) é do EMISSOR, não da nota:
  // o 2º item já sabe o desfecho. Hoje só FISCAL_AUTHORITY_UNAVAILABLE pára o lote.
  it('3 notas, TLS recusado na 1ª → fisco chamado UMA vez, lote pára (stoppedEarly), restantes sem F', async () => {
    for (const id of [6201, 6202]) headerRows.set(id, header({ id, branchId: id }))
    adapter.transmit.mockRejectedValue(authFailed())
    const res = await request(app).post('/api/billing/fiscal/transmit-batch').set('Authorization', asAdmin()).send({ orderIds: [INVOICE, 6201, 6202] })
    expect(res.status).toBe(200)
    expect(adapter.transmit).toHaveBeenCalledTimes(1)
    expect(res.body.data.stoppedEarly).toBe(true)
    expect(events.filter(e => e.kind === 'F')).toHaveLength(1)
  })
})

describe('ACHADO 5 (LOW) — chave de acesso fora de 50 dígitos aceita no A: o cancelamento depois estoura Error cru (buildEventId exige 50)', () => {
  it('2xx com chaveAcesso "123" e XML sem Id → 502 (não é chave), nada gravado', async () => {
    useRealAdn()
    const xml = NFSE_XML.replace(`Id="NFS${KEY}"`, 'Id="NFS"')
    mockHttp.mockResolvedValue(ok({ chaveAcesso: '123', nfseXmlGZipB64: gz(xml) }, 200))
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 502 })
    expect(repo.fillAuthorityData).not.toHaveBeenCalled()
    expect(events).toHaveLength(0)
  })
})

// ===========================================================================
// PROVAS POSITIVAS — ataques que NÃO reproduziram bug (regressão)
// ===========================================================================

describe('A. transmitServiceInvoice — concorrência, ambíguo, rejeição, 2xx ilegível', () => {
  it('(1) duas transmissões SIMULTÂNEAS da mesma nota sob lock serializado → uma reserva, a outra 409 IN_PROGRESS; fisco chamado UMA vez', async () => {
    let chain = Promise.resolve(); const releases: (() => void)[] = []
    const acquire = () => { let rel!: () => void; const p = new Promise<void>(r => (rel = r)); const prev = chain; chain = chain.then(() => p); return prev.then(() => rel) }
    let reserved: any = null
    ;(invoice.lockInvoice as jest.Mock).mockImplementation(async () => { releases.push(await acquire()); return { id: INVOICE, number: '17', serie: '1', model: 'SE', value: 1234.5, status: '0', lastEvent: 1, lastKind: 'E' } })
    conn.commit.mockImplementation(async () => { releases.shift()?.() })
    conn.rollback.mockImplementation(async () => { releases.shift()?.() })
    ;(repo.latestTransmission as jest.Mock).mockImplementation(async () => reserved)
    ;(repo.getTransmission as jest.Mock).mockImplementation(async () => reserved)
    ;(repo.insertTransmission as jest.Mock).mockImplementation(async () => { reserved = inFlightNow(); return 1 })
    adapter.transmit.mockResolvedValue(authorized())
    const results = await Promise.allSettled([transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE), transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)])
    const okCount = results.filter(r => r.status === 'fulfilled').length
    const busy = results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason)
    expect(okCount).toBe(1); expect(busy).toHaveLength(1)
    expect(busy[0]).toMatchObject({ statusCode: 409, code: 'FISCAL_TRANSMISSION_IN_PROGRESS' })
    expect(repo.insertTransmission).toHaveBeenCalledTimes(1)
    expect(adapter.transmit).toHaveBeenCalledTimes(1)
    expect(repo.nextDpsNumber).toHaveBeenCalledTimes(1)
  })

  it('(2) timeout no POST /nfse (503) → NADA de A/R, tentativa em voo; nova chamada ANTES de reconciliar → 409, sem 2º envio', async () => {
    adapter.transmit.mockRejectedValue(unavailable())
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 503, code: 'FISCAL_AUTHORITY_UNAVAILABLE' })
    expect(events).toHaveLength(0); expect(repo.fillAuthorityData).not.toHaveBeenCalled()
    setTx(inFlightNow())
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_TRANSMISSION_IN_PROGRESS' })
    expect(adapter.transmit).toHaveBeenCalledTimes(1)
    expect(repo.insertTransmission).toHaveBeenCalledTimes(1)
    expect(adapter.queryDpsAccessKey).not.toHaveBeenCalled()             // < 10 min: não é "interrompida"
  })

  it('(2b) reserva INTERROMPIDA (> 10 min) e fisco FORA no GET /dps → falha fechada: nenhuma tentativa nova, nenhum F', async () => {
    setTx(interrupted())
    adapter.queryDpsAccessKey.mockRejectedValue(unavailable())
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ code: 'FISCAL_AUTHORITY_UNAVAILABLE' })
    expect(repo.insertTransmission).not.toHaveBeenCalled(); expect(adapter.transmit).not.toHaveBeenCalled(); expect(events).toHaveLength(0)
  })

  it('(2c) reserva INTERROMPIDA e o fisco ACHOU a NFS-e pelo Id → A retroativo (source Q) e 409 ALREADY_AUTHORIZED, sem 2º envio', async () => {
    setTx(interrupted())
    ;(repo.latestTransmission as jest.Mock).mockImplementation(async () => events.some(e => e.kind === 'A') ? tx({ lastKind: 'A' }) : currentTx)
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ code: 'FISCAL_ALREADY_AUTHORIZED' })
    expect(events).toEqual([expect.objectContaining({ kind: 'A', source: 'Q', attempt: 1 })])
    expect(adapter.transmit).not.toHaveBeenCalled(); expect(repo.insertTransmission).not.toHaveBeenCalled()
  })

  it.each([
    ['erros vazio', '{"erros":[]}'],
    ['erros com null/objeto vazio/número/string', '{"erros":[null,{},123,"E0001 texto solto"]}'],
    ['erros não é array', '{"erros":"E0718"}'],
    ['array vazio na raiz', '[]'],
    ['corpo vazio', ''],
    ['HTML', '<html><body>Bad Request</body></html>'],
    ['campos com tipo errado', '{"erros":[{"codigo":{"a":1},"descricao":["x"],"complemento":null}]}'],
    ['descricao de 10 KB', `{"erros":[{"codigo":"E0718","descricao":"${'x'.repeat(10_000)}"}]}`],
  ])('(3) 400 do fisco com erros[] %s → 422 FISCAL_DPS_REJECTED + voz R legível (nunca 500)', async (_l, body) => {
    useRealAdn()
    mockHttp.mockResolvedValue({ status: 400, headers: {}, text: body })
    let outcome: any
    try { outcome = await transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE) } catch (e) { outcome = e }
    expect(outcome).toBeInstanceOf(HttpError)
    expect(outcome).toMatchObject({ statusCode: 422, code: 'FISCAL_DPS_REJECTED' })
    expect(events).toEqual([expect.objectContaining({ kind: 'R', source: 'P', attempt: 1 })])
    expect((events[0].message ?? '').length).toBeLessThanOrEqual(255)
    expect((events[0].authorityCode ?? '').length).toBeLessThanOrEqual(10)
    expect(repo.fillAuthorityData).not.toHaveBeenCalled()
  })

  it('(3b) authorityRejections nunca lança com lixo', () => {
    for (const t of ['', '{', 'null', '1', '"s"', '{"erros":[[]]}', '{"errors":[{"code":1}]}', '{"mensagens":["a","b"]}']) {
      expect(() => authorityRejections(t)).not.toThrow()
    }
  })

  it.each([
    ['200 corpo vazio', ok(null, 200)],
    ['200 JSON sem XML', ok({ ok: true }, 200)],
    ['201 não-JSON', ok('not json', 201)],
    ['200 XML sem Id e sem chaveAcesso', ok({ nfseXmlGZipB64: gz(NFSE_XML.replace(`Id="NFS${KEY}"`, 'Id="NFS"')) }, 200)],
    ['200 campo gzip com base64 inválido', ok({ nfseXmlGZipB64: '!!!nao-e-base64!!!' }, 200)],
  ])('(4) %s no POST /nfse → 502 UNKNOWN_RESPONSE, tentativa em voo, nada fechado', async (_l, resp) => {
    useRealAdn()
    mockHttp.mockResolvedValue(resp)
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 502, code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
    expect(repo.insertTransmission).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(0); expect(repo.fillAuthorityData).not.toHaveBeenCalled()
    expect(conn.commit).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['cancelada (C)', () => header({ lastKind: 'C' }), 409, 'INVOICE_NOT_TRANSMITTABLE'],
    ['sincronizada (sem evento)', () => header({ lastKind: null }), 409, 'INVOICE_NOT_TRANSMITTABLE'],
    ['sem ramo de serviço', () => header({ branchId: null }), 422, 'INVOICE_SERVICE_BRANCH_MISSING'],
    ['sem código nacional', () => header({ nationalCode: null }), 422, 'SERVICE_RULE_NATIONAL_CODE_REQUIRED'],
  ])('(5) nota %s → %i %s ANTES do fisco e ANTES de cunhar nDPS', async (_l, mk, status, code) => {
    headerRows.set(INVOICE, mk())
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: status, code })
    expect(counters.lockInstitutionCounters).not.toHaveBeenCalled()
    expect(repo.nextDpsNumber).not.toHaveBeenCalled(); expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(adapter.transmit).not.toHaveBeenCalled()
  })
  it('(5b) nota de OUTRO institution / inexistente → 404 sem vazar, sem tocar o emissor', async () => {
    await expect(transmitServiceInvoice(S.schema, 2, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 404, code: 'INVOICE_NOT_FOUND' })
    expect(issuerRepo.getIssuer).not.toHaveBeenCalled()
  })

  it.each([
    ['emitente sem CNPJ', (id: number) => id === 1 ? { ...fullEntity(1), company: null } : fullEntity(id), 'FISCAL_EMITTER_INCOMPLETE', 'emitter.cnpj'],
    ['emitente sem endereço', (id: number) => id === 1 ? { ...fullEntity(1), addresses: [] } : fullEntity(id), 'FISCAL_EMITTER_INCOMPLETE', 'emitter.address'],
    ['emitente cidade sem IBGE', (id: number) => id === 1 ? { ...fullEntity(1), addresses: [{ ...fullEntity(1).addresses[0], tbCityId: 999 }] } : fullEntity(id), 'FISCAL_EMITTER_INCOMPLETE', 'emitter.city'],
    ['tomador sem nome', (id: number) => id === 900 ? { ...fullEntity(900), entity: { nameCompany: '  ', nickTrade: null } } : fullEntity(id), 'FISCAL_RECIPIENT_INCOMPLETE', 'recipient.name'],
    ['tomador sem documento', (id: number) => id === 900 ? { ...fullEntity(900), company: null, person: { cpf: '123' } } : fullEntity(id), 'FISCAL_RECIPIENT_INCOMPLETE', 'recipient.document'],
  ])('(6) %s → 422 com o campo, sem tentativa gravada', async (_l, mk, code, field) => {
    ibgeByCity.set(999, null)
    ;(entity.getEntityFiscalFull as jest.Mock).mockImplementation(async (id: number) => mk(id))
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 422, code, fields: [expect.objectContaining({ field })] })
    expect(repo.insertTransmission).not.toHaveBeenCalled(); expect(counters.lockInstitutionCounters).not.toHaveBeenCalled()
  })
  it('(6b) cidade de incidência sem IBGE → 422 no campo cityId', async () => {
    headerRows.set(INVOICE, header({ cityId: 999 })); ibgeByCity.set(999, null)
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 422, fields: [expect.objectContaining({ field: 'cityId' })] })
    expect(repo.insertTransmission).not.toHaveBeenCalled()
  })
  it('(6c) tomador com CEP inválido / sem endereço → DPS SEM <end> (XSD opcional) e segue — comportamento documentado (LOW no relatório)', async () => {
    ;(entity.getEntityFiscalFull as jest.Mock).mockImplementation(async (id: number) => id === 900 ? { ...fullEntity(900), addresses: [{ ...fullEntity(900).addresses[0], zipCode: '80.010-00' }] } : fullEntity(id))
    adapter.transmit.mockResolvedValue(authorized())
    await transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)
    const sent = adapter.transmit.mock.calls[0][1] as string
    expect(sent).toContain('<toma><CNPJ>98765432000188</CNPJ><xNome>Cliente Ltda</xNome></toma>')
    expect(sent).not.toContain('<end>')
  })

  it.each([
    ['sem habilitação do modelo', () => { (issuerRepo.getIssuer as jest.Mock).mockResolvedValue(null) }, 'FISCAL_ISSUER_MISSING'],
    ['cofre vazio', () => clearVault(), 'FISCAL_CERT_MISSING'],
    ['só a chave no cofre', () => deleteSecret(vault().cert), 'FISCAL_CERT_MISSING'],
    ['certificado VENCIDO', () => installVault(EXPIRED.certPem, EXPIRED.keyPem), 'FISCAL_CERT_EXPIRED'],
    ['PEM lixo no cofre', () => installVault('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----', PAIR.keyPem), 'FISCAL_CERT_INVALID'],
  ])('(7) emissor %s → 409 %s sem tentativa (openIssuer REAL sobre o cofre)', async (_l, arrange, code) => {
    arrange()
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 409, code })
    expect(repo.insertTransmission).not.toHaveBeenCalled(); expect(adapter.transmit).not.toHaveBeenCalled()
  })
  it('(7b) tentativa nasceu em H, emissor agora em P → a consulta fala com o HOST de H (D-N6) usando o ÚNICO A1 do estabelecimento (D-N31, Valdo 2026-09-28)', async () => {
    ;(issuerRepo.getIssuer as jest.Mock).mockResolvedValue(issuerRow({ environment: 'P' }))
    withAuthorizedTx()
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })
    await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(adapter.queryNfse).toHaveBeenCalledTimes(1)
    expect(adapter.queryNfse.mock.calls[0][0]).toMatchObject({ environment: 'H', cert: Buffer.from(PAIR.certPem), key: Buffer.from(PAIR.keyPem) })
  })

  it('caminho feliz com assinatura REAL: o DPS enviado verifica com o certificado do cofre e o Id é o do infDPS', async () => {
    adapter.transmit.mockResolvedValue(authorized())
    const r = await transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)
    expect(r.kind).toBe('A')
    const sent = adapter.transmit.mock.calls[0][1] as string
    expect(verifyXml(sent, PAIR.certPem)).toBe(true)
    expect(verifyXml(sent, EXPIRED.certPem)).toBe(false)
    expect(sent).toContain(`URI="#${DPS_ID}"`)
  })

  it('TOCTOU reserva × cancelamento local (MEDIUM-3): evento novo na nota entre a leitura e o lock → 409 RESOURCE_BUSY, fisco NUNCA chamado, nDPS não cunhado', async () => {
    ;(invoice.lockInvoice as jest.Mock).mockResolvedValue({ id: INVOICE, number: '17', serie: '1', model: 'SE', value: 1234.5, status: '0', lastEvent: 2, lastKind: 'C' })
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
    expect(adapter.transmit).not.toHaveBeenCalled(); expect(repo.nextDpsNumber).not.toHaveBeenCalled(); expect(conn.rollback).toHaveBeenCalled()
  })
  it('TOCTOU do RAMO (MEDIUM-3): ramo editado (updated_at) entre a leitura e o lock → 409 RESOURCE_BUSY; ramo soft-deletado → 422 — nunca o fisco', async () => {
    conn.query.mockImplementation(async (sql: string) => /dps_number AS dpsNumber/.test(sql) ? [[{ dpsNumber: null, updatedAt: '2026-09-21 09:00:01' }]] : [{}])
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
    conn.query.mockImplementation(async (sql: string) => /dps_number AS dpsNumber/.test(sql) ? [[]] : [{}])
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 422, code: 'INVOICE_SERVICE_BRANCH_MISSING' })
    expect(adapter.transmit).not.toHaveBeenCalled(); expect(repo.insertTransmission).not.toHaveBeenCalled()
  })
})

describe('B. refreshServiceTransmission — voz do fisco, idempotência, efeito em SAVEPOINT real', () => {
  const cancelledVoice = (dhEvento: string | null = '2026-09-22T09:00:00-03:00') =>
    ({ accessKey: KEY, status: 'cancelled', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00', cancelled: { dhEvento, motive: 'erro na emissão' } })

  it('(8) voz C com a NOSSA regra recusando (título baixado) → C gravado com invoice_event NULL + "Efeito recusado", SAVEPOINT desfeito, transação COMMITADA', async () => {
    withAuthorizedTx()
    ;(invoice.cancelInvoice as jest.Mock).mockRejectedValue(new HttpError(409, 'Título 6200/1 tem baixa de 80.00 — estorne a baixa antes', [], 'INVOICE_CANCEL_BLOCKED'))
    adapter.queryNfse.mockResolvedValue(cancelledVoice())
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ changed: true, kind: 'C', invoiceEvent: null, effectRefused: expect.stringMatching(/baixa/) })
    expect(events).toEqual([expect.objectContaining({ kind: 'C', dh: '2026-09-22 12:00:00', invoiceEvent: null, message: expect.stringMatching(/^Efeito recusado: /) })])
    const sqls = conn.query.mock.calls.map(c => String(c[0]))
    expect(sqls).toContain('SAVEPOINT fiscal_cancel_effect'); expect(sqls).toContain('ROLLBACK TO SAVEPOINT fiscal_cancel_effect')
    expect(conn.commit).toHaveBeenCalledTimes(1); expect(conn.rollback).not.toHaveBeenCalled()
  })

  it('(9) mesma voz C 2× (leitura VELHA em A nas duas) → 1 evento; C é idempotente por KIND (HIGH-3a): dh NULL e dh diferente também não duplicam', async () => {
    withAuthorizedTx()
    adapter.queryNfse.mockResolvedValue(cancelledVoice())
    await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    const r2 = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(events.filter(e => e.kind === 'C')).toHaveLength(1)
    expect(r2.invoiceEvent).toBe(2); expect(invoice.cancelInvoice).toHaveBeenCalledTimes(1)
    events = []
    adapter.queryNfse.mockResolvedValue(cancelledVoice(null))
    await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    adapter.queryNfse.mockResolvedValue(cancelledVoice('2026-09-23T08:00:00-03:00'))       // o fisco "mudou" o dh: mesma voz
    await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(events.filter(e => e.kind === 'C')).toHaveLength(1); expect(events[0].dh).toBeNull()
  })
  it('(9b) A 2× em voo (dh igual e dh NULL) → 1 evento A', async () => {
    setTx(inFlightNow())
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })
    await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q'); await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(events.filter(e => e.kind === 'A')).toHaveLength(1)
    events = []
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML.replace(/<dhProc>.*?<\/dhProc>/, ''), dhProc: null })
    await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q'); await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(events.filter(e => e.kind === 'A')).toHaveLength(1); expect(events[0].dh).toBeNull()
  })

  it('(10) situação "unknown" → 502, transação DESFEITA (nem o touchQueriedAt sobrevive), nada gravado', async () => {
    withAuthorizedTx()
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'unknown', nfseXml: NFSE_XML, dhProc: null })
    await expect(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')).rejects.toMatchObject({ statusCode: 502, code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
    expect(conn.rollback).toHaveBeenCalledTimes(1); expect(conn.commit).not.toHaveBeenCalled()
    expect(events).toHaveLength(0); expect(repo.fillAuthorityData).not.toHaveBeenCalled()
  })
  it('(10b) ADN real: GET /nfse ok e GET /eventos 2xx ilegível (JSON sem XML, não vazio) → unknown → 502 sem gravar', async () => {
    useRealAdn(); withAuthorizedTx()
    mockHttp.mockImplementation(async (call: any) => /\/eventos$/.test(call.url) ? ok({ foo: 'bar' }) : ok({ nfseXmlGZipB64: gz(NFSE_XML) }))
    await expect(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')).rejects.toMatchObject({ statusCode: 502 })
    expect(events).toHaveLength(0)
  })

  it.each([
    ['ER_LOCK_WAIT_TIMEOUT', Object.assign(new Error('lock'), { code: 'ER_LOCK_WAIT_TIMEOUT' })],
    ['ER_LOCK_DEADLOCK', Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' })],
    ['409 RESOURCE_BUSY', new HttpError(409, 'em uso', undefined, 'RESOURCE_BUSY')],
    ['erro de programa (TypeError)', new TypeError('x is not a function')],
  ])('(11) %s no EFEITO → NADA gravado (fato inclusive: rollback da transação), erro propaga', async (_l, err) => {
    withAuthorizedTx()
    ;(invoice.cancelInvoice as jest.Mock).mockRejectedValue(err)
    adapter.queryNfse.mockResolvedValue(cancelledVoice())
    await expect(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')).rejects.toBe(err)
    expect(conn.rollback).toHaveBeenCalledTimes(1); expect(conn.commit).not.toHaveBeenCalled()
    expect(repo.setTransmissionEventEffect).not.toHaveBeenCalled()
    // o C foi inserido DENTRO da transação desfeita — o rollback vem depois dele
    expect(conn.rollback.mock.invocationCallOrder[0]).toBeGreaterThan((repo.insertTransmissionEvent as jest.Mock).mock.invocationCallOrder[0])
  })

  it('A3 (voz atrasada): transmissão já C com pendência, consulta antiga diz "authorized" → NENHUM A depois do C', async () => {
    setTx(tx({ lastKind: 'C', lastEvent: 2 }))
    events.push({ attempt: 1, event: 2, kind: 'C', dh: '2026-09-22 09:00:00', source: 'Q', message: null, authorityCode: null, invoiceEvent: null })
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r.changed).toBe(false); expect(events.filter(e => e.kind === 'A')).toHaveLength(0)
  })
  it('A5 (TOCTOU tentativa): a voz consultada para a tentativa 1 é gravada NA 1 mesmo que a 2 exista sob o lock; tentativa sumida → nada gravado', async () => {
    withAuthorizedTx()
    ;(repo.latestTransmission as jest.Mock).mockResolvedValueOnce(tx({ attempt: 1, lastKind: 'A' })).mockResolvedValue(inFlightNow({ attempt: 2 }))
    adapter.queryNfse.mockResolvedValue(cancelledVoice())
    await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    for (const e of events) expect(e.attempt).toBe(1)
    expect(repo.touchQueriedAt).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1)
    events = []; jest.clearAllMocks()
    withAuthorizedTx()
    ;(repo.getTransmission as jest.Mock).mockResolvedValue(null)
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r.changed).toBe(false); expect(events).toHaveLength(0)
    expect(repo.touchQueriedAt).not.toHaveBeenCalled(); expect(repo.fillAuthorityData).not.toHaveBeenCalled()
  })
  it('D-N17: K sem cancelamento no fisco → N (uma vez); estado volta a "authorized" e o cancelamento pode ser pedido de novo', async () => {
    setTx(tx({ lastKind: 'K', lastEvent: 2, lastEventAgeMinutes: 30 }))   // D-N28: K com mais de 10 min
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ changed: true, kind: 'N' })
    expect(events.filter(e => e.kind === 'A')).toHaveLength(0); expect(events.filter(e => e.kind === 'N')).toHaveLength(1)
  })
  it('consulta ativa coalesce: duas telas ao mesmo tempo = UMA varredura', async () => {
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockImplementation(() => new Promise(r => setTimeout(() => r([]), 20)))
    await Promise.all([refreshOpenServiceTransmissions(S.schema, S.inst, S.user), refreshOpenServiceTransmissions(S.schema, S.inst, S.user)])
    expect(repo.listLiveTransmissionsToRefresh).toHaveBeenCalledTimes(1)
  })
})

describe('C. cancelServiceInvoiceAtAuthority — D-N7 na ordem, com o adaptador ADN real onde o ataque é de envelope', () => {
  it('(12) bloqueio LOCAL (baixa) → 409 INVOICE_CANCEL_BLOCKED ANTES de abrir o emissor, consultar o PAM ou chamar o fisco', async () => {
    ;(invoice.buildCancelPlan as jest.Mock).mockResolvedValue(planOk([{ field: 'title', ref: '6200/1', message: 'baixa' }, { field: 'fiscal', ref: '1', message: 'A' }]))
    withAuthorizedTx()
    await expect(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço')).rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_CANCEL_BLOCKED' })
    expect(issuerRepo.getIssuer).not.toHaveBeenCalled(); expect(adapter.municipalTerms).not.toHaveBeenCalled(); expect(adapter.registerEvent).not.toHaveBeenCalled()
    expect(conn.rollback).toHaveBeenCalledTimes(1)
  })
  it.each([['em voo', () => inFlightNow(), 'FISCAL_TRANSMISSION_IN_PROGRESS'], ['K', () => tx({ lastKind: 'K' }), 'FISCAL_CANCEL_IN_FLIGHT'], ['A sem chave', () => tx({ lastKind: 'A', accessKey: null }), 'FISCAL_TRANSMISSION_IN_PROGRESS']])(
    '(13) transmissão %s → 409 %s sem abrir o emissor nem chamar o fisco', async (_l, mk, code) => {
      setTx(mk())
      await expect(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'erro na emissão')).rejects.toMatchObject({ statusCode: 409, code })
      expect(issuerRepo.getIssuer).not.toHaveBeenCalled(); expect(adapter.registerEvent).not.toHaveBeenCalled(); expect(invoice.cancelInvoice).not.toHaveBeenCalled()
    })

  it('(14) fisco ACEITA → voz C + cancelInvoice na MESMA transação (2º begin antes dos dois, 2º commit depois, nenhum commit/rollback no meio); evento assinado verifica', async () => {
    withAuthorizedTx()
    const r = await cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço')
    expect(r).toMatchObject({ atAuthority: true, invoiceEvent: 2, transmissionEvent: 1 })
    const begin2 = conn.beginTransaction.mock.invocationCallOrder[1], commit2 = conn.commit.mock.invocationCallOrder[1]
    const cIns = (repo.insertTransmissionEvent as jest.Mock).mock.invocationCallOrder[0], cLocal = (invoice.cancelInvoice as jest.Mock).mock.invocationCallOrder[0]
    expect(begin2).toBeLessThan(cIns); expect(cIns).toBeLessThan(cLocal); expect(cLocal).toBeLessThan(commit2)
    expect(conn.commit).toHaveBeenCalledTimes(2); expect(conn.rollback).not.toHaveBeenCalled()
    expect(adapter.registerEvent.mock.invocationCallOrder[0]).toBeLessThan(begin2)
    expect(verifyXml(adapter.registerEvent.mock.calls[0][2], PAIR.certPem)).toBe(true)
  })
  it('(14b) voz C já gravada por uma consulta concorrente (efeito aplicado) → idempotente: nenhum 2º cancelInvoice', async () => {
    withAuthorizedTx()
    adapter.registerEvent.mockResolvedValue({ dhEvento: '2026-09-22T09:00:00-03:00', raw: {} })
    events.push({ attempt: 1, event: 2, kind: 'C', dh: '2026-09-22 09:00:00', source: 'Q', message: null, authorityCode: null, invoiceEvent: 5 })
    const r = await cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço')
    expect(r.invoiceEvent).toBe(5); expect(invoice.cancelInvoice).not.toHaveBeenCalled(); expect(events).toHaveLength(1)
  })

  it('(15) fisco RECUSA (ADN real: 400 com E0822) → 409 FISCAL_CANCEL_REFUSED com o E0822 em fields[], NADA gravado, só 1 transação (o plano)', async () => {
    useRealAdn(); withAuthorizedTx()
    mockHttp.mockImplementation(async (call: any) => /convenio/.test(call.url) ? ok({ prazoCancelamentoDias: 30 }) : { status: 400, headers: {}, text: '{"erros":[{"codigo":"E0822","descricao":"prazo expirado"}]}' })
    await expect(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço'))
      .rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CANCEL_REFUSED', fields: [expect.objectContaining({ field: 'event', message: expect.stringMatching(/E0822/) })] })
    expect(events).toHaveLength(0); expect(invoice.cancelInvoice).not.toHaveBeenCalled(); expect(conn.beginTransaction).toHaveBeenCalledTimes(1)
  })
  it('(15b) prazo do PAM vencido só AVISA; a recusa é a do fisco (D-N15)', async () => {
    setTx(tx({ lastKind: 'A', dhProc: '2026-01-01 10:00:00' }))
    adapter.municipalTerms.mockResolvedValue({ cancelDays: 30, raw: {} })
    const r = await cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço')
    expect(r.warnings).toHaveLength(1); expect(r.atAuthority).toBe(true)
  })

  it.each([['503 UNAVAILABLE', unavailable()], ['502 UNKNOWN (classificação do adaptador)', new AuthorityHttpError(502, 'ilegível', 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE', 200, '')], ['erro cru de programa', new TypeError('boom')]])(
    '(16) ambíguo (%s) → K gravado (source P) e o erro sobe; nada cancelado localmente', async (_l, err) => {
      withAuthorizedTx()
      adapter.registerEvent.mockRejectedValue(err)
      await expect(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço')).rejects.toBe(err)
      expect(events).toEqual([expect.objectContaining({ kind: 'K', source: 'P' })]); expect(invoice.cancelInvoice).not.toHaveBeenCalled()
    })
  it('(16b) K só nasce se a tentativa ainda é a mesma e está em A (TOCTOU) — outra chegou antes: nada gravado', async () => {
    withAuthorizedTx()
    ;(repo.latestTransmission as jest.Mock).mockResolvedValueOnce(tx({ lastKind: 'A' })).mockResolvedValue(tx({ lastKind: 'K', lastEvent: 2 }))
    adapter.registerEvent.mockRejectedValue(unavailable())
    await expect(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço')).rejects.toMatchObject({ code: 'FISCAL_AUTHORITY_UNAVAILABLE' })
    expect(events).toHaveLength(0)
  })
  it('motivo: só espaços → 400; 14 chars ganha complemento; 300 chars é cortado em 255; "<script>" escapado no XML', async () => {
    await expect(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, '   ')).rejects.toMatchObject({ statusCode: 400, code: 'INVOICE_REASON_REQUIRED' })
    withAuthorizedTx()
    await cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'a<script>b</b>')
    const xml1 = adapter.registerEvent.mock.calls[0][2] as string
    expect(xml1).toContain('<xMotivo>a&lt;script&gt;b&lt;/b&gt; — Cancelamento solicitado pelo emissor</xMotivo>')
    await cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'x'.repeat(300))
    const xml2 = adapter.registerEvent.mock.calls[1][2] as string
    expect(xml2).toContain(`<xMotivo>${'x'.repeat(255)}</xMotivo>`)
  })
})

describe('C.17 — POST /billing/cancel (cancelamento LOCAL, peça @shared/invoice REAL) com transmissão viva/autorizada', () => {
  function realCancelPlanSql() {
    ;(invoice.cancelInvoice as jest.Mock).mockImplementation(actualInvoice.cancelInvoice)
    conn.query.mockImplementation(async (sql: string) => {
      if (/FROM `setes_setes`\.tb_order\s+WHERE id = \?/.test(sql)) return [[{ status: 'F' }]]
      if (/FROM `setes_setes`\.tb_invoice\s+WHERE id = \?/.test(sql)) return [[{ id: INVOICE, number: '17', serie: '1', model: 'SE', value: 1234.5, status: '0' }]]
      if (/FROM `setes_setes`\.tb_invoice_event/.test(sql)) return [[{ event: 1, kind: 'E' }]]
      if (/^UPDATE/.test(sql.trim())) throw new Error(`o cancelamento local NÃO pode gravar nada aqui: ${sql.slice(0, 60)}`)
      return [[]]
    })
  }
  it.each([['A', () => tx({ lastKind: 'A', environment: 'P' }), /Cancelar NFS-e/], ['em voo', () => inFlightNow(), /andamento/], ['K', () => tx({ lastKind: 'K' }), /sem resposta/]])(
    '(17) transmissão %s → 409 INVOICE_CANCEL_BLOCKED com field "fiscal" e mensagem que aponta o caminho; nada gravado', async (_l, mk, msg) => {
      realCancelPlanSql()
      setTx(mk())
      const res = await request(app).post('/api/billing/cancel').set('Authorization', asAdmin()).send({ orderId: INVOICE, reason: 'erro na emissão' })
      expect(res.status).toBe(409); expect(res.body.code).toBe('INVOICE_CANCEL_BLOCKED')
      expect(res.body.fields).toEqual([expect.objectContaining({ field: 'fiscal', message: expect.stringMatching(msg) })])
      expect(repo.latestTransmission).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, true)   // leitura TRAVANTE
      expect(conn.rollback).toHaveBeenCalled()
    })
  it('(17b) transmissão R/F/nunca → o plano NÃO bloqueia pelo fisco (cancela local)', async () => {
    realCancelPlanSql()
    for (const t of [tx({ lastKind: 'R', accessKey: null }), tx({ lastKind: 'F', accessKey: null }), null]) {
      ;(repo.latestTransmission as jest.Mock).mockResolvedValue(t)
      const plan = await actualInvoice.buildCancelPlan(conn, S.schema, S.inst, INVOICE)
      expect(plan.blocks.filter((b: any) => b.field === 'fiscal')).toHaveLength(0)
    }
  })
})

describe('D. transmit-batch — bordas de entrada, isolamento por item, privilégio', () => {
  it('(18) 51 ordens / 0 ordens / id 0 / não-array → 400 VALIDATION_FAILED; 50 iguais = 1 pedido', async () => {
    for (const body of [{ orderIds: Array.from({ length: 51 }, (_, i) => i + 1) }, { orderIds: [] }, { orderIds: [0] }, { orderIds: '1' }, { orderIds: [1.5] }, {}]) {
      const res = await request(app).post('/api/billing/fiscal/transmit-batch').set('Authorization', asAdmin()).send(body)
      expect(res.status).toBe(400); expect(res.body.code).toBe('VALIDATION_FAILED')
    }
    adapter.transmit.mockResolvedValue(authorized())
    const res = await request(app).post('/api/billing/fiscal/transmit-batch').set('Authorization', asAdmin()).send({ orderIds: Array(50).fill(INVOICE) })
    expect(res.status).toBe(200); expect(res.body.data.requested).toBe(1); expect(adapter.transmit).toHaveBeenCalledTimes(1)
  })

  it('(19) item 404, item com erro CRU (TypeError) e item ok → 200 com 3 resultados, nunca 500; erro cru vira code null + retryable false', async () => {
    headerRows.set(6202, header({ id: 6202, branchId: 6202 }))
    adapter.transmit.mockImplementation(async (_c: any, xml: string) => { if (xml.includes('000000000000043')) throw new TypeError('boom'); return authorized() })
    ;(repo.nextDpsNumber as jest.Mock).mockResolvedValueOnce(42).mockResolvedValueOnce(43)
    const res = await request(app).post('/api/billing/fiscal/transmit-batch').set('Authorization', asAdmin()).send({ orderIds: [INVOICE, 6201, 6202] })
    expect(res.status).toBe(200)
    const { data } = res.body
    expect(data).toMatchObject({ requested: 3, transmitted: 1, failed: 2, stoppedEarly: false })
    expect(data.results.find((r: any) => r.orderId === 6201)).toMatchObject({ ok: false, code: 'INVOICE_NOT_FOUND' })
    expect(data.results.find((r: any) => r.orderId === 6202)).toMatchObject({ ok: false, code: null, retryable: false })
    expect(data.results.find((r: any) => r.orderId === INVOICE)).toMatchObject({ ok: true, accessKey: KEY })
  })
  it('(19b) fisco INDISPONÍVEL no 2º → lote pára, 3º marcado retryable sem chamar o fisco; 1º já autorizado fica', async () => {
    for (const id of [6201, 6202]) headerRows.set(id, header({ id, branchId: id }))
    adapter.transmit.mockResolvedValueOnce(authorized()).mockRejectedValueOnce(unavailable())
    const res = await request(app).post('/api/billing/fiscal/transmit-batch').set('Authorization', asAdmin()).send({ orderIds: [INVOICE, 6201, 6202] })
    expect(res.body.data).toMatchObject({ transmitted: 1, failed: 2, stoppedEarly: true })
    expect(res.body.data.results[2]).toMatchObject({ orderId: 6202, ok: false, retryable: true })
    expect(adapter.transmit).toHaveBeenCalledTimes(2)
  })
  it('(19c) lock wait cru no item → RESOURCE_BUSY retryable, sem 500', async () => {
    ;(repo.latestTransmission as jest.Mock).mockRejectedValue(Object.assign(new Error('lock'), { code: 'ER_LOCK_WAIT_TIMEOUT' }))
    const res = await request(app).post('/api/billing/fiscal/transmit-batch').set('Authorization', asAdmin()).send({ orderIds: [INVOICE] })
    expect(res.status).toBe(200); expect(res.body.data.results[0]).toMatchObject({ ok: false, code: 'RESOURCE_BUSY', retryable: true })
  })

  it('(20) usuário sem TRANSMITIR em nenhuma interface do ramo → 403 GLOBAL (antes de qualquer item); com TRANSMITIR só em orders → item da OS recebe 403 POR ITEM e o de venda transmite', async () => {
    let res = await request(app).post('/api/billing/fiscal/transmit-batch').set('Authorization', asUser()).send({ orderIds: [INVOICE] })
    expect(res.status).toBe(403); expect(res.body.code).toBe('PRIVILEGE_REQUIRED'); expect(adapter.transmit).not.toHaveBeenCalled()
    privilegeInterfaces.add(INTERFACE_IDS.orders)
    headerRows.set(6201, header({ id: 6201, branchId: 6201 }))
    ;(resolver.resolveOrderInterface as jest.Mock).mockImplementation(async (_s: any, _i: any, id: number) => id === 6201 ? 'service-orders' : 'orders')
    adapter.transmit.mockResolvedValue(authorized())
    res = await request(app).post('/api/billing/fiscal/transmit-batch').set('Authorization', asUser()).send({ orderIds: [6201, INVOICE] })
    expect(res.status).toBe(200)
    expect(res.body.data.results[0]).toMatchObject({ orderId: 6201, ok: false, code: 'PRIVILEGE_REQUIRED' })
    expect(res.body.data.results[1]).toMatchObject({ orderId: INVOICE, ok: true })
    expect(adapter.transmit).toHaveBeenCalledTimes(1)
    // POST /transmit (unitário) pelo RAMO: OS sem privilégio → 403 antes do fisco
    res = await request(app).post('/api/billing/transmit').set('Authorization', asUser()).send({ orderId: 6201 })
    expect(res.status).toBe(403); expect(adapter.transmit).toHaveBeenCalledTimes(1)
  })

  it('D-N32: leituras fiscais (visão, XML, DANFSe) exigem a interface do RAMO no contrato da institution — usuário regular sem contrato → 403; admin passa', async () => {
    contractedInterfaces = false
    for (const u of ['/api/billing/fiscal/6200', '/api/billing/fiscal/6200/xml', '/api/billing/fiscal/6200/danfse']) {
      const res = await request(app).get(u).set('Authorization', asUser())
      expect(res.status).toBe(403); expect(res.body.code).toBe('INTERFACE_NOT_ALLOWED')
    }
    const res = await request(app).get('/api/billing/fiscal/6200/xml').set('Authorization', asAdmin())
    expect(res.status).toBe(404)                                              // passou do guard: chegou ao negócio
  })
  it('rotas fiscais: sem JWT → 401; :orderId não numérico → 400 INVALID_ID; XML de nota sem NFS-e → 404; pending limit fora de forma → clamp', async () => {
    for (const [m, u] of [['post', '/api/billing/transmit'], ['post', '/api/billing/fiscal/transmit-batch'], ['post', '/api/billing/fiscal/cancel'], ['get', '/api/billing/fiscal/1/xml'], ['get', '/api/billing/fiscal/1/danfse']] as const) {
      expect((await (request(app) as any)[m](u)).status).toBe(401)
    }
    let res = await request(app).get('/api/billing/fiscal/abc').set('Authorization', asUser())
    expect(res.status).toBe(400); expect(res.body.code).toBe('INVALID_ID')
    res = await request(app).get('/api/billing/fiscal/6200/xml').set('Authorization', asUser())
    expect(res.status).toBe(404); expect(res.body.code).toBe('FISCAL_NFSE_NOT_FOUND')
    for (const lim of ['999999', '-1', 'abc']) {
      res = await request(app).get(`/api/billing/fiscal/pending?limit=${lim}`).set('Authorization', asUser())
      expect(res.status).toBe(200)
      const passed = (repo.listPendingServiceInvoices as jest.Mock).mock.calls.at(-1)![2]
      expect(passed).toBeGreaterThan(0); expect(passed).toBeLessThanOrEqual(200)
    }
    res = await request(app).post('/api/billing/fiscal/cancel').set('Authorization', asAdmin()).send({ orderId: INVOICE, reason: '   ' })
    expect(res.status).toBe(400)
    res = await request(app).post('/api/billing/fiscal/cancel').set('Authorization', asAdmin()).send({ orderId: INVOICE, reason: 'x'.repeat(256) })
    expect(res.status).toBe(400)
    // D-N22 (lição da Onda 2): o throttle da consulta ativa não fica na mão do cliente
    res = await request(app).post('/api/billing/fiscal/refresh').set('Authorization', asAdmin()).send({ minMinutes: 0 })
    expect(res.status).toBe(400)
    // consulta ativa e consulta unitária exigem TRANSMITIR (retrabalho): usuário sem o privilégio → 403
    res = await request(app).post('/api/billing/fiscal/refresh').set('Authorization', asUser()).send({})
    expect(res.status).toBe(403)
    res = await request(app).post(`/api/billing/fiscal/${INVOICE}/refresh`).set('Authorization', asUser())
    expect(res.status).toBe(403)
  })
  it('MEDIUM-4: dois lotes SIMULTÂNEOS da mesma institution → o 2º recebe 409 FISCAL_BATCH_RUNNING (não dois lotes)', async () => {
    adapter.transmit.mockImplementation(() => new Promise(r => setTimeout(() => r(authorized()), 150)))
    const [a, b] = await Promise.all([
      request(app).post('/api/billing/fiscal/transmit-batch').set('Authorization', asAdmin()).send({ orderIds: [INVOICE] }),
      new Promise<any>(r => setTimeout(() => request(app).post('/api/billing/fiscal/transmit-batch').set('Authorization', asAdmin()).send({ orderIds: [INVOICE] }).then(r), 30)),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(adapter.transmit).toHaveBeenCalledTimes(1)
  })
})

describe('E. dps-builder / xmldsig — escape, série, forma dos códigos', () => {
  const base: DpsInput = {
    environment: 'H', dhEmi: '2026-09-21T10:15:30-03:00', verAplic: 'SETES-1.0', serie: 1, nDps: 42, dCompet: '2026-09-21', tpEmit: '1', cLocEmi: '4106902',
    prest: { cnpj: CNPJ, regTrib: { opSimpNac: '3', regEspTrib: '0' } }, toma: { cnpj: '98765432000188', xNome: 'Cliente' },
    serv: { locPrest: { cLocPrestacao: '4106902' }, cServ: { cTribNac: '010201', xDescServ: 'x' } },
    valores: { vServ: 10, trib: { tribMun: { tribISSQN: '1', tpRetISSQN: '1', pAliq: 2 }, totTrib: { indTotTrib: '0' } } },
  }
  const sign = (xml: string) => signXml(xml, { referenceId: DPS_ID, cert: Buffer.from(PAIR.certPem), key: Buffer.from(PAIR.keyPem), algorithm: 'sha1' })

  it('(21) xDescServ com <, &, ]]>, aspas e acentos → escapado, XML bem formado, assinatura verifica e o texto volta igual', () => {
    const desc = 'Licença <ERP> & suporte ]]> "aspas" \'apóstrofo\' — ação ç ü 日本'
    const xml = buildDpsXml({ ...base, serv: { ...base.serv, cServ: { ...base.serv.cServ, xDescServ: desc } } }, DPS_ID)
    expect(xml).toContain('<xDescServ>Licença &lt;ERP&gt; &amp; suporte ]]&gt; &quot;aspas&quot; &apos;apóstrofo&apos; — ação ç ü 日本</xDescServ>')
    expect(xml).not.toContain('<ERP>'); expect(xml).not.toContain(' & '); expect(xml).not.toContain(']]>')
    const signed = sign(xml)
    expect(verifyXml(signed, PAIR.certPem)).toBe(true)
    expect(unescapeXml(/<xDescServ>(.*?)<\/xDescServ>/.exec(signed)![1])).toBe(desc)
    // 1 char alterado depois da assinatura → falha
    expect(verifyXml(signed.replace('suporte', 'suportE'), PAIR.certPem)).toBe(false)
  })
  it('(21b) descrição no limite: 2000 caracteres é cortada; caractere de controle não derruba o assinador com Error cru', () => {
    const big = 'a'.repeat(2500)
    const xml = buildDpsXml({ ...base, serv: { ...base.serv, cServ: { ...base.serv.cServ, xDescServ: big } } }, DPS_ID)
    expect(/<xDescServ>(a+)<\/xDescServ>/.exec(xml)![1]).toHaveLength(2000)
    const ctrl = buildDpsXml({ ...base, serv: { ...base.serv, cServ: { ...base.serv.cServ, xDescServ: 'ab c' } } }, DPS_ID)
    expect(() => sign(ctrl)).not.toThrow()
  })

  it('(22) série 0 → recusada por buildDpsId e buildDpsXml; série numérica em string "00001" vale 1', () => {
    expect(() => buildDpsId('4106902', '2', CNPJ, '0', 1)).toThrow(/série/)
    expect(() => buildDpsXml({ ...base, serie: 0 }, DPS_ID)).toThrow()
    expect(buildDpsId('4106902', '2', CNPJ, '00001', 1)).toBe(DPS_ID.slice(0, 25) + '00001' + '000000000000001')
    expect(buildDpsXml({ ...base, serie: '00001' }, DPS_ID)).toContain('<serie>1</serie>')
  })

  it.each([
    ['cLocPrestacao 6 dígitos', { serv: { ...base.serv, locPrest: { cLocPrestacao: '410690' } } }],
    ['cLocEmi 8 dígitos', { cLocEmi: '41069020' }],
    ['CEP do tomador 7 dígitos', { toma: { ...base.toma!, end: { cMun: '4106902', cep: '8001000', xLgr: 'R', nro: '1', xBairro: 'C' } } }],
    ['cMun do tomador com letras', { toma: { ...base.toma!, end: { cMun: '41069AB', cep: '80010000', xLgr: 'R', nro: '1', xBairro: 'C' } } }],
    ['cTribNac 5 dígitos', { serv: { ...base.serv, cServ: { ...base.serv.cServ, cTribNac: '01020' } } }],
    ['CNPJ do prestador 13 dígitos', { prest: { ...base.prest, cnpj: '1234567800019' } }],
    ['tomador com CPF E CNPJ', { toma: { ...base.toma!, cpf: '12345678901' } }],
    ['pAliq 10', { valores: { ...base.valores, trib: { ...base.valores.trib, tribMun: { ...base.valores.trib.tribMun, pAliq: 10 } } } }],
    ['dCompet fora de forma', { dCompet: '21/09/2026' }],
    ['Id com 44 posições', null],
  ])('(23) %s → recusa ANTES de assinar', (_l, over) => {
    if (over === null) expect(() => buildDpsXml(base, DPS_ID.slice(0, 44))).toThrow()
    else expect(() => buildDpsXml({ ...base, ...(over as any) }, DPS_ID)).toThrow()
  })
  it('(23b) signXml recusa Id de referência fora do alfabeto (nada de XPath injetado)', () => {
    const xml = buildDpsXml(base, DPS_ID)
    expect(() => signXml(xml, { referenceId: `${DPS_ID}'] | //*[@Id='x`, cert: Buffer.from(PAIR.certPem), key: Buffer.from(PAIR.keyPem), algorithm: 'sha1' })).toThrow()
    expect(() => signXml(xml, { referenceId: 'DPS' + '9'.repeat(42), cert: Buffer.from(PAIR.certPem), key: Buffer.from(PAIR.keyPem), algorithm: 'sha1' })).toThrow()
  })
})

describe('F. fiscal-issuer — PKCS#12 na porta de entrada (node-forge real)', () => {
  const year = new Date(Date.now() + 365 * 86_400_000)
  it('(24) .pfx com CADEIA (AC antes e depois da folha) → escolhe o certificado que casa com a chave; a AC nunca entra', () => {
    const ca = selfSigned('AC ISCA', year)
    for (const certs of [[ca.cert, PAIR.cert], [PAIR.cert, ca.cert]]) {
      const { certPem, keyPem } = pkcs12ToPem(toPfx(PAIR.keyPem, certs, 'senha'), 'senha')
      expect(certPem.match(/BEGIN CERTIFICATE/g)).toHaveLength(1)
      expect(certPem).toContain(PAIR.certPem.trim().split('\n')[1])
      expect(crypto.createPrivateKey(keyPem)).toBeTruthy()
    }
  })
  it('ACHADO 6 (LOW) — (24b) .pfx com DOIS certificados da MESMA chave (renovação que reaproveitou o par: vencido + válido) → o cofre fica com o VÁLIDO (hoje: o 1º que casa, mesmo vencido → 409)', () => {
    const renewed = selfSigned(`SETES RENOVADA:${CNPJ}`, year, new Date(Date.now() - 60_000), PAIR.keyPem)
    const old = selfSigned(`SETES ANTIGA:${CNPJ}`, new Date(Date.now() - 86_400_000), new Date(Date.now() - 2 * 86_400_000), PAIR.keyPem)
    const status = storeIssuerCertificate(S.schema, S.inst, toPfx(PAIR.keyPem, [old.cert, renewed.cert], 'senha'), 'senha')
    expect(status.certificateInfo?.expired).toBe(false)
    expect(status.certificateInfo?.subject).toMatch(/RENOVADA/)
    clearVault('P')
  })
  it('(25) senha vazia: .pfx SEM senha abre com ""; .pfx com senha NÃO abre com "" (400 FISCAL_CERT_INVALID no campo pfx); senha errada idem', () => {
    const noPass = toPfx(PAIR.keyPem, [PAIR.cert], '')
    expect(pkcs12ToPem(noPass, '').certPem).toContain('BEGIN CERTIFICATE')
    const withPass = toPfx(PAIR.keyPem, [PAIR.cert], 'segredo')
    for (const pw of ['', 'errada', ' segredo']) {
      let err: any
      try { pkcs12ToPem(withPass, pw) } catch (e) { err = e }
      expect(err).toMatchObject({ statusCode: 400, code: 'FISCAL_CERT_INVALID', fields: [expect.objectContaining({ field: 'pfx' })] })
    }
  })
  it.each([
    ['PEM de certificado com cabeçalho', Buffer.from('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----')],
    ['PEM de certificado VÁLIDO (não é PKCS#12)', Buffer.from(PAIR.certPem)],
    ['DER de um X.509 solto', Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(PAIR.cert)).getBytes(), 'binary')],
    ['vazio', Buffer.alloc(0)],
    ['lixo binário', crypto.randomBytes(512)],
    ['ASN.1 truncado', Buffer.from('3082', 'hex')],
  ])('(26) %s → 400 FISCAL_CERT_INVALID (nunca Error cru), nada no cofre', (_l, buf) => {
    clearVault()   // D-N31: cofre único — o beforeEach instala o par válido; o ataque parte do cofre VAZIO
    let err: any
    try { storeIssuerCertificate(S.schema, S.inst, buf, 'x') } catch (e) { err = e }
    expect(err).toBeInstanceOf(HttpError); expect(err).toMatchObject({ statusCode: 400, code: 'FISCAL_CERT_INVALID' })
    expect(hasSecret(vault('P').cert)).toBe(false); expect(hasSecret(vault('P').key)).toBe(false)
  })
  it('(26b) .pfx sem chave privada (só certificados) → 400; vencido → 409 sem gravar', () => {
    clearVault()   // D-N31: cofre único
    const certOnly = forge.pkcs12.toPkcs12Asn1(null as any, [PAIR.cert], 'senha', { algorithm: '3des' })
    const buf = Buffer.from(forge.asn1.toDer(certOnly).getBytes(), 'binary')
    expect(() => storeIssuerCertificate(S.schema, S.inst, buf, 'senha')).toThrow(expect.objectContaining({ statusCode: 400, code: 'FISCAL_CERT_INVALID' }))
    expect(() => storeIssuerCertificate(S.schema, S.inst, toPfx(EXPIRED.keyPem, [EXPIRED.cert], 'senha'), 'senha')).toThrow(expect.objectContaining({ statusCode: 409, code: 'FISCAL_CERT_EXPIRED' }))
    expect(hasSecret(vault('P').cert)).toBe(false); expect(hasSecret(vault('P').key)).toBe(false)
  })
  it('toDbDateTime tolera lixo (null) e grava a voz do fisco como INSTANTE UTC (Q-TZ1)', () => {
    expect(toDbDateTime('garbage')).toBeNull(); expect(toDbDateTime(null)).toBeNull()
    expect(toDbDateTime('2026-09-21T10:15:30.123-03:00')).toBe('2026-09-21 13:15:30')
    expect(toDbDateTime('2026-09-21')).toBe('2026-09-21 03:00:00')   // sem offset = hora de Brasília
  })
})
