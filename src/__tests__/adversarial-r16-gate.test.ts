/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 16 das APIs fiscais (D-F86…D-F89, Valdo 2026-10-11) — setes-api (caminho de PRODUÇÃO da NFS-e).
// Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta no setes-api: D-F86 (laço do GET tipado para no 1º tipo — fixado), D-F87 (`runRefresh` registra o ambíguo
// persistente COM a nota), D-F88/D-F89 (`shared/tax-authority/adapters/adn.ts` — todo evento GERADO desta chave conta; mesmo tipo só
// vale com conteúdo idêntico — `eventSignature`). A D-F90 é só da nfse-api/fiscal-api (o setes-api não lê o `fiscal_api` ainda).
//
//  * ACHADOS (`it.failing('[SEV R16-xx] …')`) — o teste afirma o que a spec promete e FALHA no código atual: é a prova do bug.
//    O corretor troca `it.failing` por `it` depois de corrigir. NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (ficam como regressão).
//  * CONTEXTO (`it('contexto …')`) — fixa o comportamento atual (fail-closed) que fundamenta uma observação.
//
// REGRAS DO GATE: nenhum socket (transporte `transport.request` mockado), nenhum banco (pool/conn/repositório mockados na
// fronteira — harness copiado do `adversarial-r15-gate.test.ts`), nenhum script que fale com o fisco, nenhuma migration.
// ⚠️ Este arquivo NÃO é importado pelo `tsx watch` do dev (só o jest o carrega).
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import forge from 'node-forge'
import { gzipSync } from 'zlib'

const SECRETS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-adv-r16-secrets-'))
const STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-adv-r16-storage-'))
process.env.SECRETS_PATH = SECRETS_ROOT
process.env.STORAGE_PATH = STORAGE_ROOT
process.env.JWT_SECRET = 'adversarial-r16'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVR16'), recordCrash: jest.fn().mockResolvedValue(undefined),
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
jest.mock('../shared/invoice', () => {
  const actual = jest.requireActual('../shared/invoice')
  return { __esModule: true, ...actual, lockInvoice: jest.fn(), buildCancelPlan: jest.fn(), cancelInvoice: jest.fn() }
})
jest.mock('../modules/billing/billing.interface-resolver', () => {
  const resolveOrderInterface = jest.fn(async () => 'service-orders')
  return {
    __esModule: true, resolveOrderInterface,
    resolveFromBody: (req: any) => resolveOrderInterface(), resolveFromParam: (req: any) => resolveOrderInterface(),
  }
})

import pool from '../shared/db/connection'
import * as repo from '../shared/invoice-transmission/transmission.repository'
import * as authority from '../shared/tax-authority'
import * as issuerRepo from '../shared/fiscal-issuer/fiscal-issuer.repository'
import * as entity from '../shared/entity'
import * as invoice from '../shared/invoice'
import logger from '../shared/logger/logger'
import { ErrorCodes } from '../shared/errors/error-codes'
import { transport, HttpsCall } from '../shared/tax-authority/https-json'
import { adnAdapter } from '../shared/tax-authority/adapters/adn'
import { refreshOpenServiceTransmissions } from '../shared/invoice-transmission'
import { resetMunicipalTermsCache } from '../shared/invoice-transmission/branches/service'
import { issuerSecretRef, ISSUER_SECRET_NAMES } from '../shared/fiscal-issuer'
import { writeSecret } from '../shared/secret-store'

