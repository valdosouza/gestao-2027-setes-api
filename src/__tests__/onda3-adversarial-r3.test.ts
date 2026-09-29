/// <reference types="jest" />
// Onda 3 (NFS-e pelo Padrão Nacional) — GATE ADVERSARIAL, RE-PROVA FINAL (rodada 3, 2026-09-28).
//
// A rodada 2 (`onda3-adversarial-r2.test.ts`, R2-1…R2-5) e o retrabalho do socrático
// (`onda3-gate-rework-r2.test.ts`, D-N26…D-N30, L5/L6) estão verdes. Aqui só ATAQUES NOVOS nos
// CONTORNOS dessas correções:
//  * ACHADOS R3-x — o teste afirma o que a spec promete (D-N26 leitor único "quem detém a chave",
//    D-N30 "credencial LOCAL = 409 sem voz, nada gravado", D-N29 "o A1 é do emitente", D-N21 "o fisco
//    pode ter cancelado sem nós", XSD tiposEventos_v1.01 = vocabulário dos cancelamentos) e FALHA no
//    código atual: é a prova do bug. A correção é da sessão principal — NUNCA corrigir o teste.
//  * PROVAS POSITIVAS — ataques que NÃO reproduziram bug (ficam como regressão).
//
// Harness = o do molde r2: pool/repositório mockados na fronteira (loja de eventos em memória),
// `adapterFor` injetável (adaptador falso OU o ADN REAL com `transport.request` mockado — nenhum
// socket), assinatura/cofre/openIssuer/runIsolated REAIS, certificado autoassinado gerado no teste.
// Novidade deste arquivo: LOJA DE TENTATIVAS multi-attempt (`multiAttemptStore`) que implementa em
// memória a MESMA regra do `latestTransmission`/`findTransmissionByDpsId`/`currentOf` (D-N26 +
// MEDIUM-1) — sem isso a tentativa órfã não se prova.
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import forge from 'node-forge'
import { gzipSync } from 'zlib'

const SECRETS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-onda3-adv-r3-secrets-'))
const STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-onda3-adv-r3-storage-'))
process.env.SECRETS_PATH = SECRETS_ROOT
process.env.STORAGE_PATH = STORAGE_ROOT
process.env.JWT_SECRET = 'onda3-adversarial-r3'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADV3R3'), recordCrash: jest.fn().mockResolvedValue(undefined),
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
const authorizedVoice = () => ({ accessKey: KEY, status: 'authorized' as const, nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })
const withAuthorizedTx = () => setTx(tx({ lastKind: 'A' }))
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
/** SQL que o repositório REAL emite para uma leitura (captura sem banco). */
async function sqlOf(fn: (qq: any) => Promise<unknown>): Promise<string> {
  let captured = ''
  const qq = { query: jest.fn(async (sql: string) => { captured = sql; return [[]] }) }
  await fn(qq)
  return captured.replace(/\s+/g, ' ')
}
async function settle<T>(p: Promise<T>): Promise<any> { try { return await p } catch (e) { return e } }

