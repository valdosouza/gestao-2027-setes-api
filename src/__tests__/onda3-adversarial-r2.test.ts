/// <reference types="jest" />
// Onda 3 (NFS-e pelo Padrão Nacional) — GATE ADVERSARIAL, RE-PROVA (rodada 2, 2026-09-28).
//
// A 1ª rodada (onda3-adversarial.test.ts) deixou 10 achados que foram corrigidos em sessão
// (§10.3 do prompt). Aqui só ATAQUES NOVOS, em torno das 6 correções e das corridas:
//  * ACHADOS R2-x — o teste afirma o que a spec promete (D-N7 "C local só com a voz",
//    §6.3 "consulta → A com chave 50", lição §10.4 da Onda 2 "credencial ≠ indisponibilidade",
//    MEDIUM-5 "sem default silencioso em fato fiscal") e FALHA no código atual: é a prova
//    do bug. A correção é da sessão principal — NUNCA corrigir o teste para passar.
//  * PROVAS POSITIVAS — ataques que NÃO reproduziram bug (ficam como regressão).
//
// Harness = o do molde: pool/repositório mockados na fronteira (loja de eventos em memória),
// `adapterFor` injetável (adaptador falso OU o ADN REAL com `transport.request` mockado —
// nenhum socket), assinatura/cofre/openIssuer/runIsolated REAIS, certificado autoassinado
// gerado no teste. Novidade deste arquivo: transação SERIALIZADA em `beginTransaction`
// (corridas) e transmissão DINÂMICA (o `lastKind` deriva da loja de eventos).
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import forge from 'node-forge'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { gzipSync, gunzipSync } from 'zlib'

const SECRETS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-onda3-adv-r2-secrets-'))
const STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-onda3-adv-r2-storage-'))
process.env.SECRETS_PATH = SECRETS_ROOT
process.env.STORAGE_PATH = STORAGE_ROOT
const JWT_SECRET = 'onda3-adversarial-r2'
process.env.JWT_SECRET = JWT_SECRET

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADV3R2'), recordCrash: jest.fn().mockResolvedValue(undefined),
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
import { ErrorCodes } from '../shared/errors/error-codes'
import { AuthorityHttpError, transport, HttpsCall } from '../shared/tax-authority/https-json'
import { adnAdapter } from '../shared/tax-authority/adapters/adn'
import { buildDpsId } from '../shared/tax-authority'
import {
  transmitServiceInvoice, refreshServiceTransmission, cancelServiceInvoiceAtAuthority, refreshOpenServiceTransmissions,
} from '../shared/invoice-transmission'
import { resetMunicipalTermsCache } from '../shared/invoice-transmission/branches/service'
import { issuerSecretRef, ISSUER_SECRET_NAMES, pkcs12ToPem, storeIssuerCertificate } from '../shared/fiscal-issuer'
import { writeSecret, deleteSecret } from '../shared/secret-store'
import { issuerDto } from '../modules/establishment/establishment.issuer.dto'
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import { transmitInvoiceBatch } from '../modules/billing/billing.fiscal.service'

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
const YEAR = new Date(Date.now() + 365 * 86_400_000)
const PAIR = selfSigned(`SETES TESTE:${CNPJ}`, YEAR)

const S = { schema: 'setes_setes', inst: 1, user: 7 }
const INVOICE = 6200
const KEY = '4106902212345678000199000000000012320260921000012345'.slice(0, 50)
/** Outra chave de 50 dígitos — "parece chave" mas não é a que pedimos. */
const OTHER_KEY = KEY.slice(0, 40) + '9999999999'
const DPS_ID = 'DPS410690221234567800019900001000000000000042'
const OTHER_DPS_ID = DPS_ID.slice(0, -1) + '3'
const nfseXmlFor = (key = KEY, dpsId = DPS_ID) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${key}"><nNFSe>123</nNFSe><dhProc>2026-09-21T10:15:30-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS Id="${dpsId}"></infDPS></DPS></infNFSe></NFSe>`
const NFSE_XML = nfseXmlFor()
const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')
const ungz = (b64: string) => gunzipSync(Buffer.from(b64, 'base64')).toString('utf8')

/**
 * Evento GERADO pelo fisco (forma do XSD: infEvento Id="EVT…" + chNFSe + nSeqEvento + dhProc +
 * o pedRegEvento embutido). Cada opção retira/troca UM fato para o ataque.
 */
