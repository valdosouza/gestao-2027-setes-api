/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 19 das APIs fiscais (D-F98…D-F99, Valdo 2026-10-11) — setes-api (caminho de PRODUÇÃO da NFS-e até a F2a).
// Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta no setes-api: D-F98 (= Q-F104 (b)+(c)) — `shared/tax-authority/ambiguous-cause.ts` (ESPELHO do núcleo), o 405/406/415
// do transporte marcado `rota-nao-atendida`, o `unknownResponse(causa, …)` e o 401/403 de evento do `adapters/adn.ts`, e na composição
// `shared/invoice-transmission/invoice-transmission.ts` ("OUTRO DPS" sem o Id do terceiro, "situação ilegível", "evento contraditório");
// o alarme `logAmbiguousFiscal` leva `reason = ambiguousCauseOf(err)`. D-F99 não tem consumidor no setes-api (é da F2a).
//
//  * ACHADOS (`it.failing('[SEV R19-xx] …')`) — o teste afirma o que a spec/decisão promete e FALHA no código atual: é a prova do bug.
//    O corretor troca `it.failing` por `it` depois de corrigir (ou de decidida a questão). NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (ficam como regressão).
//  * CONTEXTO (`it('contexto …')`) — fixa o comportamento atual que fundamenta um achado/questão (e prova que o cenário do
//    `it.failing` vizinho monta de verdade — o `it.failing` só afirma a última coisa).
//
// REGRAS DO GATE: nenhum socket (transporte `transport.request` mockado), nenhum banco (pool/conn/repositório mockados na
// fronteira — harness copiado do `adversarial-r18-gate.test.ts`), nada que fale com o fisco, nenhuma migration.
// ⚠️ Este arquivo NÃO é importado pelo `tsx watch` do dev (só o jest o carrega).
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import forge from 'node-forge'
import { gzipSync, gunzipSync } from 'zlib'

const SECRETS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-adv-r19-secrets-'))
const STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-adv-r19-storage-'))
process.env.SECRETS_PATH = SECRETS_ROOT
process.env.STORAGE_PATH = STORAGE_ROOT
process.env.JWT_SECRET = 'adversarial-r19'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVR19'), recordCrash: jest.fn().mockResolvedValue(undefined),
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
// Gate R19 (R19-03): a chave de teste segue o layout REAL (conferido nas 3 chaves de produção em 2026-10-11) — cMun(7) + ambGer(1) +
// tpInsc(1) + inscrição(14) + nNFSe(13) + AAMM(4) + código(9) + DV(1); a antiga não tinha o tpInsc e o GET /dps agora confere o emitente
const KEY = '4106902' + '2' + '2' + '12345678000199' + '0000000000123' + '2609' + '000012345' + '1'
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
    if (/tb_institution_has_interface/.test(sql)) return [[{ 1: 1 }]]                 // D-F37 (F2a A2): licenca do ramo conferida por item no lote
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
// Ferramentas da Rodada 18
// ===========================================================================

/** D-F95: a consulta pedida pela TELA diz a origem. */
const SCREEN = { origin: 'consulta' as const }
/** CNPJ ALFANUMÉRICO (formato da RFB para inscrições NOVAS desde 07/2026: 12 posições alfanuméricas + 2 DV numéricos) — exemplo da RFB. */
const ALNUM_CNPJ = '12ABC34501DE35'
/** Id de DPS de um TERCEIRO com CNPJ alfanumérico (tpInsc 2) — o que a resposta TROCADA traz no `infDPS/@Id`. */
const FOREIGN_ALNUM_DPS_ID = `DPS41069022${ALNUM_CNPJ}00001000000000000077`
const reasonOf = (i = 0) => String(ambiguousLogs()[i]?.[1]?.reason ?? '')
const foreignVoice = (dpsId: string) => ({ accessKey: KEY, status: 'authorized' as const, nfseXml: nfseXmlFor(KEY, dpsId), dhProc: '2026-09-21T10:15:30-03:00' })
const SRC_ROOT = path.resolve(__dirname, '..')
const PROJECT_ROOT = path.resolve(SRC_ROOT, '..')
const walkTs = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : walkTs(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []))
const uncomment = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ===========================================================================
// Ferramentas da Rodada 19
// ===========================================================================
import { AMBIGUOUS_CAUSES, ambiguousCauseOf, tagAmbiguous } from '../shared/tax-authority/ambiguous-cause'

