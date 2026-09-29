/// <reference types="jest" />
// Onda 3 NFS-e — RETRABALHO da 2ª rodada dos gates (2026-09-28): assunções D-N26…D-N30 + L5/L6
// do re-score socrático (0.67). Os achados do adversarial R2 têm as provas em
// `onda3-adversarial-r2.test.ts`; aqui ficam as do socrático, que não tinham teste:
//   D-N26 leitor ÚNICO da transmissão vigente = quem DETÉM a chave (HIGH-1)
//   D-N27 a transmissão pertence a uma VIDA da nota (invoice_event) (MEDIUM-1)
//   D-N28 K só vira N depois da carência (MEDIUM-2)
//   D-N29 o A1 tem que ser do CNPJ do emitente (MEDIUM-3)
//   D-N30 credencial LOCAL recusada = 409 sem voz F (MEDIUM-4)
//   L5 kinds numa fonte só · L6 lote pára em 409 do emissor
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import forge from 'node-forge'
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-nfse-rework2-'))
process.env.SECRETS_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-nfse-rework2-secrets-'))

import pool from '../shared/db/connection'
import * as repo from '../shared/invoice-transmission/transmission.repository'
import * as authority from '../shared/tax-authority'
import * as issuer from '../shared/fiscal-issuer'
import * as entity from '../shared/entity'
import * as entityTax from '../shared/entity-tax/entity-tax.repository'
import * as invoice from '../shared/invoice'
import { transport, authorityJson, AuthorityHttpError } from '../shared/tax-authority/https-json'
import { transmitServiceInvoice, refreshServiceTransmission, IN_FLIGHT_MINUTES } from '../shared/invoice-transmission'
import { resetMunicipalTermsCache } from '../shared/invoice-transmission/branches/service'
import { transmitInvoiceBatch } from '../modules/billing/billing.fiscal.service'
import { FINAL_TRANSMISSION_KINDS as KINDS_A } from '../shared/invoice-transmission/transmission-kinds'
import { FINAL_TRANSMISSION_KINDS as KINDS_B } from '../shared/fiscal-issuer/fiscal-issuer.repository'
import { HttpError } from '../shared/errors/http-error'
import { ErrorCodes } from '../shared/errors/error-codes'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/db/deadlock-retry', () => ({ __esModule: true, withDeadlockRetry: (_l: any, _c: any, _n: any, fn: any) => fn() }))
jest.mock('../shared/db/counters', () => ({ __esModule: true, lockInstitutionCounters: jest.fn() }))
jest.mock('../shared/invoice-transmission/transmission.repository', () => {
  const actual = jest.requireActual('../shared/invoice-transmission/transmission.repository')
  return {
    __esModule: true, ...actual,
    latestTransmission: jest.fn(), getTransmission: jest.fn(), findTransmissionByDpsId: jest.fn(),
    insertTransmission: jest.fn(), setDpsId: jest.fn(), fillAuthorityData: jest.fn(), nextDpsNumber: jest.fn(),
    insertTransmissionEvent: jest.fn(), setTransmissionEventEffect: jest.fn(), hasTransmissionEvent: jest.fn(),
    findTransmissionEvent: jest.fn(), findTransmissionEventByKind: jest.fn(), touchQueriedAt: jest.fn(),
    listServiceTransmissions: jest.fn(), setDpsNumber: jest.fn(), countPendingEffects: jest.fn(),
  }
})
jest.mock('../shared/tax-authority', () => {
  const actual = jest.requireActual('../shared/tax-authority')
  return { __esModule: true, ...actual, adapterFor: jest.fn(), signXml: jest.fn((xml: string) => xml) }
})
jest.mock('../shared/fiscal-issuer', () => {
  const actual = jest.requireActual('../shared/fiscal-issuer')
  return { __esModule: true, ...actual, openIssuer: jest.fn() }
})
jest.mock('../shared/entity', () => ({ __esModule: true, getEntityFiscalFull: jest.fn() }))
jest.mock('../shared/entity-tax/entity-tax.repository', () => ({ __esModule: true, getEntityTax: jest.fn() }))
jest.mock('../shared/invoice', () => ({
  __esModule: true, lockInvoice: jest.fn(), buildCancelPlan: jest.fn(), cancelInvoice: jest.fn(),
  LAST_INVOICE_EVENT_KIND_SQL: (_s: string, _a = 'i') => `(SELECT 'E')`,
}))
jest.mock('../modules/billing/billing.interface-resolver', () => ({
  __esModule: true, resolveOrderInterface: jest.fn().mockResolvedValue('orders'),
  resolveFromBody: jest.fn().mockResolvedValue('orders'), resolveFromParam: jest.fn().mockResolvedValue('orders'),
}))