function generatedEventXml(o: { key?: string; code?: string; withId?: boolean; withDhProc?: boolean } = {}): string {
  const key = o.key ?? KEY, code = o.code ?? '101101'
  const id = o.withId === false ? '' : ` Id="EVT${key}${code}000000001"`
  const dhProc = o.withDhProc === false ? '' : '<dhProc>2026-09-28T10:00:00-03:00</dhProc>'
  return `<evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infEvento${id}><chNFSe>${key}</chNFSe><nSeqEvento>1</nSeqEvento>${dhProc}` +
    `<pedRegEvento><infPedReg Id="PRE${key}${code}"><tpAmb>2</tpAmb><dhEvento>2026-09-28T09:59:00-03:00</dhEvento><CNPJAutor>${CNPJ}</CNPJAutor><chNFSe>${key}</chNFSe>` +
    `<e${code}><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>cliente desistiu do serviço</xMotivo></e${code}></infPedReg></pedRegEvento></infEvento></evento>`
}

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
let currentTx: any = null
const setTx = (row: any) => { currentTx = row; (repo.latestTransmission as jest.Mock).mockResolvedValue(row) }
const unavailable = () => new AuthorityHttpError(503, 'Fisco indisponível', ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE, 0, '')
const authFailed = (authorityStatus = 0) => new AuthorityHttpError(409, 'Fisco recusou o certificado (mTLS)', ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED, authorityStatus, authorityStatus ? '{"erros":[]}' : 'EPROTO')
const unknownResp = () => new AuthorityHttpError(502, 'ilegível', ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, 200, '')
const planOk = (blocks: any[] = []) => ({
  orderId: INVOICE, invoice: { id: INVOICE, lastKind: 'E', lastEvent: 1 }, blocks, bankSlipsToCancel: [], releasedTitles: [],
  serviceOrder: null, checksToReverse: [], commissionEntries: [], touchesCash: false,
})
const cancelled = { orderId: INVOICE, invoiceNumber: '17', event: 2, checksReversed: [], bankSlipsCancelled: [], releasedTitles: [], commissionsCompensated: 0 }
const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: obj == null ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj) })
const notFound = () => ({ status: 404, headers: {}, text: '' })
const tokenFor = (role: string, userId = 7) => jwt.sign({ institutionId: 1, userId, role, schemaName: 'setes_setes' }, JWT_SECRET)
const asAdmin = () => `Bearer ${tokenFor('admin')}`
const ADMIN = { institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes' }
const delay = <T,>(ms: number, v: () => T) => new Promise<T>((res, rej) => setTimeout(() => { try { res(v()) } catch (e) { rej(e) } }, ms))
const delayReject = (ms: number, e: unknown) => new Promise<never>((_r, rej) => setTimeout(() => rej(e), ms))

// loja de eventos em memória
type Ev = { attempt: number; event: number; kind: string; dh: string | null; source: string; message: string | null; authorityCode: string | null; invoiceEvent: number | null }
let events: Ev[] = []
const evMatch = (attempt: number, kind: string, dh: string | null) => events.filter(e => e.attempt === attempt && e.kind === kind && (e.dh ?? null) === (dh ?? null))
const kinds = () => events.map(e => e.kind)

let headerRows: Map<number, any>
let ibgeByCity: Map<number, string | null>
let privilegeInterfaces: Set<number>
const INTERFACE_IDS: Record<string, number> = { 'service-orders': 40, orders: 30, 'order-returns': 31 }
function poolDefaults() {
  q.mockImplementation(async (sql: string, params: any[]) => {
    if (/FROM `setes_setes`\.tb_invoice i/.test(sql)) { const r = Number(params?.[1]) === S.inst ? headerRows.get(Number(params?.[0])) : null; return [r ? [r] : []] }
    if (/setes_central\.tb_city/.test(sql)) { const ib = ibgeByCity.has(Number(params?.[0])) ? ibgeByCity.get(Number(params?.[0])) : '4106902'; return [ib ? [{ ibge: ib }] : []] }
    if (/setes_central\.tb_interface WHERE i18n_key/.test(sql)) { const id = INTERFACE_IDS[String(params?.[0])]; return [id ? [{ id }] : []] }
    if (/tb_user_has_privilege/.test(sql)) return [privilegeInterfaces.has(Number(params?.[1])) ? [{ 1: 1 }] : []]
    return [[]]
  })
}
function connDefaults() {
  conn.query.mockImplementation(async (sql: string, params: any[]) => {
    if (/dps_number AS dpsNumber/.test(sql)) { const r = headerRows.get(Number(params?.[0])); return [r ? [{ dpsNumber: r.dpsNumber, updatedAt: r.branchUpdatedAt }] : []] }
    return [{}]
  })
}

/**
 * Transmissão DINÂMICA: `lastKind`/`lastEvent` derivam da loja de eventos (a linha do banco
 * "vê" o que a outra transação acabou de gravar) — sem isso corrida nenhuma se prova.
 */
function dynamicTx(base: any) {
  const derive = () => {
    const evs = events.filter(e => e.attempt === base.attempt).sort((a, b) => b.event - a.event)
    return evs[0] ? { ...base, lastKind: evs[0].kind, lastEvent: evs[0].event, lastDh: evs[0].dh } : { ...base, lastKind: null, lastEvent: null }
  }
  currentTx = base
  ;(repo.latestTransmission as jest.Mock).mockImplementation(async () => derive())
  ;(repo.getTransmission as jest.Mock).mockImplementation(async (_q: any, _s: any, _i: any, _inv: any, attempt: number) => attempt === base.attempt ? derive() : null)
  ;(repo.findTransmissionByDpsId as jest.Mock).mockImplementation(async () => derive())
  if (base.lastKind) events.push({ attempt: base.attempt, event: 1, kind: base.lastKind, dh: base.lastDh ?? null, source: 'P', message: null, authorityCode: null, invoiceEvent: null })
}

/** Transações SERIALIZADAS (uma de cada vez, FIFO) — o lock de linha do InnoDB no molde do harness. */
function serializeTransactions() {
  let chain = Promise.resolve(); const releases: (() => void)[] = []
  const acquire = () => { let rel!: () => void; const p = new Promise<void>(r => (rel = r)); const prev = chain; chain = chain.then(() => p); return prev.then(() => rel) }
  conn.beginTransaction.mockImplementation(async () => { releases.push(await acquire()) })
  conn.commit.mockImplementation(async () => { releases.shift()?.() })
  conn.rollback.mockImplementation(async () => { releases.shift()?.() })
}

/** Estado LOCAL da nota (tb_invoice_event) que o cancelamento local altera. */
let localLast: { event: number; kind: string }
function localInvoice() {
  ;(invoice.lockInvoice as jest.Mock).mockImplementation(async () => ({ id: INVOICE, number: '17', serie: '1', model: 'SE', value: 1234.5, status: '0', lastEvent: localLast.event, lastKind: localLast.kind }))
  ;(invoice.cancelInvoice as jest.Mock).mockImplementation(async () => { localLast = { event: 2, kind: 'C' }; return cancelled })
}

beforeEach(() => {
  jest.clearAllMocks()
  conn.beginTransaction.mockReset(); conn.commit.mockReset(); conn.rollback.mockReset()
  resetMunicipalTermsCache()
  resetPrivilegeCache()
  events = []
  localLast = { event: 1, kind: 'E' }
  headerRows = new Map([[INVOICE, header()]])
  ibgeByCity = new Map()
  privilegeInterfaces = new Set()
  poolDefaults(); connDefaults()
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
  installVault()
  ;(authority.adapterFor as jest.Mock).mockReturnValue(adapter)
  ;(issuerRepo.getIssuer as jest.Mock).mockResolvedValue(issuerRow())
  ;(entity.getEntityFiscalFull as jest.Mock).mockImplementation(async (id: number) => fullEntity(id))
  ;(entityTax.getEntityTax as jest.Mock).mockResolvedValue({ simplesRegime: '3', specialTaxRegime: '0' })
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
  mockHttp.mockReset()
})
afterAll(() => {
  transport.request = realTransport
  fs.rmSync(SECRETS_ROOT, { recursive: true, force: true })
  fs.rmSync(STORAGE_ROOT, { recursive: true, force: true })
  delete process.env.SECRETS_PATH; delete process.env.STORAGE_PATH
})

const authorized = () => ({ accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21T10:15:30-03:00', nfseXml: NFSE_XML, raw: {} })
const withAuthorizedTx = () => setTx(tx({ lastKind: 'A' }))
const cancelledVoice = (dhEvento: string | null = '2026-09-22T09:00:00-03:00') =>
  ({ accessKey: KEY, status: 'cancelled', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00', cancelled: { dhEvento, motive: 'erro na emissão' } })
const authorizedVoice = () => ({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })
/** O que veio (resultado ou erro), legível no relatório do jest. */
function describeOutcome(o: any) {
  return { ctor: o?.constructor?.name ?? typeof o, message: String(o?.message ?? ''), stack: String(o?.stack ?? '').split('\n').slice(0, 5).map(l => l.trim()).join(' | ') }
}
/** Roteador HTTP do ADN real: convênio sempre OK; o resto por rota. */
function adnRoutes(routes: { dps?: (c: HttpsCall) => any; nfse?: (c: HttpsCall) => any; eventosGet?: (c: HttpsCall) => any; eventosPost?: (c: HttpsCall) => any }) {
  mockHttp.mockImplementation(async (call: HttpsCall) => {
    if (/convenio/.test(call.url)) return ok({ prazoCancelamentoDias: 365 })
    if (/\/dps\//.test(call.url)) return routes.dps?.(call) ?? notFound()
    if (/\/eventos$/.test(call.url)) return call.method === 'POST' ? (routes.eventosPost?.(call) ?? ok(null)) : (routes.eventosGet?.(call) ?? notFound())
    if (/\/nfse\/\d+$/.test(call.url)) return routes.nfse?.(call) ?? notFound()
    if (/\/nfse$/.test(call.url)) return routes.nfse?.(call) ?? ok(null)
    return notFound()
  })
}

// ===========================================================================
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO R2-1 (MEDIUM) — registerEvent aceita como VOZ DO FISCO um "evento" que não é a resposta ao pedido (contorno da correção 1)', () => {
  // A correção 1 exige `eventCode` + (`dhProc` | `dhEvento`). Mas o PRÓPRIO pedido que enviamos
  // (pedRegEvento assinado) tem os dois: um gateway/WAF que ECOA o corpo com 200 passa como aceite.
  // E nem chave nem código são conferidos: um evento gerado de OUTRA NFS-e, ou de outro TIPO,
  // vira "o fisco cancelou" → C + cancelInvoice sem voz (mesmo efeito do ACHADO 1, D-N7).
  const cases: [string, (c: HttpsCall) => any][] = [
    ['eco do PRÓPRIO pedido (pedRegEvento assinado devolvido com 200: e101101 + dhEvento, sem Id EVT nem dhProc)',
      c => ok({ eventoXmlGZipB64: gz(ungz(JSON.parse(String(c.body)).pedidoRegistroEventoXmlGZipB64)) })],
    ['evento gerado (Id EVT + dhProc) mas com chNFSe de OUTRA chave', () => ok({ eventoXmlGZipB64: gz(generatedEventXml({ key: OTHER_KEY })) })],
    ['evento gerado de OUTRO tipo (e105102, não o e101101 pedido)', () => ok({ eventoXmlGZipB64: gz(generatedEventXml({ code: '105102' })) })],
    ['infEvento SEM Id e SEM dhProc (só o dhEvento do pedido embutido)', () => ok({ eventoXmlGZipB64: gz(generatedEventXml({ withId: false, withDhProc: false })) })],
  ]
  it.each(cases)('%s → 5xx ambíguo + K em voo, NUNCA C nem cancelInvoice', async (_l, resp) => {
    useRealAdn(); withAuthorizedTx()
    adnRoutes({ eventosPost: resp })
    let outcome: any
    try { outcome = await cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço') } catch (e) { outcome = e }
    expect(describeOutcome(outcome)).toEqual(expect.objectContaining({ ctor: expect.stringMatching(/HttpError/) }))
    expect(outcome.statusCode).toBeGreaterThanOrEqual(502)
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
    expect(kinds()).not.toContain('C')
    expect(kinds()).toContain('K')
  })
})

describe('ACHADO R2-2 (MEDIUM) — resposta do fisco não é conferida contra a PERGUNTA (chave/DPS pedidos × chave/DPS que vieram)', () => {
  // Correção 5: "chave só com 50 dígitos". Mas 50 dígitos DIFERENTES da chave pedida passam, e o
  // Id do DPS embutido na NFS-e nunca é comparado com o DPS enviado. Resposta trocada (proxy/cache,
  // fisco em manutenção) grava A/C da nota ERRADA: a nossa fica "autorizada" com chave alheia (o
  // cancelamento depois pede o cancelamento da NFS-e de outro contribuinte) ou é cancelada aqui
  // por um e101101 que não é dela.
  it('(a) POST /nfse 2xx com NFS-e cujo infDPS Id ≠ o DPS enviado → 502, nada gravado', async () => {
    useRealAdn()
    adnRoutes({ nfse: () => ok({ nfseXmlGZipB64: gz(nfseXmlFor(KEY, OTHER_DPS_ID)) }) })
    let outcome: any
    try { outcome = await transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE) } catch (e) { outcome = e }
    expect(describeOutcome(outcome)).toEqual(expect.objectContaining({ ctor: expect.stringMatching(/HttpError/) }))
    expect(outcome.statusCode).toBe(502)
    expect(repo.fillAuthorityData).not.toHaveBeenCalled(); expect(kinds()).not.toContain('A')
  })
  it('(b) POST /nfse 2xx com `chaveAcesso` (50 dígitos) ≠ Id da NFS-e do XML → 502, nada gravado', async () => {
    useRealAdn()
    adnRoutes({ nfse: () => ok({ chaveAcesso: OTHER_KEY, nfseXmlGZipB64: gz(NFSE_XML) }) })
    let outcome: any
    try { outcome = await transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE) } catch (e) { outcome = e }
    expect(describeOutcome(outcome)).toEqual(expect.objectContaining({ ctor: expect.stringMatching(/HttpError/) }))
    expect(outcome.statusCode).toBe(502)
    expect(repo.fillAuthorityData).not.toHaveBeenCalled(); expect(kinds()).not.toContain('A')
  })
  it('(c) consulta em voo: GET /dps diz chave K, GET /nfse/K devolve NFS-e com Id de OUTRA chave (50 dígitos) → 502; a chave alheia NUNCA entra na tentativa', async () => {
    useRealAdn(); setTx(inFlightNow())
    adnRoutes({ dps: () => ok({ chaveAcesso: KEY }), nfse: () => ok({ nfseXmlGZipB64: gz(nfseXmlFor(OTHER_KEY)) }) })
    let outcome: any
    try { outcome = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q') } catch (e) { outcome = e }
    expect(describeOutcome(outcome)).toEqual(expect.objectContaining({ ctor: expect.stringMatching(/HttpError/) }))
    expect(outcome.statusCode).toBe(502)
    expect(repo.fillAuthorityData).not.toHaveBeenCalled()
    expect(events.filter(e => e.kind === 'A' && (e.message ?? '').includes(OTHER_KEY))).toHaveLength(0)
  })
  it('(d) NFS-e autorizada: GET /nfse/{K}/eventos traz um e101101 GERADO de OUTRA chave → não é cancelamento desta: nenhum C, nenhum cancelInvoice', async () => {
    useRealAdn(); withAuthorizedTx()
    adnRoutes({ nfse: () => ok({ nfseXmlGZipB64: gz(NFSE_XML) }), eventosGet: () => ok([{ eventoXmlGZipB64: gz(generatedEventXml({ key: OTHER_KEY })) }]) })
    let outcome: any
    try { outcome = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q') } catch (e) { outcome = e }
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
    expect(kinds()).not.toContain('C')
    if (outcome instanceof Error) expect(outcome).toBeInstanceOf(HttpError)     // 502 "ambíguo" também vale; C não
  })
})

describe('ACHADO R2-3 (MEDIUM) — consulta ativa NÃO pára em AUTH_FAILED: N handshakes com o mesmo A1 quebrado e N notas "olhadas" sem nada aprendido', () => {
  // Correção 4 parou o LOTE de transmissão em AUTH_FAILED (lição §10.4 da Onda 2). A consulta
  // ativa (`refreshOpenServiceTransmissions`) ficou de fora: `stopsTheRun` só conhece UNAVAILABLE e
  // `isPersistentRefreshFailure` classifica o 409 de credencial como "persistente" → marca
  // `last_queried_at` em cada nota (elas saem do rodízio por N minutos sem que o fisco tenha dito
  // nada sobre elas) e insiste no handshake até esgotar os 8 da passada.
  it('3 vivas, TLS recusado na 1ª → fisco chamado UMA vez, passada pára (stoppedEarly), nenhuma nota marcada como olhada', async () => {
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([6200, 6201, 6202].map(invoiceId => ({ invoiceId, attempt: 1 })))
    ;(repo.latestTransmission as jest.Mock).mockImplementation(async (_q: any, _s: any, _i: any, invoiceId: number) => tx({ invoiceId, lastKind: 'A' }))
    adapter.queryNfse.mockRejectedValue(authFailed())
    const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(adapter.queryNfse).toHaveBeenCalledTimes(1)
    expect(r.stoppedEarly).toBe(true)
    expect(repo.touchQueriedAt).not.toHaveBeenCalled()
  })
})

describe('ACHADO R2-4 (LOW) — certificado AINDA NÃO VIGENTE (notBefore no futuro) entra no cofre e abre o emissor (contorno da correção 6)', () => {
  // Correção 6 escolhe "o vigente agora" quando há mais de um; mas `certificateInfo.expired` só olha
  // notAfter. Um .pfx cujo ÚNICO certificado começa a valer amanhã passa em `storeIssuerCertificate`
  // e em `openIssuer`, e a falha aparece só no handshake (CERT_NOT_YET_VALID → F em cada nota do lote).
  const future = selfSigned(`SETES FUTURA:${CNPJ}`, new Date(Date.now() + 2 * 365 * 86_400_000), new Date(Date.now() + 86_400_000))
  it('upload de .pfx com certificado que só vale amanhã → 409 legível, nada no cofre', () => {
    let err: any
    try { storeIssuerCertificate(S.schema, S.inst, toPfx(future.keyPem, [future.cert], 'senha'), 'senha') } catch (e) { err = e } finally { clearVault('P') }
    expect(err).toBeInstanceOf(HttpError)
    expect(err.statusCode).toBe(409)
  })
  it('cofre com certificado que só vale amanhã → 409 antes do fisco (openIssuer), sem reserva', async () => {
    installVault(future.certPem, future.keyPem)
    adapter.transmit.mockResolvedValue(authorized())          // se chegar ao fisco, a prova é "resolveu em vez de 409"
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 409 })
    expect(repo.insertTransmission).not.toHaveBeenCalled(); expect(adapter.transmit).not.toHaveBeenCalled()
  })
})

describe('ACHADO R2-5 (LOW) — municipal_code com lixo entre 3 dígitos ("1-2-3", "12 3") vira cTribMun "123" em silêncio (contorno da correção 2)', () => {
  // Correção 2: "presente e fora de 3 dígitos → 422". A conferência é sobre os DÍGITOS extraídos:
  // "1-2-3" tem 3 dígitos e passa como "123" — código que ninguém digitou (MEDIUM-5: nada de
  // normalização silenciosa em fato fiscal; a regra de ISS é quem corrige).
  it.each([['1-2-3'], ['12 3'], ['1.2.3']])('municipal_code %j → 422 no campo municipalCode ANTES de reservar', async (mc) => {
    headerRows.set(INVOICE, header({ municipalCode: mc }))
    adapter.transmit.mockResolvedValue(authorized())          // se chegar ao fisco, a prova é "resolveu (cTribMun 123) em vez de 422"
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 422, fields: [expect.objectContaining({ field: 'municipalCode' })] })
    expect(repo.insertTransmission).not.toHaveBeenCalled(); expect(adapter.transmit).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// PROVAS POSITIVAS — ataques que NÃO reproduziram bug (regressão)
// ===========================================================================

describe('P1. registerEvent — o evento GERADO legítimo (Id EVT + dhProc + chave pedida + e101101) É aceite: voz C + C local na mesma transação', () => {
  it('sanidade do ataque R2-1: com todos os fatos certos o caminho (5) acontece', async () => {
    useRealAdn(); withAuthorizedTx()
    adnRoutes({ eventosPost: () => ok({ eventoXmlGZipB64: gz(generatedEventXml()) }) })
    const r = await cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço')
    expect(r).toMatchObject({ atAuthority: true, invoiceEvent: 2 })
    expect(events).toEqual([expect.objectContaining({ kind: 'C', source: 'P', dh: '2026-09-28 10:00:00', invoiceEvent: 2 })])
    expect(invoice.cancelInvoice).toHaveBeenCalledTimes(1)
  })
})

describe('P2. municipal_code na porta (correção 2): vazio/espaços omite; letras, 2 e 4 dígitos → 422 sem reservar', () => {
  it('"  " → cTribMun omitido e transmite', async () => {
    headerRows.set(INVOICE, header({ municipalCode: '  ' }))
    adapter.transmit.mockResolvedValue(authorized())
    await transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)
    expect(adapter.transmit.mock.calls[0][1] as string).not.toContain('<cTribMun>')
  })
  it.each([['abc'], ['12'], ['1234'], ['0102'], ['١٢٣']])('%j → 422 municipalCode, nada reservado', async (mc) => {
    headerRows.set(INVOICE, header({ municipalCode: mc }))
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 422, code: 'FISCAL_DPS_INVALID', fields: [expect.objectContaining({ field: 'municipalCode' })] })
    expect(repo.insertTransmission).not.toHaveBeenCalled()
  })
})

describe('P3. série (correção 3): forma e faixa na porta e no Id', () => {
  it('DTO recusa "049999" (6 posições), "1e3", "49999.0", dígitos não-ASCII; aceita " 49999 " (trim) e "00001"', () => {
    for (const s of ['049999', '1e3', '49999.0', '٤٩٩٩٩', '4999９', '-1', '+1']) expect(issuerDto.safeParse({ environment: 'H', serie: s }).success).toBe(false)
    for (const s of [' 49999 ', '00001', '49999']) expect(issuerDto.safeParse({ environment: 'H', serie: s }).success).toBe(true)
  })
  it('buildDpsId: "049999" vindo por SQL vale 49999 (5 posições no Id — tolerância documentada); 49999.5 / NaN / "" recusados', () => {
    expect(buildDpsId('4106902', '2', CNPJ, '049999', 1)).toContain('49999000000000000001')
    for (const s of [49999.5, Number.NaN, '', 'abc', 50000, -1]) expect(() => buildDpsId('4106902', '2', CNPJ, s as any, 1)).toThrow()
  })
})

describe('P4. lote (correção 4): 1º item recusado com 403 HTTP do fisco e 2º com cancelamento em voo (K)', () => {
  it('fisco chamado UMA vez, 1 F (código 403) só na 1ª, 2ª não processada e `retryable` (o K dela nem foi lido), stoppedEarly', async () => {
    headerRows.set(6201, header({ id: 6201, branchId: 6201 }))
    ;(repo.latestTransmission as jest.Mock).mockImplementation(async (_q: any, _s: any, _i: any, invoiceId: number) => invoiceId === 6201 ? tx({ invoiceId: 6201, lastKind: 'K', lastEvent: 2 }) : null)
    adapter.transmit.mockRejectedValue(authFailed(403))
    const res = await request(app).post('/api/billing/fiscal/transmit-batch').set('Authorization', asAdmin()).send({ orderIds: [INVOICE, 6201] })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ requested: 2, transmitted: 0, failed: 2, stoppedEarly: true })
    expect(res.body.data.results[0]).toMatchObject({ orderId: INVOICE, ok: false, code: 'FISCAL_AUTHORITY_AUTH_FAILED', retryable: false })
    expect(res.body.data.results[1]).toMatchObject({ orderId: 6201, ok: false, code: null, retryable: true })
    expect(adapter.transmit).toHaveBeenCalledTimes(1)
    expect(events).toEqual([expect.objectContaining({ kind: 'F', attempt: 1, authorityCode: '403' })])
  })
})

