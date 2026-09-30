/// <reference types="jest" />
// Onda 3 — composição @shared/invoice-transmission (estratégia por RAMO — D-E6).
// O que se fixa: a ORQUESTRAÇÃO (institution → nota → reserva → fisco FORA da
// transação → A/R/F; ambíguo nunca fecha), a voz idempotente, a única porta de
// efeitos (C do fisco → cancelInvoice em SAVEPOINT; recusa = fato + pendência) e
// o cancelamento na ordem da D-N7 (plano local ANTES do fisco; voz C + C local na
// mesma transação; ambíguo = K). Peças reais mockadas na fronteira.
import fs from 'fs'
import os from 'os'
import path from 'path'
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-nfse-'))

import pool from '../shared/db/connection'
import * as repo from '../shared/invoice-transmission/transmission.repository'
import * as authority from '../shared/tax-authority'
import * as issuer from '../shared/fiscal-issuer'
import * as entity from '../shared/entity'
import * as entityTax from '../shared/entity-tax/entity-tax.repository'
import * as invoice from '../shared/invoice'
import * as counters from '../shared/db/counters'
import { AuthorityHttpError } from '../shared/tax-authority/https-json'
import {
  transmitServiceInvoice, refreshServiceTransmission, cancelServiceInvoiceAtAuthority, getServiceFiscalView, getServiceFiscalSummaries, toDbDateTime,
} from '../shared/invoice-transmission'
import { HttpError } from '../shared/errors/http-error'
import { resetMunicipalTermsCache } from '../shared/invoice-transmission/branches/service'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/db/deadlock-retry', () => ({ __esModule: true, withDeadlockRetry: (_l: any, _c: any, _n: any, fn: any) => fn() }))
jest.mock('../shared/db/savepoint', () => ({
  __esModule: true,
  runIsolated: async (_c: any, _n: any, _l: any, fn: any) => { try { return await fn() } catch { return null } },
}))
jest.mock('../shared/db/counters', () => ({ __esModule: true, lockInstitutionCounters: jest.fn() }))
jest.mock('../shared/invoice-transmission/transmission.repository', () => {
  const actual = jest.requireActual('../shared/invoice-transmission/transmission.repository')
  return {
    __esModule: true, ...actual,
    latestTransmission: jest.fn(), insertTransmission: jest.fn(), setDpsId: jest.fn(), fillAuthorityData: jest.fn(),
    insertTransmissionEvent: jest.fn(), setTransmissionEventEffect: jest.fn(), hasTransmissionEvent: jest.fn(),
    findTransmissionEvent: jest.fn(), findTransmissionEventByKind: jest.fn(), getTransmission: jest.fn(), findTransmissionByDpsId: jest.fn(),
    touchQueriedAt: jest.fn(), listServiceTransmissions: jest.fn(),
    listLiveTransmissionsToRefresh: jest.fn(), nextDpsNumber: jest.fn(), setDpsNumber: jest.fn(), countPendingEffects: jest.fn(),
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
}))

const q = (pool as any).query as jest.Mock
const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)

const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const S = { schema: 'setes_setes', inst: 1, user: 7 }
const INVOICE = 6200
const KEY = '4106902212345678000199000000000012320260921000012345'.slice(0, 50)
const NFSE_XML = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${KEY}"><nNFSe>123</nNFSe><dhProc>2026-09-21T10:15:30-03:00</dhProc><cStat>100</cStat><emit><CNPJ>12345678000199</CNPJ></emit><DPS><infDPS Id="DPS410690221234567800019900001000000000000042"></infDPS></DPS></infNFSe></NFSe>`

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
  info: { subject: 'CN=SETES:12345678000199', issuer: 'AC', notAfter: '2027-01-01', daysToExpire: 100, expired: false, cnpj: '12345678000199' },
})
const tx = (over: any = {}) => ({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, environment: 'H', dpsId: 'DPS410690221234567800019900001000000000000042',
  accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21 10:15:30', createdAt: '2026-09-21 10:15:00', ageMinutes: 0, lastQueriedAt: null,
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastDh: '2026-09-21 10:15:30', lastEventAt: null, ...over,
})
const rejected = () => new AuthorityHttpError(422, 'Fisco rejeitou (400): E0718: alíquota inválida', 'FISCAL_DPS_REJECTED', 400,
  '{"erros":[{"codigo":"E0718","descricao":"alíquota inválida"}]}', [{ field: 'dps', message: 'E0718: alíquota inválida' }])
