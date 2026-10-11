/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 15 das APIs fiscais (D-F84 = Q-F90 · D-F85 = Q-F91, Valdo 2026-10-10) — setes-api.
// Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta: D-F84 no adaptador ADN (`shared/tax-authority/adapters/adn.ts` — o GET tipado que traz TIPOS DIFERENTES de
// cancelamento desta chave é ambíguo, supera o L7) e D-F85 em `substituteKeyOf` (`invoice-transmission.ts` — a chave da
// substituta só é exibida se for do MESMO emitente: posições 9–23 da chave de 50).
//
//  * ACHADOS (`it.failing('[SEV R15-xx] …')`) — o teste afirma o que a spec promete e FALHA no código atual: é a prova do bug.
//    O corretor troca `it.failing` por `it` depois de corrigir. NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (ficam como regressão).
//  * CONTEXTO (`it('contexto …')`) — fixa o comportamento atual que fundamenta uma QUESTÃO (decisão do Valdo).
//
// REGRAS DO GATE: nenhum socket (transporte `transport.request` mockado), nenhum banco (pool/conn/repositório mockados na
// fronteira — harness copiado do `adversarial-r13-gate.test.ts`), nenhum script que fale com o fisco, nenhuma migration.
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import forge from 'node-forge'
import { gzipSync } from 'zlib'

const SECRETS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-adv-r15-secrets-'))
const STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-adv-r15-storage-'))
process.env.SECRETS_PATH = SECRETS_ROOT
process.env.STORAGE_PATH = STORAGE_ROOT
const JWT_SECRET = 'adversarial-r15'
process.env.JWT_SECRET = JWT_SECRET

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVR15'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../shared/db/deadlock-retry', () => ({ __esModule: true, withDeadlockRetry: (_l: any, _c: any, _n: any, fn: any) => fn() }))
jest.mock('../shared/db/counters', () => ({ __esModule: true, lockInstitutionCounters: jest.fn(), setLockWaitSupported: jest.fn(), isLockWaitSupported: () => false, detectLockWaitSupport: jest.fn() }))
jest.mock('../shared/invoice-transmission/transmission.repository', () => {
  const actual = jest.requireActual('../shared/invoice-transmission/transmission.repository')
  return {
    __esModule: true, ...actual,
    // setCancelEventCode, countPendingEffects (quando não sobrescrito) e os SQL ficam REAIS onde o teste precisa
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
// o BARREL é mockado (a composição fiscal importa dele); a peça "manter a nota" importa `./invoice` direto → lockInvoice REAL
jest.mock('../shared/invoice', () => {
  const actual = jest.requireActual('../shared/invoice')
  return { __esModule: true, ...actual, lockInvoice: jest.fn(), buildCancelPlan: jest.fn(), cancelInvoice: jest.fn() }
})
jest.mock('../modules/billing/billing.interface-resolver', () => {
  const resolveOrderInterface = jest.fn(async (_s: string, _i: number, _o: number) => 'service-orders')
  return {
    __esModule: true, resolveOrderInterface,
    resolveFromBody: (req: any) => resolveOrderInterface(req.institution.schemaName, req.institution.institutionId, Number(req.body?.orderId)),
    resolveFromParam: (req: any) => resolveOrderInterface(req.institution.schemaName, req.institution.institutionId, Number(req.params?.orderId)),
  }
})

import jwt from 'jsonwebtoken'
import request from 'supertest'
import pool from '../shared/db/connection'
import * as repo from '../shared/invoice-transmission/transmission.repository'
import * as authority from '../shared/tax-authority'
import * as issuerRepo from '../shared/fiscal-issuer/fiscal-issuer.repository'
import * as entity from '../shared/entity'
import * as invoice from '../shared/invoice'
import * as resolver from '../modules/billing/billing.interface-resolver'
import { ErrorCodes } from '../shared/errors/error-codes'
import { transport, HttpsCall } from '../shared/tax-authority/https-json'
import { adnAdapter } from '../shared/tax-authority/adapters/adn'
import { refreshServiceTransmission, getServiceFiscalView, SUBSTITUTION_EFFECT_SUSPENDED } from '../shared/invoice-transmission'
import { resetMunicipalTermsCache, saveFiscalXml, cancelEventFileName } from '../shared/invoice-transmission/branches/service'
import { issuerSecretRef, ISSUER_SECRET_NAMES } from '../shared/fiscal-issuer'
import { writeSecret } from '../shared/secret-store'
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import { PRIVILEGE_CANCELAR } from '../shared/auth/privileges'
import { institutionZoneFor } from '../shared/time-zone'
import { waiveOrderInvoiceCancel, cancelOrderInvoice } from '../modules/billing/billing.service'
import app from '../app'

const actualRepo = jest.requireActual('../shared/invoice-transmission/transmission.repository')

// ---------------------------------------------------------------------------
// certificado autoassinado REAL (par RSA 2048) — nunca um e-CNPJ de verdade (molde do R11)
// ---------------------------------------------------------------------------
const CNPJ = '12345678000199'
function selfSigned(cn: string, notAfter: Date) {
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
  const fk = forge.pki.privateKeyFromPem(kp)
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.setRsaPublicKey(fk.n, fk.e)
  cert.serialNumber = String(Date.now())
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = notAfter
  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }]
  cert.setSubject(attrs); cert.setIssuer(attrs)
  cert.sign(fk, forge.md.sha256.create())
  return { certPem: forge.pki.certificateToPem(cert), keyPem: kp }
}
const PAIR = selfSigned(`SETES TESTE:${CNPJ}`, new Date(Date.now() + 365 * 86_400_000))

const S = { schema: 'setes_setes', inst: 1, user: 7 }
const INVOICE = 6300
const KEY = '4106902212345678000199000000000012320260921000012345'.slice(0, 50)
const SUBST_KEY = '4106902212345678000199000000000099920261010000099999'.slice(0, 50)
const DPS_ID = 'DPS410690221234567800019900001000000000000042'
const nfseXmlFor = (key = KEY, extra = '') =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${key}"><nNFSe>123</nNFSe><dhProc>2026-09-21T10:15:30-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS Id="${DPS_ID}"></infDPS></DPS>${extra}</infNFSe></NFSe>`
const NFSE_XML = nfseXmlFor()
const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')

/** Evento GERADO pelo fisco (forma do XSD 1.01 — molde do R11); `inner` entra no fim do bloco eNNNNNN. */
function generatedEventXml(o: { key?: string; code?: string; inner?: string } = {}): string {
  const key = o.key ?? KEY, code = o.code ?? '101101'
  return `<evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infEvento Id="EVT${key}${code}000000001"><verAplic>SEFIN</verAplic><ambGer>2</ambGer><nSeqEvento>1</nSeqEvento><dhProc>2026-09-28T10:00:00-03:00</dhProc><nDFSe>1</nDFSe>` +
    `<pedRegEvento versao="1.01"><infPedReg Id="PRE${key}${code}"><tpAmb>2</tpAmb><verAplic>SETES-1.0</verAplic><dhEvento>2026-09-28T09:59:00-03:00</dhEvento><CNPJAutor>${CNPJ}</CNPJAutor><chNFSe>${key}</chNFSe>` +
    `<e${code}><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>cliente desistiu do serviço</xMotivo>${o.inner ?? ''}</e${code}></infPedReg></pedRegEvento></infEvento></evento>`
}
const substEventXml = (substitute: string) => generatedEventXml({ code: '105102', inner: `<chSubstituta>${substitute}</chSubstituta>` })

function installVault() {
  writeSecret(issuerSecretRef(S.schema, S.inst, ISSUER_SECRET_NAMES.cert), PAIR.certPem)
  writeSecret(issuerSecretRef(S.schema, S.inst, ISSUER_SECRET_NAMES.key), PAIR.keyPem)
}

const q = (pool as any).query as jest.Mock
const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }

const realTransport = transport.request
const mockHttp = jest.fn()
transport.request = mockHttp as any

const adapter = { authority: 'ADN' as const, transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const useRealAdn = () => (authority.adapterFor as jest.Mock).mockReturnValue(adnAdapter)
const ctxH = { environment: 'H' as const, cert: Buffer.from(PAIR.certPem), key: Buffer.from(PAIR.keyPem) }

const fullEntity = (id: number): any => ({
  id, entity: { nameCompany: 'SETES SISTEMAS LTDA', nickTrade: null }, personType: 'J', person: null,
  company: { cnpj: '12.345.678/0001-99', ie: null, im: '777', dtFoundation: null }, noDoc: null, addresses: [], phones: [], socialMedia: [],
})
const tx = (over: any = {}) => ({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, environment: 'H', dpsId: DPS_ID, accessKey: KEY, nfseNumber: '123', invoiceEvent: 1,
  dhProc: '2026-09-21 10:15:30', createdAt: '2026-09-21 10:15:00', ageMinutes: 0, lastQueriedAt: null,
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastDh: '2026-09-21 10:15:30', lastEventAt: null, lastEventAgeMinutes: 0, ...over,
})
let currentTx: any = null
const setTx = (row: any) => { currentTx = row; (repo.latestTransmission as jest.Mock).mockResolvedValue(row) }

// loja de eventos da TRANSMISSÃO em memória (molde do R11)
type Ev = { attempt: number; event: number; kind: string; dh: string | null; source: string; message: string | null; authorityCode: string | null; invoiceEvent: number | null }
let events: Ev[] = []

// loja da NOTA (para o lockInvoice REAL da peça "manter a nota") e da tb_invoice_cancel_waiver
let invoices: Map<number, { inst: number; deleted: 'N' | 'S'; events: { event: number; kind: string }[] }>
let waivers: Map<string, { reason: string; userId: number; deleted: 'N' | 'S'; createdAt: string }>
const wk = (inv: number, key: string) => `${S.inst}|${inv}|0|${key}`

function wireConn() {
  conn.query.mockImplementation(async (sql: string, params: any[] = []) => {
    // lockInvoice REAL (peça "manter a nota") — escopado pela institution (params[1])
    if (/FROM `setes_setes`\.tb_invoice\s+WHERE id = \? AND tb_institution_id = \?/.test(sql)) {
      const inv = invoices.get(Number(params[0]))
      return [inv && inv.inst === Number(params[1]) && inv.deleted === 'N'
        ? [{ id: Number(params[0]), number: '17', serie: '1', model: 'SE', value: 250, status: '0' }] : []]
    }
    if (/SELECT event, kind FROM `setes_setes`\.tb_invoice_event/.test(sql)) {
      const inv = invoices.get(Number(params[1]))
      const evs = inv && inv.inst === Number(params[0]) ? [...inv.events].sort((a, b) => b.event - a.event) : []
      return [evs.slice(0, 1)]
    }
    if (/FROM `setes_setes`\.tb_invoice_cancel_waiver/.test(sql)) {
      const w = waivers.get(wk(Number(params[1]), String(params[2])))
      return [w && w.deleted === 'N' ? [{ accessKey: params[2], reason: w.reason, userId: w.userId, createdAt: w.createdAt }] : []]
    }
    if (/^INSERT INTO `setes_setes`\.tb_invoice_cancel_waiver/.test(sql.trim())) {
      const [, inv, key, reason, user] = params
      waivers.set(wk(Number(inv), String(key)), { reason, userId: user, deleted: 'N', createdAt: '2026-10-11 00:10:00' })
      return [{ affectedRows: 1 }]
    }
    return [{}]
  })
}
function poolDefaults() {
  q.mockImplementation(async (sql: string, params: any[] = []) => {
    if (/FROM `setes_setes`\.tb_invoice_cancel_waiver/.test(sql)) {
      const w = waivers.get(wk(Number(params[1]), String(params[2])))
      // D-F81 (`findCurrentCancelWaiver`, entrou durante o gate): o JOIN com a nota só devolve a decisão com a nota VIVA e não-C
      if (/JOIN `setes_setes`\.tb_invoice i/.test(sql)) {
        const inv = invoices.get(Number(params[1]))
        const last = inv ? [...inv.events].sort((a, b) => b.event - a.event)[0]?.kind : undefined
        if (!inv || inv.deleted !== 'N' || last === 'C') return [[]]
      }
      return [w && w.deleted === 'N' ? [{ accessKey: params[2], reason: w.reason, userId: w.userId, createdAt: w.createdAt }] : []]
    }
    if (/setes_central\.tb_interface WHERE i18n_key/.test(sql)) return [[{ id: ({ 'service-orders': 30, orders: 31 } as any)[String(params[0])] ?? 99 }]]
    if (/tb_user_has_privilege/.test(sql)) return [grants.has(`${params[1]}:${params[2]}`) ? [{ 1: 1 }] : []]
    return [[]]
  })
}
let grants: Set<string>

/** Transações SERIALIZADAS (uma de cada vez, FIFO) — o lock de linha do InnoDB no molde do harness. */
function serializeTransactions() {
  let chain = Promise.resolve(); const releases: (() => void)[] = []
  const acquire = () => { let rel!: () => void; const p = new Promise<void>(r => (rel = r)); const prev = chain; chain = chain.then(() => p); return prev.then(() => rel) }
  conn.beginTransaction.mockImplementation(async () => { releases.push(await acquire()) })
  conn.commit.mockImplementation(async () => { releases.shift()?.() })
  conn.rollback.mockImplementation(async () => { releases.shift()?.() })
}

const cancelled = { orderId: INVOICE, invoiceNumber: '17', event: 2, checksReversed: [], bankSlipsCancelled: [], releasedTitles: [], commissionsCompensated: 0 }
const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: obj == null ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj) })
const notFound = () => ({ status: 404, headers: {}, text: '' })
async function settle<T>(p: Promise<T>): Promise<any> { try { return await p } catch (e) { return e } }

