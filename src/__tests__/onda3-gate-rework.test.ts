/// <reference types="jest" />
// Onda 3 NFS-e — RETRABALHO do gate socrático (score 0.63 → correções em sessão).
// Um bloco por achado: HIGH-1 (kind N — D-N17), HIGH-2 (contador do nDPS no
// emissor — D-N18), HIGH-3 (C por KIND + nota já cancelada dos dois lados),
// MEDIUM-1 (consulta por dps_id em R/F → chave na tentativa que cunhou),
// MEDIUM-2 (idade no banco), MEDIUM-3 (reserva confere nota/ramo + emissor FOR
// UPDATE), MEDIUM-4 (lote com orçamento e coalescência), MEDIUM-5 (D-N19/D-N20),
// MEDIUM-6 (D-N21 vigilância de A e C pendente), MEDIUM-7 (D-N22 privilégio nas
// consultas), LOW-1/3/6/9. Peças reais mockadas na fronteira.
import fs from 'fs'
import os from 'os'
import path from 'path'
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'setes-nfse-rework-'))

import pool from '../shared/db/connection'
import logger from '../shared/logger/logger'
import * as repo from '../shared/invoice-transmission/transmission.repository'
import * as authority from '../shared/tax-authority'
import * as issuer from '../shared/fiscal-issuer'
import * as entity from '../shared/entity'
import * as entityTax from '../shared/entity-tax/entity-tax.repository'
import * as invoice from '../shared/invoice'
import * as counters from '../shared/db/counters'
import * as taxRule from '../shared/service-tax-rule'
import { transport } from '../shared/tax-authority/https-json'
import {
  transmitServiceInvoice, refreshServiceTransmission, cancelServiceInvoiceAtAuthority, applyCancelEffect,
  isInterruptedInFlight, fiscalStateOf,
} from '../shared/invoice-transmission'
import { buildEmitter, buildSignedDps, resetMunicipalTermsCache } from '../shared/invoice-transmission/branches/service'
import { liabilityFromExigibilidade } from '../shared/entity-tax/entity-tax.types'
import { buildServiceBranch, serviceDescription } from '../modules/billing/billing.repository'
import { resolveServiceOrderFiscal } from '../modules/service-orders/service-orders.repository'
import { transmitInvoiceBatch } from '../modules/billing/billing.fiscal.service'
import { fiscalRefreshBodyDto } from '../modules/billing/billing.dto'
import billingRoutes from '../modules/billing/billing.routes'
import { HttpError } from '../shared/errors/http-error'

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
// repositório: só as funções que GRAVAM ou leem a transmissão são mockadas; nextDpsNumber, listLive* e
// listPending* ficam REAIS (o SQL deles é o que os achados HIGH-2/MEDIUM-6/LOW-3 fixam)
jest.mock('../shared/invoice-transmission/transmission.repository', () => {
  const actual = jest.requireActual('../shared/invoice-transmission/transmission.repository')
  return {
    __esModule: true, ...actual,
    latestTransmission: jest.fn(), getTransmission: jest.fn(), findTransmissionByDpsId: jest.fn(),
    insertTransmission: jest.fn(), setDpsId: jest.fn(), fillAuthorityData: jest.fn(),
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
  LAST_INVOICE_EVENT_KIND_SQL: (s: string, a = 'i') => `(SELECT 'E')`,
}))
jest.mock('../shared/service-tax-rule', () => ({
  __esModule: true, ...jest.requireActual('../shared/service-tax-rule'), resolveServiceTaxRule: jest.fn(),
}))
jest.mock('../shared/auth/require-privilege', () => ({
  __esModule: true, ...jest.requireActual('../shared/auth/require-privilege'), userHasPrivilege: jest.fn().mockResolvedValue(true),
}))

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
const opened = (environment: 'H' | 'P' = 'H', serie = '1') => ({
  issuer: { institutionId: 1, model: 'SE', environment, serie, userId: null },
  cert: Buffer.from('CERT'), key: Buffer.from('KEY'),
  info: { subject: 'CN=SETES:12345678000199', issuer: 'AC', notAfter: '2027-01-01', daysToExpire: 100, expired: false, cnpj: '12345678000199' },
})
const tx = (over: any = {}) => ({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, environment: 'H', dpsId: DPS_ID,
  accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21 10:15:30', createdAt: '2026-09-21 10:15:00', ageMinutes: 0, lastQueriedAt: null,
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastDh: '2026-09-21 10:15:30', lastEventAt: null, ...over,
})
const cancelled = { orderId: INVOICE, invoiceNumber: '17', event: 2, checksReversed: [], bankSlipsCancelled: [], releasedTitles: [], commissionsCompensated: 0 }
const planOk = (blocks: any[] = []) => ({ orderId: INVOICE, invoice: { id: INVOICE, lastKind: 'E', lastEvent: 1 }, blocks, bankSlipsToCancel: [], releasedTitles: [], serviceOrder: null, checksToReverse: [], commissionEntries: [], touchesCash: false })
const authorizedQuery = () => ({ accessKey: KEY, status: 'authorized' as const, nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })
const cancelledQuery = () => ({ ...authorizedQuery(), status: 'cancelled' as const, cancelled: { dhEvento: '2026-09-22T09:00:00-03:00', motive: 'erro na emissão' } })