const causeOf = (i = 0) => ambiguousLogs()[i]?.[1]?.reason
/** Todo texto que saiu por log — no setes-api o transporte loga pelo MESMO logger (mockado no topo). */
const allLogs = () => JSON.stringify([(logger.info as jest.Mock).mock.calls, (logger.warn as jest.Mock).mock.calls, (logger.error as jest.Mock).mock.calls])
/** Chave de 50 dígitos de OUTRO emitente — prestador PF (tpInsc 1, inscrição = 000 + CPF do terceiro). */
const FOREIGN_KEY = `4106902${'1'}${'1'}000${THIRD_CPF}${'0000000000077'}2610${'000000000'}1`
const foreignNfse = (dpsId: string) => ok({ nfseXmlGZipB64: gz(nfseXmlFor(KEY, dpsId)) })
/** "Não há esse evento" para PRODUÇÃO (tipoAmbiente 1 — o envelope tem de ser do ambiente perguntado). */
const sefinNoneP = () => ({ status: 404, headers: {}, text: JSON.stringify({ ...SEFIN, tipoAmbiente: 1 }) })
const sefinP = (o: Parameters<typeof sefin>[0] = {}) => sefin({ typed: () => sefinNoneP(), ...o })
const THIRD_PARTIES = [
  { label: 'CPF', dpsId: FOREIGN_DPS_ID, needles: [THIRD_CPF, FOREIGN_DPS_ID] },
  { label: 'CNPJ alfanumérico', dpsId: FOREIGN_ALNUM_DPS_ID, needles: [ALNUM_CNPJ, FOREIGN_ALNUM_DPS_ID, 'ABC34501DE', 'ABC'] },
]
/** Tudo o que a porta produziu: mensagem/campos do erro, relatório, logs, vozes gravadas e escritas do fisco. */
const haystack = (out: any) => JSON.stringify([out?.message ?? null, out?.fields ?? null, out, allLogs(), events,
  (repo.insertTransmissionEvent as jest.Mock).mock.calls.map(c => c.slice(1)), (repo.fillAuthorityData as jest.Mock).mock.calls.map(c => c.slice(1))])
const unknownVoice = () => ({ accessKey: KEY, status: 'unknown' as const, nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })

/** Cada ocorrência de `FISCAL_AUTHORITY_UNKNOWN_RESPONSE` no código (sem comentários) — molde da cerca do r19 do núcleo. */
type Site = { file: string; kind: 'definicao' | 'comparacao' | 'conjunto' | 'produtor' | 'DESCONHECIDO'; tagged?: boolean; cause?: string | null }
function ambiguousSites(roots: string[], base: string): Site[] {
  const out: Site[] = []
  for (const f of roots.flatMap(walkTs)) {
    const code = uncomment(fs.readFileSync(f, 'utf8'))
    if (!code.includes('FISCAL_AUTHORITY_UNKNOWN_RESPONSE')) continue
    const rel = path.relative(base, f).replace(/\\/g, '/')
    const re = /FISCAL_AUTHORITY_UNKNOWN_RESPONSE/g
    let m: RegExpExecArray | null
    while ((m = re.exec(code))) {
      const lineStart = code.lastIndexOf('\n', m.index) + 1
      const nl = code.indexOf('\n', m.index)
      const line = code.slice(lineStart, nl === -1 ? undefined : nl)
      if (/^\s*FISCAL_AUTHORITY_UNKNOWN_RESPONSE\s*:/.test(line)) { out.push({ file: rel, kind: 'definicao' }); continue }
      const before = code.slice(Math.max(0, m.index - 600), m.index)
      if (/(===|!==)\s*(ErrorCodes\.)?$/.test(before)) { out.push({ file: rel, kind: 'comparacao' }); continue }
      const ctor = Math.max(before.lastIndexOf('new HttpError('), before.lastIndexOf('new AuthorityHttpError('))
      // o texto entre o construtor e o código, sem o conteúdo das strings (mensagem com ';' não fecha a instrução)
      const between = ctor >= 0 ? before.slice(ctor).replace(/'[^'\n]*'|`[^`]*`|"[^"\n]*"/g, "''") : ''
      if (ctor >= 0 && !/;|\n\s*\n/.test(between)) {
        const tagged = /tagAmbiguous\($/.test(before.slice(0, ctor).replace(/\s+$/, ''))
        const cause = tagged ? (code.slice(m.index, m.index + 400).match(/^[^;]*?\)\s*,\s*(?:(?:nfse\.unknownCause \?\? )?'([^']*)'|(cause))\s*\)/)?.slice(1).find(Boolean) ?? null) : null
        out.push({ file: rel, kind: 'produtor', tagged, cause })
        continue
      }
      if (/new Set[^;]*$/.test(before)) { out.push({ file: rel, kind: 'conjunto' }); continue }
      out.push({ file: rel, kind: 'DESCONHECIDO' })
    }
  }
  return out
}
const unknownResponseCauses = (file: string) => [...uncomment(fs.readFileSync(file, 'utf8')).matchAll(/unknownResponse\(\s*([^,\s)]+)/g)].map(m => m[1])
const causePairs = (file: string) => [...uncomment(fs.readFileSync(file, 'utf8')).matchAll(/unknownResponse\('([a-z-]+)',\s*([^,]+),/g)].map(m => `${m[1]} :: ${m[2]}`)

// ===========================================================================
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO R19-04 (LOW, fora do delta mas NO caminho produtor → alarme) — o `withInvoiceTx` do setes-api faz `await conn.rollback()` SEM guarda (invoice-transmission.ts:89-91): se o rollback falha (conexão caída), o erro do rollback SUBSTITUI o ambíguo lançado DENTRO da transação (`situacao-ilegivel` e `evento-contraditorio` — invoice-transmission.ts:468/663). O alarme some (o erro não é HttpError), a tela recebe 500 com ref, e no rodízio a nota não é carimbada. O `withTransaction` do núcleo (nfse-api) já engole a falha do rollback — o espelho divergiu', () => {
  const rollbackDies = () => conn.rollback.mockRejectedValueOnce(Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST' }))
  it('[CORRIGIDO na sessão — R19-04] consulta da tela, situação ilegível (502 marcado DENTRO da transação) + rollback que falha → sai o AMBÍGUO (nunca o erro do rollback) e UM alarme', async () => {
    withAuthorizedTx()
    adapter.queryNfse.mockResolvedValue(unknownVoice())
    rollbackDies()
    const out = await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', SCREEN))
    expect(out).toBeInstanceOf(HttpError)
    expect(String(out?.message)).not.toMatch(/Connection lost/)
    expect(ambiguousLogs()).toHaveLength(1)
  })
  it('[CORRIGIDO na sessão] [LOW R19-04] consulta da tela: o ambíguo lançado dentro da transação chega ao chamador e ao alarme com a causa `situacao-ilegivel`, mesmo com o rollback falhando', async () => {
    withAuthorizedTx()
    adapter.queryNfse.mockResolvedValue(unknownVoice())
    rollbackDies()
    expect(await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', SCREEN))).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(causeOf()).toBe('situacao-ilegivel')
  })
  it('[CORRIGIDO na sessão] [LOW R19-04] rodízio: a mesma falha conta como "persistente" — alarme "rodizio" e carimbo da vez (hoje: erro cru, sem alarme, sem carimbo — a nota volta à frente da fila)', async () => {
    withAuthorizedTx()
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([tx({ lastKind: 'A' })])
    adapter.queryNfse.mockResolvedValue(unknownVoice())
    rollbackDies()
    await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(origins()).toEqual(['rodizio'])
    expect(repo.touchQueriedAt).toHaveBeenCalledWith(pool, S.schema, S.inst, INVOICE, 1)
  })
})

describe('ACHADO R19-03 (LOW, fora do delta — a mesma classe do R18-02, por outra porta; também na nfse-api) — a chave do `GET /dps/{id}` NÃO é conferida contra o emitente da nota (`adapters/adn.ts` `queryDpsAccessKey` aceita `chaveAcesso`/`chave` ou QUALQUER 50 dígitos do corpo); numa resposta TROCADA ela é de OUTRO emitente e EMBUTE o CPF/CNPJ dele. Vira URL do `GET /nfse/{chave}`, e o transporte (`tax-authority/https-json.ts`) grava a URL no log em 405/406/415 e em falha de rede. A conferência por emitente existe (`sameIssuerKey`, D-F85 — invoice-transmission.ts:933) e não é usada aqui', () => {
  const inFlightP = () => inFlightNow({ environment: 'P' })
  it('[CORRIGIDO na sessão — R19-03] consulta da tela de tentativa SEM chave → GET /dps devolve a chave do TERCEIRO → 502 `dps-fora-do-contrato` ANTES de perguntar por ela; nenhum log leva o documento', async () => {
    useRealAdn(); setTx(inFlightP())
    sefinP({ dps: () => ok({ chaveAcesso: FOREIGN_KEY }), nfse: () => ({ status: 405, headers: { allow: 'POST' }, text: '' }) })
    const out = await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', SCREEN))
    expect(out).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(mockHttp.mock.calls.some((c: any[]) => String(c[0].url).endsWith(`/nfse/${FOREIGN_KEY}`))).toBe(false)
    expect(causeOf()).toBe('dps-fora-do-contrato')
    expect(JSON.stringify(ambiguousLogs())).not.toContain(THIRD_CPF)
    expect(allLogs()).not.toContain(THIRD_CPF)
  })
  it('[CORRIGIDO na sessão] [LOW R19-03] a chave de OUTRO emitente vinda do GET /dps nunca é perguntada ao fisco (falha FECHADO antes — ambígua `dps-fora-do-contrato`)', async () => {
    useRealAdn(); setTx(inFlightP())
    sefinP({ dps: () => ok({ chaveAcesso: FOREIGN_KEY }), nfse: () => ({ status: 405, headers: {}, text: '' }) })
    await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', SCREEN))
    expect(mockHttp.mock.calls.some((c: any[]) => String(c[0].url).includes(FOREIGN_KEY))).toBe(false)
  })
  it('[CORRIGIDO na sessão] [LOW R19-03] …e NENHUM log leva o documento do terceiro — 405 e falha de rede na consulta pela chave dele', async () => {
    useRealAdn()
    for (const nfse of [() => ({ status: 405, headers: {}, text: '' }), () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }]) {
      setTx(inFlightP())
      mockHttp.mockReset(); sefinP({ dps: () => ok({ chaveAcesso: FOREIGN_KEY }), nfse })
      await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', SCREEN))
    }
    expect(allLogs()).not.toContain(THIRD_CPF)
  })
  it('[CORRIGIDO na sessão — R19-03] (implausível) reconferência: GET /dps devolve a chave do terceiro e a NFS-e dele vem SEM o `infDPS/@Id` → a chave alheia NÃO pousa na tentativa 1 e nenhuma voz A nasce com ela', async () => {
    useRealAdn(); reconfirmScenario()
    const noDps = nfseXmlFor(FOREIGN_KEY).replace(/<DPS>[\s\S]*<\/DPS>/, '')
    sefinP({ dps: () => ok({ chaveAcesso: FOREIGN_KEY }), nfse: () => ok({ nfseXmlGZipB64: gz(noDps) }) })
    await settle(reconfirmBeforeLocalCancel(S.schema, S.inst, S.user, INVOICE))
    expect(JSON.stringify((repo.fillAuthorityData as jest.Mock).mock.calls)).not.toContain(FOREIGN_KEY)
    expect(kindsOf(1)).not.toContain('A')
  })
  it('[CORRIGIDO na sessão] [LOW R19-03] (mesma correção) reconferência: a chave de OUTRO emitente vinda do GET /dps nunca pousa na nossa tentativa', async () => {
    useRealAdn(); reconfirmScenario()
    const noDps = nfseXmlFor(FOREIGN_KEY).replace(/<DPS>[\s\S]*<\/DPS>/, '')
    sefinP({ dps: () => ok({ chaveAcesso: FOREIGN_KEY }), nfse: () => ok({ nfseXmlGZipB64: gz(noDps) }) })
    await settle(reconfirmBeforeLocalCancel(S.schema, S.inst, S.user, INVOICE))
    expect(JSON.stringify((repo.fillAuthorityData as jest.Mock).mock.calls.map(c => c.slice(1)))).not.toContain(FOREIGN_KEY)
  })
})

// ===========================================================================
// RESISTIU — D-F98: cerca estática + espelho
// ===========================================================================

describe('RESISTIU — D-F98: cerca estática do setes-api (todo produtor do ambíguo é marcado com causa da lista) e ESPELHO do núcleo', () => {
  it('resistiu: todo `FISCAL_AUTHORITY_UNKNOWN_RESPONSE` produzido em setes-api/src (fora dos testes) nasce DENTRO de `tagAmbiguous(…, causa)`; nenhuma outra forma de produzir o código', () => {
    const sites = ambiguousSites([SRC_ROOT], PROJECT_ROOT)
    expect(sites.filter(s => s.kind === 'DESCONHECIDO')).toEqual([])
    const producers = sites.filter(s => s.kind === 'produtor')
    expect(producers.filter(p => !p.tagged)).toEqual([])
    expect(producers.map(p => `${p.file} :: ${p.cause}`).sort()).toEqual([
      'src/shared/invoice-transmission/invoice-transmission.ts :: evento-contraditorio',
      'src/shared/invoice-transmission/invoice-transmission.ts :: nfse-de-outro-dps',
      'src/shared/invoice-transmission/invoice-transmission.ts :: situacao-ilegivel',
      'src/shared/tax-authority/adapters/adn.ts :: cause',                // o `unknownResponse(cause, …)` — conferido abaixo
      'src/shared/tax-authority/adapters/adn.ts :: evento-recusado',
      'src/shared/tax-authority/https-json.ts :: rota-nao-atendida',
    ])
    for (const p of producers.filter(x => x.cause !== 'cause')) expect(AMBIGUOUS_CAUSES as readonly string[]).toContain(p.cause)
  })
  it('[gate R19 — S3] toda `unknownCause:` do adaptador é LITERAL da lista FECHADA (a composição marca com ela; a reserva é `situacao-ilegivel`)', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'shared/tax-authority/adapters/adn.ts'), 'utf8')
    const causes = [...src.matchAll(/unknownCause:\s*([^,}\s]+)/g)].map(m => m[1])
    expect(causes.length).toBeGreaterThanOrEqual(6)
    for (const c of causes) {
      expect(c).toMatch(/^'[a-z-]+'$/)
      expect(AMBIGUOUS_CAUSES as readonly string[]).toContain(c.slice(1, -1))
    }
  })
  it('resistiu: toda chamada de `unknownResponse(` passa uma causa LITERAL da lista FECHADA (nunca `nao-classificada`, nunca variável)', () => {
    const causes = unknownResponseCauses(path.join(SRC_ROOT, 'shared/tax-authority/adapters/adn.ts')).filter(c => c !== 'cause:')
    expect(causes.length).toBeGreaterThan(0)
    for (const c of causes) {
      expect(c).toMatch(/^'[a-z-]+'$/)
      expect(AMBIGUOUS_CAUSES as readonly string[]).toContain(c.slice(1, -1))
    }
  })
  it('resistiu: ESPELHO — `ambiguous-cause.ts` do setes-api é o do núcleo palavra por palavra (só o comentário de cabeçalho difere): mesma lista, mesma chave `Symbol.for`, mesmas funções', () => {
    const core = path.resolve(PROJECT_ROOT, '..', 'fiscal-api', 'src', 'errors', 'ambiguous-cause.ts')
    if (!fs.existsSync(core)) return
    const body = (f: string) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').replace(/^\/\*\*[\s\S]*?\*\/\n/, '')
    expect(body(path.join(SRC_ROOT, 'shared/tax-authority/ambiguous-cause.ts'))).toBe(body(core))
    expect(fs.readFileSync(core, 'utf8')).toContain("Symbol.for('fiscal.ambiguousCause')")
  })
  it('resistiu: ESPELHO — os pares (causa, rótulo) do adaptador do setes-api são os MESMOS da nfse-api', () => {
    const nfse = path.resolve(PROJECT_ROOT, '..', 'nfse-api', 'src', 'authority', 'adn.ts')
    if (!fs.existsSync(nfse)) return
    expect(causePairs(path.join(SRC_ROOT, 'shared/tax-authority/adapters/adn.ts'))).toEqual(causePairs(nfse))
  })
})