describe('P5. lote com ORÇAMENTO estourado no meio (MEDIUM-4): processados = chamadas ao fisco; restantes retryable sem toque; trava do lote liberada', () => {
  it('3 notas, fisco leva 40 ms cada, orçamento 50 ms → pára entre a 2ª e a 3ª; 2º lote logo depois NÃO recebe FISCAL_BATCH_RUNNING', async () => {
    for (const id of [6201, 6202]) headerRows.set(id, header({ id, branchId: id }))
    adapter.transmit.mockImplementation(() => delay(40, authorized))
    const r = await transmitInvoiceBatch(ADMIN as any, { orderIds: [INVOICE, 6201, 6202] }, { budgetMs: 50 })
    expect(r.stoppedEarly).toBe(true)
    expect(r.transmitted).toBeGreaterThanOrEqual(1); expect(r.transmitted).toBeLessThan(3)
    expect(adapter.transmit).toHaveBeenCalledTimes(r.transmitted)
    expect(r.transmitted + r.failed).toBe(3)
    const skipped = r.results.filter(x => !x.ok)
    expect(skipped.length).toBe(r.failed)
    for (const s of skipped) expect(s).toMatchObject({ code: null, retryable: true })
    expect(r.results.map(x => x.orderId)).toEqual([INVOICE, 6201, 6202])            // ordem preservada
    adapter.transmit.mockResolvedValue(authorized())
    const r2 = await transmitInvoiceBatch(ADMIN as any, { orderIds: [6202] }, { budgetMs: 60_000 })
    expect(r2).toMatchObject({ transmitted: 1, stoppedEarly: false })
  })
})