let headerRow: any
let emitterTax: any
beforeEach(() => {
  jest.clearAllMocks()
  resetMunicipalTermsCache()
  headerRow = header()
  emitterTax = { simplesRegime: '3', simplesAssessment: '1', simplesTotalTaxAliquot: 6, specialTaxRegime: null, issExigibilidade: '01' }
  q.mockImplementation(async (sql: string) => {
    if (/FROM `setes_setes`\.tb_invoice i/.test(sql)) return [[headerRow]]
    if (/tb_city/.test(sql)) return [[{ ibge: '4106902' }]]
    return [[]]
  })
  conn.query.mockImplementation(async (sql: string) => {
    if (/dps_number AS dpsNumber/.test(sql)) return [[{ dpsNumber: headerRow.dpsNumber, updatedAt: headerRow.branchUpdatedAt }]]
    if (/UPDATE .*tb_establishment_issuer SET dps_last_number/.test(sql)) return [{ affectedRows: 1 }]
    if (/SELECT dps_last_number AS n/.test(sql)) return [[{ n: 43 }]]
    return [[]]
  })
  ;(authority.adapterFor as jest.Mock).mockReturnValue(adapter)
  ;(issuer.openIssuer as jest.Mock).mockResolvedValue(opened())
  ;(entity.getEntityFiscalFull as jest.Mock).mockImplementation(async (id: number) => fullEntity(id))
  ;(entityTax.getEntityTax as jest.Mock).mockImplementation(async () => emitterTax)
  ;(invoice.lockInvoice as jest.Mock).mockResolvedValue({ id: INVOICE, number: '17', serie: '1', model: 'SE', value: 1234.5, status: '0', lastEvent: 1, lastKind: 'E' })
  ;(invoice.buildCancelPlan as jest.Mock).mockResolvedValue(planOk([{ field: 'fiscal', ref: '1', message: 'x' }]))
  ;(invoice.cancelInvoice as jest.Mock).mockResolvedValue(cancelled)
  ;(repo.latestTransmission as jest.Mock).mockResolvedValue(null)
  ;(repo.getTransmission as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionByDpsId as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue(null)
  ;(repo.insertTransmission as jest.Mock).mockResolvedValue(1)
  ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
  ;(repo.hasTransmissionEvent as jest.Mock).mockResolvedValue(false)
  ;(repo.countPendingEffects as jest.Mock).mockResolvedValue(0)
  ;(repo.listServiceTransmissions as jest.Mock).mockResolvedValue({ transmissions: [], events: [] })
  adapter.municipalTerms.mockResolvedValue({ cancelDays: null, raw: {} })
  adapter.transmit.mockResolvedValue({ accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21T10:15:30-03:00', nfseXml: NFSE_XML, raw: {} })
})

// ---------------------------------------------------------------------------
describe('HIGH-1 / D-N17 — K sem cancelamento no fisco → N, e a NFS-e volta a AUTORIZADA', () => {
  it('consulta com último evento K e fisco "authorized" → grava N (source Q, dh = agora), changed', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'K', lastEventAgeMinutes: 30 }))   // D-N28: K com mais de 10 min
    adapter.queryNfse.mockResolvedValue(authorizedQuery())
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ changed: true, kind: 'N' })
    expect(repo.insertTransmissionEvent).toHaveBeenCalledTimes(1)
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, S.user,
      expect.objectContaining({ kind: 'N', source: 'Q', dh: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) }))
  })
  it('N é AUTORIZADA para a nota e FINAL para a consulta; K sem resposta continua bloqueando; view mostra "authorized"', () => {
    expect(repo.isAuthorized(tx({ lastKind: 'N' }) as any)).toBe(true)
    expect(repo.isLiveTransmission(tx({ lastKind: 'N' }) as any)).toBe(false)
    expect(repo.FINAL_TRANSMISSION_KINDS.has('N')).toBe(true)
    expect(repo.isLiveTransmission(tx({ lastKind: 'K' }) as any)).toBe(true)
    expect(fiscalStateOf(tx({ lastKind: 'N' }) as any)).toBe('authorized')
  })
  it('K + fisco "cancelled" → C (não N): o pedido chegou', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'K' }))
    adapter.queryNfse.mockResolvedValue(cancelledQuery())
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r.kind).toBe('C')
    const kinds = (repo.insertTransmissionEvent as jest.Mock).mock.calls.map(c => c[6].kind)
    expect(kinds).toEqual(['C'])
  })
  it('depois de N o cancelamento fica LIBERADO (vai ao fisco) e transmitir de novo continua 409 ALREADY_AUTHORIZED', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'N' }))
    adapter.registerEvent.mockResolvedValue({ dhEvento: '2026-09-22T09:00:00-03:00', raw: {} })
    const r = await cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'cliente desistiu do serviço')
    expect(r.atAuthority).toBe(true)
    expect(adapter.registerEvent).toHaveBeenCalledTimes(1)
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ code: 'FISCAL_ALREADY_AUTHORIZED' })
  })
  // o bloco fiscal do plano com N é fixado em invoice-cancel.test.ts (harness do plano)
})

