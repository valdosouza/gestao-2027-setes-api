/// <reference types="jest" />
// RE-GATE ADVERSARIAL — Rodada 11 (retrabalho dos MEDIUMs do gate da D-F61) — setes-api, 2026-10-10.
//
// Alvo do delta: D-F63 (200 no GET tipado que não se confere = "unknown"), D-F64 (substituição e105102 = voz C com o EFEITO
// SUSPENSO), D-F65 (401/403 numa rota de EVENTO = 502 da nota), D-F66 (NFC antes do filtro Latin-1), `cut()` do montador,
// `tipoAmbiente` do envelope do 404, 405/406/415 → 502.
//
//  * ACHADOS (`it.failing('[SEV R11-xx] …')`) — o teste afirma o que a spec promete e FALHA no código atual: é a prova do bug.
//    O corretor troca `it.failing` por `it` depois de corrigir. NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (ficam como regressão).
//
// REGRAS DO GATE: nenhum socket (transporte `transport.request` mockado), nenhum banco (pool/repositório mockados na
// fronteira — harness copiado do `adversarial-df61-gate.test.ts`), nenhum script que fale com o fisco.
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import forge from 'node-forge'
import { gzipSync, gunzipSync } from 'zlib'

const SECRETS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-adv-r11-secrets-'))
const STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-adv-r11-storage-'))
process.env.SECRETS_PATH = SECRETS_ROOT
process.env.STORAGE_PATH = STORAGE_ROOT
process.env.JWT_SECRET = 'adversarial-r11'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVR11'), recordCrash: jest.fn().mockResolvedValue(undefined),
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
import { parseEventXml } from '../shared/tax-authority/dps-builder'
import {
  transmitServiceInvoice, refreshServiceTransmission, cancelServiceInvoiceAtAuthority, refreshOpenServiceTransmissions,
  IN_FLIGHT_MINUTES,
} from '../shared/invoice-transmission'
import { resetMunicipalTermsCache } from '../shared/invoice-transmission/branches/service'
import { issuerSecretRef, ISSUER_SECRET_NAMES, storeIssuerCertificate, cnpjFromSubject, clearIssuerCertificate } from '../shared/fiscal-issuer'
import { writeSecret, deleteSecret } from '../shared/secret-store'
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import { transmitInvoiceBatch } from '../modules/billing/billing.fiscal.service'

const actualRepo = jest.requireActual('../shared/invoice-transmission/transmission.repository')

// ---------------------------------------------------------------------------
// certificado autoassinado REAL (par RSA 2048) — nunca um e-CNPJ de verdade
// ---------------------------------------------------------------------------
const CNPJ = '12345678000199'
function selfSigned(cn: string, notAfter: Date, notBefore = new Date(Date.now() - 60_000), keyPem?: string, extraAttrs: { name?: string; shortName?: string; value: string }[] = []) {
  const kp = keyPem ?? (crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) as string)
  const fk = forge.pki.privateKeyFromPem(kp)
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.setRsaPublicKey(fk.n, fk.e)
  cert.serialNumber = String(Date.now() + Math.floor(Math.random() * 1000))
  cert.validity.notBefore = notBefore
  cert.validity.notAfter = notAfter
  const attrs = [{ name: 'commonName', value: cn }, ...extraAttrs, { name: 'countryName', value: 'BR' }]
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
const INVOICE = 6300
const KEY = '4106902212345678000199000000000012320260921000012345'.slice(0, 50)
const OTHER_KEY = KEY.slice(0, 40) + '9999999999'
const DPS_ID = 'DPS410690221234567800019900001000000000000042'
const OTHER_DPS_ID = DPS_ID.slice(0, -1) + '3'
const nfseXmlFor = (key = KEY, dpsId = DPS_ID, infDpsAttrs = `Id="${dpsId}"`) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${key}"><nNFSe>123</nNFSe><dhProc>2026-09-21T10:15:30-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS ${infDpsAttrs}></infDPS></DPS></infNFSe></NFSe>`
const NFSE_XML = nfseXmlFor()
const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')

/**
 * Evento GERADO pelo fisco na forma do XSD 1.01 (`TCInfEvento`: Id EVT + verAplic, ambGer,
 * nSeqEvento, dhProc, nDFSe, pedRegEvento{infPedReg{…chNFSe, eNNNNNN}}). Repare: o `chNFSe` do
 * XSD vive SÓ dentro do pedido embutido — não há chNFSe no nível do infEvento. `outerKey` põe um
 * chNFSe extra no infEvento (forma do molde r2) para os ataques de "duas chaves".
 */