// ---------------------------------------------------------------------------
// certificado autoassinado REAL (par RSA 2048) — nunca um e-CNPJ de verdade (molde do R11/R15)
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
const INVOICE_B = 6301
const KEY = '4106902212345678000199000000000012320260921000012345'.slice(0, 50)
const KEY_B = `${KEY.slice(0, -1)}8`
const DPS_ID = 'DPS410690221234567800019900001000000000000042'
const nfseXmlOf = (key: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${key}"><nNFSe>123</nNFSe><dhProc>2026-09-21T10:15:30-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS Id="${DPS_ID}"></infDPS></DPS></infNFSe></NFSe>`
const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')

/** Evento GERADO pelo fisco (forma do XSD 1.01 — molde do R11/R15). */
function generatedEventXml(o: { key?: string; code?: string; inner?: string } = {}): string {
  const key = o.key ?? KEY, code = o.code ?? '101101'
  return `<evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infEvento Id="EVT${key}${code}000000001"><verAplic>SEFIN</verAplic><ambGer>2</ambGer><nSeqEvento>1</nSeqEvento><dhProc>2026-09-28T10:00:00-03:00</dhProc><nDFSe>1</nDFSe>` +
    `<pedRegEvento versao="1.01"><infPedReg Id="PRE${key}${code}"><tpAmb>2</tpAmb><verAplic>SETES-1.0</verAplic><dhEvento>2026-09-28T09:59:00-03:00</dhEvento><CNPJAutor>${CNPJ}</CNPJAutor><chNFSe>${key}</chNFSe>` +
    `<e${code}><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>cliente desistiu do serviço</xMotivo>${o.inner ?? ''}</e${code}></infPedReg></pedRegEvento></infEvento></evento>`
}

function installVault() {
  writeSecret(issuerSecretRef(S.schema, S.inst, ISSUER_SECRET_NAMES.cert), PAIR.certPem)
  writeSecret(issuerSecretRef(S.schema, S.inst, ISSUER_SECRET_NAMES.key), PAIR.keyPem)
}

const q = (pool as any).query as jest.Mock
const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }

const realTransport = transport.request
const mockHttp = jest.fn()
transport.request = mockHttp as any

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

const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: obj == null ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj) })
const notFound = () => ({ status: 404, headers: {}, text: '' })

// a Sefin REAL (D-F61): GET tipado `…/eventos/{tipo}/1`; sem evento = 404 com o envelope JSON (molde do R11)
const SEFIN = { dataHoraProcessamento: '2026-10-10T18:45:27.438738-03:00', tipoAmbiente: 2, versaoAplicativo: 'SefinNacional_1.6.0' }
const sefinNone = () => ({ status: 404, headers: {}, text: JSON.stringify(SEFIN) })
const b64 = (s: string | Buffer) => (typeof s === 'string' ? Buffer.from(s, 'utf8') : s).toString('base64')
const arquivo2 = (x: string) => b64(gzipSync(Buffer.from(x, 'utf8')).toString('base64'))
const typedItemRaw = (xml: string, code = '101101', key = KEY) =>
  ({ chaveAcesso: key, tipoEvento: Number(code), numeroPedidoRegistroEvento: 1, dataHoraRecebimento: '2026-10-10T18:43:04.82', arquivoXml: arquivo2(xml) })
const typedOk = (...items: any[]) => ok({ ...SEFIN, eventos: items })
const item = (code: string, o: { key?: string; inner?: string } = {}) => typedItemRaw(generatedEventXml({ code, key: o.key, inner: o.inner }), code, o.key ?? KEY)

/** A Sefin falsa: `/nfse/{chave}` por chave e GET tipado por chave + código. */
function fisco(o: { typed?: (code: string, key: string) => any; nfse?: (key: string) => any } = {}) {
  mockHttp.mockImplementation(async (call: HttpsCall) => {
    if (/convenio/.test(call.url)) return ok({ prazoCancelamentoDias: 365 })
    const typed = call.url.match(/\/nfse\/(\d+)\/eventos\/(\d+)\/(\d+)$/)
    if (typed && call.method === 'GET') return (await o.typed?.(typed[2], typed[1])) ?? sefinNone()
    const nf = call.url.match(/\/nfse\/(\d+)$/)
    if (nf) return o.nfse?.(nf[1]) ?? ok({ nfseXmlGZipB64: gz(nfseXmlOf(nf[1])) })
    return notFound()
  })
}
const ambiguousLogs = () => (logger.error as jest.Mock).mock.calls.filter((c: any[]) => /Fisco ambíguo persistente/.test(String(c[0])))