// ---------------------------------------------------------------------------
describe('HIGH-2 / D-N18 — contador do nDPS vive no EMISSOR', () => {
  const real = jest.requireActual('../shared/invoice-transmission/transmission.repository')
  it('nextDpsNumber = UPDATE dps_last_number + 1 na linha SE e devolve o novo valor (nunca MAX do ramo)', async () => {
    const n = await real.nextDpsNumber(conn as any, S.schema, S.inst)
    expect(n).toBe(43)
    const sqls = conn.query.mock.calls.map(c => String(c[0]).replace(/\s+/g, ' '))
    expect(sqls[0]).toMatch(/UPDATE `setes_setes`\.tb_establishment_issuer SET dps_last_number = dps_last_number \+ 1/)
    expect(sqls[0]).toMatch(/model = 'SE'/)
    expect(sqls.some(s => /MAX\(dps_number\)/.test(s))).toBe(false)
  })
  it('sem linha SE viva → erro explícito (nunca cunha "1" do nada)', async () => {
    conn.query.mockImplementation(async (sql: string) => /UPDATE .*dps_last_number/.test(sql) ? [{ affectedRows: 0 }] : [[]])
    await expect(real.nextDpsNumber(conn as any, S.schema, S.inst)).rejects.toThrow(/Emissor SE sem linha/)
  })
  it('na reserva: institution → nota → EMISSOR FOR UPDATE (conn) → ramo → cunha no emissor; nova vida (dps_number NULL) = novo nDPS', async () => {
    const r = await transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)
    expect(r.attempt).toBe(1)
    expect(repo.setDpsNumber).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 43)
    expect(r.dpsId).toBe('DPS410690221234567800019900001000000000000043')
    const openInside = (issuer.openIssuer as jest.Mock).mock.calls.find(c => c[3]?.conn === conn && c[3]?.forUpdate === true)
    expect(openInside).toBeTruthy()
    const order = {
      inst: (counters.lockInstitutionCounters as jest.Mock).mock.invocationCallOrder[0],
      invoice: (invoice.lockInvoice as jest.Mock).mock.invocationCallOrder[0],
      issuerInside: (issuer.openIssuer as jest.Mock).mock.invocationCallOrder[1],
      counter: conn.query.mock.invocationCallOrder[conn.query.mock.calls.findIndex(c => /dps_last_number = dps_last_number/.test(String(c[0])))],
    }
    expect(order.inst).toBeLessThan(order.invoice)
    expect(order.invoice).toBeLessThan(order.issuerInside)
    expect(order.issuerInside).toBeLessThan(order.counter)
  })
})