const unavailable = () => new AuthorityHttpError(503, 'Fisco indisponível', 'FISCAL_AUTHORITY_UNAVAILABLE', 0, '')

let headerRow: any
beforeEach(() => {
  jest.clearAllMocks()
  resetMunicipalTermsCache()          // o PAM fica 1 h em cache — cada teste parte limpo
  headerRow = header()
  q.mockImplementation(async (sql: string) => {
    if (/FROM `setes_setes`\.tb_invoice i/.test(sql)) return [[headerRow]]
    if (/tb_city/.test(sql)) return [[{ ibge: '4106902' }]]
    return [[]]
  })
  conn.query.mockImplementation(async (sql: string) => {
    if (/dps_number AS dpsNumber/.test(sql)) return [[{ dpsNumber: headerRow.dpsNumber, updatedAt: headerRow.branchUpdatedAt }]]
    return [{}]
  })
  ;(authority.adapterFor as jest.Mock).mockReturnValue(adapter)
  ;(issuer.openIssuer as jest.Mock).mockResolvedValue(opened())
  ;(entity.getEntityFiscalFull as jest.Mock).mockImplementation(async (id: number) => fullEntity(id))
  ;(entityTax.getEntityTax as jest.Mock).mockResolvedValue({ simplesRegime: '3', simplesAssessment: '1', simplesTotalTaxAliquot: 6, specialTaxRegime: '0' })
  ;(invoice.lockInvoice as jest.Mock).mockResolvedValue({ id: INVOICE, number: '17', serie: '1', model: 'SE', value: 1234.5, status: '0', lastEvent: 1, lastKind: 'E' })
  ;(repo.latestTransmission as jest.Mock).mockResolvedValue(null)
  // a leitura por tentativa / por dps_id espelha a última (os cenários mudam só latestTransmission)
  ;(repo.getTransmission as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionByDpsId as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue(null)
  ;(repo.insertTransmission as jest.Mock).mockResolvedValue(1)
  ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(1)
  ;(repo.hasTransmissionEvent as jest.Mock).mockResolvedValue(false)
  ;(repo.findTransmissionEvent as jest.Mock).mockResolvedValue(null)
  ;(repo.nextDpsNumber as jest.Mock).mockResolvedValue(42)
  ;(repo.countPendingEffects as jest.Mock).mockResolvedValue(0)
  ;(repo.listServiceTransmissions as jest.Mock).mockResolvedValue({ transmissions: [], events: [] })
  adapter.municipalTerms.mockResolvedValue({ cancelDays: null, raw: {} })
})

describe('transmitServiceInvoice — reserva sob lock → fisco FORA da transação → A', () => {
  it('caminho feliz: institution travada PRIMEIRO, nDPS cunhado write-once, DPS assinado em disco, fisco entre os commits, A source P + XML da NFS-e', async () => {
    adapter.transmit.mockResolvedValue({ accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21T10:15:30-03:00', nfseXml: NFSE_XML, raw: {} })
    const r = await transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)
    expect(r).toEqual({ invoiceId: INVOICE, attempt: 1, dpsId: 'DPS410690221234567800019900001000000000000042', accessKey: KEY, nfseNumber: '123', kind: 'A' })
    // regra 7 do §9: quem cunha número trava a institution antes da nota
    expect((counters.lockInstitutionCounters as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((invoice.lockInvoice as jest.Mock).mock.invocationCallOrder[0])
    expect(repo.nextDpsNumber).toHaveBeenCalledTimes(1)
    expect(repo.setDpsNumber).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 42)
    expect(repo.insertTransmission).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 'H', S.user, 1)   // D-N27: a vida (E) da nota
    expect(repo.setDpsId).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, 'DPS410690221234567800019900001000000000000042')
    // o fisco NUNCA é chamado com transação aberta: depois do 1º commit, antes do 2º begin
    const fiscoAt = adapter.transmit.mock.invocationCallOrder[0]
    expect(conn.commit.mock.invocationCallOrder[0]).toBeLessThan(fiscoAt)
    expect(conn.beginTransaction.mock.invocationCallOrder[1]).toBeGreaterThan(fiscoAt)
    expect(conn.commit).toHaveBeenCalledTimes(2)
    // o XML enviado é o DPS do ramo (emitente = institution, tomador = entidade da nota)
    const sent = adapter.transmit.mock.calls[0][1] as string
    expect(sent).toContain('<infDPS Id="DPS410690221234567800019900001000000000000042">')
    expect(sent).toContain('<prest><CNPJ>12345678000199</CNPJ><IM>777</IM><regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib></prest>')
    expect(sent).toContain('<toma><CNPJ>98765432000188</CNPJ><xNome>Cliente Ltda</xNome><end><endNac><cMun>4106902</cMun><CEP>80010000</CEP></endNac>')
    expect(sent).toContain('<cTribNac>010201</cTribNac>')
    expect(sent).toContain('<vServ>1234.50</vServ>')
    expect(sent).not.toContain('<pAliq>')   // ME/EPP pelo Simples sem retenção: alíquota PROIBIDA no DPS (E0625) — o ISS vai no DAS
    expect(sent).toContain('<dCompet>2026-09-21</dCompet>')
    // voz A (source P, dh = dhProc) + write-once do fisco
    expect(repo.fillAuthorityData).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, { accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21 10:15:30' })
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, S.user,
      expect.objectContaining({ kind: 'A', source: 'P', dh: '2026-09-21 10:15:30' }))
    // XML em disco: STORAGE_PATH/<cnpj>/<yyyy>/<mm>/<dpsId>-dps.xml e <chave>-nfse.xml
    const now = new Date()
    const dir = path.join(process.env.STORAGE_PATH!, '12345678000199', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'))
    expect(fs.existsSync(path.join(dir, 'DPS410690221234567800019900001000000000000042-dps.xml'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, `${KEY}-nfse.xml`), 'utf8')).toBe(NFSE_XML)
  })

  it('nDPS já cunhado (tentativa anterior R) → REUSA o número (D-N3 write-once), attempt 2', async () => {
    headerRow = header({ dpsNumber: 42 })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'R', accessKey: null }))
    ;(repo.insertTransmission as jest.Mock).mockResolvedValue(2)
    adapter.transmit.mockResolvedValue({ accessKey: KEY, nfseNumber: '124', dhProc: '2026-09-21T11:00:00-03:00', nfseXml: NFSE_XML, raw: {} })
    const r = await transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)
    expect(r.attempt).toBe(2)
    expect(repo.nextDpsNumber).not.toHaveBeenCalled()
    expect(repo.setDpsNumber).not.toHaveBeenCalled()
    expect(repo.setDpsId).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 2, 'DPS410690221234567800019900001000000000000042')
  })

  it('REJEIÇÃO explícita (422 E0xxx) → voz R (source P, authority_code = 1º E0xxx) e o 422 sobe', async () => {
    adapter.transmit.mockRejectedValue(rejected())
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 422, code: 'FISCAL_DPS_REJECTED' })
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, S.user,
      expect.objectContaining({ kind: 'R', source: 'P', authorityCode: 'E0718', message: expect.stringMatching(/E0718/) }))
    expect(repo.fillAuthorityData).not.toHaveBeenCalled()
  })

  it('AMBÍGUO (503 do fisco) → NADA gravado (reserva fica em voo para a consulta por dps_id)', async () => {
    adapter.transmit.mockRejectedValue(unavailable())
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 503, code: 'FISCAL_AUTHORITY_UNAVAILABLE' })
    expect(repo.insertTransmission).toHaveBeenCalledTimes(1)          // a reserva existe…
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()       // …sem voz
    expect(conn.commit).toHaveBeenCalledTimes(1)
  })

  it('já AUTORIZADA (A vigente) → 409 FISCAL_ALREADY_AUTHORIZED sem reservar nem chamar o fisco', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_ALREADY_AUTHORIZED' })
    expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(adapter.transmit).not.toHaveBeenCalled()
  })

  it('reserva SEM voz recente (em voo) → 409 FISCAL_TRANSMISSION_IN_PROGRESS; K → FISCAL_CANCEL_IN_FLIGHT', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: null, accessKey: null, ageMinutes: 1 }))
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ code: 'FISCAL_TRANSMISSION_IN_PROGRESS' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'K' }))
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ code: 'FISCAL_CANCEL_IN_FLIGHT' })
    expect(adapter.transmit).not.toHaveBeenCalled()
  })

  it('sem ramo de serviço → 422 INVOICE_SERVICE_BRANCH_MISSING; sem código nacional → 422 SERVICE_RULE_NATIONAL_CODE_REQUIRED; nota sincronizada → 409 — tudo ANTES do emissor', async () => {
    headerRow = header({ branchId: null })
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 422, code: 'INVOICE_SERVICE_BRANCH_MISSING' })
    headerRow = header({ nationalCode: null })
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 422, code: 'SERVICE_RULE_NATIONAL_CODE_REQUIRED' })
    headerRow = header({ lastKind: null })
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_NOT_TRANSMITTABLE' })
    expect(repo.insertTransmission).not.toHaveBeenCalled()
  })

  it('tomador sem CNPJ/CPF → 422 FISCAL_RECIPIENT_INCOMPLETE com o campo (dado se corrige no cadastro)', async () => {
    ;(entity.getEntityFiscalFull as jest.Mock).mockImplementation(async (id: number) => id === 900 ? { ...fullEntity(900), company: null } : fullEntity(id))
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({
      statusCode: 422, code: 'FISCAL_RECIPIENT_INCOMPLETE', fields: [expect.objectContaining({ field: 'recipient.document' })],
    })
  })
})

