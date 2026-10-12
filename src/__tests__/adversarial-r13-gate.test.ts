/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 13 das APIs fiscais (D-F67…D-F76, Valdo 2026-10-10) — setes-api.
// Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta: "manter a nota" (peça `@shared/invoice.waiveSubstitutedCancel` + POST /api/billing/cancel-waiver), código
// do evento na voz C (`authority_code`, migration 067 + `setCancelEventCode`), D-F69 no adaptador ADN, chave da substituta
// (D-F76) na tela "No fisco", guarda do transmitir/rodízio/lote para a SUBSTITUIÇÃO (e105102).
//
//  * ACHADOS (`it.failing('[SEV R13-xx] …')`) — o teste afirma o que a spec promete e FALHA no código atual: é a prova do bug.
//    O corretor troca `it.failing` por `it` depois de corrigir. NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (ficam como regressão).
//  * CONTEXTO (`it('contexto …')`) — fixa o comportamento atual que fundamenta um achado de OUTRO arquivo ou uma QUESTÃO.
//
// REGRAS DO GATE: nenhum socket (transporte `transport.request` mockado), nenhum banco (pool/conn/repositório mockados na
// fronteira — harness copiado do `adversarial-r11-gate.test.ts` e do `invoice-cancel-waiver.test.ts`), nenhum script que
// fale com o fisco, nenhuma migration executada (a 067 é LIDA do disco e interpretada em memória).
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import forge from 'node-forge'
import { gzipSync } from 'zlib'

const SECRETS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-adv-r13-secrets-'))
const STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-adv-r13-storage-'))
process.env.SECRETS_PATH = SECRETS_ROOT
process.env.STORAGE_PATH = STORAGE_ROOT
const JWT_SECRET = 'adversarial-r13'
process.env.JWT_SECRET = JWT_SECRET

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVR13'), recordCrash: jest.fn().mockResolvedValue(undefined),
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
    if (/FROM `setes_setes`\.vw_invoice_life/.test(sql)) {               // D-F32 (F2a A2): vida e último evento pela view
      const inv = invoices.get(Number(params[1]))
      const evs = inv && inv.inst === Number(params[0]) ? [...inv.events].sort((a, b) => b.event - a.event) : []
      const life = evs.find(e => e.kind === 'E')
      return [inv && inv.inst === Number(params[0])
        ? [{ lifeEvent: life?.event ?? null, lastEvent: evs[0]?.event ?? null, lastKind: evs[0]?.kind ?? null }] : []]
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
    if (/tb_institution_has_interface/.test(sql)) return [[{ 1: 1 }]]                 // D-F37 (F2a A2): licença para todos — contratada
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
// Interpretador MÍNIMO dos UPDATEs de backfill da 067 (sem banco — lê o arquivo do disco e aplica em memória, NA ORDEM).
// Átomos conhecidos do WHERE; átomo desconhecido FALHA alto (a correção que mudar a forma do SQL atualiza este modelo).
// ---------------------------------------------------------------------------
type VoiceRow = { kind: string; source: string; message: string; code: string | null }
export function applyBackfill(sqlFile: string, rows: VoiceRow[]): VoiceRow[] {
  const text = fs.readFileSync(sqlFile, 'utf8').split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
  const stmts = text.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(s => /^UPDATE `tb_invoice_service_transmission_event` SET `authority_code` = '/.test(s))
  const out = rows.map(r => ({ ...r }))
  for (const st of stmts) {
    const value = st.match(/SET `authority_code` = '(\d+)'/)![1]
    const where = st.split(/ WHERE /)[1]
    const atoms = where.split(/ AND /).map(a => a.trim())
    const preds = atoms.map(a => {
      if (a === "`kind` = 'C'") return (r: VoiceRow) => r.kind === 'C'
      if (a === '`authority_code` IS NULL') return (r: VoiceRow) => r.code == null
      if (a === "`message` LIKE '%(e105102)%'") return (r: VoiceRow) => r.message.includes('(e105102)')
      if (a === "`source` = 'P'") return (r: VoiceRow) => r.source === 'P'
      if (a === "`source` = 'Q'") return (r: VoiceRow) => r.source === 'Q'
      if (a === "`source` <> 'P'") return (r: VoiceRow) => r.source !== 'P'
      throw new Error(`átomo do backfill não modelado: ${a}`)
    })
    for (const r of out) if (preds.every(p => p(r))) r.code = value
  }
  return out
}
const MIGRATION_067 = path.join(__dirname, '..', 'migrations', 'sql', '067_fiscal_cancel_code_and_cancel_waiver.sql')

// ===========================================================================
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO R13-01 (MEDIUM — CORRIGIDO durante o gate pelo L6 da nfse-api, 21:33) — D-F71/D-F75 × réplica: a ORIGEM preenche o código NULL de uma voz C com 101101/105104/305101 depois da cópia; a re-sincronia do `migrate:setes` só levava a PROMOÇÃO para 105102 e ABORTAVA a institution (e o ATO da virada) com "voz divergente — dual-write". A prova de que a réplica não converge está no `nfse-api/src/__tests__/adversarial-r13-gate.test.ts`; aqui, a metade da origem', () => {
  it('contexto [R13-01]: voz C de CONSULTA sem código (anterior à 067, efeito recusado) + a re-consulta do rodízio lê e101101 → o setes-api GRAVA authority_code = 101101 na voz existente (UPDATE real do `setCancelEventCode`)', async () => {
    events.push({ attempt: 1, event: 1, kind: 'A', dh: '2026-09-21 10:15:30', source: 'P', message: 'NFS-e 123', authorityCode: null, invoiceEvent: null })
    events.push({ attempt: 1, event: 2, kind: 'C', dh: '2026-09-28 10:00:00', source: 'Q', message: 'Efeito recusado: título baixado', authorityCode: null, invoiceEvent: null })
    setTx(tx({ lastKind: 'C', lastEvent: 2, lastCode: null }))
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'cancelled', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00',
      cancelled: { dhEvento: '2026-09-28T10:00:00-03:00', motive: 'cliente desistiu', eventCode: '101101' } })
    await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', { attempt: 1 })
    const fill = conn.query.mock.calls.find((c: any[]) => /SET authority_code = \?/.test(String(c[0])))
    expect(fill?.[1]?.[0]).toBe('101101')                       // NULL → 101101 na ORIGEM (a réplica copiada antes fica NULL)
  })
})