// ---------------------------------------------------------------------------
describe('HIGH-3 — C por KIND; nota já cancelada dos dois lados não vira pendência', () => {
  it('(a) C do fisco com dh DIFERENTE do C já gravado (efeito aplicado) → nenhum C novo', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'C' }))
    ;(repo.countPendingEffects as jest.Mock).mockResolvedValue(1)
    ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue({ attempt: 1, event: 2, kind: 'C', dh: '2026-09-22 08:00:00', invoiceEvent: 5 })
    adapter.queryNfse.mockResolvedValue(cancelledQuery())        // dhEvento 09:00 ≠ 08:00 gravado
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(r).toMatchObject({ kind: 'C', invoiceEvent: 5 })
  })
  it('(b) applyCancelEffect com cabeçalho soft-deletado (404) e último evento da nota = C → devolve esse evento, sem cancelInvoice', async () => {
    ;(invoice.lockInvoice as jest.Mock).mockRejectedValue(new HttpError(404, 'Nota não encontrada', undefined, 'INVOICE_NOT_FOUND'))
    conn.query.mockImplementation(async (sql: string) => /tb_invoice_event/.test(sql) ? [[{ event: 9, kind: 'C' }]] : [[]])
    const ev = await applyCancelEffect(conn as any, S.schema, S.inst, S.user, INVOICE, 'x')
    expect(ev).toBe(9)
    expect(invoice.cancelInvoice).not.toHaveBeenCalled()
    expect(String(conn.query.mock.calls[0][0])).toMatch(/tb_invoice_event[\s\S]*FOR UPDATE/)
  })
  it('(b2) 404 e a nota NÃO está cancelada → o 404 sobe (nada inventado)', async () => {
    ;(invoice.lockInvoice as jest.Mock).mockRejectedValue(new HttpError(404, 'Nota não encontrada', undefined, 'INVOICE_NOT_FOUND'))
    await expect(applyCancelEffect(conn as any, S.schema, S.inst, S.user, INVOICE, 'x')).rejects.toMatchObject({ statusCode: 404 })
  })
  it('(c) cancelar no fisco com voz C já gravada e nota já C → 200 local (sem FISCAL_EFFECT_PENDING), pendência ligada ao C existente', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'C' }))
    ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue({ attempt: 1, event: 2, kind: 'C', dh: null, invoiceEvent: null })
    conn.query.mockImplementation(async (sql: string) => /tb_invoice_event/.test(sql) ? [[{ event: 9, kind: 'C' }]] : [[]])
    const r = await cancelServiceInvoiceAtAuthority(S.schema, S.inst, S.user, INVOICE, 'motivo qualquer do emissor')
    expect(r).toEqual({ invoiceId: INVOICE, attempt: 1, atAuthority: false, invoiceEvent: 9, transmissionEvent: 2, warnings: [] })
    expect(repo.setTransmissionEventEffect).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, 2, 9, expect.stringMatching(/já feito/))
    expect(invoice.buildCancelPlan).not.toHaveBeenCalled()
    expect(adapter.registerEvent).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
describe('MEDIUM-1 — consulta por dps_id em R/F: a chave vai para a tentativa que CUNHOU o Id', () => {
  it('última tentativa R sem chave: GET /dps acha → A gravado na tentativa mais antiga com esse dps_id (mesmo sendo R)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ attempt: 2, lastKind: 'R', accessKey: null }))
    ;(repo.findTransmissionByDpsId as jest.Mock).mockResolvedValue(tx({ attempt: 1, lastKind: 'F', accessKey: null }))
    ;(repo.getTransmission as jest.Mock).mockImplementation(async (_c: any, _s: any, _i: any, _inv: any, attempt: number) => tx({ attempt, lastKind: attempt === 1 ? 'F' : 'R', accessKey: null }))
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
    adapter.queryNfse.mockResolvedValue(authorizedQuery())
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ attempt: 1, changed: true, kind: 'A', accessKey: KEY })
    expect(adapter.queryDpsAccessKey).toHaveBeenCalledWith(expect.anything(), DPS_ID)
    expect(repo.fillAuthorityData).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, expect.objectContaining({ accessKey: KEY }))
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 1, S.user, expect.objectContaining({ kind: 'A', source: 'Q' }))
  })
  it('R sem chave e GET /dps 404 → só touch (R continua R)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'R', accessKey: null }))
    adapter.queryDpsAccessKey.mockResolvedValue(null)
    const r = await refreshServiceTransmission(S.schema, S.inst, S.user, INVOICE, 'Q')
    expect(r).toMatchObject({ changed: false, kind: 'R' })
    expect(repo.touchQueriedAt).toHaveBeenCalledWith(pool, S.schema, S.inst, INVOICE, 1)
  })
})