describe('P6. consulta ativa sob 502 REPETIDO (2xx ilegível em todas) × 503', () => {
  beforeEach(() => {
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([6200, 6201, 6202].map(invoiceId => ({ invoiceId, attempt: 1 })))
    ;(repo.latestTransmission as jest.Mock).mockImplementation(async (_q: any, _s: any, _i: any, invoiceId: number) => tx({ invoiceId, lastKind: 'A' }))
  })
  it('502 em todas → cada nota conta como "olhada" (rodízio) e a passada NÃO pára; nada gravado', async () => {
    adapter.queryNfse.mockRejectedValue(unknownResp())
    const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(r).toMatchObject({ checked: 3, changed: 0, stoppedEarly: false })
    expect(r.errors).toHaveLength(3); for (const e of r.errors) expect(e.code).toBe('FISCAL_AUTHORITY_UNKNOWN_RESPONSE')
    expect(adapter.queryNfse).toHaveBeenCalledTimes(3)
    expect(repo.touchQueriedAt).toHaveBeenCalledTimes(3)
    expect(events).toHaveLength(0); expect(repo.fillAuthorityData).not.toHaveBeenCalled()
  })
  it('503 na 1ª → pára, 1 chamada, nenhuma marcada como olhada', async () => {
    adapter.queryNfse.mockRejectedValue(unavailable())
    const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(r).toMatchObject({ checked: 1, stoppedEarly: true })
    expect(adapter.queryNfse).toHaveBeenCalledTimes(1); expect(repo.touchQueriedAt).not.toHaveBeenCalled()
  })
})