beforeEach(() => {
  jest.clearAllMocks()
  conn.beginTransaction.mockReset(); conn.commit.mockReset(); conn.rollback.mockReset()
  resetMunicipalTermsCache()
  conn.query.mockReset().mockImplementation(async () => [{}])
  q.mockReset().mockImplementation(async () => [[]])
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
  installVault()
  useRealAdn()
  ;(issuerRepo.getIssuer as jest.Mock).mockResolvedValue({ institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: null })
  ;(entity.getEntityFiscalFull as jest.Mock).mockImplementation(async (id: number) => fullEntity(id))
  ;(invoice.lockInvoice as jest.Mock).mockReset().mockImplementation(async (_c: any, _s: any, _i: any, inv: number) =>
    ({ id: inv, number: '17', serie: '1', model: 'SE', value: 250, status: '0', lastEvent: 1, lastKind: 'E' }))
  ;(invoice.buildCancelPlan as jest.Mock).mockReset()
  ;(invoice.cancelInvoice as jest.Mock).mockReset()
  ;(repo.findTransmissionEventByKind as jest.Mock).mockReset().mockResolvedValue(null)
  ;(repo.insertTransmissionEvent as jest.Mock).mockReset().mockResolvedValue(2)
  ;(repo.hasTransmissionEvent as jest.Mock).mockReset().mockResolvedValue(false)
  ;(repo.countPendingEffects as jest.Mock).mockReset().mockResolvedValue(0)
  ;(repo.fillAuthorityData as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(repo.touchQueriedAt as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockReset().mockResolvedValue([])
  mockHttp.mockReset()
})
afterAll(() => {
  transport.request = realTransport
  fs.rmSync(SECRETS_ROOT, { recursive: true, force: true })
  fs.rmSync(STORAGE_ROOT, { recursive: true, force: true })
  delete process.env.SECRETS_PATH; delete process.env.STORAGE_PATH
})

/** Duas autorizadas na passada: A (INVOICE, KEY) e B (INVOICE_B, KEY_B, tentativa 2). */
function twoNotes() {
  const txA = tx({ invoiceId: INVOICE, accessKey: KEY })
  const txB = tx({ invoiceId: INVOICE_B, accessKey: KEY_B, attempt: 2 })
  ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([txA, txB])
  const byInvoice = async (_q: any, _s: any, _i: any, inv: number) => (inv === INVOICE_B ? txB : txA)
  ;(repo.getTransmission as jest.Mock).mockReset().mockImplementation(byInvoice)
  ;(repo.latestTransmission as jest.Mock).mockReset().mockImplementation(byInvoice)
  ;(repo.findTransmissionByDpsId as jest.Mock).mockReset().mockImplementation(byInvoice)
}
function oneNote() {
  const t = tx()
  ;(repo.listLiveTransmissionsToRefresh as jest.Mock).mockResolvedValue([t])
  ;(repo.getTransmission as jest.Mock).mockReset().mockResolvedValue(t)
  ;(repo.latestTransmission as jest.Mock).mockReset().mockResolvedValue(t)
}

// ===========================================================================
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO R16-01 (LOW) — D-F89 no setes-api (mesmo código da nfse-api): `eventSignature` cobre só 8 campos; dois e101101 com o MESMO Id que divergem fora deles (nDFSe — o número do documento no ADN) passam como "repetição" e o XML do evento arquivado em disco (Q-N38) é o do 1º item — depende da ordem da lista', () => {
  const one = generatedEventXml({ code: '101101' })
  const other = one.replace('<nDFSe>1</nDFSe>', '<nDFSe>2</nDFSe>')
  it('[CORRIGIDO — D-F93] [LOW R16-01] /eventos/101101/1 com [nDFSe 1, nDFSe 2] (mesmo Id) → ambíguo nas duas ordens OU o mesmo XML nas duas ordens', async () => {
    fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(one), typedItemRaw(other)) : undefined) })
    const ab = await adnAdapter.queryNfse(ctxH, KEY)
    mockHttp.mockReset()
    fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(other), typedItemRaw(one)) : undefined) })
    const ba = await adnAdapter.queryNfse(ctxH, KEY)
    const orderIndependent = (ab.status === 'unknown' && ba.status === 'unknown') || ab.cancelled?.eventXml === ba.cancelled?.eventXml
    expect(orderIndependent).toBe(true)          // hoje: cancelled nas duas, cada uma com o XML do 1º item da sua lista
  })
})