describe('ACHADO R13-02 (LOW) — backfill da 067 por TEXTO LIVRE (o que a D-F71 quis aposentar): a regra "(e105102)" roda ANTES da regra source=P e sem filtrar a origem da voz — uma voz do NOSSO pedido (P, sempre e101101) cujo motivo DIGITADO pelo usuário contém "(e105102)" vira SUBSTITUIÇÃO; e a marca de texto é MUTÁVEL (`setTransmissionEventEffect` troca a mensagem no efeito), então origem e réplica podem sair do backfill com códigos diferentes', () => {
  it('[CORRIGIDO] [LOW R13-02] voz C source P "Cancelada no fisco: valor errado (e105102) corrigido" (motivo do usuário) → o backfill grava 101101 (o único evento que o produto pede), nunca 105102', () => {
    const [r] = applyBackfill(MIGRATION_067, [{ kind: 'C', source: 'P', message: 'Cancelada no fisco: valor errado (e105102) corrigido', code: null }])
    expect(r.code).toBe('101101')                               // hoje: 105102 (a regra do texto vence a do source)
  })
  it('contexto [R13-02]: os casos previstos funcionam — suspensão (texto da D-F64) → 105102, P comum → 101101, consulta sem marca → NULL; e uma voz de substituição cujo efeito o HUMANO aplicou (mensagem trocada pelo efeito) PERDE o fato (fica NULL)', () => {
    const out = applyBackfill(MIGRATION_067, [
      { kind: 'C', source: 'Q', message: SUBSTITUTION_EFFECT_SUSPENDED, code: null },
      { kind: 'C', source: 'P', message: 'Cancelada no fisco: cliente desistiu do serviço', code: null },
      { kind: 'C', source: 'Q', message: 'Cancelada no fisco: cliente desistiu', code: null },
      { kind: 'C', source: 'Q', message: 'Efeito aplicado pelo cancelamento manual (evento 3)', code: null },   // era e105102 antes do ato humano
      { kind: 'R', source: 'P', message: 'E0116 (e105102)', code: 'E0116' },
    ])
    expect(out.map(r => r.code)).toEqual(['105102', '101101', null, null, 'E0116'])
  })
})