describe('P7. consulta com a nota já SOFT-DELETADA e voz C com efeito PENDENTE (HIGH-3b)', () => {
  const softDeleted = (lastLocal: { event: number; kind: string } | null) => {
    ;(invoice.lockInvoice as jest.Mock).mockRejectedValue(new HttpError(404, 'Nota do pedido 6200 não encontrada', undefined, 'INVOICE_NOT_FOUND'))
    conn.query.mockImplementation(async (sql: string) => /FROM `setes_setes`\.tb_invoice_event/.test(sql) ? [lastLocal ? [lastLocal] : []] : [{}])
    setTx(tx({ lastKind: 'C', lastEvent: 2 }))
    events.push({ attempt: 1, event: 2, kind: 'C', dh: '2026-09-22 09:00:00', source: 'Q', message: 'Cancelada no fisco', authorityCode: null, invoiceEvent: null })
    adapter.queryNfse.mockResolvedValue(cancelledVoice())
  }
  it('último evento local é C (cancelada aqui antes, cabeçalho soft-deletado) → pendência LIGADA a esse evento, sem 2º cancelInvoice, sem 2º C', async () => {
    softDeleted({ event: 3, kind: 'C' })
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ kind: 'C', invoiceEvent: 3, effectRefused: null })
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
    expect(events.filter(e => e.kind === 'C')).toHaveLength(1); expect(events[0].invoiceEvent).toBe(3)
    expect(conn.commit).toHaveBeenCalledTimes(1); expect(conn.rollback).not.toHaveBeenCalled()
  })
  it('cabeçalho soft-deletado SEM C local (último evento E) → recusa de regra: pendência FICA ("Efeito recusado"), transação commitada — comportamento documentado (a pendência será retentada a cada 15 min até alguém restaurar/cancelar a nota)', async () => {
    softDeleted({ event: 1, kind: 'E' })
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ kind: 'C', invoiceEvent: null, effectRefused: expect.stringMatching(/não encontrada/) })
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
    expect(conn.query.mock.calls.map(c => String(c[0]))).toContain('ROLLBACK TO SAVEPOINT fiscal_cancel_effect')
    expect(conn.commit).toHaveBeenCalledTimes(1)
  })
})