// ===========================================================================
// RESISTIU — D-F88/D-F89 no adaptador ADN do setes-api
// ===========================================================================

describe('RESISTIU — D-F88/D-F89 no adaptador ADN do setes-api', () => {
  it('resistiu: D-F89 repetição LEGÍTIMA com formatação diferente (indentado, declaração XML, espaços em volta dos valores) → cancelled', async () => {
    const compact = generatedEventXml({ code: '101101' })
    const pretty = '<?xml version="1.0" encoding="UTF-8"?>\n' + compact.replace(/></g, '>\n  <').replace('<xMotivo>cliente desistiu do serviço</xMotivo>', '<xMotivo>\n   cliente desistiu do serviço  \n</xMotivo>')
    fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(compact), typedItemRaw(pretty)) : undefined) })
    expect(await adnAdapter.queryNfse(ctxH, KEY)).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101', motive: 'cliente desistiu do serviço' } })
  })
  it('resistiu: D-F89 nSeqEvento, Id, dhEvento ou cMotivo diferentes no mesmo GET tipado → ambíguo (cada um)', async () => {
    const base = generatedEventXml({ code: '101101' })
    const variants = [
      base.replace('<nSeqEvento>1</nSeqEvento>', '<nSeqEvento>2</nSeqEvento>'),
      base.replace(`Id="EVT${KEY}101101000000001"`, `Id="EVT${KEY}101101000000002"`),
      base.replace('<dhEvento>2026-09-28T09:59:00-03:00</dhEvento>', '<dhEvento>2026-09-28T09:58:00-03:00</dhEvento>'),
      base.replace('<cMotivo>1</cMotivo>', '<cMotivo>2</cMotivo>'),
    ]
    for (const v of variants) {
      mockHttp.mockReset(); fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(base), typedItemRaw(v)) : undefined) })
      expect((await adnAdapter.queryNfse(ctxH, KEY)).status).toBe('unknown')
    }
  })
  it('resistiu: D-F88/D-F89 contam só eventos GERADOS DESTA chave — e101101 de OUTRA chave com outro motivo é filtrado antes da assinatura → cancelled 101101', async () => {
    const otherKey = generatedEventXml({ code: '101101', key: KEY_B }).replace('cliente desistiu do serviço', 'erro de valor na emissao')
    fisco({ typed: code => (code === '101101' ? typedOk(item('101101'), typedItemRaw(otherKey, '101101', KEY_B)) : undefined) })
    expect(await adnAdapter.queryNfse(ctxH, KEY)).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101' } })
  })
  it('resistiu: D-F88 tipo fora do domínio com chNFSe formatado (pontos/espaços) ainda é "desta chave" → conta → ambíguo', async () => {
    const dotted = KEY.replace(/(\d{10})/g, '$1.').replace(/\.$/, '')
    const x = generatedEventXml({ code: '105105' }).replace(`<chNFSe>${KEY}</chNFSe>`, `<chNFSe> ${dotted} </chNFSe>`)
    fisco({ typed: code => (code === '105104' ? typedOk(item('105104'), typedItemRaw(x, '105105')) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH, KEY)).status).toBe('unknown')
  })
  it('contexto [liveness, fail-closed]: o MESMO instante em formatos diferentes (−03:00 × Z) conta como conteúdo diferente → ambíguo', async () => {
    const zulu = generatedEventXml({ code: '101101' }).replace('<dhProc>2026-09-28T10:00:00-03:00</dhProc>', '<dhProc>2026-09-28T13:00:00Z</dhProc>')
    fisco({ typed: code => (code === '101101' ? typedOk(item('101101'), typedItemRaw(zulu)) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH, KEY)).status).toBe('unknown')
  })
  it('resistiu: D-F86 — rota 101101 AMBÍGUA (D-F89) não segue para as rotas seguintes', async () => {
    const other = generatedEventXml({ code: '101101' }).replace('cliente desistiu do serviço', 'erro de valor na emissao')
    fisco({ typed: code => (code === '101101' ? typedOk(item('101101'), typedItemRaw(other)) : code === '105102' ? typedOk(item('105102')) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH, KEY)).status).toBe('unknown')
    expect(mockHttp.mock.calls.map((c: any[]) => String(c[0].url).match(/\/eventos\/(\d+)\/1$/)?.[1]).filter(Boolean)).toEqual(['101101'])
  })
})

