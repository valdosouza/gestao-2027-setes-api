/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 17 das APIs fiscais (D-F91…D-F93, Valdo 2026-10-11 "siga as recomendações") — setes-api (caminho de
// PRODUÇÃO da NFS-e). Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta no setes-api: D-F91 (`logAmbiguousFiscal` + invólucro do `refreshServiceTransmission` → origem "consulta"; o rodízio
// → "rodizio"; `reconfirmBeforeLocalCancel` → `reconfirmCandidate` dentro de try/catch → "reconferencia") e D-F93
// (`shared/tax-authority/adapters/adn.ts` — `eventSignature` soma nDFSe, autor, ambGer e tpAmb lidos por `tagText`).
//
//  * ACHADOS (`it.failing('[SEV R17-xx] …')`) — o teste afirma o que a spec promete e FALHA no código atual: é a prova do bug.
//    O corretor troca `it.failing` por `it` depois de corrigir. NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (ficam como regressão).
//  * CONTEXTO (`it('contexto …')`) — fixa o comportamento atual que fundamenta um achado/questão.
//
// REGRAS DO GATE: nenhum socket (transporte `transport.request` mockado), nenhum banco (pool/conn/repositório mockados na
// fronteira — harness copiado do `adversarial-r11-gate.test.ts`), nada que fale com o fisco, nenhuma migration.
// ⚠️ Este arquivo NÃO é importado pelo `tsx watch` do dev (só o jest o carrega).
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import forge from 'node-forge'
import { gzipSync, gunzipSync } from 'zlib'

const SECRETS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-adv-r17-secrets-'))
const STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-adv-r17-storage-'))
process.env.SECRETS_PATH = SECRETS_ROOT
process.env.STORAGE_PATH = STORAGE_ROOT
process.env.JWT_SECRET = 'adversarial-r17'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVR17'), recordCrash: jest.fn().mockResolvedValue(undefined),
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
// Ferramentas da Rodada 17
// ===========================================================================
import { reconfirmBeforeLocalCancel, logAmbiguousFiscal } from '../shared/invoice-transmission/invoice-transmission'

const INVOICE_B = 6301
const KEY_B = `${KEY.slice(0, -1)}8`
const ambiguousLogs = () => (logger.error as jest.Mock).mock.calls.filter((c: any[]) => /Fisco ambíguo persistente/.test(String(c[0])))
const origins = () => ambiguousLogs().map((c: any[]) => c[1]?.origin)
const unknownBoom = () => new HttpError(502, 'Fisco respondeu sem situação legível para a NFS-e', undefined, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE)
/** GET tipado contraditório (D-F84): e101101 + e105102 desta chave na rota 101101 → 502 ambíguo. */
const CONTRA = (code: string) => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml({ code: '101101' }))), substItem()) : undefined)
/** F "envio interrompido" por CONSULTA em PRODUÇÃO — a candidata da reconferência (Q-ADV1b). */
const fCand = (over: any = {}) => tx({ attempt: 1, environment: 'P', accessKey: null, nfseNumber: null, dhProc: null, lastKind: 'F', lastSource: 'Q', lastEvent: 2, ...over })
/** CPF fictício (dígitos verificadores válidos) de um PRESTADOR pessoa física — um TERCEIRO (tpInsc 1 no Id do DPS). */
const THIRD_CPF = '12345678909'
const FOREIGN_DPS_ID = `DPS41069021000${THIRD_CPF}00001000000000000077`
/** Reconferência em P com a candidata F (tentativa 1) — o estado de partida dos ataques à reconferência. */
function reconfirmScenario(f = fCand()) {
  ;(repo.listServiceTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f], events: [] })
  setTx(f)
  return f
}
const orderIndependent = async (a: string, b: string) => {
  mockHttp.mockReset(); sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(a)), typedItem(arquivo2(b))) : undefined) })
  const ab = await adnAdapter.queryNfse(ctxH, KEY)
  mockHttp.mockReset(); sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(b)), typedItem(arquivo2(a))) : undefined) })
  const ba = await adnAdapter.queryNfse(ctxH, KEY)
  return { ab, ba, ok: (ab.status === 'unknown' && ba.status === 'unknown') || ab.cancelled?.eventXml === ba.cancelled?.eventXml }
}