const actualRepo = jest.requireActual('../shared/invoice-transmission/transmission.repository')
const q = (pool as any).query as jest.Mock
const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)

const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const S = { schema: 'setes_setes', inst: 1, user: 7 }
const INVOICE = 6300
const KEY = '4106902212345678000199000000000012320260921000012345'.slice(0, 50)
const DPS_ID = 'DPS410690221234567800019900001000000000000042'
const NFSE_XML = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${KEY}"><nNFSe>123</nNFSe><dhProc>2026-09-21T10:15:30-03:00</dhProc><cStat>100</cStat><emit><CNPJ>12345678000199</CNPJ></emit><DPS><infDPS Id="${DPS_ID}"></infDPS></DPS></infNFSe></NFSe>`

const header = (over: any = {}) => ({
  id: INVOICE, number: '17', serie: '1', model: 'SE', value: 1234.5, dtEmission: '2026-09-21', entityId: 900, status: '0', lastKind: 'E',
  lastEvent: 1, branchUpdatedAt: '2026-09-21 09:00:00',
  branchId: INVOICE, serviceListId: '1.02', nationalCode: '010201', municipalCode: null, cityId: 1, baseIss: 1234.5, aliqIss: 2,
  issValue: 24.69, issWithheld: 'N', liability: '1', dpsNumber: null, description: 'Licença mensal ERP', totalValue: 1234.5, ...over,
})
const fullEntity = (id: number) => ({
  id, entity: { nameCompany: id === 1 ? 'SETES SISTEMAS LTDA' : 'Cliente Ltda', nickTrade: null }, personType: 'J', person: null,
  company: { cnpj: id === 1 ? '12.345.678/0001-99' : '98.765.432/0001-88', ie: null, im: id === 1 ? '777' : null, dtFoundation: null }, noDoc: null,
  addresses: [{ kind: 'C', street: 'Rua A', nmbr: '10', complement: null, neighborhood: 'Centro', zipCode: '80.010-000', tbCountryId: 1, tbStateId: 16, tbCityId: 1, main: 'S', countryName: 'Brasil', stateName: 'Paraná', cityName: 'Curitiba' }],
  phones: [], socialMedia: [],
})
const opened = () => ({
  issuer: { institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: null },
  cert: Buffer.from('CERT'), key: Buffer.from('KEY'),
  info: { subject: 'CN=SETES:12345678000199', issuer: 'AC', notAfter: '2027-01-01', daysToExpire: 100, expired: false, notYetValid: false, cnpj: '12345678000199' },
})
const tx = (over: any = {}): any => ({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, environment: 'H', dpsId: DPS_ID, invoiceEvent: 1,
  accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21 10:15:30', createdAt: '2026-09-21 10:15:00', ageMinutes: 0, lastQueriedAt: null,
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastDh: '2026-09-21 10:15:30', lastEventAt: null, lastEventAgeMinutes: 0, ...over,
})
const authorizedQuery = () => ({ accessKey: KEY, status: 'authorized' as const, nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })

let headerRow: any
beforeEach(() => {
  jest.clearAllMocks()
  resetMunicipalTermsCache()
  headerRow = header()
  q.mockImplementation(async (sql: string) => {
    if (/FROM `setes_setes`\.tb_invoice i/.test(sql)) return [[headerRow]]
    if (/tb_city/.test(sql)) return [[{ ibge: '4106902' }]]
    return [[]]
  })
  conn.query.mockImplementation(async (sql: string) => {
    if (/dps_number AS dpsNumber/.test(sql)) return [[{ dpsNumber: headerRow.dpsNumber, updatedAt: headerRow.branchUpdatedAt }]]
    return [[]]
  })
  ;(authority.adapterFor as jest.Mock).mockReturnValue(adapter)
  ;(issuer.openIssuer as jest.Mock).mockResolvedValue(opened())
  ;(entity.getEntityFiscalFull as jest.Mock).mockImplementation(async (id: number) => fullEntity(id))
  ;(entityTax.getEntityTax as jest.Mock).mockResolvedValue({ simplesRegime: '3', specialTaxRegime: null, issExigibilidade: '01' })
  ;(invoice.lockInvoice as jest.Mock).mockResolvedValue({ id: INVOICE, number: '17', serie: '1', model: 'SE', value: 1234.5, status: '0', lastEvent: 1, lastKind: 'E' })
  ;(repo.latestTransmission as jest.Mock).mockResolvedValue(null)
  ;(repo.getTransmission as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionByDpsId as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue(null)
  ;(repo.insertTransmission as jest.Mock).mockResolvedValue(1)
  ;(repo.nextDpsNumber as jest.Mock).mockResolvedValue(42)
  ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
  ;(repo.hasTransmissionEvent as jest.Mock).mockResolvedValue(false)
  ;(repo.countPendingEffects as jest.Mock).mockResolvedValue(0)
  adapter.municipalTerms.mockResolvedValue({ cancelDays: null, raw: {} })
})
afterAll(() => {
  fs.rmSync(process.env.STORAGE_PATH!, { recursive: true, force: true })
  fs.rmSync(process.env.SECRETS_PATH!, { recursive: true, force: true })
})

/** SQL que o repositório REAL emite para uma leitura (captura sem banco). */
async function sqlOf(fn: (qq: any) => Promise<unknown>): Promise<string> {
  let captured = ''
  const qq = { query: jest.fn(async (sql: string) => { captured = sql; return [[]] }) }
  await fn(qq)
  return captured.replace(/\s+/g, ' ')
}

// ---------------------------------------------------------------------------
describe('D-N26 (HIGH-1) — a transmissão VIGENTE é quem DETÉM a chave, não a última tentativa', () => {
  it('latestTransmission (SQL real): ordena pela presença da chave ANTES do attempt, dentro da vida da nota', async () => {
    const sql = await sqlOf(qq => actualRepo.latestTransmission(qq, S.schema, S.inst, INVOICE, true))
    expect(sql).toContain('ORDER BY (t.access_key IS NOT NULL) DESC, t.attempt DESC LIMIT 1 FOR UPDATE')
    expect(sql).toMatch(/t\.invoice_event IS NULL OR t\.invoice_event >= COALESCE/)
  })
  it('currentOf: a tentativa 1 (A com chave) vence a tentativa 2 (R sem chave) — o plano, o transmit e a tela veem a NFS-e viva', () => {
    const a1 = tx({ attempt: 1, lastKind: 'A' })
    const r2 = tx({ attempt: 2, lastKind: 'R', accessKey: null, nfseNumber: null, dhProc: null })
    expect(repo.currentOf([a1, r2])).toBe(a1)
    expect(repo.currentOf([r2])).toBe(r2)                       // sem chave em ninguém: a última
    expect(repo.currentOf([])).toBeNull()
  })
})

describe('D-N27 (MEDIUM-1) — a transmissão pertence a uma VIDA da nota (invoice_event)', () => {
  it('a reserva grava o evento E da nota lida; os leitores da tela/consulta/pendentes filtram pela vida vigente', async () => {
    adapter.transmit.mockResolvedValue({ accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21T10:15:30-03:00', nfseXml: NFSE_XML, raw: {} })
    await transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)
    expect(repo.insertTransmission).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 'H', S.user, 1)
    const list = await sqlOf(qq => actualRepo.findTransmissionByDpsId(qq, S.schema, S.inst, INVOICE, DPS_ID))
    expect(list).toMatch(/t\.invoice_event IS NULL OR t\.invoice_event >= COALESCE/)
    // os leitores pelo pool (tela, consulta ativa, pendentes) emitem o MESMO filtro de vida
    const seen: string[] = []
    q.mockImplementation(async (sql: string) => { seen.push(sql.replace(/\s+/g, ' ')); return [[]] })
    await actualRepo.listServiceTransmissions(S.schema, S.inst, INVOICE)
    await actualRepo.listLiveTransmissionsToRefresh(S.schema, S.inst, 5, 8)
    await actualRepo.listPendingServiceInvoices(S.schema, S.inst, 50)
    // transmissões + EVENTOS da tela (M1), consulta ativa e pendentes = 4 leitores pela vida
    expect(seen.filter(s => /t\.invoice_event IS NULL OR t\.invoice_event >= COALESCE/.test(s))).toHaveLength(4)
  })
})

describe('D-N28 (MEDIUM-2) — K só vira N depois da carência (ambíguo não é N)', () => {
  it(`K com ${IN_FLIGHT_MINUTES - 1} min e fisco "authorized" → nada de N: kind segue K, "nós olhamos" marcado`, async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'K', lastEventAgeMinutes: IN_FLIGHT_MINUTES - 1 }))
    adapter.queryNfse.mockResolvedValue(authorizedQuery())
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ changed: false, kind: 'K' })
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(repo.touchQueriedAt).toHaveBeenCalled()
  })
  it(`K com ${IN_FLIGHT_MINUTES} min → N (source Q) e a NFS-e volta a autorizada`, async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'K', lastEventAgeMinutes: IN_FLIGHT_MINUTES }))
    adapter.queryNfse.mockResolvedValue(authorizedQuery())
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ changed: true, kind: 'N' })
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, S.user, expect.objectContaining({ kind: 'N', source: 'Q' }))
  })
  it('a NFS-e devolvida embute OUTRO DPS (R2-2 c) → 502 e nada gravado, nem "nós olhamos"', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.queryNfse.mockResolvedValue({ ...authorizedQuery(), nfseXml: NFSE_XML.replace(DPS_ID, 'DPS410690221234567800019900001000000000000099') })
    await expect(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')).rejects.toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(repo.fillAuthorityData).not.toHaveBeenCalled(); expect(repo.touchQueriedAt).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// certificado autoassinado REAL para a porta do cofre (D-N29)
function selfSigned(cn: string, notAfter: Date, notBefore = new Date(Date.now() - 60_000)) {
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
  const fk = forge.pki.privateKeyFromPem(kp)
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.setRsaPublicKey(fk.n, fk.e)
  cert.serialNumber = String(Date.now())
  cert.validity.notBefore = notBefore; cert.validity.notAfter = notAfter
  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }]
  cert.setSubject(attrs); cert.setIssuer(attrs); cert.sign(fk, forge.md.sha256.create())
  const asn1 = forge.pkcs12.toPkcs12Asn1(fk, [cert], 'senha', { algorithm: '3des' })
  return { pfx: Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary') }
}

describe('D-N29 (MEDIUM-3) — o A1 tem que ser do CNPJ do EMITENTE', () => {
  const year = new Date(Date.now() + 365 * 86_400_000)
  it('.pfx de OUTRO CNPJ → 409 FISCAL_CERT_INVALID no campo pfx, nada no cofre', () => {
    const other = selfSigned('OUTRA EMPRESA:99887766000155', year)
    let err: any
    try { issuer.storeIssuerCertificate(S.schema, S.inst, other.pfx, 'senha', { expectedCnpj: '12.345.678/0001-99' }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(HttpError)
    expect(err).toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_CERT_INVALID, fields: [expect.objectContaining({ field: 'pfx' })] })
    expect(issuer.issuerCertificateStatus(S.schema, S.inst).certificate).toBe(false)
  })
  it('.pfx do CNPJ do emitente → entra; CN sem CNPJ (padrão fora do ICP-Brasil) → entra (não há como comparar)', () => {
    const mine = selfSigned('SETES SISTEMAS:12345678000199', year)
    expect(issuer.storeIssuerCertificate(S.schema, S.inst, mine.pfx, 'senha', { expectedCnpj: '12345678000199' }).certificateInfo?.cnpj).toBe('12345678000199')
    const noCnpj = selfSigned('SETES SISTEMAS', year)
    expect(issuer.storeIssuerCertificate(S.schema, S.inst, noCnpj.pfx, 'senha', { expectedCnpj: '12345678000199' }).certificateInfo?.cnpj).toBeNull()
    issuer.clearIssuerCertificate(S.schema, S.inst)
  })
})

describe('D-N30 (MEDIUM-4) — credencial LOCAL recusada (par PEM não abre) = 409 sem voz do fisco', () => {
  const realRequest = transport.request
  afterEach(() => { transport.request = realRequest })
  it('transporte: ERR_OSSL_X509_KEY_VALUES_MISMATCH → 409 FISCAL_CERT_INVALID (authorityStatus 0); EPROTO no handshake segue AUTH_FAILED', async () => {
    transport.request = jest.fn().mockRejectedValue(Object.assign(new Error('key values mismatch'), { code: 'ERR_OSSL_X509_KEY_VALUES_MISMATCH' })) as any
    await expect(authorityJson({ url: 'https://x/y', method: 'GET' }, 'adn x')).rejects.toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_CERT_INVALID, authorityStatus: 0 })
    transport.request = jest.fn().mockRejectedValue(Object.assign(new Error('alert'), { code: 'EPROTO' })) as any
    await expect(authorityJson({ url: 'https://x/y', method: 'GET' }, 'adn x')).rejects.toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED })
  })
  it('transmit: par local inválido → 409 sobe, NENHUMA voz gravada (nem F) — a reserva reconcilia como as demais', async () => {
    adapter.transmit.mockRejectedValue(new AuthorityHttpError(409, 'par inválido', ErrorCodes.FISCAL_CERT_INVALID, 0, 'ERR_OSSL_X509_KEY_VALUES_MISMATCH'))
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_CERT_INVALID })
    expect(repo.insertTransmission).toHaveBeenCalledTimes(1)
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
  })
})