// ===========================================================================
// RESISTIU — D-F87 no `runRefresh` do setes-api
// ===========================================================================

describe('RESISTIU — D-F87: o alarme do ambíguo persistente na passada do setes-api', () => {
  it('resistiu: passada com 2 notas, só a 2ª ambígua (D-F89: mesmo tipo, motivos diferentes) → UM alarme, com a nota/tentativa CERTAS e sem a chave de acesso; nada gravado', async () => {
    twoNotes()
    const other = generatedEventXml({ code: '101101', key: KEY_B }).replace('cliente desistiu do serviço', 'erro de valor na emissao')
    fisco({ typed: (code, key) => (key === KEY_B && code === '101101' ? typedOk(item('101101', { key: KEY_B }), typedItemRaw(other, '101101', KEY_B)) : undefined) })
    const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
    expect(r).toMatchObject({ checked: 2, stoppedEarly: false })
    expect(r.errors.map(e => [e.invoiceId, e.code])).toEqual([[INVOICE_B, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE]])
    expect(ambiguousLogs()).toHaveLength(1)
    expect(ambiguousLogs()[0][1]).toMatchObject({ institutionId: S.inst, invoiceId: INVOICE_B, attempt: 2, lastKind: 'A' })
    expect(JSON.stringify(ambiguousLogs()[0][1])).not.toContain(KEY_B)
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled(); expect(invoice.cancelInvoice).not.toHaveBeenCalled()
  })
  it('resistiu: ambíguo que nasce NO ADAPTADOR (AuthorityHttpError 502 — 200 com a lista vazia; 404 fora do envelope da Sefin) também dispara o alarme', async () => {
    for (const typed of [() => typedOk(), () => ({ status: 404, headers: {}, text: '<html>gateway</html>' })]) {
      ;(logger.error as jest.Mock).mockClear()
      oneNote()
      mockHttp.mockReset(); fisco({ typed: code => (code === '101101' ? typed() : undefined) })
      const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
      expect(r.errors.map(e => e.code)).toEqual([ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE])
      expect(ambiguousLogs()).toHaveLength(1)
    }
  })
  it('resistiu: 503 TRANSITÓRIO (5xx/429) e recusa de REGRA (400 → 422) nunca disparam o alarme do ambíguo', async () => {
    for (const nfse of [() => ({ status: 503, headers: {}, text: '' }), () => ({ status: 429, headers: {}, text: '' }), () => ({ status: 400, headers: {}, text: JSON.stringify({ erros: [{ codigo: 'E9999', descricao: 'x' }] }) })]) {
      oneNote()
      mockHttp.mockReset(); fisco({ nfse })
      const r = await refreshOpenServiceTransmissions(S.schema, S.inst, S.user)
      expect(r.errors).toHaveLength(1)
    }
    expect(ambiguousLogs()).toHaveLength(0)
  })
})