// ===========================================================================
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

/** D-F95 (Rodada 18): a consulta pedida pela TELA diz a origem — o invólucro não a deduz mais pela ausência de flags. */
const SCREEN = { origin: 'consulta' as const }

describe('ACHADO R17-01 (LOW) — D-F93: `tagText` é MAIS ESTRITO que o leitor do evento (`firstText` do parseEventXml aceita atributos, CDATA e entidades): com atributo ou CDATA nos 4 campos novos os dois lados leem null → divergência real passa como "repetição" e o XML ARQUIVADO volta a depender da ordem da lista (a R16-01 reabre por outra forma); com CDATA/entidade × texto do MESMO valor, repetição legítima vira ambígua', () => {
  const base = generatedEventXml({ code: '101101' })
  it('[CORRIGIDO — Rodada 18] [LOW R17-01] nDFSe com ATRIBUTO (`<nDFSe versao="1">1</nDFSe>` × `…>2</nDFSe>`, mesmo Id) → ambíguo nas duas ordens OU o mesmo XML nas duas ordens', async () => {
    const a = base.replace('<nDFSe>1</nDFSe>', '<nDFSe versao="1">1</nDFSe>')
    const b = base.replace('<nDFSe>1</nDFSe>', '<nDFSe versao="1">2</nDFSe>')
    expect((await orderIndependent(a, b)).ok).toBe(true)          // hoje: cancelled nas duas, com o XML do 1º item de cada lista
  })
  it('[CORRIGIDO — Rodada 18] [LOW R17-01] CNPJAutor em CDATA (`<![CDATA[A]]>` × `<![CDATA[B]]>`, mesmo Id) → ambíguo nas duas ordens OU o mesmo XML', async () => {
    const a = base.replace(`<CNPJAutor>${CNPJ}</CNPJAutor>`, `<CNPJAutor><![CDATA[${CNPJ}]]></CNPJAutor>`)
    const b = base.replace(`<CNPJAutor>${CNPJ}</CNPJAutor>`, '<CNPJAutor><![CDATA[98765432000188]]></CNPJAutor>')
    expect((await orderIndependent(a, b)).ok).toBe(true)
  })
  it('[D-F96] as duas formas (atributo, CDATA divergentes) → AMBÍGUO nas DUAS ordens (o leitor do parse lê o valor)', async () => {
    const forms: [string, string][] = [
      [base.replace('<nDFSe>1</nDFSe>', '<nDFSe versao="1">1</nDFSe>'), base.replace('<nDFSe>1</nDFSe>', '<nDFSe versao="1">2</nDFSe>')],
      [base.replace(`<CNPJAutor>${CNPJ}</CNPJAutor>`, `<CNPJAutor><![CDATA[${CNPJ}]]></CNPJAutor>`), base.replace(`<CNPJAutor>${CNPJ}</CNPJAutor>`, '<CNPJAutor><![CDATA[98765432000188]]></CNPJAutor>')],
    ]
    for (const [a, b] of forms) {
      const r = await orderIndependent(a, b)
      expect([r.ab.status, r.ba.status]).toEqual(['unknown', 'unknown'])
    }
  })
  it('[D-F96] liveness: CDATA × texto segue contando como conteúdo diferente (ambíguo, fail-closed); entidade numérica × literal nunca deixa o arquivo depender da ordem', async () => {
    const cdata = base.replace('<nDFSe>1</nDFSe>', '<nDFSe><![CDATA[1]]></nDFSe>')
    const entity = base.replace('<ambGer>2</ambGer>', '<ambGer>&#50;</ambGer>')
    mockHttp.mockReset(); sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(base)), typedItem(arquivo2(cdata))) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH, KEY)).status).toBe('unknown')
    // entidade × literal: ou é a MESMA voz (o parse des-escapa) ou é ambígua — nunca um XML arquivado que dependa da ordem
    expect((await orderIndependent(base, entity)).ok).toBe(true)
  })
  it('[D-F96 (c)] divergência em `verAplic` (fora da assinatura) passa como repetição — e o XML arquivado é o MESMO nas duas ordens (escolha determinística)', async () => {
    const v2 = base.replace('<verAplic>SEFIN</verAplic>', '<verAplic>SEFIN-2</verAplic>')
    const r = await orderIndependent(base, v2)
    expect(r.ab.status).toBe('cancelled'); expect(r.ba.status).toBe('cancelled')
    expect(r.ok).toBe(true)
  })
})