describe('P8. efeito RECUSADO por regra → na retentativa vira TRANSITÓRIO → depois APLICA: um C só, a pendência sobrevive ao rollback do meio', () => {
  it('3 consultas com a mesma voz C', async () => {
    dynamicTx(tx({ lastKind: 'A' }))
    adapter.queryNfse.mockResolvedValue(cancelledVoice())
    ;(invoice.cancelInvoice as jest.Mock)
      .mockRejectedValueOnce(new HttpError(409, 'Título 6200/1 tem baixa de 80.00 — estorne a baixa antes', [], 'INVOICE_CANCEL_BLOCKED'))
      .mockRejectedValueOnce(Object.assign(new Error('lock'), { code: 'ER_LOCK_WAIT_TIMEOUT' }))
      .mockResolvedValueOnce(cancelled)
    const r1 = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r1).toMatchObject({ kind: 'C', invoiceEvent: null, effectRefused: expect.stringMatching(/baixa/) })
    expect(events.filter(e => e.kind === 'C')).toHaveLength(1); expect(conn.rollback).not.toHaveBeenCalled()
    await expect(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' })
    expect(conn.rollback).toHaveBeenCalledTimes(1)
    expect(events.filter(e => e.kind === 'C')).toHaveLength(1); expect(events.find(e => e.kind === 'C')!.invoiceEvent).toBeNull()
    const r3 = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r3).toMatchObject({ kind: 'C', invoiceEvent: 2, effectRefused: null, changed: true })
    expect(events.filter(e => e.kind === 'C')).toHaveLength(1); expect(events.find(e => e.kind === 'C')!.invoiceEvent).toBe(2)
    expect(invoice.cancelInvoice).toHaveBeenCalledTimes(3)
  })
})