describe('refreshServiceTransmission — a voz do fisco, idempotente', () => {
  it('A já gravado e fisco diz "authorized" → nenhum evento novo; last_queried_at marcado', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ invoiceId: INVOICE, attempt: 1, changed: false, kind: 'A', accessKey: KEY })
    expect(repo.touchQueriedAt).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1)
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(adapter.queryDpsAccessKey).not.toHaveBeenCalled()
  })

  it('em voo sem chave: GET /dps ainda não gerou (null) → só touchQueriedAt (F só por recusa explícita — D-I21)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: null, accessKey: null }))
    adapter.queryDpsAccessKey.mockResolvedValue(null)
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r.changed).toBe(false)
    expect(repo.touchQueriedAt).toHaveBeenCalledWith(pool, S.schema, S.inst, INVOICE, 1)
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
  })

  it('em voo sem chave: GET /dps achou → consulta pela chave → A retroativo (source Q) + write-once', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: null, accessKey: null }))
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ changed: true, kind: 'A', accessKey: KEY })
    expect(repo.fillAuthorityData).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, { accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21 10:15:30' })
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, S.user, expect.objectContaining({ kind: 'A', source: 'Q' }))
  })

  it('C do fisco → voz C + EFEITO pela única porta (cancelInvoice "Cancelada no fisco: …") e invoice_event ligado', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
    ;(invoice.cancelInvoice as jest.Mock).mockResolvedValue({ orderId: INVOICE, invoiceNumber: '17', event: 2, checksReversed: [], bankSlipsCancelled: [], releasedTitles: [], commissionsCompensated: 0 })
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'cancelled', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00', cancelled: { dhEvento: '2026-09-22T09:00:00-03:00', motive: 'erro na emissão do documento' } })
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ changed: true, kind: 'C', invoiceEvent: 2, effectRefused: null })
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, S.user,
      expect.objectContaining({ kind: 'C', source: 'Q', dh: '2026-09-22 09:00:00' }))
    expect(invoice.cancelInvoice).toHaveBeenCalledWith(conn, S.schema, S.inst, S.user, { orderId: INVOICE, reason: 'Cancelada no fisco: erro na emissão do documento' })
    expect(repo.setTransmissionEventEffect).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, 2, 2, null)
  })

  it('D-I10: C do fisco que a NOSSA regra recusa (título baixado) → fato gravado, invoice_event NULL, "Efeito recusado: …" — nunca cancelamento forçado', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
    ;(invoice.cancelInvoice as jest.Mock).mockRejectedValue(new HttpError(409, 'Título 6200/1 tem baixa de 80.00 — estorne a baixa antes', [], 'INVOICE_CANCEL_BLOCKED'))
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'cancelled', nfseXml: NFSE_XML, dhProc: null, cancelled: { dhEvento: '2026-09-22T09:00:00-03:00', motive: 'x' } })
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ changed: true, kind: 'C', invoiceEvent: null, effectRefused: expect.stringMatching(/baixa/) })
    expect(repo.setTransmissionEventEffect).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, 2, null, expect.stringMatching(/^Efeito recusado: /))
    expect(conn.commit).toHaveBeenCalledTimes(1)                      // a voz FICA (pendência visível)
  })

  it('mesma voz C 2× (idempotência por KIND — HIGH-3a) → nada novo; efeito pendente é RETENTADO na consulta seguinte', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'C' }))
    ;(repo.countPendingEffects as jest.Mock).mockResolvedValue(1)
    ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue({ attempt: 1, event: 2, kind: 'C', dh: '2026-09-22 09:00:00', invoiceEvent: null })
    ;(invoice.cancelInvoice as jest.Mock).mockResolvedValue({ event: 3 })
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'cancelled', nfseXml: NFSE_XML, dhProc: null, cancelled: { dhEvento: '2026-09-22T09:00:00-03:00', motive: 'x' } })
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(r).toMatchObject({ kind: 'C', invoiceEvent: 3 })
    expect(repo.setTransmissionEventEffect).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, 2, 3, null)
  })

  it('nunca transmitida → 409 FISCAL_NOT_TRANSMITTED; situação "unknown" → 502 sem gravar voz', async () => {
    await expect(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_NOT_TRANSMITTED' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'unknown', nfseXml: NFSE_XML, dhProc: null })
    await expect(refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')).rejects.toMatchObject({ statusCode: 502, code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
  })
})