// ===========================================================================
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO R3-1 (HIGH) — D-N26 × MEDIUM-1: a chave pousa numa tentativa ANTIGA e a tentativa em voo vira ÓRFÃ — invisível ao leitor único, nunca reconciliada, e monopoliza a consulta ativa', () => {
  // Nascimento (fluxo comum, sem nenhuma "falha estranha"): tentativa 1 → timeout → 10 min → F "sem resposta"
  // (GET /dps 404). Tentativa 2 reusa o nDPS (D-N3, 059) → o fisco GERA a NFS-e mas a resposta se perde
  // (timeout) → em voo. 10 min depois, "Transmitir" → reconcileInterrupted(2) → GET /dps acha → refresh →
  // `findTransmissionByDpsId` = "a mais antiga sem chave" = tentativa 1 (a que já era F) → A na 1.
  // A tentativa 2 (a que de fato gerou a NFS-e) fica sem voz PARA SEMPRE: `latestTransmission` só vê a 1
  // (detém a chave), `reconcileInterrupted` só olha a vigente, e `listLiveTransmissionsToRefresh` lista a 2
  // (le.kind IS NULL, last_queried_at NULL) em TODA passada, em 1º lugar — o refresh dela toca só a 1.
  it('(a) nascimento: transmit com a tentativa 2 interrompida e a NFS-e achada pelo Id → A pousa na 1 (F) e a 2 NÃO pode continuar viva sem voz', async () => {
    const st = multiAttemptStore(
      [{ attempt: 1, ageMinutes: 40 }, { attempt: 2, ageMinutes: IN_FLIGHT_MINUTES + 2 }],
      [{ attempt: 1, kind: 'F', source: 'Q', message: 'Sem resposta do fisco e nenhuma NFS-e gerada para este DPS — envio interrompido' }],
    )
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
    adapter.queryNfse.mockResolvedValue(authorizedVoice())
    const out = await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))
    // o que JÁ acontece (sanidade do cenário): A na tentativa 1, transmit recusado por "já autorizada"
    expect(out).toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_ALREADY_AUTHORIZED })
    expect(kindsOf(1)).toEqual(['F', 'A']); expect(st.row(1).accessKey).toBe(KEY)
    expect(adapter.transmit).not.toHaveBeenCalled()
    // o que a spec promete (D-N26: leitor ÚNICO; "reserva interrompida é reconciliada"): nenhuma tentativa
    // fica em voo sem voz depois de o fisco ter dito onde a NFS-e está
    const orphan = st.row(2)
    expect({ attempt: 2, lastKind: orphan.lastKind, live: repo.isLiveTransmission(orphan), touched: orphan.lastQueriedAt !== null })
      .toMatchObject({ live: false })
  })
  it('(b) rodízio: a órfã listada em 1º lugar é "consultada" (fisco chamado), mas o toque vai para a tentativa 1 — a 2 nunca sai da fila', async () => {
    const st = multiAttemptStore(
      [{ attempt: 1, accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21 10:15:30', ageMinutes: 60 }, { attempt: 2, ageMinutes: 30 }],
      [{ attempt: 1, kind: 'F' }, { attempt: 1, kind: 'A', dh: '2026-09-21 10:15:30', source: 'Q' }],
    )
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([st.row(2)])
    adapter.queryNfse.mockResolvedValue(authorizedVoice())
    const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(r).toMatchObject({ checked: 1, changed: 0, stoppedEarly: false }); expect(r.errors).toHaveLength(0)
    expect(adapter.queryNfse).toHaveBeenCalledTimes(1)                         // custa uma chamada ao fisco por passada
    const touchedAttempts = (repo.touchQueriedAt as jest.Mock).mock.calls.map(c => c[4])
    // promessa: a linha LISTADA sai da fila (tocada) ou é encerrada — senão volta em 1º lugar a cada passada
    const evidence = { touchedAttempts, eventsOn2: kindsOf(2), leftInQueue: !touchedAttempts.includes(2) && kindsOf(2).length === 0 }
    expect(evidence).toMatchObject({ leftInQueue: false })
  })
  it('(c) evidência no SQL real: a órfã entra pela cláusula `le.kind IS NULL` e vem PRIMEIRO (`last_queried_at IS NULL DESC`) — com 8 órfãs a consulta ativa não olha mais ninguém', async () => {
    const sql = await sqlOf(qq => { (pool as any).query = qq.query; return actualRepo.listLiveTransmissionsToRefresh(S.schema, S.inst, 5, 8).finally(() => { (pool as any).query = q }) })
    expect(sql).toContain('le.kind IS NULL OR le.kind IN')
    expect(sql).toContain('ORDER BY (t.last_queried_at IS NULL) DESC')
    expect(sql).toContain('LIMIT ?')
  })
})