describe('P9. CORRIDAS com transação serializada e transmissão dinâmica — cancel × refresh × transmit ao mesmo tempo', () => {
  beforeEach(() => { serializeTransactions(); localInvoice(); dynamicTx(tx({ lastKind: 'A' })) })

  it('(a) cancelamento no fisco (aceita em 30 ms) × consulta com voz VELHA "autorizada" (chega em 60 ms) × nova transmissão → 1 C, 0 A/N novos, transmit 409, fisco de transmissão NUNCA chamado', async () => {
    adapter.registerEvent.mockImplementation(() => delay(30, () => ({ dhEvento: '2026-09-28T10:00:00-03:00', protocol: 'EVT1', raw: {} })))
    adapter.queryNfse.mockImplementation(() => delay(60, authorizedVoice))
    const [c, r, t] = await Promise.allSettled([
      cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço'),
      refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q'),
      transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE),
    ])
    expect(c.status).toBe('fulfilled'); expect((c as PromiseFulfilledResult<any>).value).toMatchObject({ atAuthority: true, invoiceEvent: 2 })
    expect(r.status).toBe('fulfilled'); expect((r as PromiseFulfilledResult<any>).value.changed).toBe(false)
    expect(t.status).toBe('rejected'); expect((t as PromiseRejectedResult).reason).toBeInstanceOf(HttpError); expect((t as PromiseRejectedResult).reason.statusCode).toBe(409)
    expect(kinds().filter(k => k === 'C')).toHaveLength(1); expect(kinds().filter(k => k === 'A')).toHaveLength(1); expect(kinds()).not.toContain('N'); expect(kinds()).not.toContain('K')
    expect(invoice.cancelInvoice).toHaveBeenCalledTimes(1); expect(adapter.transmit).not.toHaveBeenCalled(); expect(repo.insertTransmission).not.toHaveBeenCalled()
  })

  it.each([
    ['K antes da voz C (pedido cai em 10 ms, consulta responde em 40 ms)', 10, 40],
    ['voz C antes do K (consulta responde em 10 ms, pedido cai em 40 ms)', 40, 10],
  ])('(b) cancelamento AMBÍGUO (503) × consulta que já vê CANCELADA — %s → termina em C, um cancelInvoice, K (se existir) vem ANTES do C', async (_l, cancelMs, queryMs) => {
    adapter.registerEvent.mockImplementation(() => delayReject(cancelMs, unavailable()))
    adapter.queryNfse.mockImplementation(() => delay(queryMs, cancelledVoice))
    const [c, r] = await Promise.allSettled([
      cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço'),
      refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q'),
    ])
    expect(c.status).toBe('rejected'); expect((c as PromiseRejectedResult).reason).toMatchObject({ code: 'FISCAL_AUTHORITY_UNAVAILABLE' })
    expect(r.status).toBe('fulfilled'); expect((r as PromiseFulfilledResult<any>).value).toMatchObject({ kind: 'C', invoiceEvent: 2 })
    const ks = kinds()
    expect(ks[ks.length - 1]).toBe('C'); expect(ks.filter(k => k === 'C')).toHaveLength(1)
    if (ks.includes('K')) expect(ks.indexOf('K')).toBeLessThan(ks.indexOf('C'))
    expect(invoice.cancelInvoice).toHaveBeenCalledTimes(1)
  })

  it('(c) DOIS cancelamentos no fisco simultâneos → ambos terminam sem 500, 1 C, 1 cancelInvoice, o 2º é idempotente', async () => {
    adapter.registerEvent.mockImplementation(() => delay(20, () => ({ dhEvento: '2026-09-28T10:00:00-03:00', protocol: 'EVT1', raw: {} })))
    const rs = await Promise.allSettled([
      cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço'),
      cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço'),
    ])
    for (const r of rs) {
      if (r.status === 'fulfilled') expect(r.value).toMatchObject({ invoiceEvent: 2 })
      else expect(r.reason).toBeInstanceOf(HttpError)
    }
    expect(rs.filter(r => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    expect(kinds().filter(k => k === 'C')).toHaveLength(1)
    expect(invoice.cancelInvoice).toHaveBeenCalledTimes(1)
    expect(adapter.registerEvent.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('(d) consulta que vê C × cancelamento no fisco que também aceita (voz pelas duas portas) → 1 C, 1 cancelInvoice, nenhum erro', async () => {
    adapter.registerEvent.mockImplementation(() => delay(25, () => ({ dhEvento: '2026-09-28T10:00:00-03:00', protocol: 'EVT1', raw: {} })))
    adapter.queryNfse.mockImplementation(() => delay(5, cancelledVoice))
    const [c, r] = await Promise.allSettled([
      cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço'),
      refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q'),
    ])
    expect(c.status).toBe('fulfilled'); expect(r.status).toBe('fulfilled')
    expect(kinds().filter(k => k === 'C')).toHaveLength(1); expect(invoice.cancelInvoice).toHaveBeenCalledTimes(1)
  })
})

describe('P10. PKCS#12 (correção 6) — empates e futuro', () => {
  it('DOIS certificados VÁLIDOS da mesma chave com notAfter IGUAL → escolha determinística, casa com a chave, é um dos dois', () => {
    const same = new Date(Date.now() + 400 * 86_400_000)
    const a = selfSigned(`SETES A:${CNPJ}`, same, new Date(Date.now() - 60_000), PAIR.keyPem)
    const b = selfSigned(`SETES B:${CNPJ}`, same, new Date(Date.now() - 60_000), PAIR.keyPem)
    for (const order of [[a.cert, b.cert], [b.cert, a.cert]]) {
      const { certPem, keyPem } = pkcs12ToPem(toPfx(PAIR.keyPem, order, 'senha'), 'senha')
      const chosen = forge.pki.certificateFromPem(certPem)
      expect((chosen.publicKey as forge.pki.rsa.PublicKey).n.compareTo(forge.pki.privateKeyFromPem(keyPem).n)).toBe(0)
      expect([a.certPem, b.certPem]).toContain(certPem)
      expect(certPem.match(/BEGIN CERTIFICATE/g)).toHaveLength(1)
    }
  })
  it('válido AGORA (vence em 30 dias) × renovado que só vale amanhã (vence em 2 anos) → fica o válido agora', () => {
    const now = selfSigned(`SETES AGORA:${CNPJ}`, new Date(Date.now() + 30 * 86_400_000), new Date(Date.now() - 60_000), PAIR.keyPem)
    const future = selfSigned(`SETES FUTURA:${CNPJ}`, new Date(Date.now() + 730 * 86_400_000), new Date(Date.now() + 86_400_000), PAIR.keyPem)
    for (const order of [[now.cert, future.cert], [future.cert, now.cert]]) {
      const { certPem } = pkcs12ToPem(toPfx(PAIR.keyPem, order, 'senha'), 'senha')
      expect(certPem).toBe(now.certPem)
    }
  })
})