describe('cancelServiceInvoiceAtAuthority — D-N7: plano local → estado fiscal → fisco → voz → C', () => {
  const planOk = (extraBlocks: any[] = []) => ({
    orderId: INVOICE, invoice: { id: INVOICE, lastKind: 'E', lastEvent: 1 }, blocks: extraBlocks, bankSlipsToCancel: [], releasedTitles: [],
    serviceOrder: null, checksToReverse: [], commissionEntries: [], touchesCash: false,
  })
  const cancelled = { orderId: INVOICE, invoiceNumber: '17', event: 2, checksReversed: [], bankSlipsCancelled: [], releasedTitles: [], commissionsCompensated: 0 }

  it('plano LOCAL bloqueia (título baixado) → 409 INVOICE_CANCEL_BLOCKED ANTES de tocar o fisco', async () => {
    ;(invoice.buildCancelPlan as jest.Mock).mockResolvedValue(planOk([
      { field: 'title', ref: '6200/1', message: 'Título 6200/1 tem baixa de 80.00 — estorne a baixa antes' },
      { field: 'fiscal', ref: '1', message: 'NFS-e autorizada' },
    ]))
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    await expect(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço'))
      .rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_CANCEL_BLOCKED', fields: [expect.objectContaining({ field: 'title' })] })
    expect(adapter.registerEvent).not.toHaveBeenCalled()
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
  })

  it('fisco ACEITA (e101101) → voz C (source P, dh = dhEvento) + cancelInvoice na MESMA transação; invoice_event ligado', async () => {
    ;(invoice.buildCancelPlan as jest.Mock).mockResolvedValue(planOk([{ field: 'fiscal', ref: '1', message: 'NFS-e autorizada' }]))
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
    ;(invoice.cancelInvoice as jest.Mock).mockResolvedValue(cancelled)
    adapter.registerEvent.mockResolvedValue({ dhEvento: '2026-09-22T09:00:00-03:00', protocol: 'EVT1', raw: {} })
    const r = await cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço')
    expect(r).toEqual({ invoiceId: INVOICE, attempt: 1, atAuthority: true, invoiceEvent: 2, transmissionEvent: 2, warnings: [] })
    // xMotivo assinado com a chave da transmissão; fisco chamado depois do commit do plano
    const eventXml = adapter.registerEvent.mock.calls[0][2] as string
    expect(eventXml).toContain(`<chNFSe>${KEY}</chNFSe>`)
    expect(eventXml).toContain('<xMotivo>cliente desistiu do serviço</xMotivo>')
    expect(eventXml).toContain('<CNPJAutor>12345678000199</CNPJAutor>')
    const fiscoAt = adapter.registerEvent.mock.invocationCallOrder[0]
    expect(conn.commit.mock.invocationCallOrder[0]).toBeLessThan(fiscoAt)
    // voz C e C local na MESMA transação (2º begin antes dos dois, 2º commit depois)
    const cIns = (repo.insertTransmissionEvent as jest.Mock).mock.invocationCallOrder[0]
    const cLocal = (invoice.cancelInvoice as jest.Mock).mock.invocationCallOrder[0]
    expect(conn.beginTransaction.mock.invocationCallOrder[1]).toBeLessThan(cIns)
    expect(cIns).toBeLessThan(cLocal)
    expect(conn.commit.mock.invocationCallOrder[1]).toBeGreaterThan(cLocal)
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, S.user,
      expect.objectContaining({ kind: 'C', source: 'P', dh: '2026-09-22 09:00:00' }))
    expect(repo.setTransmissionEventEffect).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, 2, 2, null)
  })

  it('motivo curto ganha o complemento (xMotivo 15–255); prazo do PAM vencido só AVISA (D-N15)', async () => {
    ;(invoice.buildCancelPlan as jest.Mock).mockResolvedValue(planOk([{ field: 'fiscal', ref: '1', message: 'x' }]))
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A', dhProc: '2026-01-01 10:00:00' }))
    ;(invoice.cancelInvoice as jest.Mock).mockResolvedValue(cancelled)
    adapter.municipalTerms.mockResolvedValue({ cancelDays: 30, raw: {} })
    adapter.registerEvent.mockResolvedValue({ dhEvento: null, raw: {} })
    const r = await cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'erro')
    expect(r.warnings).toEqual([expect.stringMatching(/Prazo de cancelamento .*30 dias/)])
    expect(adapter.registerEvent.mock.calls[0][2]).toContain('<xMotivo>erro — Cancelamento solicitado pelo emissor</xMotivo>')
  })

  it('fisco RECUSA (422 → E0822 prazo) → 409 FISCAL_CANCEL_REFUSED, nada gravado', async () => {
    ;(invoice.buildCancelPlan as jest.Mock).mockResolvedValue(planOk([{ field: 'fiscal', ref: '1', message: 'x' }]))
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.registerEvent.mockRejectedValue(new AuthorityHttpError(422, 'Fisco rejeitou', 'FISCAL_DPS_REJECTED', 400, '', [{ field: 'event', message: 'E0822: prazo de cancelamento expirado' }]))
    await expect(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço'))
      .rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CANCEL_REFUSED', fields: [expect.objectContaining({ message: expect.stringMatching(/E0822/) })] })
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
  })

  it('AMBÍGUO (503) → K em voo (source P) e o 503 sobe; nada cancelado localmente', async () => {
    ;(invoice.buildCancelPlan as jest.Mock).mockResolvedValue(planOk([{ field: 'fiscal', ref: '1', message: 'x' }]))
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.registerEvent.mockRejectedValue(unavailable())
    await expect(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço'))
      .rejects.toMatchObject({ statusCode: 503, code: 'FISCAL_AUTHORITY_UNAVAILABLE' })
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, S.user, expect.objectContaining({ kind: 'K', source: 'P' }))
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
  })

  it('recusa LOCAL no intervalo (fisco já cancelou) → voz C fica com pendência e 409 FISCAL_EFFECT_PENDING', async () => {
    ;(invoice.buildCancelPlan as jest.Mock).mockResolvedValue(planOk([{ field: 'fiscal', ref: '1', message: 'x' }]))
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
    ;(invoice.cancelInvoice as jest.Mock).mockRejectedValue(new HttpError(409, 'Nenhum caixa aberto', undefined, 'NO_OPEN_CASHIER'))
    adapter.registerEvent.mockResolvedValue({ dhEvento: '2026-09-22T09:00:00-03:00', raw: {} })
    await expect(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço'))
      .rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_EFFECT_PENDING' })
    expect(repo.setTransmissionEventEffect).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, 2, null, 'Efeito recusado: Nenhum caixa aberto')
    expect(conn.commit).toHaveBeenCalledTimes(2)                      // plano + voz C (a voz FICA)
  })

  it('nunca transmitida / R / F → cancela SÓ local (cancelInvoice normal), fisco não é chamado', async () => {
    ;(invoice.buildCancelPlan as jest.Mock).mockResolvedValue(planOk())
    ;(invoice.cancelInvoice as jest.Mock).mockResolvedValue(cancelled)
    const r = await cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'erro')
    expect(r).toEqual({ invoiceId: INVOICE, attempt: null, atAuthority: false, invoiceEvent: 2, transmissionEvent: null, warnings: [] })
    expect(adapter.registerEvent).not.toHaveBeenCalled()
    expect(invoice.cancelInvoice).toHaveBeenCalledWith(conn, S.schema, S.inst, S.user, { orderId: INVOICE, reason: 'erro' })
  })

  it('em voo (sem voz) → 409 FISCAL_TRANSMISSION_IN_PROGRESS; K → 409 FISCAL_CANCEL_IN_FLIGHT — nunca ao fisco', async () => {
    ;(invoice.buildCancelPlan as jest.Mock).mockResolvedValue(planOk([{ field: 'fiscal', ref: '1', message: 'x' }]))
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: null, accessKey: null }))
    await expect(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'erro')).rejects.toMatchObject({ code: 'FISCAL_TRANSMISSION_IN_PROGRESS' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'K' }))
    await expect(cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'erro')).rejects.toMatchObject({ code: 'FISCAL_CANCEL_IN_FLIGHT' })
    expect(adapter.registerEvent).not.toHaveBeenCalled()
  })
})