function generatedEventXml(o: { key?: string; code?: string; withId?: boolean; withDhProc?: boolean; withDhEvento?: boolean; outerKey?: string | null; prefixBlock?: string } = {}): string {
  const key = o.key ?? KEY, code = o.code ?? '101101'
  const id = o.withId === false ? '' : ` Id="EVT${key}${code}000000001"`
  const dhProc = o.withDhProc === false ? '' : '<dhProc>2026-09-28T10:00:00-03:00</dhProc>'
  const dhEvento = o.withDhEvento === false ? '' : '<dhEvento>2026-09-28T09:59:00-03:00</dhEvento>'
  const outer = o.outerKey ? `<chNFSe>${o.outerKey}</chNFSe>` : ''
  return `<evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infEvento${id}>${o.prefixBlock ?? ''}<verAplic>SEFIN</verAplic><ambGer>2</ambGer>${outer}<nSeqEvento>1</nSeqEvento>${dhProc}<nDFSe>1</nDFSe>` +
    `<pedRegEvento versao="1.01"><infPedReg Id="PRE${key}${code}"><tpAmb>2</tpAmb><verAplic>SETES-1.0</verAplic>${dhEvento}<CNPJAutor>${CNPJ}</CNPJAutor><chNFSe>${key}</chNFSe>` +
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
  issValue: 24.69, issWithheld: 'N', liability: '1', dpsNumber: 42, description: 'Licença mensal ERP', totalValue: 1234.5, ...over,
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
  institutionId: 1, invoiceId: INVOICE, attempt: 1, environment: 'H', dpsId: DPS_ID, accessKey: KEY, nfseNumber: '123', invoiceEvent: 1,
  dhProc: '2026-09-21 10:15:30', createdAt: '2026-09-21 10:15:00', ageMinutes: 0, lastQueriedAt: null,
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastDh: '2026-09-21 10:15:30', lastEventAt: null, lastEventAgeMinutes: 0, ...over,
})
const inFlightNow = (over: any = {}) => tx({ lastKind: null, lastEvent: null, accessKey: null, nfseNumber: null, dhProc: null, createdAt: fmtLocal(new Date()), ageMinutes: 0, ...over })
let currentTx: any = null
const setTx = (row: any) => { currentTx = row; (repo.latestTransmission as jest.Mock).mockResolvedValue(row) }
const unavailable = () => new AuthorityHttpError(503, 'Fisco indisponível', ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE, 0, '')
const localCertInvalid = () => new AuthorityHttpError(409, 'par inválido', ErrorCodes.FISCAL_CERT_INVALID, 0, 'ERR_OSSL_X509_KEY_VALUES_MISMATCH', [{ field: 'certificate', message: 'Par PEM inválido' }])
const dpsRejected = (code = 'E0000') => new AuthorityHttpError(422, `Fisco rejeitou (400): ${code}: DPS já processado`, ErrorCodes.FISCAL_DPS_REJECTED, 400, '{"erros":[]}', [{ field: 'dps', message: `${code}: DPS já processado` }])
const osslMismatch = () => Object.assign(new Error('key values mismatch'), { code: 'ERR_OSSL_X509_KEY_VALUES_MISMATCH' })
const planOk = (blocks: any[] = []) => ({
  orderId: INVOICE, invoice: { id: INVOICE, lastKind: 'E', lastEvent: 1 }, blocks, bankSlipsToCancel: [], releasedTitles: [],
  serviceOrder: null, checksToReverse: [], commissionEntries: [], touchesCash: false,
})
const cancelled = { orderId: INVOICE, invoiceNumber: '17', event: 2, checksReversed: [], bankSlipsCancelled: [], releasedTitles: [], commissionsCompensated: 0 }
const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: obj == null ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj) })
const notFound = () => ({ status: 404, headers: {}, text: '' })
const ADMIN = { institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes' }
const delay = <T,>(ms: number, v: () => T) => new Promise<T>((res, rej) => setTimeout(() => { try { res(v()) } catch (e) { rej(e) } }, ms))

// loja de eventos em memória
type Ev = { attempt: number; event: number; kind: string; dh: string | null; source: string; message: string | null; authorityCode: string | null; invoiceEvent: number | null }
let events: Ev[] = []
const evMatch = (attempt: number, kind: string, dh: string | null) => events.filter(e => e.attempt === attempt && e.kind === kind && (e.dh ?? null) === (dh ?? null))
const kinds = () => events.map(e => e.kind)
const kindsOf = (attempt: number) => events.filter(e => e.attempt === attempt).map(e => e.kind)

let headerRows: Map<number, any>
let ibgeByCity: Map<number, string | null>
function poolDefaults() {
  q.mockImplementation(async (sql: string, params: any[]) => {
    if (/FROM `setes_setes`\.tb_invoice i/.test(sql)) { const r = Number(params?.[1]) === S.inst ? headerRows.get(Number(params?.[0])) : null; return [r ? [r] : []] }
    if (/setes_central\.tb_city/.test(sql)) { const ib = ibgeByCity.has(Number(params?.[0])) ? ibgeByCity.get(Number(params?.[0])) : '4106902'; return [ib ? [{ ibge: ib }] : []] }
    if (/setes_central\.tb_interface WHERE i18n_key/.test(sql)) return [[{ id: 30 }]]
    if (/tb_user_has_privilege/.test(sql)) return [[{ 1: 1 }]]
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
 * LOJA MULTI-TENTATIVA: implementa em memória a MESMA regra dos leitores reais —
 *  latestTransmission  = quem detém a chave (maior attempt com chave), senão a última (D-N26);
 *  findTransmissionByDpsId = a mais antiga com esse Id SEM chave (MEDIUM-1);
 *  insertTransmission = attempt MAX+1 sem voz; fillAuthorityData = COALESCE (write-once);
 *  touchQueriedAt = last_queried_at; lastKind/lastEvent derivam da loja de eventos.
 */
type StoreRow = { attempt: number; dpsId: string | null; accessKey: string | null; nfseNumber: string | null; dhProc: string | null; ageMinutes: number; lastQueriedAt: string | null; lastEventAgeMinutes: number }
let store: Map<number, StoreRow>
function derive(r: StoreRow): any {
  const evs = events.filter(e => e.attempt === r.attempt).sort((a, b) => b.event - a.event)
  return tx({
    attempt: r.attempt, dpsId: r.dpsId, accessKey: r.accessKey, nfseNumber: r.nfseNumber, dhProc: r.dhProc, ageMinutes: r.ageMinutes,
    createdAt: fmtLocal(new Date(Date.now() - r.ageMinutes * 60_000)), lastQueriedAt: r.lastQueriedAt, lastEventAgeMinutes: r.lastEventAgeMinutes,
    lastKind: evs[0]?.kind ?? null, lastEvent: evs[0]?.event ?? null, lastDh: evs[0]?.dh ?? null,
  })
}
function multiAttemptStore(rows: Partial<StoreRow>[], initialEvents: Partial<Ev>[] = []) {
  store = new Map()
  for (const r of rows) store.set(r.attempt!, { attempt: r.attempt!, dpsId: r.dpsId ?? DPS_ID, accessKey: r.accessKey ?? null, nfseNumber: r.nfseNumber ?? null, dhProc: r.dhProc ?? null, ageMinutes: r.ageMinutes ?? 0, lastQueriedAt: r.lastQueriedAt ?? null, lastEventAgeMinutes: r.lastEventAgeMinutes ?? 0 })
  for (const e of initialEvents) events.push({ attempt: e.attempt!, event: e.event ?? events.filter(x => x.attempt === e.attempt).length + 1, kind: e.kind!, dh: e.dh ?? null, source: e.source ?? 'P', message: e.message ?? null, authorityCode: e.authorityCode ?? null, invoiceEvent: e.invoiceEvent ?? null })
  const all = () => [...store.values()].sort((a, b) => a.attempt - b.attempt).map(derive)
  const latest = () => { const rows = all(); const keyed = [...rows].reverse().find(t => !!t.accessKey); return keyed ?? rows[rows.length - 1] ?? null }
  ;(repo.latestTransmission as jest.Mock).mockImplementation(async () => latest())
  ;(repo.getTransmission as jest.Mock).mockImplementation(async (_q: any, _s: any, _i: any, _inv: any, attempt: number) => store.has(attempt) ? derive(store.get(attempt)!) : null)
  ;(repo.findTransmissionByDpsId as jest.Mock).mockImplementation(async (_q: any, _s: any, _i: any, _inv: any, dpsId: string) => {
    const rows = all().filter(t => t.dpsId === dpsId).sort((a, b) => Number(!!b.accessKey) - Number(!!a.accessKey) || a.attempt - b.attempt); return rows[0] ?? null   // regra do repositório após R3-1: quem JÁ detém a chave, senão a mais antiga
  })
  ;(repo.insertTransmission as jest.Mock).mockImplementation(async () => {
    const attempt = Math.max(0, ...store.keys()) + 1
    store.set(attempt, { attempt, dpsId: null, accessKey: null, nfseNumber: null, dhProc: null, ageMinutes: 0, lastQueriedAt: null, lastEventAgeMinutes: 0 }); return attempt
  })
  ;(repo.setDpsId as jest.Mock).mockImplementation(async (_c: any, _s: any, _i: any, _inv: any, attempt: number, dpsId: string) => { const r = store.get(attempt); if (r && !r.dpsId) r.dpsId = dpsId })
  ;(repo.fillAuthorityData as jest.Mock).mockImplementation(async (_c: any, _s: any, _i: any, _inv: any, attempt: number, d: any) => {
    const r = store.get(attempt); if (!r) return
    r.accessKey ??= d.accessKey ?? null; r.nfseNumber ??= d.nfseNumber ?? null; r.dhProc ??= d.dhProc ?? null
  })
  ;(repo.touchQueriedAt as jest.Mock).mockImplementation(async (_q: any, _s: any, _i: any, _inv: any, attempt: number) => { const r = store.get(attempt); if (r) r.lastQueriedAt = fmtLocal(new Date()) })
  return { latest, row: (attempt: number) => derive(store.get(attempt)!), all }
}

/** Transações SERIALIZADAS (uma de cada vez, FIFO) — o lock de linha do InnoDB no molde do harness. */
function serializeTransactions() {
  let chain = Promise.resolve(); const releases: (() => void)[] = []
  const acquire = () => { let rel!: () => void; const p = new Promise<void>(r => (rel = r)); const prev = chain; chain = chain.then(() => p); return prev.then(() => rel) }
  conn.beginTransaction.mockImplementation(async () => { releases.push(await acquire()) })
  conn.commit.mockImplementation(async () => { releases.shift()?.() })
  conn.rollback.mockImplementation(async () => { releases.shift()?.() })
}

beforeEach(() => {
  jest.clearAllMocks()
  conn.beginTransaction.mockReset(); conn.commit.mockReset(); conn.rollback.mockReset()
  resetMunicipalTermsCache()
  resetPrivilegeCache()
  events = []
  headerRows = new Map([[INVOICE, header()]])
  ibgeByCity = new Map()
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
  mockHttp.mockReset()
})
afterAll(() => {
  transport.request = realTransport
  fs.rmSync(SECRETS_ROOT, { recursive: true, force: true })
  fs.rmSync(STORAGE_ROOT, { recursive: true, force: true })
  delete process.env.SECRETS_PATH; delete process.env.STORAGE_PATH
})

const authorized = () => ({ accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21T10:15:30-03:00', nfseXml: NFSE_XML, raw: {} })
const authorizedVoice = () => ({ accessKey: KEY, status: 'authorized' as const, nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })
const withAuthorizedTx = () => setTx(tx({ lastKind: 'A' }))
/**
 * D-F61 (Valdo 2026-10-10): a Sefin REAL só atende `GET /nfse/{chave}/eventos/{tipo}/{nSeq}` (o `GET …/eventos` dá 405 —
 * cravado ao vivo em H). O roteador traduz a lista "antiga" de cada teste (`[{ eventoXmlGZipB64 }]`) para a forma real, filtrada
 * pelo TIPO pedido: 200 `{ …envelope, eventos: [{ arquivoXml: base64 do gzip+b64 }] }`; sem evento desse tipo = 404 com o
 * envelope JSON da Sefin. Resposta que não é lista (ilegível) passa como veio.
 */
function sefinTypedEvents(legacy: any, code: string) {
  const env = { dataHoraProcessamento: '2026-10-10T18:45:27-03:00', tipoAmbiente: 2, versaoAplicativo: 'SefinNacional_1.6.0' }
  const none = { status: 404, headers: {}, text: JSON.stringify(env) }
  if (!legacy) return none
  let list: any[]
  try { const j = JSON.parse(legacy.text); list = Array.isArray(j) ? j : Array.isArray(j?.eventos) ? j.eventos : [j] } catch { return legacy }
  const mine = list.map(it => it?.eventoXmlGZipB64).filter((b: unknown): b is string => typeof b === 'string')
    .filter(b => { try { return parseEventXml(gunzipSync(Buffer.from(b, 'base64')).toString('utf8')).eventCode === code } catch { return false } })
  return mine.length
    ? ok({ ...env, eventos: mine.map(b => ({ tipoEvento: Number(code), numeroPedidoRegistroEvento: 1, arquivoXml: Buffer.from(b, 'utf8').toString('base64') })) })
    : none
}
/** Roteador HTTP do ADN real: convênio sempre OK; o resto por rota. */
function adnRoutes(routes: { dps?: (c: HttpsCall) => any; nfse?: (c: HttpsCall) => any; eventosGet?: (c: HttpsCall) => any; eventosPost?: (c: HttpsCall) => any }) {
  mockHttp.mockImplementation(async (call: HttpsCall) => {
    if (/convenio/.test(call.url)) return ok({ prazoCancelamentoDias: 365 })
    if (/\/dps\//.test(call.url)) return routes.dps?.(call) ?? notFound()
    if (/\/eventos$/.test(call.url)) return call.method === 'POST' ? (routes.eventosPost?.(call) ?? ok(null)) : (routes.eventosGet?.(call) ?? notFound())
    const typed = call.url.match(/\/eventos\/(\d+)\/(\d+)$/)
    if (typed && call.method === 'GET') return sefinTypedEvents(routes.eventosGet?.(call), typed[1])
    if (/\/nfse\/\d+$/.test(call.url)) return routes.nfse?.(call) ?? notFound()
    if (/\/nfse$/.test(call.url)) return routes.nfse?.(call) ?? ok(null)
    return notFound()
  })
}
/** SQL que o repositório REAL emite para uma leitura (captura sem banco). */
async function sqlOf(fn: (qq: any) => Promise<unknown>): Promise<string> {
  let captured = ''
  const qq = { query: jest.fn(async (sql: string) => { captured = sql; return [[]] }) }
  await fn(qq)
  return captured.replace(/\s+/g, ' ')
}
async function settle<T>(p: Promise<T>): Promise<any> { try { return await p } catch (e) { return e } }

// ===========================================================================
// Ferramentas do ataque: a Sefin REAL (D-F61, §21 do prompt das APIs fiscais)
// ===========================================================================
import { buildDpsXml, buildCancelEventXml, toTsString, buildDpsId, unescapeXml } from '../shared/tax-authority/dps-builder'
import type { DpsInput } from '../shared/tax-authority/types'
import { normalizeCancelMotive } from '../shared/invoice-transmission'

const SEFIN = { dataHoraProcessamento: '2026-10-10T18:45:27.438738-03:00', tipoAmbiente: 2, versaoAplicativo: 'SefinNacional_1.6.0' }
/** "Não há esse evento" na forma cravada ao vivo: 404 com o envelope JSON da Sefin, sem `eventos` e sem `erro`. */
const sefinNone = () => ({ status: 404, headers: {}, text: JSON.stringify(SEFIN) })
const b64 = (s: string | Buffer) => (typeof s === 'string' ? Buffer.from(s, 'utf8') : s).toString('base64')
const gzBuf = (x: string | Buffer) => gzipSync(typeof x === 'string' ? Buffer.from(x, 'utf8') : x)
/** Forma REAL do `arquivoXml`: base64 do TEXTO gzip+base64 (duas camadas). */
const arquivo2 = (x: string | Buffer) => b64(gzBuf(x).toString('base64'))
const typedItem = (file: string, code = '101101', key = KEY) =>
  ({ chaveAcesso: key, tipoEvento: Number(code), numeroPedidoRegistroEvento: 1, dataHoraRecebimento: '2026-10-10T18:43:04.82', arquivoXml: file })
const typedOk = (...items: any[]) => ok({ ...SEFIN, eventos: items })
const wrap76 = (s: string) => s.replace(/(.{76})/g, '$1\r\n')
/** Roteador da Sefin real: `GET /nfse/{chave}/eventos/{tipo}/{nSeq}` tipado; `GET …/eventos` = 405 (Allow: POST). */
function sefin(o: { nfse?: () => any; typed?: (code: string, call: HttpsCall) => any; post?: (c: HttpsCall) => any; dps?: () => any } = {}) {
  mockHttp.mockImplementation(async (call: HttpsCall) => {
    if (/convenio/.test(call.url)) return ok({ prazoCancelamentoDias: 365 })
    const typed = call.url.match(/\/nfse\/\d+\/eventos\/(\d+)\/(\d+)$/)
    if (typed && call.method === 'GET') return (await o.typed?.(typed[1], call)) ?? sefinNone()
    if (/\/eventos$/.test(call.url)) return call.method === 'POST' ? (o.post?.(call) ?? ok(null)) : { status: 405, headers: { allow: 'POST' }, text: '' }
    if (/\/dps\//.test(call.url)) return o.dps?.() ?? notFound()
    if (/\/nfse\/\d+$/.test(call.url)) return o.nfse?.() ?? ok({ nfseXmlGZipB64: gz(NFSE_XML) })
    if (/\/nfse$/.test(call.url) && call.method === 'POST') return o.post?.(call) ?? ok(null)
    return notFound()
  })
}
const ctxH = { environment: 'H' as const, cert: Buffer.from(PAIR.certPem), key: Buffer.from(PAIR.keyPem) }
/** TSString do XSD (tiposSimples_v1.01 linha 19): só U+0020–U+00FF, sem espaço nas pontas. */
const TS_STRING = /^(?:[!-ÿ][ -ÿ]*[!-ÿ]|[!-ÿ])$/
const textOf = (xml: string, el: string): string | null => { const m = xml.match(new RegExp(`<${el}>([\\s\\S]*?)</${el}>`)); return m ? unescapeXml(m[1]) : null }
const prestOf = (xml: string) => xml.match(/<prest>[\s\S]*?<\/prest>/)?.[0] ?? ''
const tomaOf = (xml: string) => xml.match(/<toma>[\s\S]*?<\/toma>/)?.[0] ?? ''

/** DPS base para os ataques ao montador (puro — sem banco). */
const DPS_BASE: DpsInput = {
  environment: 'H', dhEmi: '2026-10-10T10:15:30-03:00', verAplic: 'setes-api 1.0', serie: 1, nDps: 42, dCompet: '2026-10-10',
  tpEmit: '1', cLocEmi: '4106902',
  prest: { cnpj: CNPJ, im: '777', regTrib: { opSimpNac: '3', regApTribSN: '1', regEspTrib: '0' } },
  toma: { cnpj: '98765432000188', xNome: 'Cliente Ltda', end: { cMun: '4106902', cep: '80010000', xLgr: 'Rua A', nro: '10', xCpl: 'Sala 2', xBairro: 'Centro' } },
  serv: { locPrest: { cLocPrestacao: '4106902' }, cServ: { cTribNac: '010201', xDescServ: 'Licença mensal ERP' } },
  valores: { vServ: 100, trib: { tribMun: { tribISSQN: '1', tpRetISSQN: '1' }, totTrib: { pTotTribSN: 6 } } },
}
const DPS_XML_ID = buildDpsId('4106902', '2', CNPJ, 1, 42)
const dpsWith = (f: (d: DpsInput) => void): DpsInput => { const d = JSON.parse(JSON.stringify(DPS_BASE)); f(d); return d }


// ===========================================================================
// Ferramentas da Rodada 11
// ===========================================================================
import logger from '../shared/logger/logger'
import { SUBSTITUTION_EFFECT_SUSPENDED } from '../shared/invoice-transmission'

const ctxP = { environment: 'P' as const, cert: Buffer.from(PAIR.certPem), key: Buffer.from(PAIR.keyPem) }
/** Evento GERADO de substituição (e105102) desta chave, na forma real do `arquivoXml` (2 camadas). */
const substItem = () => typedItem(arquivo2(generatedEventXml({ code: '105102' })), '105102')
/** A Sefin: 101101 não existe (404 do envelope), 105102 existe (200 tipado). */
const sefinSubstituted = () => sefin({ typed: code => (code === '105102' ? typedOk(substItem()) : undefined) })
/** Voz C de substituição JÁ gravada com o efeito SUSPENSO (estado depois da 1ª leitura — D-F64; código na voz desde a
 *  migration 067 — D-F71, que fez o backfill das vozes antigas pela marca do texto). */
function seedSuspendedVoice() {
  events.push({ attempt: 1, event: 1, kind: 'A', dh: '2026-09-21 10:15:30', source: 'P', message: 'NFS-e 123', authorityCode: null, invoiceEvent: null })
  events.push({ attempt: 1, event: 2, kind: 'C', dh: '2026-09-28 10:00:00', source: 'Q', message: SUBSTITUTION_EFFECT_SUSPENDED, authorityCode: '105102', invoiceEvent: null })
  setTx(tx({ lastKind: 'C', lastEvent: 2, lastCode: '105102' }))
}
const fiscoCalls = () => mockHttp.mock.calls.filter((c: any[]) => !/convenio/.test(c[0].url)).length

// ===========================================================================
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO R11-01 (LOW) — D-F64 × rodízio: a voz de substituição com efeito SUSPENSO fica no rodízio de 15 min ("C com efeito pendente — retenta o efeito", D-N21) PARA SEMPRE; nada pode mudar por consulta (o efeito só nasce de ato humano) e cada passada gasta 3 idas ao fisco por nota', () => {
  it('contexto: a regra do rodízio (SQL real) põe toda C com invoice_event NULL na fila de 15 min — sem distinguir a suspensão', async () => {
    let captured = ''
    q.mockImplementationOnce(async (sql: string) => { captured = sql; return [[]] })
    await actualRepo.listLiveTransmissionsToRefresh(S.schema, S.inst, 5, 8)
    expect(captured.replace(/\s+/g, ' ')).toMatch(/le\.kind = 'C' AND le\.invoice_event IS NULL/)
  })
  it('[CORRIGIDO — D-F67] [LOW R11-01] passada com a voz de substituição já suspensa como candidata → não volta ao fisco por ela (nada a retentar sem humano)', async () => {
    useRealAdn(); seedSuspendedVoice()
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([{ invoiceId: INVOICE, attempt: 1 }])
    sefinSubstituted()
    const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(r.errors).toEqual([])
    expect(fiscoCalls()).toBe(0)                                     // hoje: GET /nfse + /eventos/101101/1 + /eventos/105102/1
    expect(events.find(e => e.kind === 'C')!.invoiceEvent).toBeNull()  // e a pendência segue (só o humano a resolve)
  })
})

describe('ACHADO R11-02 (LOW) — D-F64: a voz C "por SUBSTITUIÇÃO (e105102): <motivo do fisco>" é SOBRESCRITA na mesma transação pela nota da suspensão (`message = COALESCE(?, message)`): o motivo do fisco some da trilha; depois do ato humano a nota do efeito sobrescreve de novo e a palavra "substituição" também some', () => {
  it('[CORRIGIDO] [LOW R11-02] depois da 1ª leitura, a voz C ainda carrega o motivo do evento do fisco ("cliente desistiu do serviço")', async () => {
    useRealAdn(); withAuthorizedTx()
    sefinSubstituted()
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ kind: 'C', invoiceEvent: null, effectRefused: SUBSTITUTION_EFFECT_SUSPENDED })
    const c = events.find(e => e.kind === 'C')!
    expect(c.message).toContain('SUBSTITU')
    expect(c.message).toContain('cliente desistiu do serviço')          // hoje: só o texto da suspensão
  })
})

describe('ACHADO R11-03 (LOW) — D-F64 não é PEGAJOSA nem confere o TIPO perguntado: a suspensão é recalculada a cada consulta pelo código do XML LIDO — resposta contraditória (o GET do 105102 trazendo e101101, ou a re-consulta de 15 min trazendo e101101 depois de ter lido e105102) aplica o efeito AUTOMÁTICO numa nota já lida como substituída (D-F63: "outro tipo" = ambíguo)', () => {
  it('[CORRIGIDO — D-F69] [LOW R11-03a] adaptador: /eventos/101101/1 = 404 e /eventos/105102/1 = 200 com um e101101 desta chave → nunca "cancelled" sem a marca 105102 (unknown/502 ou eventCode 105102)', async () => {
    sefin({ typed: code => (code === '105102' ? typedOk(typedItem(arquivo2(generatedEventXml({ code: '101101' })), '105102')) : undefined) })
    const out = await settle(adnAdapter.queryNfse(ctxH, KEY))
    const downgraded = out?.status === 'cancelled' && out?.cancelled?.eventCode !== '105102'
    expect(downgraded).toBe(false)                                     // hoje: cancelled com eventCode 101101
  })
  it('[CORRIGIDO] [LOW R11-03b] composição: voz de substituição já SUSPENSA + a re-consulta do rodízio lê e101101 desta chave → o efeito local NÃO nasce sozinho', async () => {
    useRealAdn(); seedSuspendedVoice()
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml({ code: '101101' })))) : undefined) })
    await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', { attempt: 1 }))
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()               // hoje: cancelInvoice chamado (efeito automático)
  })
})