// ---------------------------------------------------------------------------
describe('MEDIUM-2 — idade da reserva calculada NO BANCO', () => {
  it('isInterruptedInFlight lê ageMinutes (TIMESTAMPDIFF), nunca Date.now() contra a string', () => {
    expect(isInterruptedInFlight(tx({ lastKind: null, accessKey: null, ageMinutes: 11, createdAt: '2026-01-01 00:00:00' }) as any)).toBe(true)
    expect(isInterruptedInFlight(tx({ lastKind: null, accessKey: null, ageMinutes: 9, createdAt: '2020-01-01 00:00:00' }) as any)).toBe(false)
    expect(isInterruptedInFlight(tx({ lastKind: null, accessKey: null, ageMinutes: null, createdAt: '2020-01-01 00:00:00' }) as any)).toBe(false)
    expect(isInterruptedInFlight(tx({ lastKind: 'R', ageMinutes: 999 }) as any)).toBe(false)
  })
  it('TX_SELECT do repositório traz ageMinutes por TIMESTAMPDIFF', async () => {
    const real = jest.requireActual('../shared/invoice-transmission/transmission.repository')
    q.mockResolvedValueOnce([[]])
    await real.latestTransmission(pool, S.schema, S.inst, INVOICE)
    expect(String(q.mock.calls[0][0])).toMatch(/TIMESTAMPDIFF\(MINUTE, t\.created_at, NOW\(\)\) AS ageMinutes/)
  })
})

// ---------------------------------------------------------------------------
describe('MEDIUM-3 — a reserva confere que a nota não mudou e congela ambiente/série do emissor FOR UPDATE', () => {
  it('evento da nota mudou entre a leitura e o lock → 409 RESOURCE_BUSY "nota mudou", nada reservado', async () => {
    ;(invoice.lockInvoice as jest.Mock).mockResolvedValue({ id: INVOICE, lastEvent: 2, lastKind: 'E' })
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY', message: expect.stringMatching(/mudou/) })
    expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(adapter.transmit).not.toHaveBeenCalled()
  })
  it('updated_at do ramo mudou (refaturamento/ajuste no intervalo) → 409 RESOURCE_BUSY', async () => {
    conn.query.mockImplementation(async (sql: string) => /dps_number AS dpsNumber/.test(sql) ? [[{ dpsNumber: null, updatedAt: '2026-09-21 09:00:01' }]] : [{ affectedRows: 1 }])
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ code: 'RESOURCE_BUSY' })
    expect(repo.insertTransmission).not.toHaveBeenCalled()
  })
  it('ambiente/série vêm da leitura FOR UPDATE de dentro da reserva (H fora, P dentro → tentativa nasce em P, Id com a série de dentro)', async () => {
    ;(issuer.openIssuer as jest.Mock).mockImplementation(async (_s: any, _i: any, _m: any, opts: any) => opts?.conn ? opened('P', '7') : opened('H', '1'))
    const r = await transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)
    expect(repo.insertTransmission).toHaveBeenCalledWith(conn, S.schema, S.inst, INVOICE, 'P', S.user, 1)   // D-N27
    expect(r.dpsId).toBe('DPS410690221234567800019900007000000000000043')
    expect(adapter.transmit.mock.calls[0][0]).toMatchObject({ environment: 'P' })
    expect(adapter.transmit.mock.calls[0][1]).toContain('<tpAmb>1</tpAmb>')
  })
})

