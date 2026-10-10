/// <reference types="jest" />
// GATE ADVERSARIAL — D-F61 (contrato REAL da Sefin para os eventos, cravado ao vivo em H) + TSString + D-F59 (IM do
// prestador só em H) — setes-api, 2026-10-10.
//
// Alvo: `tax-authority/adapters/adn.ts` (isSefinNoEventEnvelope, decodeEventFile, cancelEventXmls, laço do queryNfse),
// `tax-authority/https-json.ts` (405 → 502), `dps-builder.ts` (toTsString/text), `branches/service.ts`
// (normalizeCancelMotive, IM do prestador por ambiente) e a camada de cima (`invoice-transmission.ts`: refresh, rodízio,
// transmissão).
//
//  * ACHADOS (`it.failing('[SEV ID] …')`) — o teste afirma o que a spec promete e FALHA no código atual: é a prova do bug.
//    O corretor troca `it.failing` por `it` depois de corrigir. NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (ficam como regressão).
//
// REGRAS DO GATE: nenhum socket (transporte `transport.request` mockado), nenhum banco (pool/repositório mockados na
// fronteira — harness copiado do `onda3-adversarial-r3.test.ts`), nenhum script que fale com o fisco.
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import forge from 'node-forge'
import { gzipSync, gunzipSync } from 'zlib'

const SECRETS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-adv-df61-secrets-'))
const STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-adv-df61-storage-'))
process.env.SECRETS_PATH = SECRETS_ROOT
process.env.STORAGE_PATH = STORAGE_ROOT
process.env.JWT_SECRET = 'adversarial-df61'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVDF61'), recordCrash: jest.fn().mockResolvedValue(undefined),
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
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO DF61-01 (MEDIUM) — 200 no GET TIPADO diz que o evento EXISTE; `arquivoXml` gzip VÁLIDO que não se lê como evento vira "autorizada" (fura o invariante do próprio laço: "ilegível nunca vira autorizada")', () => {
  // decodeEventFile só confere "começa com <" no ramo NÃO-gzip; no ramo gzip qualquer texto descomprimido é "XML" →
  // parseEventXml não acha código → `continue` → os outros 3 códigos dão 404 → `return base` (authorized).
  // O contraste (lixo NÃO-gzip → unknown) está coberto no tax-authority.test.ts.
  const illegible: [string, string][] = [
    ['gzip de HTML de erro (gateway/WAF devolvendo 200)', arquivo2('<html><body>Erro interno</body></html>')],
    ['gzip do evento CERTO em UTF-16LE com BOM', arquivo2(Buffer.from('﻿' + generatedEventXml(), 'utf16le'))],
    ['gzip de texto qualquer', arquivo2('lixo')],
    ['gzip do evento CERTO com prefixo de namespace (ns2:)', arquivo2(generatedEventXml().replace(/<(\/?)/g, '<$1ns2:'))],
  ]
  it('[CORRIGIDO — D-F63] [MEDIUM DF61-01a] adaptador: /eventos/101101/1 → 200 com o 101101 listado e ilegível (mas gzip válido) → "unknown" ou 502, NUNCA "authorized"', async () => {
    for (const [label, file] of illegible) {
      mockHttp.mockReset()
      sefin({ typed: code => (code === '101101' ? typedOk(typedItem(file)) : undefined) })
      const out = await settle(adnAdapter.queryNfse(ctxH, KEY))
      expect([label, out?.status === 'authorized']).toEqual([label, false])
    }
  })
  it('[CORRIGIDO — D-F63] [MEDIUM DF61-01b] refresh: K com 10 min + /eventos/101101/1 → 200 com o arquivo ilegível → grava N "pedido não consta — segue autorizada" (voz CONCLUSIVA sobre resposta ambígua; "ambíguo não é N", D-N28)', async () => {
    useRealAdn()
    setTx(tx({ lastKind: 'K', lastEvent: 2, lastEventAgeMinutes: IN_FLIGHT_MINUTES }))
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(illegible[0][1])) : undefined) })
    const out = await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q'))
    expect(kinds()).not.toContain('N')
    expect(out).toMatchObject({ statusCode: 502 })
  })
})