describe('ACHADO R11-04 (LOW) — D-F66: o NFC compõe letra + marca combinante num caractere FORA do Latin-1 e o filtro apaga a LETRA inteira (antes perdia só o diacrítico): "S+caron" → "Š" → "" — o nome sai mutilado (e um campo obrigatório pode esvaziar — DF61-03)', () => {
  it('[CORRIGIDO] [LOW R11-04] "Ševčík" digitado DECOMPOSTO (NFD) mantém as letras base no TSString ("Sevcík": cai o diacrítico fora do Latin-1)', () => {
    const nfd = 'Ševčík'
    expect(toTsString(nfd)).toBe('Sevcík')   // Š→S e č→c (letra-base); o í é Latin-1 e FICA (era "evk" + "í")
  })
})

describe('ACHADO R11-05 (LOW) — D-F63 sem alarme: o 200 tipado que NÃO se confere (ilegível com gzip válido, outra chave, eco, outro tipo) vira "unknown" SEM `logger.error` — o 404 fora do envelope e o 405/406/415 têm o "contrato do fisco divergente" em ERRO (M5); uma mudança de forma do `arquivoXml` emudece toda consulta e prende todo K sem alarme', () => {
  it('[CORRIGIDO] [LOW R11-05] /eventos/101101/1 → 200 com arquivo ilegível → logger.error ("contrato divergente") registrado', async () => {
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2('<html><body>erro</body></html>'))) : undefined) })
    const out = await settle(adnAdapter.queryNfse(ctxH, KEY))
    expect(out?.status === 'unknown' || out?.statusCode === 502).toBe(true)
    expect(logger.error).toHaveBeenCalled()
  })
})