// ---------------------------------------------------------------------------
describe('MEDIUM-4 — lote com orçamento de tempo e coalescência por institution', () => {
  const admin = { schemaName: S.schema, institutionId: S.inst, userId: S.user, role: 'admin' } as any
  it('orçamento esgotado → stoppedEarly e itens não processados voltam retryable', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'R', accessKey: null }))
    const r = await transmitInvoiceBatch(admin, { orderIds: [INVOICE, INVOICE + 1, INVOICE + 2] }, { budgetMs: 0 })
    expect(r).toMatchObject({ requested: 3, transmitted: 0, failed: 3, stoppedEarly: true })
    expect(r.results.every(i => i.retryable === true && !i.ok)).toBe(true)
    expect(adapter.transmit).not.toHaveBeenCalled()
  })
  it('dois lotes ao mesmo tempo para a mesma institution → o 2º recebe 409 FISCAL_BATCH_RUNNING; depois libera', async () => {
    let release!: () => void
    adapter.transmit.mockImplementationOnce(() => new Promise(res => { release = () => res({ accessKey: KEY, nfseNumber: '1', dhProc: null, nfseXml: NFSE_XML, raw: {} }) }))
    const first = transmitInvoiceBatch(admin, { orderIds: [INVOICE] })
    await new Promise(r => setTimeout(r, 20))
    await expect(transmitInvoiceBatch(admin, { orderIds: [INVOICE + 1] })).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_BATCH_RUNNING' })
    release()
    const r1 = await first
    expect(r1.transmitted).toBe(1)
    const r2 = await transmitInvoiceBatch(admin, { orderIds: [INVOICE + 1] })
    expect(r2.requested).toBe(1)
  })
  it('FISCAL_TRANSMISSION_IN_PROGRESS por item = retryable; DPS rejeitado = não', async () => {
    // a reserva lê latestTransmission FORA (reconciliação) e DENTRO (guarda) — duas leituras por item
    ;(repo.latestTransmission as jest.Mock)
      .mockResolvedValueOnce(tx({ lastKind: null, accessKey: null, ageMinutes: 1 }))
      .mockResolvedValueOnce(tx({ lastKind: null, accessKey: null, ageMinutes: 1 }))
      .mockResolvedValue(null)
    adapter.transmit.mockRejectedValueOnce(new authority.AuthorityHttpError(422, 'Fisco rejeitou', 'FISCAL_DPS_REJECTED', 400, '', [{ field: 'dps', message: 'E0718: x' }]))
    const r = await transmitInvoiceBatch(admin, { orderIds: [INVOICE, INVOICE + 1] })
    expect(r.results[0]).toMatchObject({ ok: false, code: 'FISCAL_TRANSMISSION_IN_PROGRESS', retryable: true })
    expect(r.results[1]).toMatchObject({ ok: false, code: 'FISCAL_DPS_REJECTED', retryable: false })
  })
})

// ---------------------------------------------------------------------------
describe('MEDIUM-5 — D-N19 opSimpNac sem default; D-N20 tribISSQN pela exigibilidade do EMITENTE', () => {
  it('simples_regime NULL → 422 FISCAL_EMITTER_INCOMPLETE com field simplesRegime (antes de reservar)', async () => {
    emitterTax = { simplesRegime: null, specialTaxRegime: null }
    await expect(buildEmitter(S.schema, S.inst)).rejects.toMatchObject({ statusCode: 422, code: 'FISCAL_EMITTER_INCOMPLETE', fields: [expect.objectContaining({ field: 'simplesRegime' })] })
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ code: 'FISCAL_EMITTER_INCOMPLETE' })
    expect(repo.insertTransmission).not.toHaveBeenCalled()
  })
  it('Q-N36/Q-N37: o LEITOR do emitente (usado também no cancelamento) NÃO exige apuração nem % — a obrigação é só da montagem do DPS', async () => {
    emitterTax = { simplesRegime: '3', simplesAssessment: null, simplesTotalTaxAliquot: null, specialTaxRegime: null }
    const e = await buildEmitter(S.schema, S.inst)
    expect(e.prest.regTrib).toEqual({ opSimpNac: '3', regEspTrib: '0' })
    expect(e.simplesTotalTaxAliquot).toBeNull()
  })
  it('special_tax_regime NULL → regEspTrib 0 (documentado, não é chute de imposto)', async () => {
    emitterTax = { simplesRegime: '2', specialTaxRegime: null }
    const e = await buildEmitter(S.schema, S.inst)
    expect(e.prest.regTrib).toEqual({ opSimpNac: '2', regEspTrib: '0' })
  })
  it('mapa da exigibilidade: 01→1 · 05→2 · 04→3 · 02→4 · demais/NULL→1', () => {
    expect(['01', '05', '04', '02', '03', '06', '07', null, undefined, '', '1', '5'].map(liabilityFromExigibilidade))
      .toEqual(['1', '2', '3', '4', '1', '1', '1', '1', '1', '1', '1', '2'])
  })
  it('porta do billing (venda): buildServiceBranch grava a liability recebida; sem opção = 1', () => {
    const ci: any = { item: { id: 1, quantity: 1, productId: 42, productDescription: 'Suporte', productKind: 'S' }, merchandiseValue: 100, taxes: { issqn: { base: 100, value: 2, withheldValue: 0 } }, issqnExtras: { nationalCode: '010201', serviceListId: '1.02', municipalCode: null, cityId: 1, aliq: 2 } }
    expect(buildServiceBranch([ci], { liability: '2' }).liability).toBe('2')
    expect(buildServiceBranch([ci]).liability).toBe('1')
  })
  it('porta da OS: resolveServiceOrderFiscal deriva a liability da exigibilidade do EMITENTE (não do tomador)', async () => {
    q.mockImplementation(async (sql: string) => {
      if (/tb_order_service/.test(sql)) return [[{ customerId: 900 }]]
      if (/tb_order_item i/.test(sql)) return [[{ productId: 42, description: 'Suporte' }]]
      return [[]]
    })
    ;(entityTax.getEntityTax as jest.Mock).mockImplementation(async (_s: string, _i: number, entityId: number) =>
      entityId === S.inst ? { issExigibilidade: '05' } : { issRetido: 'N', issExigibilidade: '01' })
    ;(taxRule.resolveServiceTaxRule as jest.Mock).mockResolvedValue({ id: 2, active: 'S', cityId: 1, aliq: 2, serviceListId: '1.02', municipalCode: null, nationalCode: '010201' })
    const f = await resolveServiceOrderFiscal(S.schema, S.inst, 500)
    expect(f.liability).toBe('2')
  })
})