describe('ACHADO DF61-02 (MEDIUM — EXIGE DECISÃO: contraria a asserção "evento de outra chave → authorized (R2-2 (d))" do tax-authority.test.ts) — sob o contrato TIPADO, 200 em /eventos/101101/1 com evento de OUTRA chave, pedido ecoado ou outro tipo é resposta TROCADA, não "não há evento"', () => {
  // Na lista antiga (GET /eventos, que nunca existiu) "evento alheio na lista" podia ser vizinho legítimo; no GET por
  // chave+tipo+sequência um 200 só tem um significado: o evento EXISTE. Ler outra coisa ali é a resposta trocada da R2-2
  // — que no transmit (R2-2 a/b) e no GET /nfse (R2-2 c) vira 502, e aqui vira "autorizada" (e K → N).
  const swapped: [string, string][] = [
    ['evento GERADO de OUTRA chave', generatedEventXml({ key: OTHER_KEY })],
    ['pedido ecoado (sem Id EVT e sem dhProc)', generatedEventXml({ withId: false, withDhProc: false })],
    ['evento de OUTRO tipo (e202201) desta chave no GET do 101101', generatedEventXml({ code: '202201' })],
  ]
  it('[CORRIGIDO — D-F63] [MEDIUM DF61-02a] adaptador: 200 no tipado com evento que não responde à PERGUNTA → 502/unknown, nunca "authorized"', async () => {
    for (const [label, xml] of swapped) {
      mockHttp.mockReset()
      sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(xml))) : undefined) })
      const out = await settle(adnAdapter.queryNfse(ctxH, KEY))
      expect([label, out?.status === 'authorized']).toEqual([label, false])
    }
  })
  it('[CORRIGIDO — D-F63] [MEDIUM DF61-02b] refresh: K com 10 min + 200 no tipado com o evento de OUTRA chave → N falso gravado', async () => {
    useRealAdn()
    setTx(tx({ lastKind: 'K', lastEvent: 2, lastEventAgeMinutes: IN_FLIGHT_MINUTES }))
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(swapped[0][1]))) : undefined) })
    await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q'))
    expect(kinds()).not.toContain('N')
  })
})

describe('ACHADO DF61-03 (LOW) — campo OBRIGATÓRIO que o `toTsString` ESVAZIA some do XML: o montador entrega DPS fora do XSD (o fisco recusa = R) em vez do 422 local antes de reservar (LOW-1)', () => {
  const cases: [string, (d: DpsInput) => void, string][] = [
    ['xNome do tomador só em CJK (empresa estrangeira)', d => { d.toma!.xNome = '株式会社東京' }, 'xNome'],
    ['xBairro só com emoji', d => { d.toma!.end!.xBairro = '\u{1F3E0}\u{1F3E0}' }, 'xBairro'],
    ['xDescServ só com emoji (passa no `trim() || "Serviços"` do ramo)', d => { d.serv.cServ.xDescServ = '\u{1F4E6}' }, 'xDescServ'],
  ]
  it.failing('[LOW DF61-03] o montador recusa (Error → 422 FISCAL_DPS_INVALID) ou mantém o elemento obrigatório com conteúdo', () => {
    for (const [label, mutate, el] of cases) {
      let xml: string | null = null; let err: unknown = null
      try { xml = buildDpsXml(dpsWith(mutate), DPS_XML_ID) } catch (e) { err = e }
      expect([label, err !== null || !!textOf(xml!, el)]).toEqual([label, true])
    }
  })
})