// ===========================================================================
// RESISTIU — ataques que NÃO reproduziram bug (regressão)
// ===========================================================================

describe('RESISTIU — D-F63 "unknown" × rodízio: nada gravado, a nota sai do topo pelo last_queried_at (A volta em 24 h, K em 5 min), K nunca vira N', () => {
  for (const [label, row] of [['autorizada (A)', () => tx({ lastKind: 'A' })], ['K de 10 min', () => tx({ lastKind: 'K', lastEvent: 2, lastEventAgeMinutes: IN_FLIGHT_MINUTES })]] as const) {
    it(`resistiu: ${label} + 200 tipado com evento de OUTRA chave → erro persistente no relatório, nenhuma voz, touch FORA da transação desfeita`, async () => {
      useRealAdn(); setTx(row())
      ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([{ invoiceId: INVOICE, attempt: 1 }])
      sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml({ key: OTHER_KEY })))) : undefined) })
      const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
      expect(r).toMatchObject({ checked: 1, stoppedEarly: false })
      expect(r.errors[0]).toMatchObject({ invoiceId: INVOICE, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
      expect(kinds()).toEqual([])
      expect(conn.rollback).toHaveBeenCalled()                                          // o touch de dentro foi desfeito…
      expect((repo.touchQueriedAt as jest.Mock).mock.calls.some((c: any[]) => c[0] === pool)).toBe(true)  // …e o de fora vale
      expect(invoice.cancelInvoice).not.toHaveBeenCalled()
    })
  }
})