// ---------------------------------------------------------------------------
describe('MEDIUM-6 / D-N21 — a consulta ativa vigia A/N (24 h) e retenta C com efeito pendente (15 min)', () => {
  it('SQL do rodízio: vivas por minMinutes, autorizadas por 24 h, C pendente por 15 min; parâmetros na ordem', async () => {
    const real = jest.requireActual('../shared/invoice-transmission/transmission.repository')
    q.mockResolvedValueOnce([[]])
    await real.listLiveTransmissionsToRefresh(S.schema, S.inst, 5, 8)
    const sql = String(q.mock.calls[0][0]).replace(/\s+/g, ' ')
    expect(sql).toContain("(le.kind IS NULL OR le.kind IN ('S','K'))")
    expect(sql).toContain("le.kind IN ('A','N') AND (t.last_queried_at IS NULL OR t.last_queried_at < DATE_SUB(NOW(), INTERVAL ? HOUR))")
    expect(sql).toContain("le.kind = 'C' AND le.invoice_event IS NULL AND (t.last_queried_at IS NULL OR t.last_queried_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))")
    expect(sql).toMatch(/LIMIT \?$/)
    expect(q.mock.calls[0][1]).toEqual([S.inst, 5, 24, 15, 8])
  })
})

// ---------------------------------------------------------------------------
describe('MEDIUM-7 / D-N22 — consultar exige TRANSMITIR; minMinutes ≥ 1', () => {
  it('as duas rotas de consulta têm o guard de privilégio antes do handler', () => {
    const layers = (billingRoutes as any).stack.filter((l: any) => l.route && /^\/fiscal\/(refresh|:orderId\/refresh)$/.test(l.route.path))
    expect(layers).toHaveLength(2)
    for (const l of layers) {
      expect(l.route.stack).toHaveLength(2)                    // guard + controller
      expect(String(l.route.stack[0].handle.length)).toBe('3')  // (req, res, next) do requirePrivilege*
    }
  })
  it('minMinutes 0 é recusado pelo DTO', () => {
    expect(fiscalRefreshBodyDto.safeParse({ minMinutes: 0 }).success).toBe(false)
    expect(fiscalRefreshBodyDto.safeParse({ minMinutes: 1 }).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe('LOW-1 / LOW-3 / LOW-6 / LOW-9', () => {
  it('LOW-1: dado fora do leiaute (pAliq 12 > TSDec1V2) → 422 FISCAL_DPS_INVALID com campo, sem reservar', async () => {
    emitterTax = { ...emitterTax, simplesAssessment: '2' }   // ME/EPP com ISS por fora: a alíquota VAI no DPS (pelo SN ela é omitida — E0625)
    headerRow = header({ aliqIss: 12 })
    await expect(transmitServiceInvoice(S.schema, S.inst, S.user, INVOICE)).rejects.toMatchObject({ statusCode: 422, code: 'FISCAL_DPS_INVALID', fields: [expect.objectContaining({ field: 'dps', message: expect.stringMatching(/pAliq/) })] })
    expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(() => buildSignedDps({ input: { environment: 'H', dhEmi: 'x' } as any, emitter: { cnpj: '1', im: null, name: '', cMunEmi: '4106902' } }, 1, 1, opened() as any))
      .toThrow(expect.objectContaining({ code: 'FISCAL_DPS_INVALID' }))
  })
  it('LOW-3: pendentes de transmissão excluem reserva em voo (sem evento) — COALESCE trata "sem voz" como viva', async () => {
    const real = jest.requireActual('../shared/invoice-transmission/transmission.repository')
    q.mockResolvedValueOnce([[]])
    await real.listPendingServiceInvoices(S.schema, S.inst, 50)
    const sql = String(q.mock.calls[0][0]).replace(/\s+/g, ' ')
    expect(sql).toContain("ORDER BY le.event DESC LIMIT 1), '-') IN ('A','N','S','K','-')")
    // gate adversarial 2026-09-30: autorização (A/N) cuja nota foi cancelada LOCALMENTE (homologação, Q-CA5b) sai do rodízio de 24 h
    q.mockResolvedValueOnce([[]])
    await real.listLiveTransmissionsToRefresh(S.schema, S.inst, 5, 8)
    const live = String(q.mock.calls[1][0]).replace(/\s+/g, ' ')
    expect(live).toMatch(/le\.kind IN \('A','N'\)[^]*tb_invoice_event ev[^]*ORDER BY ev\.event DESC LIMIT 1\), '-'\) <> 'C'/)
    // D3/D4 (2026-09-29): nota com registro fiscal cancelada fica VIVA com evento C — não é pendente
    expect(sql).toMatch(/tb_invoice_event ev[^)]*ORDER BY ev\.event DESC LIMIT 1\), '-'\) <> 'C'/)
  })
  it('LOW-6: 2xx ilegível do fisco é logado só com status e tamanho — nunca a amostra do corpo', async () => {
    const original = transport.request
    transport.request = async () => ({ status: 200, headers: {}, text: '{"segredo":"NAO-PODE-VAZAR"}' })
    try {
      const adn = jest.requireActual('../shared/tax-authority/adapters/adn').adnAdapter
      await expect(adn.transmit({ environment: 'H', cert: Buffer.from(''), key: Buffer.from('') }, '<DPS/>')).rejects.toMatchObject({ code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
    } finally { transport.request = original }
    const call = (logger.warn as jest.Mock).mock.calls.find(c => /sem envelope/.test(String(c[0])))
    expect(call).toBeTruthy()
    expect(call![1]).toMatchObject({ status: 200, bytes: expect.any(Number) })
    expect(JSON.stringify(call![1])).not.toContain('NAO-PODE-VAZAR')
  })
  it('LOW-9: dps_description_format — I itens · O observação (vazia cai nos itens) · A ambos', () => {
    expect(serviceDescription('2 x Suporte', 'Obs da nota', 'I')).toBe('2 x Suporte')
    expect(serviceDescription('2 x Suporte', 'Obs da nota', 'O')).toBe('Obs da nota')
    expect(serviceDescription('2 x Suporte', '   ', 'O')).toBe('2 x Suporte')
    expect(serviceDescription('2 x Suporte', 'Obs da nota', 'A')).toBe('2 x Suporte\nObs da nota')
    const ci: any = { item: { id: 1, quantity: 2, productId: 42, productDescription: 'Suporte', productKind: 'S' }, merchandiseValue: 100, taxes: { issqn: { base: 100, value: 2, withheldValue: 0 } }, issqnExtras: { nationalCode: '010201', serviceListId: '1.02', municipalCode: null, cityId: 1, aliq: 2 } }
    expect(buildServiceBranch([ci], { descriptionFormat: 'A', noteText: 'Obs' }).description).toBe('2 x Suporte\nObs')
  })
})