describe('ACHADO R17-02 (LOW) — D-F91: o alarme leva `err: errMsg(err)`; a mensagem do 502 "NFS-e de OUTRO DPS" (resposta trocada) traz o Id do DPS ALHEIO, que embute o CPF/CNPJ do prestador de OUTRA nota (tpInsc 1 = CPF) — a consulta da tela e a reconferência passaram a jogar isso no log de ERRO (o rodízio já jogava desde a D-F87)', () => {
  const foreign = () => ({ accessKey: KEY, status: 'authorized' as const, nfseXml: nfseXmlFor(KEY, FOREIGN_DPS_ID), dhProc: '2026-09-21T10:15:30-03:00' })
  it('[D-F94] a consulta da tela com a NFS-e de OUTRO DPS → 502 e UM alarme "consulta" com o CÓDIGO e um rótulo SEM DÍGITOS (nada do Id alheio)', async () => {
    withAuthorizedTx()
    adapter.queryNfse.mockResolvedValue(foreign())
    const out = await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', SCREEN))
    expect(out).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(origins()).toEqual(['consulta'])
    expect(ambiguousLogs()[0][1]).toMatchObject({ code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(ambiguousLogs()[0][1].err).toBeUndefined()
    expect(String(ambiguousLogs()[0][1].reason)).not.toMatch(/\d/)
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
  })
  it('[CORRIGIDO — Rodada 18] [LOW R17-02] o alarme do ambíguo nunca carrega documento (CPF/CNPJ) de TERCEIRO', async () => {
    withAuthorizedTx()
    adapter.queryNfse.mockResolvedValue(foreign())
    await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', SCREEN))
    expect(ambiguousLogs()).toHaveLength(1)
    expect(JSON.stringify(ambiguousLogs()[0][1])).not.toContain(THIRD_CPF)
  })
})

describe('ACHADO R17-03 (LOW) — D-F91: o invólucro trata "sem `query` e sem `fromRun`" como "consulta da TELA", mas o TRANSMITIR também chama o refresh assim (passo 0b, reserva interrompida → `reconcileInterrupted`): o ambíguo da transmissão vai ao alarme rotulado "consulta"; e o GET /dps ambíguo do MESMO passo (fora do refresh) não vai ao alarme', () => {
  const interrupted = () => inFlightNow({ ageMinutes: IN_FLIGHT_MINUTES + 5 })
  it('[D-F95] transmitir com a reserva interrompida; o GET /dps acha a chave e a leitura da NFS-e é ambígua → 502 (nada reservado, nada enviado) e UM alarme "transmissao"', async () => {
    setTx(interrupted())
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'unknown', nfseXml: NFSE_XML, dhProc: null })
    const out = await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))
    expect(out).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(adapter.transmit).not.toHaveBeenCalled(); expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(origins()).toEqual(['transmissao'])
  })
  it('[CORRIGIDO — Rodada 18] [LOW R17-03] o ambíguo que nasce no TRANSMITIR nunca é rotulado como a consulta pedida pela TELA (D-F91: "só para a consulta da TELA")', async () => {
    setTx(interrupted())
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'unknown', nfseXml: NFSE_XML, dhProc: null })
    await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))
    expect(origins()).not.toContain('consulta')
  })
  it('[D-F95] no MESMO passo 0b, o GET /dps AMBÍGUO (antes do refresh) sobe 502 e alarma "transmissao" — a nota alarma onde quer que a ambiguidade nasça', async () => {
    setTx(interrupted())
    adapter.queryDpsAccessKey.mockRejectedValue(unknownBoom())
    const out = await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))
    expect(out).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(origins()).toEqual(['transmissao'])
  })
})