// a Sefin REAL (D-F61): GET tipado `…/eventos/{tipo}/1`; sem evento = 404 com o envelope JSON (molde do R11)
const SEFIN = { dataHoraProcessamento: '2026-10-10T18:45:27.438738-03:00', tipoAmbiente: 2, versaoAplicativo: 'SefinNacional_1.6.0' }
const sefinNone = () => ({ status: 404, headers: {}, text: JSON.stringify(SEFIN) })
const b64 = (s: string | Buffer) => (typeof s === 'string' ? Buffer.from(s, 'utf8') : s).toString('base64')
const arquivo2 = (x: string) => b64(gzipSync(Buffer.from(x, 'utf8')).toString('base64'))
const typedItem = (file: string, code = '101101', key = KEY) =>
  ({ chaveAcesso: key, tipoEvento: Number(code), numeroPedidoRegistroEvento: 1, dataHoraRecebimento: '2026-10-10T18:43:04.82', arquivoXml: file })
const typedOk = (...items: any[]) => ok({ ...SEFIN, eventos: items })
function sefin(o: { nfse?: () => any; typed?: (code: string, call: HttpsCall) => any } = {}) {
  mockHttp.mockImplementation(async (call: HttpsCall) => {
    if (/convenio/.test(call.url)) return ok({ prazoCancelamentoDias: 365 })
    const typed = call.url.match(/\/nfse\/\d+\/eventos\/(\d+)\/(\d+)$/)
    if (typed && call.method === 'GET') return (await o.typed?.(typed[1], call)) ?? sefinNone()
    if (/\/nfse\/\d+$/.test(call.url)) return o.nfse?.() ?? ok({ nfseXmlGZipB64: gz(NFSE_XML) })
    return notFound()
  })
}
const fiscoCalls = () => mockHttp.mock.calls.filter((c: any[]) => !/convenio/.test(c[0].url)).length