describe('RESISTIU — D-F65: 401/403 HTTP numa rota de EVENTO não para a passada; credencial recusada no TLS (authorityStatus 0) e GET /nfse 401/403 continuam parando', () => {
  it('resistiu: 403 HTTP em /eventos/101101/1 → 502 da NOTA; a passada segue para a 2ª nota e marca as duas', async () => {
    useRealAdn(); setTx(tx({ lastKind: 'A' }))
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([{ invoiceId: INVOICE, attempt: 1 }, { invoiceId: INVOICE, attempt: 1 }])
    sefin({ typed: () => ({ status: 403, headers: {}, text: '<html>403 Forbidden</html>' }) })
    const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(r).toMatchObject({ checked: 2, stoppedEarly: false })
    expect(r.errors.map(e => e.code)).toEqual([ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE])
    expect((repo.touchQueriedAt as jest.Mock).mock.calls.filter((c: any[]) => c[0] === pool)).toHaveLength(2)
  })
  it('resistiu: TLS recusado ANTES do handshake na rota de evento → 409 AUTH_FAILED (credencial, para a passada sem marcar); depois do handshake → 503 (para, sem marcar)', async () => {
    useRealAdn(); setTx(tx({ lastKind: 'A' }))
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([{ invoiceId: INVOICE, attempt: 1 }, { invoiceId: INVOICE, attempt: 1 }])
    for (const [after, code] of [[false, ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED], [true, ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE]] as const) {
      mockHttp.mockReset(); (repo.touchQueriedAt as jest.Mock).mockClear()
      sefin({ typed: () => { throw Object.assign(new Error('tlsv1 alert unknown ca'), { code: 'EPROTO', afterHandshake: after }) } })
      const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
      expect([after, r.checked, r.stoppedEarly, r.errors[0]?.code]).toEqual([after, 1, true, code])
      expect(repo.touchQueriedAt).not.toHaveBeenCalled()
    }
  })
  it('resistiu: 403 HTTP no GET /nfse/{chave} (antes de qualquer evento) segue sendo do EMISSOR → para a passada', async () => {
    useRealAdn(); setTx(tx({ lastKind: 'A' }))
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([{ invoiceId: INVOICE, attempt: 1 }, { invoiceId: INVOICE, attempt: 1 }])
    sefin({ nfse: () => ({ status: 403, headers: {}, text: '' }) })
    const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(r).toMatchObject({ checked: 1, stoppedEarly: true }); expect(r.errors[0].code).toBe(ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED)
  })
})

describe('RESISTIU — tipoAmbiente do envelope do 404: número ou texto, só o ambiente PERGUNTADO', () => {
  const none = (tipoAmbiente: unknown) => ({ status: 404, headers: {}, text: JSON.stringify({ ...SEFIN, tipoAmbiente }) })
  it('resistiu: H aceita 2 e "2"; P aceita 1 e "1"; o envelope do OUTRO ambiente, null, "", "H" → 502', async () => {
    const cases: [string, any, unknown, boolean][] = [
      ['H/2', ctxH, 2, true], ['H/"2"', ctxH, '2', true], ['P/1', ctxP, 1, true], ['P/"1"', ctxP, '1', true],
      ['H/1', ctxH, 1, false], ['P/2', ctxP, 2, false], ['P/null', ctxP, null, false], ['H/""', ctxH, '', false], ['H/"H"', ctxH, 'H', false],
    ]
    for (const [label, ctx, t, accepted] of cases) {
      mockHttp.mockReset()
      sefin({ typed: () => none(t) })
      const out = await settle(adnAdapter.queryNfse(ctx, KEY))
      expect([label, accepted ? out?.status : out?.statusCode]).toEqual([label, accepted ? 'authorized' : 502])
    }
  })
})