// ===========================================================================
// RESISTIU — D-F91: o invólucro é transparente
// ===========================================================================

describe('RESISTIU — D-F91: o invólucro do `refreshServiceTransmission` não muda valor nem exceção', () => {
  it('resistiu: caminho feliz — a consulta da tela devolve o MESMO resultado (autorizada, sem mudança) e não alarma', async () => {
    useRealAdn(); withAuthorizedTx(); sefin({})
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', SCREEN)
    expect(r).toEqual({ invoiceId: INVOICE, attempt: 1, changed: false, kind: 'A', accessKey: KEY, invoiceEvent: null, effectRefused: null })
    expect(ambiguousLogs()).toHaveLength(0)
  })
  it('resistiu: a exceção que sobe é a MESMA instância — a ambígua alarma 1×; 503, recusa de regra, erro técnico e lançamento não-Error sobem intactos e sem alarme', async () => {
    withAuthorizedTx()
    const boom = unknownBoom()
    adapter.queryNfse.mockRejectedValueOnce(boom)
    expect(await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', SCREEN))).toBe(boom)
    expect(origins()).toEqual(['consulta'])
    for (const e of [unavailable(), dpsRejected(), new Error('ECONNRESET do banco'), 'lançamento cru'] as unknown[]) {
      ;(logger.error as jest.Mock).mockClear()
      adapter.queryNfse.mockRejectedValueOnce(e)
      expect(await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', SCREEN))).toBe(e)
      expect(ambiguousLogs()).toHaveLength(0)
    }
  })
  it('resistiu: erro SÍNCRONO do corpo (schema inválido — assertSchema) sobe intacto, sem alarme e sem ir ao fisco', async () => {
    const out = await settle(refreshServiceTransmission("x`; DROP DATABASE --", S.inst, S.user, INVOICE, 'Q'))
    expect(out).toMatchObject({ statusCode: 400 })
    expect(ambiguousLogs()).toHaveLength(0); expect(mockHttp).not.toHaveBeenCalled()
  })
  it('resistiu: `logAmbiguousFiscal` filtra pelo CÓDIGO na classe certa e nunca lança (undefined, null, objeto "parecido", HttpError de outro código); AuthorityHttpError 502 ambíguo alarma', () => {
    const at = { institutionId: S.inst, invoiceId: INVOICE }
    for (const e of [undefined, null, { code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, message: 'imitação' }, new HttpError(502, 'x', undefined, ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE)]) {
      expect(() => logAmbiguousFiscal('consulta', at, e)).not.toThrow()
    }
    expect(ambiguousLogs()).toHaveLength(0)
    logAmbiguousFiscal('rodizio', at, new AuthorityHttpError(502, 'ambíguo', ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, 200, '{}'))
    expect(ambiguousLogs()).toHaveLength(1)
    expect(Object.keys(ambiguousLogs()[0][1]).sort()).toEqual(['attempt', 'code', 'institutionId', 'invoiceId', 'lastKind', 'origin', 'reason'])   // D-F94
  })
})

// ===========================================================================
// RESISTIU — D-F91: UM alarme por chamada, origem certa, nunca a chave de acesso
// ===========================================================================

describe('RESISTIU — D-F91: sem duplicata (rodízio × invólucro × reconferência) e sem a chave de acesso', () => {
  it('resistiu: passada com DUAS notas ambíguas → DOIS alarmes "rodizio" (um por nota, tentativa certa), nenhum "consulta"', async () => {
    const txA = tx({ invoiceId: INVOICE, accessKey: KEY })
    const txB = tx({ invoiceId: INVOICE_B, accessKey: KEY_B, attempt: 2 })
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([txA, txB])
    const byInvoice = async (_q: any, _s: any, _i: any, inv: number) => (inv === INVOICE_B ? txB : txA)
    ;(repo.getTransmission as jest.Mock).mockImplementation(byInvoice)
    ;(repo.latestTransmission as jest.Mock).mockImplementation(byInvoice)
    adapter.queryNfse.mockRejectedValue(unknownBoom())
    const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(r).toMatchObject({ checked: 2, stoppedEarly: false })
    expect(origins()).toEqual(['rodizio', 'rodizio'])
    expect(ambiguousLogs().map((c: any[]) => [c[1].invoiceId, c[1].attempt])).toEqual([[INVOICE, 1], [INVOICE_B, 2]])
  })
  it('resistiu: reconferência com GET /dps AMBÍGUO (404 do gateway, sem o corpo do fisco) → 502 e UM alarme "reconferencia" com a tentativa da candidata; o refresh nem roda', async () => {
    useRealAdn(); reconfirmScenario()
    sefin({ dps: () => notFound() })
    const out = await settle(reconfirmBeforeLocalCancel(S.schema, S.inst, S.user, INVOICE))
    expect(out).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(origins()).toEqual(['reconferencia'])
    expect(ambiguousLogs()[0][1]).toMatchObject({ institutionId: S.inst, invoiceId: INVOICE, attempt: 1 })
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
  })
  it('resistiu: reconferência — a chave aparece e a leitura dela é ambígua (405 na rota de evento): UM alarme "reconferencia", nunca "consulta", sem a chave de acesso', async () => {
    useRealAdn(); reconfirmScenario()
    sefin({ dps: () => ok({ chaveAcesso: KEY }), typed: () => ({ status: 405, headers: { allow: 'POST' }, text: '' }) })
    const out = await settle(reconfirmBeforeLocalCancel(S.schema, S.inst, S.user, INVOICE))
    expect(out).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(origins()).toEqual(['reconferencia'])
    expect(JSON.stringify(ambiguousLogs()[0][1])).not.toContain(KEY)
  })
  it('resistiu: reconferência sem ambiguidade — 503 no GET /dps e "NFS-e existe mas não pousou" (409) sobem iguais e NÃO alarmam', async () => {
    useRealAdn(); reconfirmScenario()
    sefin({ dps: () => ({ status: 503, headers: {}, text: '' }) })
    expect(await settle(reconfirmBeforeLocalCancel(S.schema, S.inst, S.user, INVOICE))).toMatchObject({ statusCode: 503, code: ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE })
    // "não há evento" no envelope de PRODUÇÃO (tipoAmbiente 1 — regra do L8): a NFS-e lida é autorizada e limpa
    mockHttp.mockReset(); sefin({ dps: () => ok({ chaveAcesso: KEY }), typed: () => ({ status: 404, headers: {}, text: JSON.stringify({ ...SEFIN, tipoAmbiente: 1 }) }) })
    expect(await settle(reconfirmBeforeLocalCancel(S.schema, S.inst, S.user, INVOICE))).toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_TRANSMISSION_IN_PROGRESS })
    expect(ambiguousLogs()).toHaveLength(0)
  })
  it('resistiu: reconferência sem candidata (homologação / já há chave) → nada pergunta, nada alarma', async () => {
    useRealAdn(); reconfirmScenario(fCand({ environment: 'H' }))
    await reconfirmBeforeLocalCancel(S.schema, S.inst, S.user, INVOICE)
    reconfirmScenario(fCand({ accessKey: KEY }))
    await reconfirmBeforeLocalCancel(S.schema, S.inst, S.user, INVOICE)
    expect(mockHttp).not.toHaveBeenCalled(); expect(ambiguousLogs()).toHaveLength(0)
  })
  it('resistiu: a consulta da tela — nenhuma variante de ambíguo leva a chave de acesso ao alarme (D-F84 contraditório, 200 com lista vazia, 404 fora do envelope, 401 na rota de evento, 405)', async () => {
    useRealAdn()
    const variants: ((code: string) => any)[] = [
      CONTRA,
      code => (code === '101101' ? typedOk() : undefined),
      code => (code === '101101' ? { status: 404, headers: {}, text: '<html>gateway</html>' } : undefined),
      code => (code === '101101' ? { status: 401, headers: {}, text: '' } : undefined),
      () => ({ status: 405, headers: { allow: 'POST' }, text: '' }),
    ]
    for (const typed of variants) {
      ;(logger.error as jest.Mock).mockClear(); withAuthorizedTx()
      mockHttp.mockReset(); sefin({ typed })
      expect(await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', SCREEN))).toMatchObject({ statusCode: 502 })
      expect(origins()).toEqual(['consulta'])
      expect(JSON.stringify(ambiguousLogs()[0][1])).not.toContain(KEY)
    }
  })
})

// ===========================================================================
// RESISTIU — D-F93: os 4 campos novos e a repetição legítima
// ===========================================================================

describe('RESISTIU — D-F93 no adaptador ADN do setes-api', () => {
  const base = generatedEventXml({ code: '101101' })
  it('resistiu: cada um dos 4 campos novos divergente (nDFSe, CNPJAutor, CNPJAutor × CPFAutor, ambGer, tpAmb) → ambíguo', async () => {
    const variants = [
      base.replace('<nDFSe>1</nDFSe>', '<nDFSe>2</nDFSe>'),
      base.replace(`<CNPJAutor>${CNPJ}</CNPJAutor>`, '<CNPJAutor>98765432000188</CNPJAutor>'),
      base.replace(`<CNPJAutor>${CNPJ}</CNPJAutor>`, `<CPFAutor>${THIRD_CPF}</CPFAutor>`),
      base.replace('<ambGer>2</ambGer>', '<ambGer>1</ambGer>'),
      base.replace('<tpAmb>2</tpAmb>', '<tpAmb>1</tpAmb>'),
    ]
    for (const v of variants) {
      expect(v).not.toBe(base)
      mockHttp.mockReset(); sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(base)), typedItem(arquivo2(v))) : undefined) })
      expect((await adnAdapter.queryNfse(ctxH, KEY)).status).toBe('unknown')
    }
  })
  it('resistiu: repetição LEGÍTIMA — espaços/quebras em volta dos valores dos 4 campos e declaração XML → cancelled', async () => {
    const spaced = '<?xml version="1.0" encoding="UTF-8"?>\n' + base
      .replace('<nDFSe>1</nDFSe>', '<nDFSe>\n  1 </nDFSe>').replace('<ambGer>2</ambGer>', '<ambGer> 2</ambGer>')
      .replace('<tpAmb>2</tpAmb>', '<tpAmb>2\n</tpAmb>').replace(`<CNPJAutor>${CNPJ}</CNPJAutor>`, `<CNPJAutor>\t${CNPJ} </CNPJAutor>`)
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(base)), typedItem(arquivo2(spaced))) : undefined) })
    expect(await adnAdapter.queryNfse(ctxH, KEY)).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101' } })
  })
  it('resistiu: prefixo de namespace em TODO o evento (`<ns:evento>…`) → o leitor não reconhece evento gerado → ambíguo (nunca "cancelled" com assinatura vazia)', async () => {
    const prefixed = base.replace(/<(\/?)([A-Za-z])/g, '<$1ns:$2').replace('xmlns=', 'xmlns:ns=')
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(prefixed)), typedItem(arquivo2(prefixed.replace('<ns:nDFSe>1', '<ns:nDFSe>2')))) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH, KEY)).status).toBe('unknown')
  })
})