beforeEach(() => {
  jest.clearAllMocks()
  conn.beginTransaction.mockReset(); conn.commit.mockReset(); conn.rollback.mockReset()
  resetMunicipalTermsCache()
  resetPrivilegeCache()
  events = []
  invoices = new Map([[INVOICE, { inst: S.inst, deleted: 'N', events: [{ event: 1, kind: 'E' }] }]])
  waivers = new Map()
  grants = new Set()
  wireConn(); poolDefaults()
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
  installVault()
  ;(authority.adapterFor as jest.Mock).mockReturnValue(adapter)
  ;(issuerRepo.getIssuer as jest.Mock).mockResolvedValue({ institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: null })
  ;(entity.getEntityFiscalFull as jest.Mock).mockImplementation(async (id: number) => fullEntity(id))
  ;(invoice.lockInvoice as jest.Mock).mockReset().mockResolvedValue({ id: INVOICE, number: '17', serie: '1', model: 'SE', value: 250, status: '0', lastEvent: 1, lastKind: 'E' })
  ;(invoice.buildCancelPlan as jest.Mock).mockReset().mockResolvedValue({ orderId: INVOICE, blocks: [] })
  ;(invoice.cancelInvoice as jest.Mock).mockReset().mockResolvedValue(cancelled)
  ;(resolver.resolveOrderInterface as jest.Mock).mockReset().mockResolvedValue('service-orders')
  currentTx = null
  ;(repo.latestTransmission as jest.Mock).mockReset().mockImplementation(async () => currentTx)
  ;(repo.getTransmission as jest.Mock).mockReset().mockImplementation(async (_q: any, _s: any, _i: any, _inv: any, attempt: number) => currentTx && currentTx.attempt === attempt ? currentTx : null)
  ;(repo.findTransmissionByDpsId as jest.Mock).mockReset().mockImplementation(async () => currentTx)
  ;(repo.findTransmissionEventByKind as jest.Mock).mockReset().mockImplementation(async (_q: any, _s: any, _i: any, _inv: any, attempt: number, kind: string) => {
    const m = events.filter(e => e.attempt === attempt && e.kind === kind).sort((a, b) => b.event - a.event); return m[0] ? { ...m[0] } : null
  })
  ;(repo.insertTransmissionEvent as jest.Mock).mockReset().mockImplementation(async (_c: any, _s: any, _i: any, _inv: any, attempt: number, _u: any, e: any) => {
    const ev: Ev = { attempt, event: events.filter(x => x.attempt === attempt).length + 1, kind: e.kind, dh: e.dh ?? null, source: e.source, message: e.message ?? null, authorityCode: e.authorityCode ?? null, invoiceEvent: e.invoiceEvent ?? null }
    events.push(ev); return ev.event
  })
  ;(repo.hasTransmissionEvent as jest.Mock).mockReset().mockResolvedValue(false)
  ;(repo.setTransmissionEventEffect as jest.Mock).mockReset().mockImplementation(async (_c: any, _s: any, _i: any, _inv: any, attempt: number, event: number, invoiceEvent: number | null, message: string | null) => {
    const ev = events.find(x => x.attempt === attempt && x.event === event); if (ev) { ev.invoiceEvent = invoiceEvent; if (message) ev.message = message }
  })
  ;(repo.countPendingEffects as jest.Mock).mockReset().mockImplementation(async () => events.filter(x => x.kind === 'C' && x.invoiceEvent == null).length)
  ;(repo.listServiceTransmissions as jest.Mock).mockReset().mockResolvedValue({ transmissions: [], events: [] })
  ;(repo.fillAuthorityData as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(repo.touchQueriedAt as jest.Mock).mockReset().mockResolvedValue(undefined)
  adapter.transmit.mockReset(); adapter.queryNfse.mockReset(); adapter.queryDpsAccessKey.mockReset(); adapter.registerEvent.mockReset()
  adapter.municipalTerms.mockReset().mockResolvedValue({ cancelDays: null, raw: {} })
  mockHttp.mockReset()
})
afterAll(() => {
  transport.request = realTransport
  fs.rmSync(SECRETS_ROOT, { recursive: true, force: true })
  fs.rmSync(STORAGE_ROOT, { recursive: true, force: true })
  delete process.env.SECRETS_PATH; delete process.env.STORAGE_PATH
})

/** Tela "No fisco" com a vigente C 105102 da chave KEY; `xml` = evento arquivado (null = ausente); `waived` = decisão gravada. */
async function seedSubstitutedView(xml: string | null, opts: { waived?: boolean; effect?: number | null } = {}) {
  const t = tx({ lastKind: 'C', lastEvent: 2, lastCode: '105102' })
  ;(repo.listServiceTransmissions as jest.Mock).mockResolvedValue({
    transmissions: [t],
    events: [{ attempt: 1, event: 1, kind: 'A', invoiceEvent: null, authorityCode: null },
             { attempt: 1, event: 2, kind: 'C', invoiceEvent: opts.effect ?? null, authorityCode: '105102' }],
  })
  fs.rmSync(path.join(STORAGE_ROOT, CNPJ), { recursive: true, force: true })
  if (xml) saveFiscalXml(CNPJ, cancelEventFileName(KEY), xml, new Date(`${t.dhProc.replace(' ', 'T')}Z`), 'H', await institutionZoneFor(S.schema, S.inst))
  if (opts.waived) waivers.set(wk(INVOICE, KEY), { reason: 'substituta emitida no portal', userId: 7, deleted: 'N', createdAt: '2026-10-10 21:00:00' })
}

// ---------------------------------------------------------------------------
// Ferramentas do R15
// ---------------------------------------------------------------------------
import logger from '../shared/logger/logger'
import { refreshOpenServiceTransmissions, IN_FLIGHT_MINUTES } from '../shared/invoice-transmission'

const OTHER_KEY = `${KEY.slice(0, 40)}9999999999`
/** Item do GET tipado com o XML de um evento GERADO (Id EVT + dhProc) — `key` default = KEY. */
const item = (code: string, o: { key?: string; inner?: string } = {}) =>
  typedItem(arquivo2(generatedEventXml({ code, key: o.key, inner: o.inner })), code, o.key ?? KEY)
/** Eco do NOSSO pedido (pedRegEvento sem Id EVT nem dhProc) — não é voz do fisco. */
const echoItem = (code: string) => typedItem(arquivo2(
  `<pedRegEvento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infPedReg Id="PRE${KEY}${code}"><tpAmb>2</tpAmb><verAplic>SETES-1.0</verAplic>` +
  `<dhEvento>2026-09-28T09:59:00-03:00</dhEvento><CNPJAutor>${CNPJ}</CNPJAutor><chNFSe>${KEY}</chNFSe><e${code}><xDesc>x</xDesc><cMotivo>1</cMotivo><xMotivo>eco</xMotivo></e${code}></infPedReg></pedRegEvento>`), code)
const unreadableItem = (code: string) => ({ ...typedItem('', code), arquivoXml: '%%% não é base64 %%%' })
const divergentLogged = () => (logger.error as jest.Mock).mock.calls.some((c: any[]) => /tipos diferentes de (cancelamento|evento)/.test(String(c[0])))   // D-F88: o log diz "de evento"
const typedAsked = () => mockHttp.mock.calls.map((c: any[]) => String(c[0].url).match(/\/eventos\/(\d+)\/1$/)?.[1]).filter(Boolean)

/** A Sefin falsa com `/dps/{id}` (a reconferência pergunta a chave pelo Id do DPS). */
function fisco(o: { typed?: (code: string) => any; dpsKey?: string | null } = {}) {
  mockHttp.mockImplementation(async (call: HttpsCall) => {
    if (/convenio/.test(call.url)) return ok({ prazoCancelamentoDias: 365 })
    if (/\/dps\//.test(call.url)) return o.dpsKey ? ok({ chaveAcesso: o.dpsKey }) : ok({ erro: { codigo: 'E2404' } }, 404)
    const typed = call.url.match(/\/nfse\/\d+\/eventos\/(\d+)\/(\d+)$/)
    if (typed && call.method === 'GET') return (await o.typed?.(typed[1])) ?? sefinNone()
    if (/\/nfse\/\d+$/.test(call.url)) return ok({ nfseXmlGZipB64: gz(NFSE_XML) })
    return notFound()
  })
}
/** As respostas contraditórias do delta (D-F84) — por código perguntado. */
const CONTRADICTION_101101 = (code: string) => (code === '101101' ? typedOk(item('101101'), item('105102')) : undefined)
const CONTRADICTION_105102 = (code: string) => (code === '105102' ? typedOk(item('105102', { inner: `<chSubstituta>${SUBST_KEY}</chSubstituta>` }), item('105104')) : undefined)

beforeEach(() => {
  ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockReset().mockResolvedValue([])
})

// ===========================================================================
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO R15-01 (LOW) — D-F84 só conta tipos DO DOMÍNIO de cancelamento: um evento GERADO desta chave de tipo FORA do domínio (e105105 "cancelamento INDEFERIDO por análise fiscal") no mesmo GET tipado de /eventos/105104/1 é descartado em silêncio pelo filtro `CANCEL_EVENT_CODES` ANTES do conjunto de tipos — a resposta "deferido + indeferido" vira cancelled 105104 e a composição aplica o C local AUTOMÁTICO (105104 não é ato humano)', () => {
  const deferredAndRefused = (code: string) => (code === '105104' ? typedOk(item('105105'), item('105104')) : undefined)
  it('[CORRIGIDO — D-F88] [LOW R15-01] adaptador: /eventos/105104/1 → 200 com [e105105, e105104] gerados desta chave (tipos diferentes) → unknown (502), nunca "cancelled"', async () => {
    fisco({ typed: deferredAndRefused })
    const out = await settle(adnAdapter.queryNfse(ctxH, KEY))
    expect(out?.status === 'cancelled').toBe(false)              // hoje: cancelled 105104
  })
  it('[CORRIGIDO — D-F88] [LOW R15-01] composição: a mesma resposta numa autorizada → o C local NÃO nasce sozinho', async () => {
    useRealAdn(); setTx(tx({ lastKind: 'A' }))
    fisco({ typed: deferredAndRefused })
    await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q'))
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()       // hoje: cancelInvoice chamado (efeito automático do 105104)
  })
})