describe('RESISTIU — D-F64: reaplicação humana e K NOSSO', () => {
  it('resistiu: K nosso (101101 em voo) + a consulta lê e105102 desta chave → voz C suspensa, nenhum N, nenhum cancelamento local automático', async () => {
    useRealAdn(); setTx(tx({ lastKind: 'K', lastEvent: 2, lastEventAgeMinutes: IN_FLIGHT_MINUTES }))
    sefinSubstituted()
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ kind: 'C', invoiceEvent: null, effectRefused: SUBSTITUTION_EFFECT_SUSPENDED })
    expect(kinds()).toEqual(['C']); expect(invoice.cancelInvoice).not.toHaveBeenCalled()
  })
  it('resistiu: ato humano pela rota fiscal com a voz suspensa → plano local, cancelInvoice com o motivo do HUMANO e a voz LIGADA ao C local (pendência some)', async () => {
    seedSuspendedVoice()
    ;(invoice.buildCancelPlan as jest.Mock).mockResolvedValue(planOk([]))
    const out = await cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'substituta conferida pelo financeiro')
    expect(out).toMatchObject({ atAuthority: false, invoiceEvent: cancelled.event, transmissionEvent: 2 })
    expect((invoice.cancelInvoice as jest.Mock).mock.calls[0][4]).toMatchObject({ reason: 'substituta conferida pelo financeiro' })
    expect(events.find(e => e.kind === 'C')!.invoiceEvent).toBe(cancelled.event)
    expect(mockHttp).not.toHaveBeenCalled()
  })
  it('resistiu: a 2ª consulta de uma voz suspensa NÃO aplica o efeito (mesmo e105102) nem duplica a voz', async () => {
    useRealAdn(); seedSuspendedVoice()
    sefinSubstituted()
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', { attempt: 1 })
    expect(r).toMatchObject({ kind: 'C', invoiceEvent: null, changed: false })
    expect(kinds()).toEqual(['A', 'C']); expect(invoice.cancelInvoice).not.toHaveBeenCalled()
  })
})

describe('RESISTIU — `cut()` nunca esvazia nem deixa espaço na ponta; NFC no caminho feliz', () => {
  it('resistiu: xDescServ "a" + 2500 espaços + "b" → "a"; verAplic "x" + 30 espaços → "x"; docRef 254 + " " + "z" → 254 sem espaço', () => {
    const xml = buildDpsXml(dpsWith(d => {
      d.serv.cServ.xDescServ = 'a' + ' '.repeat(2500) + 'b'; d.verAplic = 'x' + ' '.repeat(30) + 'y'
      d.serv.infoCompl = { docRef: 'd'.repeat(254) + ' z' }
    }), DPS_XML_ID)
    expect(textOf(xml, 'xDescServ')).toBe('a'); expect(textOf(xml, 'verAplic')).toBe('x'); expect(textOf(xml, 'docRef')).toBe('d'.repeat(254))
    for (const el of ['xDescServ', 'verAplic', 'docRef']) expect([el, TS_STRING.test(textOf(xml, el)!)]).toEqual([el, true])
  })
  it('resistiu: xDescServ multilinha cortado em 2000 logo depois de uma quebra → sem quebra/espaço na ponta', () => {
    const xml = buildDpsXml(dpsWith(d => { d.serv.cServ.xDescServ = 'l'.repeat(1999) + ' \nresto da descrição' }), DPS_XML_ID)
    const v = textOf(xml, 'xDescServ')!
    expect(v).toBe('l'.repeat(1999)); expect(/\s$/.test(v)).toBe(false)
  })
  it('resistiu: NFC compõe "c+cedilha", "a+til", "A+anel" (Latin-1) e o Kelvin/Ångström viram K/Å', () => {
    expect(toTsString('Serviço, manutenção, Ångström')).toBe('Serviço, manutenção, Ångström')
    expect(toTsString('KÅ')).toBe('KÅ')
  })
})

// ===========================================================================
// RODADA 13 (Valdo 2026-10-10, "Sim, siga tudo"): D-F67 (fim da pendência da substituição), D-F71 (código do evento na
// voz C), D-F74 (dispensa só da 105102), D-F75 (o código só sobe), D-F76 (chave da substituta pelo XML). Fecha R11-01 e,
// no setes-api, o equivalente da R11-06 (a substituição nunca vira "efeito pendente" que outra porta aplica sozinha).
// ===========================================================================
import { getServiceFiscalView } from '../shared/invoice-transmission'
import { saveFiscalXml, cancelEventFileName } from '../shared/invoice-transmission/branches/service'
import { institutionZoneFor } from '../shared/time-zone'

const SUBST_KEY = '4106902212345678000199000000000099920261010000099999'.slice(0, 50)
/** Evento e105102 GERADO com a chave da SUBSTITUTA (TE105102.chSubstituta). */
const substEventXml = (substitute: string | null = SUBST_KEY) => generatedEventXml({ code: '105102' })
  .replace('</xMotivo></e105102>', `</xMotivo>${substitute ? `<chSubstituta>${substitute}</chSubstituta>` : ''}</e105102>`)