describe('ACHADO R3-2 (MEDIUM) — D-N30 só chegou ao transmit: credencial LOCAL recusada no PEDIDO DE CANCELAMENTO grava K "enviado sem resposta" — o fisco nunca foi chamado', () => {
  // `classifyAuthorityError` devolve 'local', mas `cancelServiceInvoiceAtAuthority` só desvia 'rejected' e
  // 'auth_failed': 'local' cai no ramo AMBÍGUO → K em voo (fato falso: "pedido enviado") → nota presa em
  // 409 FISCAL_CANCEL_IN_FLIGHT até a carência de 10 min virar N — e só depois de alguém trocar o .pfx.
  it('ADN real: par PEM recusado ANTES do socket no POST /eventos → 409 FISCAL_CERT_INVALID sobe e NENHUM K/C nasce', async () => {
    useRealAdn(); withAuthorizedTx()
    mockHttp.mockImplementation(async (call: HttpsCall) => { if (/convenio/.test(call.url)) return ok({ prazoCancelamentoDias: 365 }); throw osslMismatch() })
    const out = await settle(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço'))
    expect(out).toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_CERT_INVALID })
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
    expect(kinds()).toEqual([])                                                  // nem K, nem C
  })
  it('adaptador falso: registerEvent rejeita com 409 FISCAL_CERT_INVALID (authorityStatus 0) → nada gravado', async () => {
    withAuthorizedTx()
    adapter.registerEvent.mockRejectedValue(localCertInvalid())
    const out = await settle(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço'))
    expect(out).toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_CERT_INVALID })
    expect(kinds()).toEqual([])
  })
})

describe('ACHADO R3-3 (MEDIUM) — o adaptador só conhece DOIS dos QUATRO cancelamentos do XSD: "Deferido por Análise Fiscal" (e105104) e "por Ofício" (e305101) deixam a NFS-e "autorizada" aqui', () => {
  // tiposEventos_v1.01.xsd (choice de infPedReg): e101101 Cancelamento · e105102 por substituição ·
  // e105104 "Cancelamento de NFS-e Deferido por Análise Fiscal" · e305101 "Cancelamento de NFS-e por Ofício".
  // D-N21 vigia A "porque o fisco pode ter cancelado sem nós": fora do prazo do município o ÚNICO caminho do
  // contribuinte é a análise fiscal (README: "fora do prazo E0822 → resta a análise fiscal") — e o de ofício
  // é do fisco. Os dois chegam por GET /nfse/{chave}/eventos como evento GERADO desta chave e são ignorados
  // pelo filtro `eventCode === '101101' || '105102'` → nada de C, financeiro/ISS seguem com a nota viva.
  it.each([['e105104 (deferido por análise fiscal)', '105104'], ['e305101 (cancelamento de ofício)', '305101']])(
    'GET /eventos traz %s GERADO (Id EVT + dhProc) desta chave → voz C + cancelInvoice', async (_l, code) => {
      useRealAdn(); withAuthorizedTx()
      adnRoutes({ nfse: () => ok({ nfseXmlGZipB64: gz(NFSE_XML) }), eventosGet: () => ok([{ eventoXmlGZipB64: gz(generatedEventXml({ code })) }]) })
      const r = await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q'))
      expect(r).toMatchObject({ kind: 'C', invoiceEvent: 2 })
      expect(invoice.cancelInvoice).toHaveBeenCalledTimes(1)
    })
})

describe('ACHADO R3-4 (MEDIUM) — D-N29 deixa passar o e-CPF: CN "NOME:CPF" (11 dígitos) não tem 14 dígitos, `cnpj` fica null e o cofre aceita com `expectedCnpj` informado', () => {
  // A regra "sem CNPJ no CN não há como comparar" foi feita para CN fora do padrão ICP-Brasil; o e-CPF ESTÁ no
  // padrão (NOME:CPF) e é identificável como "não é este CNPJ". Sem procuração (D-N12) o fisco recusa nota a
  // nota (assinatura de um CPF para um prestador CNPJ) — o mesmo modo de falha que a D-N29 veio evitar.
  it('.pfx de e-CPF com expectedCnpj do emitente → 409 FISCAL_CERT_INVALID no campo pfx, nada no cofre', () => {
    const ecpf = selfSigned('JOAO DA SILVA:12345678901', YEAR)
    let err: any
    try { storeIssuerCertificate(S.schema, S.inst, toPfx(ecpf.keyPem, [ecpf.cert], 'senha'), 'senha', { expectedCnpj: CNPJ }) } catch (e) { err = e } finally { clearIssuerCertificate(S.schema, S.inst) }
    expect(err).toBeInstanceOf(HttpError)
    expect(err).toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_CERT_INVALID, fields: [expect.objectContaining({ field: 'pfx' })] })
  })
})