describe('L5/L6 — kinds numa fonte só; lote pára em 409 do EMISSOR', () => {
  it('L5: FINAL_TRANSMISSION_KINDS é o MESMO objeto nos dois repositórios', () => {
    expect(KINDS_A).toBe(KINDS_B)
    expect([...KINDS_A].sort()).toEqual(['A', 'C', 'F', 'N', 'R'])
  })
  it('L6: 3 notas e o emissor sem certificado → openIssuer chamado UMA vez, stoppedEarly, restantes retryable', async () => {
    ;(issuer.openIssuer as jest.Mock).mockRejectedValue(new HttpError(409, 'sem A1', [{ field: 'certificate', message: 'x' }], ErrorCodes.FISCAL_CERT_MISSING))
    const inst: any = { schemaName: S.schema, institutionId: S.inst, userId: S.user, role: 'admin' }
    const r = await transmitInvoiceBatch(inst, { orderIds: [INVOICE, 6301, 6302] } as any)
    expect(issuer.openIssuer).toHaveBeenCalledTimes(1)
    expect(r.stoppedEarly).toBe(true)
    expect(r.results.map(x => x.ok)).toEqual([false, false, false])
    expect(r.results[1].retryable).toBe(true)
    expect(adapter.transmit).not.toHaveBeenCalled()
  })
})