// ===========================================================================
// RESISTIU — D-F84 no adaptador (regressão)
// ===========================================================================

describe('RESISTIU — D-F84 no adaptador ADN do setes-api', () => {
  it('resistiu: três itens [e101101, e101101, e105102] desta chave → unknown + log de contrato divergente', async () => {
    fisco({ typed: code => (code === '101101' ? typedOk(item('101101'), item('101101'), item('105102')) : undefined) })
    const out = await adnAdapter.queryNfse(ctxH, KEY)
    expect(out.status).toBe('unknown'); expect(divergentLogged()).toBe(true)
  })
  it('resistiu: /eventos/105102/1 com [e105102, e105104] (sem o tipo perguntado em conflito com o 101101) → unknown; a varredura PARA aí (não pergunta 105104/305101)', async () => {
    fisco({ typed: CONTRADICTION_105102 })
    const out = await adnAdapter.queryNfse(ctxH, KEY)
    expect(out.status).toBe('unknown'); expect(divergentLogged()).toBe(true)
    expect(typedAsked()).toEqual(['101101', '105102'])
  })
  it('resistiu: ordem invertida [e105102, e101101] → unknown (o resultado não depende mais da ordem da lista)', async () => {
    fisco({ typed: code => (code === '101101' ? typedOk(item('105102'), item('101101')) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH, KEY)).status).toBe('unknown')
  })
  it('resistiu: tipo diferente de OUTRA chave é filtrado ANTES do conjunto (não vira ambíguo) — [e101101 desta, e105102 de outra] → cancelled 101101, sem log de divergência de tipos', async () => {
    fisco({ typed: code => (code === '101101' ? typedOk(item('101101'), item('105102', { key: OTHER_KEY })) : undefined) })
    const out = await adnAdapter.queryNfse(ctxH, KEY)
    expect(out).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101' } }); expect(divergentLogged()).toBe(false)
  })
  it('resistiu: eco do nosso pedido (sem Id EVT/dhProc) de outro tipo e item ilegível são filtrados — [eco e105102, ilegível, e101101] → cancelled 101101', async () => {
    fisco({ typed: code => (code === '101101' ? typedOk(echoItem('105102'), unreadableItem('105104'), item('101101')) : undefined) })
    expect(await adnAdapter.queryNfse(ctxH, KEY)).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101' } })
  })
  it('resistiu: só itens filtrados (eco + ilegível + outra chave) → unknown pela D-F63 (nunca "autorizada")', async () => {
    fisco({ typed: code => (code === '101101' ? typedOk(echoItem('101101'), unreadableItem('101101'), item('101101', { key: OTHER_KEY })) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH, KEY)).status).toBe('unknown')
  })
  it('resistiu: a D-F69 segue DEPOIS da D-F84 — [e105102, e105102] em /eventos/101101/1 → cancelled 105102 (exceção da substituição); [e105104, e105104] → unknown', async () => {
    fisco({ typed: code => (code === '101101' ? typedOk(item('105102'), item('105102')) : undefined) })
    expect(await adnAdapter.queryNfse(ctxH, KEY)).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '105102' } })
    mockHttp.mockReset()
    fisco({ typed: code => (code === '101101' ? typedOk(item('105104'), item('105104')) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH, KEY)).status).toBe('unknown')
  })
  it('[D-F88] e101103 (solicitação de análise — fora do domínio) junto do e105104 em /eventos/105104/1 → AMBÍGUO (unknown): todo evento gerado desta chave conta', async () => {
    fisco({ typed: code => (code === '105104' ? typedOk(item('101103'), item('105104')) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH, KEY)).status).toBe('unknown')
  })
})