describe('ACHADO R3-5 (LOW) — `cnpjFromSubject` atravessa a fronteira da RDN: um ":CNPJ" em OU/O depois do CN é atribuído ao CN', () => {
  // `certificateInfo` troca "\n" por ", " e a regex `CN=[^\n]*?:(\d{14})` continua lendo até achar ":" + 14
  // dígitos em QUALQUER atributo seguinte. CN sem CNPJ + OU "AR X:99887766000155" → cnpj "99887766000155".
  it('CN sem CNPJ seguido de OU com ":14 dígitos" → null (não é o CNPJ do titular)', () => {
    expect(cnpjFromSubject('CN=SETES SISTEMAS, OU=AR TESTE:99887766000155')).toBeNull()
  })
  it('certificado REAL com esse subject e expectedCnpj do emitente → entra (não há como comparar), como no D-N29 "CN sem CNPJ"', () => {
    const c = selfSigned('SETES SISTEMAS', YEAR, undefined, undefined, [{ shortName: 'OU', value: 'AR TESTE:99887766000155' }])
    let out: any
    try { out = storeIssuerCertificate(S.schema, S.inst, toPfx(c.keyPem, [c.cert], 'senha'), 'senha', { expectedCnpj: CNPJ }) } catch (e) { out = e } finally { clearIssuerCertificate(S.schema, S.inst) }
    expect(out).not.toBeInstanceOf(Error)
    expect(out.certificateInfo?.cnpj).toBeNull()
  })
})