describe('ACHADO R13-03 (LOW) — D-F69 escolhe o PRIMEIRO XML que se confere, não o mais restritivo: um 200 tipado de /eventos/101101/1 com DOIS eventos (e101101 e e105102 desta chave — resposta contraditória, forma não cravada) vira "cancelled 101101" e a composição APLICA o efeito local automático numa NFS-e que o próprio fisco diz substituída', () => {
  const both = (first: '101101' | '105102') => {
    const a = typedItem(arquivo2(generatedEventXml({ code: '101101' })), '101101')
    const b = typedItem(arquivo2(generatedEventXml({ code: '105102' })), '105102')
    return first === '101101' ? typedOk(a, b) : typedOk(b, a)
  }
  it('[CORRIGIDO — D-F84] [LOW R13-03] /eventos/101101/1 → 200 com [e101101, e105102] desta chave → nunca "cancelled" sem a marca 105102 (unknown/502 ou eventCode 105102)', async () => {
    sefin({ typed: code => (code === '101101' ? both('101101') : undefined) })
    const out = await settle(adnAdapter.queryNfse(ctxH, KEY))
    expect(out?.status === 'cancelled' && out?.cancelled?.eventCode !== '105102').toBe(false)   // no gate: cancelled 101101; D-F84: unknown
  })
  it('[CORRIGIDO — D-F84] [LOW R13-03] composição: a mesma resposta contraditória numa autorizada → o C local NÃO nasce sozinho', async () => {
    useRealAdn(); setTx(tx({ lastKind: 'A' }))
    sefin({ typed: code => (code === '101101' ? both('101101') : undefined) })
    await settle(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q'))
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()       // no gate: cancelInvoice chamado; D-F84: 502, nada gravado
  })
  // D-F84 (= Q-F90, Valdo 2026-10-10 — supera o L7): tipos diferentes no mesmo GET tipado = AMBÍGUO em QUALQUER ordem
  it('D-F84: a ordem inversa [e105102, e101101] na rota 101101 também é AMBÍGUA (unknown) — o resultado não depende da ordem', async () => {
    sefin({ typed: code => (code === '101101' ? both('105102') : undefined) })
    const out = await settle(adnAdapter.queryNfse(ctxH, KEY))
    expect(out?.status).toBe('unknown')
  })
})

describe('ACHADO R13-04 (LOW) — D-F76: a "chave da substituta" só confere o formato — `chSubstituta` IGUAL à própria chave substituída é exibida como a substituta (a tela diria "substituída por ela mesma")', () => {
  it('[CORRIGIDO] [LOW R13-04] evento e105102 arquivado com chSubstituta = a chave da própria NFS-e → substituteAccessKey null (ilegível/incoerente = indisponível)', async () => {
    await seedSubstitutedView(substEventXml(KEY))
    const v = await getServiceFiscalView(S.schema, S.inst, INVOICE)
    expect(v.substitution?.substituteAccessKey).toBeNull()      // hoje: a própria KEY
  })
  it('D-F85 (= Q-F91): chSubstituta de OUTRO emitente (tpInsc + inscrição nas posições 9–23 diferentes) → null; do mesmo emitente → exibida', async () => {
    const otherIssuer = `${SUBST_KEY.slice(0, 8)}2${'98765432000188'}${SUBST_KEY.slice(23)}`
    expect(otherIssuer).toHaveLength(50)
    await seedSubstitutedView(substEventXml(otherIssuer))
    expect((await getServiceFiscalView(S.schema, S.inst, INVOICE)).substitution?.substituteAccessKey).toBeNull()
    await seedSubstitutedView(substEventXml(SUBST_KEY))
    expect((await getServiceFiscalView(S.schema, S.inst, INVOICE)).substitution?.substituteAccessKey).toBe(SUBST_KEY)
  })
})

describe('ACHADO R13-05 (LOW — CORRIGIDO durante o gate pelo L6, 21:38) — D-F71: o caminho "NFS-e com o bloco <e101101> embutido" (`parsed.cancelled`) devolve o cancelamento SEM `eventCode` — a voz C nasce com authority_code NULL embora o próprio bloco diga 101101 (e, com efeito pendente, a re-consulta depois PREENCHE o código — alimenta o R13-01)', () => {
  const withBlock = nfseXmlFor(KEY, '<e101101><dhEvento>2026-09-28T09:59:00-03:00</dhEvento><cMotivo>1</cMotivo><xMotivo>cliente desistiu</xMotivo></e101101>')
  it('[CORRIGIDO durante o gate — L6] [LOW R13-05] adaptador: GET /nfse/{chave} com <e101101> embutido → cancelled.eventCode = 101101', async () => {
    sefin({ nfse: () => ok({ nfseXmlGZipB64: gz(withBlock) }) })
    const out = await settle(adnAdapter.queryNfse(ctxH, KEY))
    expect(out).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101' } })   // hoje: sem eventCode
  })
  it('[CORRIGIDO durante o gate — L6] [LOW R13-05] composição: a voz C gravada por esse caminho leva authorityCode 101101', async () => {
    useRealAdn(); setTx(tx({ lastKind: 'A' }))
    sefin({ nfse: () => ok({ nfseXmlGZipB64: gz(withBlock) }) })
    await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(events.find(e => e.kind === 'C')?.authorityCode).toBe('101101')   // hoje: null
  })
})

// ===========================================================================
// RESISTIU — ataques que NÃO reproduziram bug (regressão)
// ===========================================================================

describe('RESISTIU — "manter a nota" sob concorrência e fora do escopo (peça REAL com o lockInvoice REAL)', () => {
  const substituted = () => {
    events.push({ attempt: 1, event: 1, kind: 'A', dh: null, source: 'P', message: null, authorityCode: null, invoiceEvent: null })
    events.push({ attempt: 1, event: 2, kind: 'C', dh: null, source: 'Q', message: SUBSTITUTION_EFFECT_SUSPENDED, authorityCode: '105102', invoiceEvent: null })
    setTx(tx({ lastKind: 'C', lastEvent: 2, lastCode: '105102', environment: 'P' }))   // D-F80: só chave de PRODUÇÃO se mantém
  }
  const inst = (over: any = {}) => ({ schemaName: S.schema, institutionId: S.inst, userId: S.user, role: 'user', ...over }) as any

  it('resistiu: dois "manter" SIMULTÂNEOS da mesma nota (transações serializadas pela trava da nota) → UM INSERT; o 2º devolve alreadyWaived=true; nenhum 500', async () => {
    serializeTransactions(); substituted()
    const [a, b] = await Promise.all([
      settle(waiveOrderInvoiceCancel(inst(), { orderId: INVOICE, reason: 'substituta conferida (A)' })),
      settle(waiveOrderInvoiceCancel(inst(), { orderId: INVOICE, reason: 'substituta conferida (B)' })),
    ])
    expect([a.alreadyWaived, b.alreadyWaived].sort()).toEqual([false, true])
    expect(conn.query.mock.calls.filter((c: any[]) => /^INSERT INTO `setes_setes`\.tb_invoice_cancel_waiver/.test(String(c[0]).trim()))).toHaveLength(1)
    expect(waivers.get(wk(INVOICE, KEY))!.reason).toBe('substituta conferida (A)')
  })
  it('resistiu: "cancelar a nota" ANTES do "manter" (a nota ficou com o evento C) → 409 INVOICE_CANCEL_WAIVER_NOT_APPLICABLE, nada gravado', async () => {
    substituted()
    invoices.get(INVOICE)!.events.push({ event: 2, kind: 'C' })      // o cancelamento local venceu a corrida
    const out = await settle(waiveOrderInvoiceCancel(inst(), { orderId: INVOICE, reason: 'tarde demais' }))
    expect(out).toMatchObject({ statusCode: 409, code: ErrorCodes.INVOICE_CANCEL_WAIVER_NOT_APPLICABLE })
    expect(waivers.size).toBe(0)
  })
  it('resistiu: orderId de OUTRA institution → 404 INVOICE_NOT_FOUND pelo lockInvoice escopado (não vaza existência), nada gravado', async () => {
    substituted()
    invoices.set(INVOICE, { inst: 2, deleted: 'N', events: [{ event: 1, kind: 'E' }] })
    const out = await settle(waiveOrderInvoiceCancel(inst(), { orderId: INVOICE, reason: 'nota alheia' }))
    expect(out).toMatchObject({ statusCode: 404, code: 'INVOICE_NOT_FOUND' })
    expect(waivers.size).toBe(0)
  })
  it('resistiu: nota soft-deletada (pendente cancelada) → 404, nada gravado', async () => {
    substituted(); invoices.get(INVOICE)!.deleted = 'S'
    expect(await settle(waiveOrderInvoiceCancel(inst(), { orderId: INVOICE, reason: 'x' }))).toMatchObject({ statusCode: 404 })
    expect(waivers.size).toBe(0)
  })
  it('resistiu: voz C 105104/305101 (cancelamento que NÃO é substituição) com efeito pendente → 409 (D-F74: só a 105102 se dispensa)', async () => {
    for (const code of ['105104', '305101']) {
      events = []
      events.push({ attempt: 1, event: 2, kind: 'C', dh: null, source: 'Q', message: 'Efeito recusado: x', authorityCode: code, invoiceEvent: null })
      setTx(tx({ lastKind: 'C', lastEvent: 2, lastCode: code }))
      expect(await settle(waiveOrderInvoiceCancel(inst(), { orderId: INVOICE, reason: 'x' }))).toMatchObject({ statusCode: 409, code: ErrorCodes.INVOICE_CANCEL_WAIVER_NOT_APPLICABLE })
    }
    expect(waivers.size).toBe(0)
  })
  it('resistiu [D-F80, entrou durante o gate]: substituição de uma NFS-e de HOMOLOGAÇÃO → 409 (a saída é cancelar a nota), nada gravado', async () => {
    substituted(); setTx(tx({ lastKind: 'C', lastEvent: 2, lastCode: '105102', environment: 'H' }))
    expect(await settle(waiveOrderInvoiceCancel(inst(), { orderId: INVOICE, reason: 'x' }))).toMatchObject({ statusCode: 409, code: ErrorCodes.INVOICE_CANCEL_WAIVER_NOT_APPLICABLE })
    expect(waivers.size).toBe(0)
  })
})

describe('RESISTIU — POST /api/billing/cancel-waiver: privilégio do RAMO (D-F72) e o DTO (D-F73)', () => {
  const token = (role: string) => `Bearer ${jwt.sign({ institutionId: S.inst, userId: S.user, role, schemaName: S.schema }, JWT_SECRET)}`
  beforeEach(() => {
    events.push({ attempt: 1, event: 2, kind: 'C', dh: null, source: 'Q', message: SUBSTITUTION_EFFECT_SUSPENDED, authorityCode: '105102', invoiceEvent: null })
    setTx(tx({ lastKind: 'C', lastEvent: 2, lastCode: '105102', environment: 'P' }))
  })
  it('resistiu: CANCELAR só na interface `orders` e a nota é de OS (`service-orders`) → 403 PRIVILEGE_REQUIRED; com CANCELAR em `service-orders` → 200', async () => {
    grants.add(`31:${PRIVILEGE_CANCELAR}`)                          // orders
    const denied = await request(app).post('/api/billing/cancel-waiver').set('Authorization', token('user')).send({ orderId: INVOICE, reason: 'x' })
    expect(denied.status).toBe(403); expect(denied.body.code).toBe(ErrorCodes.PRIVILEGE_REQUIRED); expect(waivers.size).toBe(0)
    resetPrivilegeCache(); grants.add(`30:${PRIVILEGE_CANCELAR}`)   // service-orders
    const ok200 = await request(app).post('/api/billing/cancel-waiver').set('Authorization', token('user')).send({ orderId: INVOICE, reason: 'x' })
    expect(ok200.status).toBe(200)
  })
  it('resistiu: o resolvedor do ramo coage `Number(orderId)` ANTES do DTO — orderId "6300" (texto) / [6300] passam pelo privilégio mas o DTO recusa (400), nada gravado', async () => {
    for (const orderId of [String(INVOICE), [INVOICE]]) {
      const res = await request(app).post('/api/billing/cancel-waiver').set('Authorization', token('admin')).send({ orderId, reason: 'x' })
      expect(res.status).toBe(400)
    }
    expect(waivers.size).toBe(0)
  })
  it('resistiu: motivo com espaços nas pontas é aparado ANTES do teto (255 úteis + espaços → 200, gravado aparado); 256 úteis → 400; só espaços/tab/quebra → 400', async () => {
    const r1 = await request(app).post('/api/billing/cancel-waiver').set('Authorization', token('admin')).send({ orderId: INVOICE, reason: `  ${'a'.repeat(255)}\n ` })
    expect(r1.status).toBe(200); expect(waivers.get(wk(INVOICE, KEY))!.reason).toBe('a'.repeat(255))
    waivers.clear()
    for (const reason of ['a'.repeat(256), ' \t\n ']) {
      const r = await request(app).post('/api/billing/cancel-waiver').set('Authorization', token('admin')).send({ orderId: INVOICE, reason })
      expect(r.status).toBe(400)
    }
    expect(waivers.size).toBe(0)
  })
})

describe('RESISTIU — D-F76: chSubstituta hostil não vira "chave" na tela (só exibição; nunca regra)', () => {
  it.each([
    ['minúsculas/hex', SUBST_KEY.slice(0, 40) + 'abcdefabcd'],
    ['44 dígitos (chave de NF-e)', SUBST_KEY.slice(0, 44)],
    ['51 dígitos', SUBST_KEY + '1'],
    ['CDATA', `<![CDATA[${SUBST_KEY}]]>`],
    ['injeção de marcação', `${SUBST_KEY}<script>x</script>`],
    ['espaço no meio', `${SUBST_KEY.slice(0, 25)} ${SUBST_KEY.slice(25, 49)}`],
  ])('resistiu: %s → substituteAccessKey null', async (_l, hostile) => {
    await seedSubstitutedView(substEventXml(hostile))
    const v = await getServiceFiscalView(S.schema, S.inst, INVOICE)
    expect(v.substitution).toEqual({ substituteAccessKey: null, waived: false })
  })
  it('resistiu: XML do evento corrompido (binário/truncado) → null, a tela não cai', async () => {
    await seedSubstitutedView('\u0000\u0001<evento><infEvento><e105102><chSubstituta>' + SUBST_KEY)
    const v = await getServiceFiscalView(S.schema, S.inst, INVOICE)
    expect(v).toMatchObject({ state: 'cancelled', substitution: { substituteAccessKey: null } })
  })
})

describe('RESISTIU — D-F75 de mão única na composição: a substituição nunca é rebaixada nem retentada', () => {
  it('resistiu: voz 105102 suspensa e o rodízio a passa mesmo assim (lista desatualizada; `fromRun`) → nenhuma ida ao fisco, nenhum UPDATE de código, nenhum efeito', async () => {
    useRealAdn()
    fs.rmSync(path.join(STORAGE_ROOT, CNPJ), { recursive: true, force: true })      // nem o XML do evento no disco
    events.push({ attempt: 1, event: 2, kind: 'C', dh: null, source: 'Q', message: SUBSTITUTION_EFFECT_SUSPENDED, authorityCode: '105102', invoiceEvent: null })
    setTx(tx({ lastKind: 'C', lastEvent: 2, lastCode: '105102' }))
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml({ code: '101101' })))) : undefined) })
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q', { attempt: 1, fromRun: true } as any)
    expect(r).toMatchObject({ kind: 'C', changed: false })
    expect(fiscoCalls()).toBe(0)
    expect(conn.query.mock.calls.some((c: any[]) => /SET authority_code/.test(String(c[0])))).toBe(false)
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
  })
  it('resistiu [D-F78, entrou durante o gate]: consulta HUMANA de uma substituição com o XML do evento ausente e o fisco fora (503) → devolve a voz C (o arquivamento só avisa); a re-leitura que diz e101101 NÃO arquiva nem muda a voz', async () => {
    useRealAdn()
    fs.rmSync(path.join(STORAGE_ROOT, CNPJ), { recursive: true, force: true })
    events.push({ attempt: 1, event: 2, kind: 'C', dh: null, source: 'Q', message: SUBSTITUTION_EFFECT_SUSPENDED, authorityCode: '105102', invoiceEvent: null })
    setTx(tx({ lastKind: 'C', lastEvent: 2, lastCode: '105102' }))
    sefin({ nfse: () => ({ status: 503, headers: {}, text: '' }) })
    expect(await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')).toMatchObject({ kind: 'C', changed: false })
    mockHttp.mockReset()
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml({ code: '101101' })))) : undefined) })
    expect(await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')).toMatchObject({ kind: 'C', changed: false })
    await seedSubstitutedView(null)
    expect((await getServiceFiscalView(S.schema, S.inst, INVOICE)).substitution).toEqual({ substituteAccessKey: null, waived: false })
    expect(conn.query.mock.calls.some((c: any[]) => /SET authority_code/.test(String(c[0])))).toBe(false)
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
  })
  it('resistiu: código fora do domínio vindo do adaptador (105103, E0116) numa voz NOVA → authorityCode NULL (nunca o 500 do CHECK da 067)', async () => {
    for (const code of ['105103', 'E0116']) {
      events = []; setTx(tx({ lastKind: 'A' }))
      adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'cancelled', nfseXml: NFSE_XML, dhProc: null,
        cancelled: { dhEvento: '2026-09-28T10:00:00-03:00', motive: 'x', eventCode: code } })
      await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
      expect([code, events.find(e => e.kind === 'C')?.authorityCode]).toEqual([code, null])
    }
  })
  it('resistiu: o rodízio exclui toda C 105102 (com ou sem "manter") e o lote exclui toda C vigente (SQL real)', async () => {
    let captured = ''
    q.mockImplementationOnce(async (sql: string) => { captured = sql; return [[]] })
    await actualRepo.listLiveTransmissionsToRefresh(S.schema, S.inst, 5, 8)
    // a forma mudou durante o gate (D-F82: `NOT IN ('105102', '305101')`); vale qualquer uma que exclua a 105102 — inclusive com NULL
    expect(captured.replace(/\s+/g, ' ')).toMatch(/le\.kind = 'C' AND le\.invoice_event IS NULL.*?AND (NOT \(le\.authority_code <=> '105102'\)|\(le\.authority_code IS NULL OR le\.authority_code NOT IN \([^)]*'105102'[^)]*\)\))/)
    q.mockImplementationOnce(async (sql: string) => { captured = sql; return [[]] })
    await actualRepo.listPendingServiceInvoices(S.schema, S.inst, 50)
    expect(captured.replace(/\s+/g, ' ')).toContain("IN ('A','N','S','K','C','-')")
  })
})