describe('ACHADO DF61-04 (LOW) — tamanho do XSD não conferido: bairro 61–100 (o banco aceita varchar(100), TSBairro = 60) e IM > 15 (banco varchar(45), TSInscMun = 15) vão crus → recusa de ESQUEMA (R) em vez de 422 local', () => {
  it.failing('[LOW DF61-04] xBairro com 62 caracteres e IM com 20 → o montador recusa ou cabe no maxLength', () => {
    const cases: [string, (d: DpsInput) => void, string, number][] = [
      ['xBairro com 62 (bairro real de conjunto habitacional)', d => { d.toma!.end!.xBairro = 'Conjunto Habitacional Residencial Parque das Palmeiras Norte 1' }, 'xBairro', 60],
      ['IM do prestador 20 (H)', d => { d.prest.im = '01.06.501.367-7/0001' }, 'IM', 15],
    ]
    for (const [label, mutate, el, max] of cases) {
      let xml: string | null = null; let err: unknown = null
      try { xml = buildDpsXml(dpsWith(mutate), DPS_XML_ID) } catch (e) { err = e }
      expect([label, err !== null || (textOf(xml!, el) ?? '').length <= max]).toEqual([label, true])
    }
  })
})

describe('ACHADO DF61-05 (LOW, LATENTE — nenhum produtor preenche infoCompl hoje) — `text(x).slice(0, N)` corta DEPOIS do trim: o corte pode terminar em espaço e fura o TSString (`[!-ÿ]` na ponta)', () => {
  it('[CORRIGIDO] [LOW DF61-05] docRef (255) e xPed (60) cortados num espaço → o valor no XML ainda casa o TSString', () => {
    const xml = buildDpsXml(dpsWith(d => { d.serv.infoCompl = { docRef: 'a'.repeat(254) + ' bcd', xPed: 'p'.repeat(59) + ' q' } }), DPS_XML_ID)
    expect(TS_STRING.test(textOf(xml, 'docRef')!)).toBe(true)
    expect(TS_STRING.test(textOf(xml, 'xPed')!)).toBe(true)
  })
})

describe('ACHADO DF61-06 (LOW) — `toTsString` não normaliza para NFC: acento DECOMPOSTO (NFD, c + U+0327) perde o diacrítico e o texto vai ao fisco sem acento', () => {
  it('[CORRIGIDO — D-F66] [LOW DF61-06] "Serviço de manutenção" em NFD chega ao XML como "Serviço de manutenção" (NFC), não "Servico de manutencao"', () => {
    expect(toTsString('Serviço de manutenção')).toBe('Serviço de manutenção')
  })
})

describe('ACHADO DF61-07 (LOW) — D-F59 decidida numa LEITURA do ambiente e o DPS enviado na OUTRA: a habilitação vira H→P entre o `buildDpsBase` (fora da transação, IM decidida por H) e a reserva (FOR UPDATE, envio para P) → DPS de PRODUÇÃO com a IM do prestador (E0120 → R)', () => {
  it.failing('[LOW DF61-07] transmit com o emissor lido H fora e P sob a trava → o XML com tpAmb=1 NÃO leva <IM> no <prest>', async () => {
    ;(issuerRepo.getIssuer as jest.Mock).mockReset()
      .mockResolvedValueOnce(issuerRow({ environment: 'H' }))       // opened0 — decide a IM (buildDpsBase)
      .mockResolvedValue(issuerRow({ environment: 'P' }))           // reserva — decide tpAmb, host e ambiente da tentativa
    const box: { sent: { env: string; xml: string } | null } = { sent: null }
    adapter.transmit.mockImplementation(async (ctx: any, xml: string) => { box.sent = { env: ctx.environment, xml }; throw unavailable() })
    await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))
    expect(box.sent).not.toBeNull()
    expect(box.sent!.env).toBe('P'); expect(box.sent!.xml).toContain('<tpAmb>1</tpAmb>')
    expect(prestOf(box.sent!.xml)).not.toContain('<IM>')
  })
})