describe('getServiceFiscalView', () => {
  it('estado derivado do último evento da última tentativa + pendências + XML em disco', async () => {
    ;(repo.listServiceTransmissions as jest.Mock).mockResolvedValue({
      transmissions: [tx({ attempt: 1, lastKind: 'R' }), tx({ attempt: 2, lastKind: 'A' })],
      events: [{ attempt: 1, event: 1, kind: 'R', invoiceEvent: null }, { attempt: 2, event: 1, kind: 'A', invoiceEvent: null }],
    })
    const v = await getServiceFiscalView(S.schema, S.inst, INVOICE)
    expect(v).toMatchObject({ invoiceId: INVOICE, state: 'authorized', pendingEffects: 0, xmlAvailable: true, danfseAvailable: true })
  })
})

describe('getServiceFiscalSummaries — selo da lista de OS pelo MESMO leitor do detalhe', () => {
  it('vigente = quem detém a chave (D-N26), senão a última; nota sem tentativa = none', async () => {
    const row = (invoiceId: number, attempt: number, lastKind: string | null, accessKey: string | null = null, environment = 'P') =>
      ({ institutionId: S.inst, invoiceId, attempt, environment, accessKey, nfseNumber: accessKey ? '15' : null, lastKind })
    q.mockResolvedValueOnce([[
      row(10, 1, 'A', 'KEY10'), row(10, 2, 'R'),          // chave na 1 → autorizada, mesmo com R depois
      row(11, 1, 'R', null, 'H'), row(11, 2, 'F', null, 'H'),
    ]])
    const m = await getServiceFiscalSummaries(S.schema, S.inst, [10, 11, 12])
    expect(m.get(10)).toEqual({ state: 'authorized', environment: 'P', nfseNumber: '15' })
    expect(m.get(11)).toEqual({ state: 'failed', environment: 'H', nfseNumber: null })
    expect(m.get(12)).toEqual({ state: 'none', environment: null, nfseNumber: null })
  })

  it('lista vazia não consulta o banco', async () => {
    q.mockClear()
    expect((await getServiceFiscalSummaries(S.schema, S.inst, [])).size).toBe(0)
    expect(q).not.toHaveBeenCalled()
  })
})