// ===========================================================================
// CONTEXTO DAS QUESTÕES (decisão do Valdo — nenhuma é bug sem a decisão)
// ===========================================================================

// Q-F84-adv (XML do evento ausente × "refresh de C 105102 = unchanged") — RESPONDIDA durante o gate pela D-F78 (= Q-F85 (a) do
// socrático) na nfse-api; no setes-api ainda não portada no instante do gate (ver o relatório). Sem teste de contexto aqui para
// não fixar o comportamento que está mudando.

// Q-F85-adv ("manter" e depois "cancelar": a tela seguia dizendo "mantida") — RESPONDIDA durante o gate pela D-F81 (= Q-F88 (a)
// do socrático): a dispensa é HISTÓRIA; só se apresenta enquanto a nota está viva. Fica como regressão:
describe('RESISTIU — D-F81 (entrou durante o gate): "manter a nota" e depois "cancelar a nota" → o cancelamento segue livre e a tela deixa de mostrar a decisão', () => {
  it('resistiu: "manter" → OK; "cancelar a nota" em seguida → OK (a voz ganha o efeito); a tela da nota CANCELADA não mostra waived nem cancelWaiver, e não há pendência', async () => {
    events.push({ attempt: 1, event: 2, kind: 'C', dh: null, source: 'Q', message: SUBSTITUTION_EFFECT_SUSPENDED, authorityCode: '105102', invoiceEvent: null })
    setTx(tx({ lastKind: 'C', lastEvent: 2, lastCode: '105102', environment: 'P' }))
    const inst = { schemaName: S.schema, institutionId: S.inst, userId: S.user, role: 'admin' } as any
    expect(await waiveOrderInvoiceCancel(inst, { orderId: INVOICE, reason: 'substituta conferida' })).toMatchObject({ alreadyWaived: false })
    // o cancelInvoice REAL grava o evento C da nota e liga a voz (M1 do socrático) — aqui, a loja faz o mesmo
    ;(invoice.cancelInvoice as jest.Mock).mockImplementation(async () => {
      invoices.get(INVOICE)!.events.push({ event: cancelled.event, kind: 'C' })
      events.find(e => e.kind === 'C')!.invoiceEvent = cancelled.event
      return cancelled
    })
    ;(repo.listServiceTransmissions as jest.Mock).mockResolvedValue({ transmissions: [tx({ lastKind: 'C', lastEvent: 2, lastCode: '105102', environment: 'P' })], events: [] })
    expect(await settle(cancelOrderInvoice(inst, { orderId: INVOICE, reason: 'mudei de ideia' }))).toMatchObject({ event: cancelled.event })
    await seedSubstitutedView(substEventXml(SUBST_KEY), { effect: cancelled.event })
    const v = await getServiceFiscalView(S.schema, S.inst, INVOICE)
    expect(v).toMatchObject({ state: 'cancelled', pendingEffects: 0, substitution: { waived: false }, cancelWaiver: null })
    expect(waivers.get(wk(INVOICE, KEY))).toBeDefined()                // a linha fica como história
  })
})