describe('ACHADO DF61-08 (LOW) — orçamento da passada (`REFRESH_BUDGET_MS`) só é conferido ENTRE notas; com a D-F61 cada consulta virou 5 idas ao fisco em SÉRIE (1 + 4 códigos, 30 s de inatividade cada) — uma nota lenta estoura o orçamento da requisição de quem abriu a tela', () => {
  it.failing('[LOW DF61-08] passada com orçamento de 60 ms e o fisco a 40 ms por GET tipado → a passada termina dentro de 2× o orçamento', async () => {
    useRealAdn()
    setTx(tx({ lastKind: 'A' }))
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([{ invoiceId: INVOICE, attempt: 1 }])
    sefin({ typed: () => delay(40, () => sefinNone()) })
    const t0 = Date.now()
    const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user, { budgetMs: 60 })
    const elapsed = Date.now() - t0
    expect(r.checked).toBe(1)
    expect(elapsed).toBeLessThan(120)
  })
})

// ===========================================================================
// RESISTIU — ataques que NÃO reproduziram bug (regressão)
// ===========================================================================

describe('RESISTIU — D-F61: 404 que imita o envelope, envelope com eventos, resposta trocada, camadas do arquivoXml', () => {
  it('resistiu: 404 com o envelope da Sefin + `erro`/`erros`, + `eventos` não vazio, versaoAplicativo vazio ou array → 502 ambíguo (nunca "não há evento")', async () => {
    const bodies: [string, string][] = [
      ['envelope + erro', JSON.stringify({ ...SEFIN, erro: { codigo: 'E9999', descricao: 'falha' } })],
      ['envelope + erros[]', JSON.stringify({ ...SEFIN, erros: [{ codigo: 'E0001', descricao: 'x' }] })],
      ['envelope + eventos NÃO vazio', JSON.stringify({ ...SEFIN, eventos: [typedItem(arquivo2(generatedEventXml()))] })],
      ['versaoAplicativo vazio', JSON.stringify({ ...SEFIN, versaoAplicativo: '' })],
      ['array com o envelope', JSON.stringify([SEFIN])],
      ['HTML', '<!DOCTYPE html><html><body>404</body></html>'],
    ]
    for (const [label, text] of bodies) {
      mockHttp.mockReset()
      sefin({ typed: code => (code === '101101' ? { status: 404, headers: {}, text } : undefined) })
      const out = await settle(adnAdapter.queryNfse(ctxH, KEY))
      expect([label, out?.statusCode, out?.code]).toEqual([label, 502, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE])
    }
  })
  it('resistiu: 200 com o evento de OUTRA chave E o desta na mesma lista → cancelled com o XML DESTA chave', async () => {
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml({ key: OTHER_KEY })), '101101', OTHER_KEY), typedItem(arquivo2(generatedEventXml()))) : undefined) })
    const q = await adnAdapter.queryNfse(ctxH, KEY)
    expect(q.status).toBe('cancelled')
    expect(q.cancelled!.eventXml).toContain(`EVT${KEY}101101`)
    expect(q.cancelled!.motive).toBe('cliente desistiu do serviço')
  })
  it('resistiu: arquivoXml em 1 camada (gzip+b64), XML em b64, XML cru, 2 camadas, 2 camadas com CRLF a cada 76 nas DUAS, BOM UTF-8 → cancelled', async () => {
    const xml = generatedEventXml()
    const files: [string, string][] = [
      ['1 camada gzip+b64', gz(xml)], ['XML em b64', b64(xml)], ['XML cru', xml], ['2 camadas', arquivo2(xml)],
      ['2 camadas com CRLF', wrap76(b64(wrap76(gzBuf(xml).toString('base64'))))], ['BOM UTF-8', arquivo2('﻿' + xml)],
    ]
    for (const [label, file] of files) {
      mockHttp.mockReset()
      sefin({ typed: code => (code === '101101' ? typedOk(typedItem(file)) : undefined) })
      const q = await adnAdapter.queryNfse(ctxH, KEY)
      expect([label, q.status]).toEqual([label, 'cancelled'])
    }
  })
  it('resistiu: 3 camadas, gzip truncado, lixo não-gzip → "unknown" (nunca authorized)', async () => {
    const xml = generatedEventXml()
    const trunc = gzBuf(xml); const truncated = trunc.subarray(0, trunc.length - 12)
    const files: [string, string][] = [
      ['3 camadas', b64(arquivo2(xml))], ['gzip truncado (2 camadas)', b64(truncated.toString('base64'))], ['lixo b64', b64('lixo')],
    ]
    for (const [label, file] of files) {
      mockHttp.mockReset()
      sefin({ typed: code => (code === '101101' ? typedOk(typedItem(file)) : undefined) })
      const q = await adnAdapter.queryNfse(ctxH, KEY)
      expect([label, q.status]).toEqual([label, 'unknown'])
    }
  })
  it('resistiu: tipoEvento divergente mas de CANCELAMENTO desta chave (pedi 101101, veio e105102) → cancelled; 101101 inexistente e 105102 achado → para no 2º código', async () => {
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml({ code: '105102' })), '105102')) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH, KEY)).status).toBe('cancelled')
    mockHttp.mockReset()
    sefin({ typed: code => (code === '105102' ? typedOk(typedItem(arquivo2(generatedEventXml({ code: '105102' })), '105102')) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH, KEY)).status).toBe('cancelled')
    expect(mockHttp.mock.calls.map((c: any[]) => c[0].url.replace(/^.*\/nfse\//, ''))).toEqual([KEY, `${KEY}/eventos/101101/1`, `${KEY}/eventos/105102/1`])
  })
  it('resistiu: GET /nfse/{chave} devolve a NFS-e de OUTRA chave → 502, nenhum GET de evento', async () => {
    sefin({ nfse: () => ok({ nfseXmlGZipB64: gz(nfseXmlFor(OTHER_KEY)) }) })
    await expect(adnAdapter.queryNfse(ctxH, KEY)).rejects.toMatchObject({ statusCode: 502 })
    expect(mockHttp).toHaveBeenCalledTimes(1)
  })
  it('D-F63: 200 com `eventos: []` (fora da forma cravada — sem evento a Sefin dá 404) → 502 ambíguo, nunca "não há esse evento"', async () => {
    sefin({ typed: () => typedOk() })
    await expect(adnAdapter.queryNfse(ctxH, KEY)).rejects.toMatchObject({ statusCode: 502, code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
  })
})

describe('RESISTIU — D-F61 no meio do laço e 405 na camada de cima', () => {
  const failAt3 = (resp: () => any) => sefin({ typed: code => (code === '105104' ? resp() : undefined) })
  it('resistiu: 503 / 405 / timeout / 404 HTML no 3º código → 503 / 502 / 503 / 502 (nunca authorized); o 4º código não é perguntado', async () => {
    const cases: [string, () => any, number][] = [
      ['503', () => ({ status: 503, headers: {}, text: 'no healthy upstream' }), 503],
      ['405', () => ({ status: 405, headers: { allow: 'POST' }, text: '' }), 502],
      ['timeout', () => { throw new Error('timeout') }, 503],
      ['404 HTML', () => ({ status: 404, headers: {}, text: '<html>404</html>' }), 502],
      ['501', () => ({ status: 501, headers: {}, text: '' }), 503],
    ]
    for (const [label, resp, status] of cases) {
      mockHttp.mockReset()
      failAt3(resp)
      const out = await settle(adnAdapter.queryNfse(ctxH, KEY))
      expect([label, out?.statusCode, mockHttp.mock.calls.length]).toEqual([label, status, 4])
    }
  })
  it('resistiu: refresh com K de 10 min e 503/405 no 3º código → nada gravado (nem N, nem "nós olhamos")', async () => {
    useRealAdn()
    for (const resp of [{ status: 503, headers: {}, text: '' }, { status: 405, headers: {}, text: '' }]) {
      setTx(tx({ lastKind: 'K', lastEvent: 2, lastEventAgeMinutes: IN_FLIGHT_MINUTES }))
      failAt3(() => resp)
      await expect(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')).rejects.toBeInstanceOf(AuthorityHttpError)
      expect(kinds()).toEqual([]); expect(repo.touchQueriedAt).not.toHaveBeenCalled()
    }
  })
  it('resistiu: rodízio — 503 no 3º código pára a passada sem "olhar" ninguém; 405 (502 persistente) registra o erro e marca last_queried_at (sai do topo do rodízio), sem N', async () => {
    useRealAdn()
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([{ invoiceId: INVOICE, attempt: 1 }, { invoiceId: 6301, attempt: 1 }])
    setTx(tx({ lastKind: 'K', lastEvent: 2, lastEventAgeMinutes: IN_FLIGHT_MINUTES }))
    failAt3(() => ({ status: 503, headers: {}, text: '' }))
    const r1 = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(r1).toMatchObject({ checked: 1, stoppedEarly: true }); expect(repo.touchQueriedAt).not.toHaveBeenCalled()
    mockHttp.mockReset(); (repo.touchQueriedAt as jest.Mock).mockClear()
    failAt3(() => ({ status: 405, headers: {}, text: '' }))
    const r2 = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(r2.errors[0]).toMatchObject({ invoiceId: INVOICE, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(repo.touchQueriedAt).toHaveBeenCalled(); expect(kinds()).not.toContain('N')
  })
  it('resistiu: 405 no POST /nfse (ADN real) → 502 ambíguo, reserva EM VOO, nenhuma voz R/F', async () => {
    useRealAdn()
    sefin({ post: () => ({ status: 405, headers: { allow: 'GET' }, text: '{"message":"method not allowed"}' }) })
    const out = await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))
    expect(out).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(repo.insertTransmission).toHaveBeenCalledTimes(1); expect(events).toHaveLength(0)
  })
  it('resistiu: 405 no POST do evento de cancelamento (ADN real) → 502 + K em voo (nunca C, nunca "recusado")', async () => {
    useRealAdn(); withAuthorizedTx()
    sefin({ post: c => (/\/eventos$/.test(c.url) ? { status: 405, headers: {}, text: '' } : ok(null)) })
    const out = await settle(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'motivo de teste do gate adversarial'))
    expect(out).toMatchObject({ statusCode: 502 }); expect(kinds()).toEqual(['K']); expect(invoice.cancelInvoice).not.toHaveBeenCalled()
  })
})

describe('RESISTIU — TSString em todo campo livre e no motivo; D-F59 (IM só em H); motivo com acentuação DUPLA vindo do fisco', () => {
  const HOSTILE = '  Rua—“Tipo”… \u{1F600}​﻿ \uD800 x\u0007\t\n &<> Fim  '
  it('resistiu: texto hostil (tipografia, emoji, ZWSP, BOM, U+2028, surrogate solto, controle, tab/quebra, &<>) em xLgr/nro/xCpl/xBairro/xNome/IM/verAplic → todo campo TSString casa o padrão do XSD', () => {
    const xml = buildDpsXml(dpsWith(d => {
      d.toma!.end = { cMun: '4106902', cep: '80010000', xLgr: HOSTILE, nro: HOSTILE, xCpl: HOSTILE, xBairro: HOSTILE }
      d.toma!.xNome = HOSTILE; d.prest.im = ' 01.065.013-677 '; d.verAplic = HOSTILE
    }), DPS_XML_ID)
    for (const el of ['xLgr', 'nro', 'xCpl', 'xBairro', 'verAplic']) {
      const v = textOf(xml, el)
      expect([el, v !== null && TS_STRING.test(v)]).toEqual([el, true])
    }
    expect(textOf(tomaOf(xml), 'xNome')).toMatch(/^[ -ÿ]+$/)
    expect(textOf(prestOf(xml), 'IM')).toBe('01.065.013-677')
  })
  it('resistiu: motivo do cancelamento — corte em 255 num espaço, só espaço/controle, só emoji, &<> → xMotivo do XML casa o TSString com 15–255', () => {
    for (const raw of ['x'.repeat(254) + ' yz', ' \u0001\u0002\t\r\n ', '\u{1F600}'.repeat(200), 'a&b<c>d "e" \'f\' — ok', 'Correção — “emissão” …']) {
      const m = normalizeCancelMotive(raw)
      const xml = buildCancelEventXml({ accessKey: KEY, dhEvento: '2026-10-10T17:30:00-03:00', cMotivo: '1', xMotivo: m, environment: 'P', verAplic: 'v', cnpjAutor: CNPJ })
      const v = textOf(xml, 'xMotivo')!
      expect([raw.slice(0, 20), TS_STRING.test(v) && v.length >= 15 && v.length <= 255]).toEqual([raw.slice(0, 20), true])
    }
  })
  it('resistiu: D-F59 — emissor em P: o DPS (tpAmb 1) NÃO leva a IM do prestador; a IM do TOMADOR continua indo', async () => {
    ;(issuerRepo.getIssuer as jest.Mock).mockResolvedValue(issuerRow({ environment: 'P' }))
    ;(entity.getEntityFiscalFull as jest.Mock).mockImplementation(async (id: number) => {
      const f = fullEntity(id); if (id !== 1) f.company.im = '555'; return f
    })
    let xml = ''
    adapter.transmit.mockImplementation(async (_c: any, x: string) => { xml = x; throw unavailable() })
    await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))
    expect(xml).toContain('<tpAmb>1</tpAmb>')
    expect(prestOf(xml)).not.toContain('<IM>')
    expect(tomaOf(xml)).toContain('<IM>555</IM>')
  })
  it('resistiu: D-F59 — emissor em H: a IM do prestador vai, aparada (o miolo da máscara fica — a forma é a Q-F62)', async () => {
    ;(entity.getEntityFiscalFull as jest.Mock).mockImplementation(async (id: number) => {
      const f = fullEntity(id); if (id === 1) f.company.im = '  01.065.013-677  '; return f
    })
    let xml = ''
    adapter.transmit.mockImplementation(async (_c: any, x: string) => { xml = x; throw unavailable() })
    await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))
    expect(xml).toContain('<tpAmb>2</tpAmb>')
    expect(prestOf(xml)).toContain('<IM>01.065.013-677</IM>')
  })
  it('resistiu: motivo do fisco com acentuação DUPLA (UTF-8 lido como Latin-1, inclusive controles C1 das maiúsculas: "Ç" → "Ã" + U+0087) gravado como voz C sem quebrar nada; o cancelamento local leva o texto como veio, ≤ 255', async () => {
    useRealAdn(); withAuthorizedTx()
    const mojibake = Buffer.from('Correção da emissão — AÇÃO DUPLICADA', 'utf8').toString('latin1')
    expect(mojibake).toMatch(/[\u0080-\u009F]/)
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml().replace('cliente desistiu do serviço', mojibake)))) : undefined) })
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ kind: 'C' })
    const c = events.find(e => e.kind === 'C')!
    expect(c.message).toBe(`Cancelada no fisco: ${mojibake}`)
    const reason = (invoice.cancelInvoice as jest.Mock).mock.calls[0][4].reason as string
    expect(reason.length).toBeLessThanOrEqual(255); expect(reason).toContain(mojibake)
  })
})

describe('ACHADO DF61-09 (LOW) — a exceção da D-F61 cobre SÓ o 405: 406 (Accept) e 415 (Content-Type) também são erro de CONTRATO do adaptador, não recusa de REGRA do documento — e ainda viram 422 FISCAL_DPS_REJECTED → voz R "Fisco rejeitou (415)"', () => {
  it('[CORRIGIDO] [LOW DF61-09] POST /nfse → 406/415 (ADN real) → ambíguo (502), nunca voz R', async () => {
    useRealAdn()
    for (const status of [406, 415]) {
      events = []; (repo.insertTransmission as jest.Mock).mockClear()
      sefin({ post: () => ({ status, headers: {}, text: '' }) })
      const out = await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))
      expect([status, out?.code, kinds()]).toEqual([status, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, []])
    }
  })
})