describe('Q-N38 — XML do evento de cancelamento no arquivo fiscal (Valdo 2026-09-30)', () => {
  const planOk = (extraBlocks: any[] = []) => ({
    orderId: INVOICE, invoice: { id: INVOICE, lastKind: 'E', lastEvent: 1 }, blocks: extraBlocks, bankSlipsToCancel: [], releasedTitles: [],
    serviceOrder: null, checksToReverse: [], commissionEntries: [], touchesCash: false,
  })
  const cancelled = { orderId: INVOICE, invoiceNumber: '17', event: 2, checksReversed: [], bankSlipsCancelled: [], releasedTitles: [], commissionsCompensated: 0 }
  it('fisco ACEITA com o evento gerado → <chave>-evt101101.xml gravado na pasta da NFS-e (mês da autorização)', async () => {
    ;(invoice.buildCancelPlan as jest.Mock).mockResolvedValue(planOk([{ field: 'fiscal', ref: '1', message: 'NFS-e autorizada' }]))
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A', dhProc: '2026-08-15 10:00:00' }))
    ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
    ;(invoice.cancelInvoice as jest.Mock).mockResolvedValue(cancelled)
    const EVT = '<evento><infEvento Id="EVT1"><dhProc>2026-09-22T09:00:00-03:00</dhProc></infEvento></evento>'
    adapter.registerEvent.mockResolvedValue({ dhEvento: '2026-09-22T09:00:00-03:00', protocol: 'EVT1', eventXml: EVT, raw: {} })
    await cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço')
    const file = path.join(process.env.STORAGE_PATH!, '12345678000199', '2026', '08', `${KEY}-evt101101.xml`)
    expect(fs.readFileSync(file, 'utf8')).toBe(EVT)
  })
})