describe('RODADA 13 — D-F67/D-F71/D-F74/D-F75/D-F76', () => {
  it('D-F67: transmitir com a voz C de SUBSTITUIÇÃO vigente → 409 FISCAL_NFSE_SUBSTITUTED antes de reservar — mesmo MANTIDA (sem pendência)', async () => {
    seedSuspendedVoice()
    ;(repo.countPendingEffects as jest.Mock).mockResolvedValue(0)          // mantida pelo humano: não é mais pendência
    const out = await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))
    expect(out).toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_NFSE_SUBSTITUTED })
    expect(repo.insertTransmission).not.toHaveBeenCalled(); expect(mockHttp).not.toHaveBeenCalled()
  })
  it('D-F67: voz C 101101 com o efeito pendente → 409 FISCAL_EFFECT_PENDING (como antes); a C vigente nunca reapresenta', async () => {
    events.push({ attempt: 1, event: 1, kind: 'A', dh: '2026-09-21 10:15:30', source: 'P', message: 'NFS-e 123', authorityCode: null, invoiceEvent: null })
    events.push({ attempt: 1, event: 2, kind: 'C', dh: '2026-09-28 10:00:00', source: 'Q', message: 'Efeito recusado: título baixado', authorityCode: '101101', invoiceEvent: null })
    setTx(tx({ lastKind: 'C', lastEvent: 2, lastCode: '101101' }))
    const out = await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))
    expect(out).toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_EFFECT_PENDING })
    expect(repo.insertTransmission).not.toHaveBeenCalled()
  })
  it('D-F71: a 1ª leitura de uma SUBSTITUIÇÃO grava o código 105102 NA VOZ (fato estruturado, não só o texto)', async () => {
    useRealAdn(); withAuthorizedTx(); sefinSubstituted()
    await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(expect.anything(), S.schema, S.inst, INVOICE, 1, S.user,
      expect.objectContaining({ kind: 'C', authorityCode: '105102' }))
  })
  it('D-F71: o cancelamento que o produto PEDE (POST /eventos aceito — source P) grava 101101 na voz', async () => {
    withAuthorizedTx()
    const out = await cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço')
    expect(out).toMatchObject({ atAuthority: true })
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(expect.anything(), S.schema, S.inst, INVOICE, 1, S.user,
      expect.objectContaining({ kind: 'C', source: 'P', authorityCode: '101101' }))
  })
  it('D-F75: voz C 101101 com efeito RECUSADO + a re-consulta lê e105102 desta chave → o código SOBE para 105102 e o efeito fica suspenso', async () => {
    useRealAdn()
    events.push({ attempt: 1, event: 1, kind: 'A', dh: '2026-09-21 10:15:30', source: 'P', message: 'NFS-e 123', authorityCode: null, invoiceEvent: null })
    events.push({ attempt: 1, event: 2, kind: 'C', dh: '2026-09-28 10:00:00', source: 'Q', message: 'Efeito recusado: título baixado', authorityCode: '101101', invoiceEvent: null })
    setTx(tx({ lastKind: 'C', lastEvent: 2, lastCode: '101101' }))
    sefinSubstituted()
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', { attempt: 1 })
    expect(r).toMatchObject({ kind: 'C', invoiceEvent: null, effectRefused: SUBSTITUTION_EFFECT_SUSPENDED })
    const promote = conn.query.mock.calls.find((c: any[]) => /SET authority_code = \?/.test(String(c[0])))
    expect(promote?.[1]).toEqual(['105102', S.inst, INVOICE, 1, 2, '105102'])
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
  })
  it('D-F75: o UPDATE do código é de mão única — preenche NULL, sobe para 105102, nunca rebaixa (SQL real)', async () => {
    const qq = { query: jest.fn(async (..._a: any[]) => [{}]) }
    await actualRepo.setCancelEventCode(qq, S.schema, S.inst, INVOICE, 1, 2, '101101')
    const sql = String(qq.query.mock.calls[0][0]).replace(/\s+/g, ' ')
    expect(sql).toContain("kind = 'C' AND (authority_code IS NULL OR (? = '105102' AND authority_code <> '105102'))")
    await actualRepo.setCancelEventCode(qq, S.schema, S.inst, INVOICE, 1, 2, 'E0116')      // fora do domínio: nada
    expect(qq.query).toHaveBeenCalledTimes(1)
  })
  it('D-F74: pendência = C sem efeito, MENOS a substituição mantida (SQL real do countPendingEffects)', async () => {
    let captured = ''
    q.mockImplementationOnce(async (sql: string) => { captured = sql; return [[{ n: 0 }]] })
    await actualRepo.countPendingEffects(pool, S.schema, S.inst, INVOICE)
    const sql = captured.replace(/\s+/g, ' ')
    expect(sql).toContain("AND NOT (e.authority_code <=> '105102' AND EXISTS ( SELECT 1 FROM `setes_setes`.tb_invoice_cancel_waiver w")
    expect(sql).toContain('w.access_key = t.access_key')
  })
  describe('D-F76: a tela "No fisco" mostra a substituição, a chave da SUBSTITUTA (do XML do evento) e a decisão "manter a nota"', () => {
    const seedView = async (waived: boolean, xml: string | null) => {
      const t = tx({ lastKind: 'C', lastEvent: 2, lastCode: '105102' })
      ;(repo.listServiceTransmissions as jest.Mock).mockResolvedValue({
        transmissions: [t],
        events: [{ attempt: 1, event: 1, kind: 'A', invoiceEvent: null, authorityCode: null }, { attempt: 1, event: 2, kind: 'C', invoiceEvent: null, authorityCode: '105102' }],
      })
      fs.rmSync(path.join(STORAGE_ROOT, CNPJ), { recursive: true, force: true })
      if (xml) saveFiscalXml(CNPJ, cancelEventFileName(KEY), xml, new Date(`${t.dhProc.replace(' ', 'T')}Z`), 'H', await institutionZoneFor(S.schema, S.inst))
      // D-F79: a tela conta a pendência pelo MESMO predicado de `countPendingEffects` (aqui mockado na fronteira do repositório);
      // D-F81: a decisão vigente vem do leitor que exige a nota viva
      ;(repo.countPendingEffects as jest.Mock).mockResolvedValue(waived ? 0 : 1)
      q.mockImplementation(async (sql: string) => (/COUNT\(\*\) AS n FROM `setes_setes`\.tb_invoice_service_transmission_event e/.test(sql)
        ? [[{ n: waived ? 0 : 1 }]]
        : /tb_invoice_cancel_waiver w/.test(sql)
        ? [waived ? [{ accessKey: KEY, reason: 'substituta emitida pelo portal, serviço segue faturado', userId: 7, createdAt: '2026-10-10 21:00:00' }] : []]
        : [[]]))
    }
    afterEach(() => { fs.rmSync(path.join(STORAGE_ROOT, CNPJ), { recursive: true, force: true }); poolDefaults() })
    it('sem decisão: pendência 1, substituição com a chave da substituta, waived=false, cancelWaiver null', async () => {
      await seedView(false, substEventXml())
      const v = await getServiceFiscalView(S.schema, S.inst, INVOICE)
      expect(v).toMatchObject({ state: 'cancelled', pendingEffects: 1, substitution: { substituteAccessKey: SUBST_KEY, waived: false }, cancelWaiver: null })
    })
    it('mantida: pendência 0, waived=true e a decisão (motivo/autor) na resposta', async () => {
      await seedView(true, substEventXml())
      const v = await getServiceFiscalView(S.schema, S.inst, INVOICE)
      expect(v).toMatchObject({ pendingEffects: 0, substitution: { substituteAccessKey: SUBST_KEY, waived: true },
        cancelWaiver: { accessKey: KEY, reason: 'substituta emitida pelo portal, serviço segue faturado', userId: 7 } })
    })
    it('XML do evento ausente ou sem chSubstituta → substituteAccessKey null (só exibição — nunca regra)', async () => {
      await seedView(false, null)
      expect((await getServiceFiscalView(S.schema, S.inst, INVOICE)).substitution).toEqual({ substituteAccessKey: null, waived: false })
      await seedView(false, substEventXml(null))
      expect((await getServiceFiscalView(S.schema, S.inst, INVOICE)).substitution).toEqual({ substituteAccessKey: null, waived: false })
    })
  })
})