describe('ACHADO R3-6 (LOW) — consulta aceita NFS-e SEM NENHUMA identidade (nem Id do infNFSe, nem Id do infDPS) como a da chave pedida — e um <e101101> dentro dela vira C irreversível', () => {
  // R2-2 (c) confere a chave do XML "quando vem" e o DPS embutido "quando vem"; o transmit exige os dois. Um
  // documento sem identidade não pode ser conferido contra a pergunta — pela régua do R2-2 é "ilegível" (502),
  // não voz. Hoje: status 'cancelled' → C + cancelInvoice local sem que o fisco tenha identificado a nota.
  it('GET /nfse/{K} devolve XML sem Ids com bloco e101101 → 502, nenhum C, cancelInvoice não chamado', async () => {
    useRealAdn(); withAuthorizedTx()
    const anonymous = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe><nNFSe>999</nNFSe><dhProc>2026-09-21T10:15:30-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit>` +
      `<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>documento sem identidade</xMotivo></e101101></infNFSe></NFSe>`
    adnRoutes({ nfse: () => ok({ nfseXmlGZipB64: gz(anonymous) }) })
    const out = await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q'))
    expect(out).toBeInstanceOf(HttpError); expect(out.statusCode).toBe(502)
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
    expect(kinds()).not.toContain('C')
  })
})

describe('ACHADO R3-7 (MEDIUM) — D-N30 ficou no TRANSPORTE: a mesma credencial LOCAL ilegível estoura na ASSINATURA (`signXml`) como Error cru → 500 por nota, e o lote NÃO pára', () => {
  // `openIssuer` valida o certificado (legível, vigência) mas NÃO a chave privada (`validatePrivateKeyPem` só
  // existe no upload). Chave corrompida no cofre → `signXml` lança `ERR_OSSL_UNSUPPORTED` (código que ESTÁ na
  // lista LOCAL_CREDENTIAL_CODES da https-json) fora do transporte → nada traduz → 500 com crashlytics no
  // transmit (antes de reservar, sem fisco) e no cancelamento; no lote, `code: null` → não entra em
  // STOPS_THE_BATCH → N itens, N 500s, nenhum "envie o .pfx novamente".
  const corrupt = () => writeSecret(vault().key, '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n')
  it('transmit com chave ilegível no cofre → 409 FISCAL_CERT_INVALID (não Error cru), nada reservado, fisco não chamado', async () => {
    corrupt()
    adapter.transmit.mockResolvedValue(authorized())
    const out = await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))
    expect(repo.insertTransmission).not.toHaveBeenCalled(); expect(adapter.transmit).not.toHaveBeenCalled()
    expect({ ctor: out?.constructor?.name, code: out?.code, statusCode: out?.statusCode }).toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_CERT_INVALID })
  })
  it('lote de 3 com a chave ilegível → assinatura falha UMA vez, stoppedEarly, restantes retryable', async () => {
    corrupt()
    for (const id of [6301, 6302]) headerRows.set(id, header({ id, branchId: id }))
    const r = await transmitInvoiceBatch(ADMIN as any, { orderIds: [INVOICE, 6301, 6302] } as any)
    expect(r.results[0]).toMatchObject({ ok: false, code: ErrorCodes.FISCAL_CERT_INVALID })
    expect(r.stoppedEarly).toBe(true)
    expect(r.results[1]).toMatchObject({ ok: false, code: null, retryable: true })
  })
  it('cancelamento no fisco com chave ilegível → 409 FISCAL_CERT_INVALID, nenhum K', async () => {
    corrupt(); withAuthorizedTx()
    const out = await settle(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço'))
    expect(kinds()).toEqual([])
    expect({ ctor: out?.constructor?.name, code: out?.code, statusCode: out?.statusCode }).toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_CERT_INVALID })
  })
})

// ===========================================================================
// PROVAS POSITIVAS — ataques que NÃO reproduziram bug (regressão)
// ===========================================================================

describe('P1. isGeneratedEventFor (contornos da R2-1) — registerEvent', () => {
  const attack = async (resp: () => any) => {
    useRealAdn(); withAuthorizedTx()
    adnRoutes({ eventosPost: resp })
    return settle(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço'))
  }
  const refusedAmbiguous = (out: any) => {
    expect(out).toBeInstanceOf(HttpError); expect(out.statusCode).toBeGreaterThanOrEqual(502)
    expect(invoice.cancelInvoice).not.toHaveBeenCalled(); expect(kinds()).toEqual(['K'])
  }
  it('chNFSe com espaços/pontuação ("4106 9022.…") mas os 50 dígitos certos → aceite (voz C + C local)', async () => {
    const spaced = KEY.replace(/(\d{4})(?=\d)/g, '$1 ')
    const xml = generatedEventXml().replace(`<chNFSe>${KEY}</chNFSe>`, `<chNFSe>${spaced}</chNFSe>`)
    const r = await attack(() => ok({ eventoXmlGZipB64: gz(xml) }))
    expect(r).toMatchObject({ atAuthority: true, invoiceEvent: 2 }); expect(kinds()).toEqual(['C'])
  })
  it('Id EVT presente mas SEM dhProc e SEM dhEvento → ambíguo (502 + K), nunca C', async () => {
    refusedAmbiguous(await attack(() => ok({ eventoXmlGZipB64: gz(generatedEventXml({ withDhProc: false, withDhEvento: false })) })))
  })
  it('chNFSe com zero à esquerda a mais (51 dígitos) → não é esta chave → ambíguo + K', async () => {
    refusedAmbiguous(await attack(() => ok({ eventoXmlGZipB64: gz(generatedEventXml({ key: '0' + KEY })) })))
  })
  it('infEvento diz OUTRA chave e o pedido embutido diz a certa → a primeira chNFSe manda: ambíguo + K', async () => {
    refusedAmbiguous(await attack(() => ok({ eventoXmlGZipB64: gz(generatedEventXml({ outerKey: OTHER_KEY })) })))
  })
  it('DOIS blocos e2xxxxx/e1xxxxx: um e202201 (confirmação) antes do e101101 embutido → o 1º código manda: não é cancelamento → ambíguo + K', async () => {
    const xml = generatedEventXml({ prefixBlock: '<e202201><xDesc>Confirmação do Prestador</xDesc></e202201>' })
    expect(parseEventXml(xml).eventCode).toBe('202201')
    refusedAmbiguous(await attack(() => ok({ eventoXmlGZipB64: gz(xml) })))
  })
  it('na CONSULTA (/eventos): e101101 com zero à esquerda a mais ou de outra chave → segue autorizada, nenhum C', async () => {
    useRealAdn(); withAuthorizedTx()
    adnRoutes({ nfse: () => ok({ nfseXmlGZipB64: gz(NFSE_XML) }), eventosGet: () => ok([{ eventoXmlGZipB64: gz(generatedEventXml({ key: '0' + KEY })) }, { eventoXmlGZipB64: gz(generatedEventXml({ key: OTHER_KEY })) }]) })
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ kind: 'A', changed: false }); expect(invoice.cancelInvoice).not.toHaveBeenCalled()
  })
})

describe('P2. sentDpsIdOf / parsed.dpsId (contornos da R2-2)', () => {
  const ctx = { environment: 'H' as const, cert: Buffer.from(PAIR.certPem), key: Buffer.from(PAIR.keyPem) }
  const sentWithAttrsFirst = `<?xml version="1.0"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infDPS versao="1.01" Id="${DPS_ID}"><tpAmb>2</tpAmb></infDPS></DPS>`
  it('DPS enviado com `Id` DEPOIS de outro atributo e NFS-e devolvida idem → casa; NFS-e com DOIS infDPS (errado antes do certo) → 502', async () => {
    adnRoutes({ nfse: () => ok({ nfseXmlGZipB64: gz(nfseXmlFor(KEY, DPS_ID, `versao="1.01" Id="${DPS_ID}"`)) }) })
    await expect(adnAdapter.transmit(ctx, sentWithAttrsFirst)).resolves.toMatchObject({ accessKey: KEY })
    const two = nfseXmlFor().replace('<DPS>', `<DPS><infDPS Id="${OTHER_DPS_ID}"></infDPS>`)
    adnRoutes({ nfse: () => ok({ nfseXmlGZipB64: gz(two) }) })
    await expect(adnAdapter.transmit(ctx, sentWithAttrsFirst)).rejects.toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
  })
  it('Id do infDPS entre aspas SIMPLES ou minúsculo (`id=`) → não é o nosso Id → 502 (fail-closed)', async () => {
    for (const attrs of [`Id='${DPS_ID}'`, `id="${DPS_ID}"`]) {
      adnRoutes({ nfse: () => ok({ nfseXmlGZipB64: gz(nfseXmlFor(KEY, DPS_ID, attrs)) }) })
      await expect(adnAdapter.transmit(ctx, sentWithAttrsFirst)).rejects.toMatchObject({ statusCode: 502 })
    }
  })
  it('consulta: NFS-e devolvida com DOIS infDPS (errado primeiro) → 502, nada gravado, nem "nós olhamos"', async () => {
    useRealAdn(); withAuthorizedTx()
    adnRoutes({ nfse: () => ok({ nfseXmlGZipB64: gz(nfseXmlFor().replace('<DPS>', `<DPS><infDPS Id="${OTHER_DPS_ID}"></infDPS>`)) }) })
    await expect(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')).rejects.toMatchObject({ statusCode: 502 })
    expect(repo.fillAuthorityData).not.toHaveBeenCalled(); expect(repo.touchQueriedAt).not.toHaveBeenCalled()
  })
})

describe('P3. queryNfse — identidade parcial (tolerância documentada)', () => {
  it('infNFSe SEM Id mas infDPS = o nosso, JSON com a chave pedida → autorizada com a chave PEDIDA (não a do JSON)', async () => {
    useRealAdn(); withAuthorizedTx()
    const noHeaderId = NFSE_XML.replace(`<infNFSe Id="NFS${KEY}">`, '<infNFSe>')
    adnRoutes({ nfse: () => ok({ chaveAcesso: OTHER_KEY, nfseXmlGZipB64: gz(noHeaderId) }) })
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ kind: 'A', accessKey: KEY, changed: false })
  })
})

describe('P4. D-N28 — carência do K: idade desconhecida é "recente"; "Consultar" repetido só adia o rodízio', () => {
  it('lastEventAgeMinutes NULL (linha sem created_at) → K fica K (fail-closed), nada de N, "nós olhamos" marcado', async () => {
    setTx(tx({ lastKind: 'K', lastEvent: 2, lastEventAgeMinutes: null }))
    adapter.queryNfse.mockResolvedValue(authorizedVoice())
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ kind: 'K', changed: false }); expect(kinds()).toEqual([])
    expect(repo.touchQueriedAt).toHaveBeenCalledTimes(1)
  })
  it('K com 9 min, "Consultar" 2× → 2 toques, nenhum N; aos 10 min → N (uma vez); a 2ª consulta depois do N não duplica', async () => {
    setTx(tx({ lastKind: 'K', lastEvent: 2, lastEventAgeMinutes: IN_FLIGHT_MINUTES - 1 }))
    adapter.queryNfse.mockResolvedValue(authorizedVoice())
    await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(kinds()).toEqual([]); expect(repo.touchQueriedAt).toHaveBeenCalledTimes(2)
    setTx(tx({ lastKind: 'K', lastEvent: 2, lastEventAgeMinutes: IN_FLIGHT_MINUTES }))
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ kind: 'N', changed: true })
    setTx(tx({ lastKind: 'N', lastEvent: 3 }))
    const r2 = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r2).toMatchObject({ kind: 'N', changed: false }); expect(kinds()).toEqual(['N'])
  })
  it('SQL real do rodízio: K só volta quando last_queried_at < NOW() − minMinutes — o toque manual adia a passada, não a carência', async () => {
    const sql = await sqlOf(qq => { (pool as any).query = qq.query; return actualRepo.listLiveTransmissionsToRefresh(S.schema, S.inst, 5, 8).finally(() => { (pool as any).query = q }) })
    expect(sql).toMatch(/le\.kind IN \('S','K'\)\) AND \(t\.last_queried_at IS NULL OR t\.last_queried_at < DATE_SUB\(NOW\(\), INTERVAL \? MINUTE\)\)/)
  })
})

describe('P5. D-N30 nos outros caminhos — consulta ativa, erro cru no transmit, reserva depois da falha local', () => {
  it('consulta ativa: par local recusado no queryNfse da 1ª → passada pára (stoppedEarly), 1 chamada, nada gravado, ninguém "olhado"', async () => {
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([6300, 6301, 6302].map(invoiceId => ({ invoiceId, attempt: 1 })))
    ;(repo.latestTransmission as jest.Mock).mockImplementation(async (_q: any, _s: any, _i: any, invoiceId: number) => tx({ invoiceId, lastKind: 'A' }))
    adapter.queryNfse.mockRejectedValue(localCertInvalid())
    const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(r).toMatchObject({ checked: 1, stoppedEarly: true }); expect(r.errors[0].code).toBe(ErrorCodes.FISCAL_CERT_INVALID)
    expect(adapter.queryNfse).toHaveBeenCalledTimes(1); expect(repo.touchQueriedAt).not.toHaveBeenCalled(); expect(events).toHaveLength(0)
  })
  it('TypeError cru no transmit → ambíguo: sobe idêntico, reserva em voo, nenhuma voz', async () => {
    const boom = new TypeError('Cannot read properties of undefined')
    adapter.transmit.mockRejectedValue(boom)
    const out = await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))
    expect(out).toBe(boom); expect(repo.insertTransmission).toHaveBeenCalledTimes(1); expect(events).toHaveLength(0)
  })
  it('falha LOCAL no transmit deixa a reserva em voo: transmitir de novo (cofre já corrigido) → 409 IN_PROGRESS por 10 min, fisco não chamado — consequência documentada da D-N30 (Q-R3.1)', async () => {
    const st = multiAttemptStore([])
    adapter.transmit.mockRejectedValueOnce(localCertInvalid()).mockResolvedValue(authorized())
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ code: ErrorCodes.FISCAL_CERT_INVALID })
    expect(st.latest()).toMatchObject({ attempt: 1, lastKind: null })
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_TRANSMISSION_IN_PROGRESS })
    expect(adapter.transmit).toHaveBeenCalledTimes(1)
  })
})

describe('P6. D-N29 — formas do CN que o padrão ICP-Brasil produz', () => {
  it('CN com dois ":" ("EMPRESA S:A LTDA:CNPJ") → o CNPJ é o dos 14 dígitos; expectedCnpj formatado casa', () => {
    expect(cnpjFromSubject(`CN=EMPRESA S:A LTDA:${CNPJ}, C=BR`)).toBe(CNPJ)
    const c = selfSigned(`EMPRESA S:A LTDA:${CNPJ}`, YEAR)
    let out: any
    try { out = storeIssuerCertificate(S.schema, S.inst, toPfx(c.keyPem, [c.cert], 'senha'), 'senha', { expectedCnpj: '12.345.678/0001-99' }) } catch (e) { out = e } finally { clearIssuerCertificate(S.schema, S.inst) }
    expect(out.certificateInfo?.cnpj).toBe(CNPJ)
  })
  it('CN com o CNPJ PONTUADO ("NOME:12.345.678/0001-99") de OUTRA empresa → sem 14 dígitos contíguos: entra sem comparar (fora do padrão ICP-Brasil — aceito, LOW analisado)', () => {
    const c = selfSigned('OUTRA EMPRESA:99.887.766/0001-55', YEAR)
    let out: any
    try { out = storeIssuerCertificate(S.schema, S.inst, toPfx(c.keyPem, [c.cert], 'senha'), 'senha', { expectedCnpj: CNPJ }) } catch (e) { out = e } finally { clearIssuerCertificate(S.schema, S.inst) }
    expect(out).not.toBeInstanceOf(Error); expect(out.certificateInfo?.cnpj).toBeNull()
  })
})

describe('P7. lote com o 1º item 409 FISCAL_CERT_INVALID vindo do ADAPTADOR (transporte, não do openIssuer)', () => {
  it('ADN real, par recusado antes do socket → 1 tentativa ao transporte, stoppedEarly, item 1 sem F (reserva em voo), 2º e 3º retryable', async () => {
    useRealAdn()
    for (const id of [6301, 6302]) headerRows.set(id, header({ id, branchId: id }))
    mockHttp.mockImplementation(async () => { throw osslMismatch() })
    const r = await transmitInvoiceBatch(ADMIN as any, { orderIds: [INVOICE, 6301, 6302] } as any)
    expect(r).toMatchObject({ requested: 3, transmitted: 0, failed: 3, stoppedEarly: true })
    expect(r.results[0]).toMatchObject({ orderId: INVOICE, ok: false, code: ErrorCodes.FISCAL_CERT_INVALID, retryable: false })
    expect(r.results[1]).toMatchObject({ ok: false, code: null, retryable: true }); expect(r.results[2]).toMatchObject({ ok: false, code: null, retryable: true })
    expect(mockHttp).toHaveBeenCalledTimes(1)
    expect(repo.insertTransmission).toHaveBeenCalledTimes(1); expect(events).toHaveLength(0)
  })
})

describe('P8. CORRIDAS transmit × refresh quando a tentativa VIGENTE não é a última (tentativa 1 F, 2 R, a NFS-e existe pelo Id)', () => {
  beforeEach(() => { serializeTransactions() })
  it.each([
    ['refresh chega ANTES da reserva (fisco responde em 5 ms) → transmit 409 ALREADY_AUTHORIZED, POST nunca feito', 5, 30],
    ['reserva ANTES do refresh (fisco responde em 60 ms) → tentativa 3 vai ao fisco e leva R (Id repetido); a chave pousa na 1', 60, 0],
  ])('%s — no fim: exatamente UM A, na tentativa 1; vigente = 1 autorizada', async (_l, queryMs, transmitMs) => {
    const st = multiAttemptStore(
      [{ attempt: 1, ageMinutes: 60 }, { attempt: 2, ageMinutes: 30 }],
      [{ attempt: 1, kind: 'F' }, { attempt: 2, kind: 'R', authorityCode: 'E0001' }],
    )
    adapter.queryDpsAccessKey.mockImplementation(() => delay(queryMs, () => KEY))
    adapter.queryNfse.mockImplementation(() => delay(queryMs, authorizedVoice))
    adapter.transmit.mockImplementation(() => new Promise((_r, rej) => setTimeout(() => rej(dpsRejected('E0001')), transmitMs)))
    const [r, t] = await Promise.allSettled([
      refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q'),
      transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE),
    ])
    expect(r.status).toBe('fulfilled'); expect((r as PromiseFulfilledResult<any>).value).toMatchObject({ attempt: 1, kind: 'A', changed: true })
    expect(t.status).toBe('rejected')
    const reason = (t as PromiseRejectedResult).reason
    expect([ErrorCodes.FISCAL_ALREADY_AUTHORIZED, ErrorCodes.FISCAL_DPS_REJECTED]).toContain(reason.code)
    expect(events.filter(e => e.kind === 'A')).toEqual([expect.objectContaining({ attempt: 1 })])
    expect(st.all().filter(x => x.accessKey)).toHaveLength(1)
    expect(st.latest()).toMatchObject({ attempt: 1, lastKind: 'A', accessKey: KEY })
    if (reason.code === ErrorCodes.FISCAL_ALREADY_AUTHORIZED) expect(adapter.transmit).not.toHaveBeenCalled()
    else { expect(adapter.transmit).toHaveBeenCalledTimes(1); expect(kindsOf(3)).toEqual(['R']) }
  })
})