// ===========================================================================
// RESISTIU — D-F98: a causa chega ao alarme por TODO caminho real — nenhum `nao-classificada`
// ===========================================================================

describe('RESISTIU — D-F98: a causa chega ao alarme por todo caminho real do setes-api (adaptador ADN real + transporte trocado)', () => {
  const consulta: [string, string, () => void][] = [
    ['2xx sem a NFS-e', 'envelope-ilegivel', () => sefin({ nfse: () => ok({}) })],
    ['NFS-e ilegível (entidade fora do Unicode)', 'nfse-ilegivel', () => sefin({ nfse: () => ok({ nfseXmlGZipB64: gz(NFSE_XML.replace('<nNFSe>123</nNFSe>', '<nNFSe>&#x110000;</nNFSe>')) }) })],
    ['NFS-e de OUTRA chave', 'nfse-chave-divergente', () => sefin({ nfse: () => ok({ nfseXmlGZipB64: gz(nfseXmlFor(OTHER_KEY)) }) })],
    ['NFS-e de OUTRO DPS', 'nfse-de-outro-dps', () => sefin({ nfse: () => foreignNfse(FOREIGN_ALNUM_DPS_ID) })],
    ['evento: 404 em HTML', 'evento-fora-do-contrato', () => sefin({ typed: () => ({ status: 404, headers: {}, text: '<html>x</html>' }) })],
    ['evento: 401 na rota do evento', 'evento-recusado', () => sefin({ typed: () => ({ status: 401, headers: {}, text: '' }) })],
    ['evento: 405 na rota do evento', 'rota-nao-atendida', () => sefin({ typed: () => ({ status: 405, headers: {}, text: '' }) })],
    ['eventos contraditórios', 'evento-contraditorio', () => sefin({ typed: CONTRA })],
  ]
  it.each(consulta)('resistiu: consulta da TELA — %s → UM alarme "consulta" com a causa `%s`', async (_l, cause, arrange) => {
    useRealAdn(); withAuthorizedTx()
    arrange()
    expect(await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', SCREEN))).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(origins()).toEqual(['consulta'])
    expect(causeOf()).toBe(cause)
  })
  it('resistiu: consulta da TELA — o fisco devolve OUTRO tipo de cancelamento (e105102) para a nota que o PRODUTO cancelou (voz C P e101101 com o efeito local pendente, D-F77) → UM alarme "consulta" com a causa `evento-contraditorio`, nada gravado', async () => {
    withAuthorizedTx()
    events.push({ attempt: 1, event: 2, kind: 'C', dh: '2026-09-28 10:00:00', source: 'P', message: 'Cancelada no fisco', authorityCode: '101101', invoiceEvent: null })   // efeito local pendente
    adapter.queryNfse.mockResolvedValue({ ...authorizedVoice(), status: 'cancelled', cancelled: { dhEvento: '2026-09-28T10:00:00-03:00', motive: 'x', eventCode: '105102' } })
    expect(await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', SCREEN))).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(origins()).toEqual(['consulta'])
    expect(causeOf()).toBe('evento-contraditorio')
  })
  const zeroB: [string, string, () => void][] = [
    ['GET /dps 404 sem a forma do fisco', 'dps-fora-do-contrato', () => sefin({ dps: () => notFound() })],
    ['GET /dps 2xx sem chave', 'dps-fora-do-contrato', () => sefin({ dps: () => ok({ algo: 1 }) })],
    ['GET /dps 405', 'rota-nao-atendida', () => sefin({ dps: () => ({ status: 405, headers: {}, text: '' }) })],
    ['GET /dps acha a chave e a NFS-e é de OUTRO DPS', 'nfse-de-outro-dps', () => sefin({ dps: () => ok({ chaveAcesso: KEY }), nfse: () => foreignNfse(FOREIGN_DPS_ID) })],
  ]
  it.each(zeroB)('resistiu: passo 0b do TRANSMITIR — %s → nada reservado, UM alarme "transmissao" com a causa `%s`', async (_l, cause, arrange) => {
    useRealAdn(); setTx(inFlightNow({ ageMinutes: IN_FLIGHT_MINUTES + 5 }))
    arrange()
    expect(await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(origins()).toEqual(['transmissao'])
    expect(causeOf()).toBe(cause)
  })
  it('resistiu: RODÍZIO — NFS-e de OUTRO DPS → relatório 502, UM alarme "rodizio" com a causa, carimbo da vez', async () => {
    useRealAdn(); withAuthorizedTx()
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([tx({ lastKind: 'A' })])
    sefin({ nfse: () => foreignNfse(FOREIGN_DPS_ID) })
    const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(r.errors).toEqual([expect.objectContaining({ invoiceId: INVOICE, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })])
    expect(origins()).toEqual(['rodizio'])
    expect(causeOf()).toBe('nfse-de-outro-dps')
    expect(repo.touchQueriedAt).toHaveBeenCalled()
  })
  it('resistiu: RECONFERÊNCIA — GET /dps 405 e NFS-e de OUTRO DPS → UM alarme "reconferencia" com a causa', async () => {
    for (const [arrange, cause] of [[() => sefinP({ dps: () => ({ status: 405, headers: {}, text: '' }) }), 'rota-nao-atendida'], [() => sefinP({ dps: () => ok({ chaveAcesso: KEY }), nfse: () => foreignNfse(FOREIGN_DPS_ID) }), 'nfse-de-outro-dps']] as const) {
      ;(logger.error as jest.Mock).mockClear(); mockHttp.mockReset()
      useRealAdn(); reconfirmScenario()
      arrange()
      expect(await settle(reconfirmBeforeLocalCancel(S.schema, S.inst, S.user, INVOICE))).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
      expect(origins()).toEqual(['reconferencia'])
      expect(causeOf()).toBe(cause)
    }
  })
  it('resistiu: 502 sem marca (ou marca fora da lista posta à força) → `nao-classificada`; o alarme nunca leva texto', () => {
    logAmbiguousFiscal('consulta', { institutionId: S.inst, invoiceId: INVOICE }, new HttpError(502, `NFS-e de ${FOREIGN_ALNUM_DPS_ID}`, undefined, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE))
    logAmbiguousFiscal('consulta', { institutionId: S.inst, invoiceId: INVOICE }, tagAmbiguous(new HttpError(502, 'x', undefined, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE), FOREIGN_ALNUM_DPS_ID as any))
    expect([causeOf(0), causeOf(1)]).toEqual(['nao-classificada', 'nao-classificada'])
    expect(JSON.stringify(ambiguousLogs())).not.toContain('ABC')
    expect(ambiguousCauseOf(null)).toBe('nao-classificada')
  })
})

// ===========================================================================
// RESISTIU — D-F98 (c): a NFS-e de OUTRO DPS (CPF e CNPJ ALFANUMÉRICO do terceiro) por TODAS as portas
// ===========================================================================

describe('RESISTIU — D-F98 (c): nenhuma porta do setes-api leva Id/CPF/CNPJ/letras do terceiro — mensagem HTTP, relatório do lote/rodízio, logs, vozes', () => {
  it.each(THIRD_PARTIES)('resistiu: POST /nfse (transmitir) devolve a NFS-e de OUTRO DPS — terceiro com $label → 502 ambíguo, nenhuma voz, nada do terceiro', async ({ dpsId, needles }) => {
    useRealAdn()
    sefin({ post: () => foreignNfse(dpsId) })
    const out = await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))
    expect(out).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(ambiguousCauseOf(out)).toBe('nfse-de-outro-dps')
    expect(events).toEqual([])
    const hay = haystack(out)
    for (const n of needles) expect(hay).not.toContain(n)
  })
  it.each(THIRD_PARTIES)('resistiu: LOTE (transmitir em lote) — terceiro com $label: o item do relatório leva a mensagem sem o Id', async ({ dpsId, needles }) => {
    useRealAdn()
    sefin({ post: () => foreignNfse(dpsId) })
    const r = await transmitInvoiceBatch(ADMIN as any, { orderIds: [INVOICE] } as any)
    expect(r.results).toEqual([expect.objectContaining({ orderId: INVOICE, ok: false, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, retryable: true })])
    const hay = haystack(r)
    for (const n of needles) expect(hay).not.toContain(n)
  })
  it.each(THIRD_PARTIES)('resistiu: consulta da TELA — terceiro com $label', async ({ dpsId, needles }) => {
    useRealAdn(); withAuthorizedTx()
    sefin({ nfse: () => foreignNfse(dpsId) })
    const out = await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', SCREEN))
    expect(causeOf()).toBe('nfse-de-outro-dps')
    const hay = haystack(out)
    for (const n of needles) expect(hay).not.toContain(n)
  })
  it.each(THIRD_PARTIES)('resistiu: passo 0b do TRANSMITIR — terceiro com $label (nenhuma voz F com o Id alheio)', async ({ dpsId, needles }) => {
    useRealAdn(); setTx(inFlightNow({ ageMinutes: IN_FLIGHT_MINUTES + 5 }))
    sefin({ dps: () => ok({ chaveAcesso: KEY }), nfse: () => foreignNfse(dpsId) })
    const out = await settle(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE))
    expect(causeOf()).toBe('nfse-de-outro-dps')
    expect(events).toEqual([])
    const hay = haystack(out)
    for (const n of needles) expect(hay).not.toContain(n)
  })
  it.each(THIRD_PARTIES)('resistiu: RODÍZIO — terceiro com $label (o relatório leva a mensagem — sem o Id)', async ({ dpsId, needles }) => {
    useRealAdn(); withAuthorizedTx()
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([tx({ lastKind: 'A' })])
    sefin({ nfse: () => foreignNfse(dpsId) })
    const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(r.errors).toHaveLength(1)
    const hay = haystack(r)
    for (const n of needles) expect(hay).not.toContain(n)
  })
  it.each(THIRD_PARTIES)('resistiu: RECONFERÊNCIA — terceiro com $label', async ({ dpsId, needles }) => {
    useRealAdn(); reconfirmScenario()
    sefinP({ dps: () => ok({ chaveAcesso: KEY }), nfse: () => foreignNfse(dpsId) })
    const out = await settle(reconfirmBeforeLocalCancel(S.schema, S.inst, S.user, INVOICE))
    expect(causeOf()).toBe('nfse-de-outro-dps')
    const hay = haystack(out)
    for (const n of needles) expect(hay).not.toContain(n)
  })
})