// ===========================================================================
// RESISTIU — D-F84 na COMPOSIÇÃO (nada gravado; rodízio marca fora; K não vira N; reconferência fail-closed)
// ===========================================================================

describe('RESISTIU — D-F84 × composição do setes-api', () => {
  const fiscalUnknown = { statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE }

  it('resistiu: autorizada (A) + /eventos/105102/1 contraditório → 502; nenhuma voz, nenhum write-once, nenhum efeito, transação desfeita', async () => {
    useRealAdn(); setTx(tx({ lastKind: 'A' }))
    fisco({ typed: CONTRADICTION_105102 })
    const out = await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q'))
    expect(out).toMatchObject(fiscalUnknown)
    expect(events).toEqual([])
    expect(repo.fillAuthorityData).not.toHaveBeenCalled()
    expect(conn.query.mock.calls.some((c: any[]) => /SET authority_code/.test(String(c[0])))).toBe(false)
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
    expect(conn.rollback).toHaveBeenCalled(); expect(conn.commit).not.toHaveBeenCalled()
  })
  it(`resistiu: K em voo há ${IN_FLIGHT_MINUTES} min (passou a carência) + resposta contraditória → 502; o K NUNCA vira N ("pedido não consta") nem C`, async () => {
    useRealAdn(); setTx(tx({ lastKind: 'K', lastEvent: 2, lastEventAgeMinutes: IN_FLIGHT_MINUTES + 60 }))
    fisco({ typed: CONTRADICTION_101101 })
    expect(await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q'))).toMatchObject(fiscalUnknown)
    expect(events.map(e => e.kind)).toEqual([])
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
  })
  it('resistiu: rodízio com duas candidatas na resposta contraditória → as duas no relatório como 502, a passada NÃO para, `last_queried_at` carimbado FORA da transação (pool) para as duas, nenhuma voz', async () => {
    useRealAdn(); setTx(tx({ lastKind: 'A' }))
    ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([{ invoiceId: INVOICE, attempt: 1 }, { invoiceId: INVOICE, attempt: 1 }])
    fisco({ typed: CONTRADICTION_101101 })
    const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(r).toMatchObject({ checked: 2, changed: 0, stoppedEarly: false })
    expect(r.errors.map(e => e.code)).toEqual([ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE])
    expect((repo.touchQueriedAt as jest.Mock).mock.calls.filter((c: any[]) => c[0] === pool)).toHaveLength(2)
    expect(events).toEqual([])
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
  })
  it('resistiu: consulta HUMANA de C 101101 sem o XML do evento (D-F78 relê só para arquivar) + resposta contraditória → devolve a voz C, NÃO arquiva, não muda o código', async () => {
    useRealAdn()
    fs.rmSync(path.join(STORAGE_ROOT, CNPJ), { recursive: true, force: true })
    events.push({ attempt: 1, event: 2, kind: 'C', dh: null, source: 'Q', message: 'Cancelada no fisco: x', authorityCode: '101101', invoiceEvent: 9 })
    setTx(tx({ lastKind: 'C', lastEvent: 2, lastCode: '101101', lastSource: 'Q' }))
    fisco({ typed: CONTRADICTION_101101 })
    expect(await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')).toMatchObject({ kind: 'C', changed: false })
    expect(fs.existsSync(path.join(STORAGE_ROOT, CNPJ))).toBe(false)
    expect(conn.query.mock.calls.some((c: any[]) => /SET authority_code/.test(String(c[0])))).toBe(false)
  })
  it('resistiu: reconferência ANTES do cancelamento local (Q-ADV1b) — F "envio interrompido" em P, o GET /dps ACHA a chave e o GET tipado é contraditório → o cancelamento da nota FALHA FECHADO (502), nada cancelado, nada gravado', async () => {
    useRealAdn()
    const f = tx({ environment: 'P', accessKey: null, nfseNumber: null, dhProc: null, lastKind: 'F', lastSource: 'Q', lastEvent: 1 })
    setTx(f)
    ;(repo.listServiceTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f], events: [] })
    fisco({ typed: CONTRADICTION_101101, dpsKey: KEY })
    const inst = { schemaName: S.schema, institutionId: S.inst, userId: S.user, role: 'admin' } as any
    const out = await settle(cancelOrderInvoice(inst, { orderId: INVOICE, reason: 'cliente desistiu' }))
    expect(out).toMatchObject(fiscalUnknown)
    expect(mockHttp.mock.calls.some((c: any[]) => /\/dps\//.test(c[0].url))).toBe(true)     // a reconferência perguntou de fato
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
    expect(events).toEqual([]); expect(repo.fillAuthorityData).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// RESISTIU — D-F85 (chave da substituta só do MESMO emitente — posições 9–23)
// ===========================================================================

describe('RESISTIU — D-F85: `chSubstituta` × emitente embutido na chave (só exibição)', () => {
  // chave REALISTA (README do nfse-adn): cMun(7) + ambGer(1) + tpInsc(1) + inscrição(14) + nNFSe(13) + AAMM(4) + código(9) + DV(1)
  const REAL = `4106902` + `2` + `2` + CNPJ + `0000000000704` + `2609` + `123456789` + `5`
  const at = (k: string, i: number, s: string) => k.slice(0, i) + s + k.slice(i + s.length)
  const SAME = at(REAL, 23, `0000000000705` + `2610` + `987654321` + `1`)    // mesma inscrição, outra NFS-e
  async function seedSubst(substituted: string, chSubstituta: string) {
    const t = tx({ accessKey: substituted, lastKind: 'C', lastEvent: 2, lastCode: '105102' })
    ;(repo.listServiceTransmissions as jest.Mock).mockResolvedValue({
      transmissions: [t],
      events: [{ attempt: 1, event: 1, kind: 'A', invoiceEvent: null, authorityCode: null },
               { attempt: 1, event: 2, kind: 'C', invoiceEvent: null, authorityCode: '105102' }],
    })
    fs.rmSync(path.join(STORAGE_ROOT, CNPJ), { recursive: true, force: true })
    saveFiscalXml(CNPJ, cancelEventFileName(substituted),
      generatedEventXml({ key: substituted, code: '105102', inner: `<chSubstituta>${chSubstituta}</chSubstituta>` }),
      new Date(`${t.dhProc.replace(' ', 'T')}Z`), 'H', await institutionZoneFor(S.schema, S.inst))
  }
  const shown = async () => (await getServiceFiscalView(S.schema, S.inst, INVOICE)).substitution?.substituteAccessKey ?? null

  it('contexto: a chave realista tem 50 posições e o emitente nas posições 9–23 (tpInsc 2 + CNPJ)', () => {
    expect(REAL).toHaveLength(50); expect(REAL.slice(8, 23)).toBe(`2${CNPJ}`); expect(SAME).toHaveLength(50)
  })
  it.each([
    ['mesmo emitente, outra NFS-e (nNFSe/AAMM/código/DV)', true, () => SAME],
    ['mesmo emitente, outro cMun (posições 1–7 fora da conferência)', true, () => at(SAME, 0, '3550308')],
    ['mesmo emitente, outro ambGer (posição 8 fora da conferência)', true, () => at(SAME, 7, '1')],
    ['quebras de linha/espaços em volta (o leitor apara)', true, () => `\n   ${SAME}\t\n`],
    ['tpInsc diferente com a MESMA inscrição', false, () => at(SAME, 8, '1')],
    ['outro estabelecimento do mesmo CNPJ raiz (filial 0002)', false, () => at(SAME, 9, '12345678000280')],
    ['inscrição alfanumérica (CNPJ alfanumérico) de outro emitente', false, () => at(SAME, 9, '12ABC34501DE35')],
    ['último dígito da inscrição (posição 23) diferente', false, () => at(SAME, 22, '8')],
    ['a própria chave substituída (R13-04)', false, () => REAL],
    ['chave de NF-e (44)', false, () => SAME.slice(0, 44)],
    ['minúsculas', false, () => at(SAME, 40, 'abcdefabcd')],
  ] as const)('resistiu: %s → exibida = %s', async (_l, expected, make) => {
    const sub = make()
    await seedSubst(REAL, sub)
    expect(await shown()).toBe(expected ? sub.trim() : null)
  })
})

// ===========================================================================
// CONTEXTO DA QUESTÃO Q-F92-adv-2 (decisão do Valdo — não é bug sem a decisão)
// ===========================================================================

describe('D-F89 (= Q-F95 = Q-F92-adv-2, Valdo 2026-10-11) — "mesmo tipo repetido vale" só com o MESMO conteúdo: dois e105102 desta chave com `chSubstituta` DIFERENTES no mesmo GET tipado', () => {
  it('[D-F89] [e105102 → substituta A, e105102 → substituta B] em QUALQUER ordem → AMBÍGUO (unknown) — o que se exibe não depende da ordem da lista', async () => {
    const SUBST_B = at2(SUBST_KEY)
    fisco({ typed: code => (code === '105102' ? typedOk(item('105102', { inner: `<chSubstituta>${SUBST_KEY}</chSubstituta>` }), item('105102', { inner: `<chSubstituta>${SUBST_B}</chSubstituta>` })) : undefined) })
    const ab = await adnAdapter.queryNfse(ctxH, KEY)
    mockHttp.mockReset()
    fisco({ typed: code => (code === '105102' ? typedOk(item('105102', { inner: `<chSubstituta>${SUBST_B}</chSubstituta>` }), item('105102', { inner: `<chSubstituta>${SUBST_KEY}</chSubstituta>` })) : undefined) })
    const ba = await adnAdapter.queryNfse(ctxH, KEY)
    expect([ab.status, ba.status]).toEqual(['unknown', 'unknown'])
  })
})
function at2(k: string): string { return `${k.slice(0, 40)}${'7'.repeat(10)}` }