// ===========================================================================
// RODADA 14 (Valdo 2026-10-10, "siga as recomendações" do gate socrático da Rodada 13): D-F77 (voz P nunca promovida; efeito
// pendente da voz P sem o fisco), D-F78 (a consulta HUMANA arquiva o XML do evento que faltou), D-F79 (um predicado de
// pendência), D-F80 (homologação), D-F81 (a dispensa é história), D-F82 (de ofício espera o humano) + L6/L7.
// ===========================================================================
describe('RODADA 14 — D-F77/D-F78/D-F82 + L6/L7', () => {
  const ourCancel = (over: Partial<Ev> = {}) => {
    events.push({ attempt: 1, event: 1, kind: 'A', dh: '2026-09-21 10:15:30', source: 'P', message: 'NFS-e 123', authorityCode: null, invoiceEvent: null })
    events.push({ attempt: 1, event: 2, kind: 'C', dh: '2026-09-28 10:00:00', source: 'P', message: 'Efeito recusado: título baixado', authorityCode: '101101', invoiceEvent: null, ...over })
    setTx(tx({ lastKind: 'C', lastEvent: 2, lastCode: '101101', lastSource: 'P' }))
  }
  it('D-F77 (M1): C do NOSSO pedido (P, 101101) com efeito pendente → o rodízio retenta o efeito LOCAL sem ir ao fisco (nenhuma leitura contraditória possível)', async () => {
    useRealAdn(); ourCancel(); sefinSubstituted()
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([{ invoiceId: INVOICE, attempt: 1 }])
    const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(r.errors).toEqual([]); expect(fiscoCalls()).toBe(0)
    expect(invoice.cancelInvoice).toHaveBeenCalledTimes(1)                                  // o efeito local retentado
    expect(events.find(e => e.kind === 'C')).toMatchObject({ authorityCode: '101101', invoiceEvent: cancelled.event })
    expect(conn.query.mock.calls.some((c: any[]) => /SET authority_code = \?/.test(String(c[0])))).toBe(false)   // nunca promovida
  })
  it('D-F77: mesmo com uma leitura contraditória NAS MÃOS (query injetada dizendo e105102), a voz P não é promovida — retenta só o efeito local', async () => {
    useRealAdn(); ourCancel(); sefinSubstituted()
    const query = await adnAdapter.queryNfse(ctxH, KEY)
    expect(query.cancelled?.eventCode).toBe('105102')
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', { query })
    expect(r).toMatchObject({ kind: 'C', invoiceEvent: cancelled.event })
    expect(events.find(e => e.kind === 'C')!.authorityCode).toBe('101101')
    expect(conn.query.mock.calls.some((c: any[]) => /SET authority_code = \?/.test(String(c[0])))).toBe(false)
  })
  it('D-F77: C por CONSULTA (Q, 101101) com efeito pendente segue relendo o fisco — e a D-F75 promove para 105102 (suspende)', async () => {
    useRealAdn(); ourCancel({ source: 'Q' }); setTx(tx({ lastKind: 'C', lastEvent: 2, lastCode: '101101', lastSource: 'Q' })); sefinSubstituted()
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', { attempt: 1 })
    expect(r).toMatchObject({ kind: 'C', invoiceEvent: null, effectRefused: SUBSTITUTION_EFFECT_SUSPENDED })
    expect(fiscoCalls()).toBeGreaterThan(0)
  })
  describe('D-F78 (M2): a consulta HUMANA de uma C relê o fisco SÓ para arquivar o XML do evento que faltou; o rodízio nunca', () => {
    afterEach(() => fs.rmSync(path.join(STORAGE_ROOT, CNPJ), { recursive: true, force: true }))
    const eventFile = async () => {
      const { findFiscalXml } = jest.requireActual('../shared/invoice-transmission/branches/service')
      return findFiscalXml(CNPJ, cancelEventFileName(KEY), ['2026-09-21 10:15:30', '2026-09-21 10:15:00'], 'H', await institutionZoneFor(S.schema, S.inst))
    }
    it('substituída sem o XML do e105102 → "Consultar" arquiva (voz intacta, nada inserido); depois não volta mais ao fisco', async () => {
      useRealAdn(); seedSuspendedVoice(); sefinSubstituted()
      const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
      expect(r).toMatchObject({ changed: false, kind: 'C' }); expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
      expect(await eventFile()).toBeTruthy()
      mockHttp.mockClear()
      await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
      expect(fiscoCalls()).toBe(0)
    })
    it('o fisco devolve OUTRO código para a voz 105102 → nada arquivado (só aviso); o rodízio (fromRun) nem pergunta', async () => {
      useRealAdn(); seedSuspendedVoice()
      sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml({ code: '101101' })))) : undefined) })
      await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
      expect(await eventFile()).toBeFalsy(); expect(logger.warn).toHaveBeenCalled()
      mockHttp.mockClear()
      await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', { attempt: 1, fromRun: true })
      expect(fiscoCalls()).toBe(0)
    })
  })
  it('D-F82 (= Q-F89): voz C DE OFÍCIO (305101) já suspensa → fora do retentar; transmitir de novo = 409 FISCAL_EFFECT_PENDING', async () => {
    events.push({ attempt: 1, event: 1, kind: 'A', dh: '2026-09-21 10:15:30', source: 'P', message: 'NFS-e 123', authorityCode: null, invoiceEvent: null })
    events.push({ attempt: 1, event: 2, kind: 'C', dh: '2026-09-28 10:00:00', source: 'Q', message: 'Efeito suspenso: DE OFÍCIO', authorityCode: '305101', invoiceEvent: null })
    setTx(tx({ lastKind: 'C', lastEvent: 2, lastCode: '305101', lastSource: 'Q' }))
    useRealAdn(); sefin({})
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', { attempt: 1, fromRun: true })
    expect(r).toMatchObject({ changed: false, kind: 'C' }); expect(fiscoCalls()).toBe(0); expect(invoice.cancelInvoice).not.toHaveBeenCalled()
    expect(await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))).toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_EFFECT_PENDING })
  })
  it('D-F80: C de SUBSTITUIÇÃO em HOMOLOGAÇÃO → o 409 aponta a saída (cancelar a nota e faturar de novo), nunca "mantenha-a"', async () => {
    seedSuspendedVoice(); setTx(tx({ lastKind: 'C', lastEvent: 2, lastCode: '105102', environment: 'H' }))
    const out = await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))
    expect(out).toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_NFSE_SUBSTITUTED })
    expect(String(out.message)).toMatch(/homologação, cancele a nota/); expect(String(out.message)).not.toMatch(/mantenha-a/)
  })
  it('L6: NFS-e com o bloco <e101101> embutido → cancelled COM eventCode 101101 (nunca voz C sem código depois da D-F68)', async () => {
    const withBlock = NFSE_XML.replace('</infNFSe>', '<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>erro na emissao do servico</xMotivo></e101101></infNFSe>')
    sefin({ nfse: () => ok({ nfseXmlGZipB64: gz(withBlock) }) })
    const out = await adnAdapter.queryNfse(ctxH, KEY)
    expect(out).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101' } })
  })
  it('D-F84 (= Q-F90 — supera o L7): o GET tipado traz DOIS tipos desta chave (305101 antes do 101101 perguntado) → AMBÍGUO (unknown), log de contrato divergente', async () => {
    const both = { ...SEFIN, eventos: [typedItem(arquivo2(generatedEventXml({ code: '305101' })), '305101'), typedItem(arquivo2(generatedEventXml({ code: '101101' })))] }
    sefin({ typed: code => (code === '101101' ? ok(both) : undefined) })
    const out = await adnAdapter.queryNfse(ctxH, KEY)
    expect(out.status).toBe('unknown'); expect(logger.error).toHaveBeenCalled()
  })
  it('D-F84: dois itens do MESMO tipo desta chave (repetição) → vale (não é contradição)', async () => {
    const twice = { ...SEFIN, eventos: [typedItem(arquivo2(generatedEventXml({ code: '101101' }))), typedItem(arquivo2(generatedEventXml({ code: '101101' })))] }
    sefin({ typed: code => (code === '101101' ? ok(twice) : undefined) })
    const out = await adnAdapter.queryNfse(ctxH, KEY)
    expect(out).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101' } })
  })
})
