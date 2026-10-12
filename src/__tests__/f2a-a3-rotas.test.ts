/// <reference types="jest" />
// F2a, etapa A3 — D-F115 (= Q-F121 (b)): duas rotas do ERP para o app — `GET /api/billing/:orderId/cancel-plan` (CONSULTIVA: o mesmo
// plano do POST numa transação SEMPRE desfeita) e `GET /api/billing/:orderId/fiscal-effect` (D-F79/D-F114: o efeito da voz do fisco na
// nota + a dispensa vigente). HTTP real (app + guardas); banco e porta da voz mockados na fronteira.
import request from 'supertest'
import { testToken } from '../test-setup/test-token'
import { serviceView, TEST_KEY } from '../test-setup/fiscal-voice-rows'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFA3'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../shared/db/deadlock-retry', () => ({ __esModule: true, withDeadlockRetry: (_l: any, _c: any, _n: any, fn: any) => fn() }))
jest.mock('../shared/fiscal-voice', () => ({ __esModule: true, readServiceVoiceOfLife: jest.fn(), readServiceVoicesOfLives: jest.fn() }))
jest.mock('../shared/invoice/invoice-cancel', () => ({
  __esModule: true, ...jest.requireActual('../shared/invoice/invoice-cancel'), buildCancelPlan: jest.fn(),
}))
jest.mock('../modules/billing/billing.interface-resolver', () => ({
  __esModule: true, resolveOrderInterface: jest.fn(async () => 'service-orders'),
  resolveFromBody: jest.fn(async () => 'service-orders'), resolveFromParam: jest.fn(async () => 'service-orders'),
}))

import pool from '../shared/db/connection'
import * as voicePort from '../shared/fiscal-voice'
import * as cancelPiece from '../shared/invoice/invoice-cancel'
import { HttpError } from '../shared/errors/http-error'
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import app from '../app'

const q = (pool as any).query as jest.Mock
const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn().mockResolvedValue(undefined), release: jest.fn() }
const AUTH = `Bearer ${testToken({ institutionId: 1, userId: 7, role: 'user', schemaName: 'setes_setes' })}`
const ADMIN = `Bearer ${testToken({ institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes' })}`   // /establishment tem adminGuard
const readVoice = () => voicePort.readServiceVoiceOfLife as jest.Mock

let lifeRows: any[]
let waiverRows: any[]
beforeEach(() => {
  jest.clearAllMocks(); resetPrivilegeCache()
  lifeRows = [{ invoiceId: 7400, invoiceDeleted: 'N', lifeEvent: 1, lastEvent: 1, lastKind: 'E' }]
  waiverRows = []
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
  q.mockImplementation(async (sql: string) => {
    if (/setes_central\.tb_interface WHERE i18n_key/.test(sql)) return [[{ id: 20 }]]
    if (/tb_institution_has_interface/.test(sql)) return [[{ 1: 1 }]]
    if (/tb_invoice_cancel_waiver/.test(sql)) return [waiverRows]          // antes: a consulta da dispensa também cita a vw_invoice_life
    if (/FROM `setes_setes`\.vw_invoice_life/.test(sql)) return [lifeRows]
    throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`)
  })
  readVoice().mockResolvedValue([])
})

describe('GET /api/billing/:orderId/fiscal-effect (D-F114/D-F115)', () => {
  const get = (id: string | number = 7400) => request(app).get(`/api/billing/${id}/fiscal-effect`).set('Authorization', AUTH)

  it('voz C comum (101101) em produção com a nota viva → effect "apply" (o app manda o POST /billing/cancel); a voz é a da VIDA da nota', async () => {
    readVoice().mockResolvedValue([serviceView({ lastKind: 'C', lastCode: '101101', lastSource: 'P' })])
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, data: { orderId: 7400, lifeEvent: 1, invoiceCancelled: false, effect: 'apply', cancelWaiver: null } })
    expect(readVoice().mock.calls[0].slice(1)).toEqual([1, 7400, 1])
  })
  it('SUBSTITUIÇÃO com "manter a nota" vigente → effect "none" + a dispensa (instante na hora do ESTABELECIMENTO — Q-TZ1)', async () => {
    readVoice().mockResolvedValue([serviceView({ lastKind: 'C', lastCode: '105102', lastSource: 'Q' })])
    waiverRows = [{ accessKey: TEST_KEY, reason: 'substituta no portal', userId: 7, createdAt: '2026-10-11 00:10:00' }]
    const res = await get()
    expect(res.body.data).toEqual({
      orderId: 7400, lifeEvent: 1, invoiceCancelled: false, effect: 'none',
      cancelWaiver: { accessKey: TEST_KEY, reason: 'substituta no portal', userId: 7, createdAt: '2026-10-10 21:10:00' },
    })
    const w = q.mock.calls.find(c => /tb_invoice_cancel_waiver/.test(String(c[0])))!
    expect(w[1]).toEqual([1, 7400, TEST_KEY])
  })
  it('SUBSTITUIÇÃO sem dispensa → "decide"; DE OFÍCIO → "cancel"; nota já cancelada → "none" com invoiceCancelled', async () => {
    readVoice().mockResolvedValue([serviceView({ lastKind: 'C', lastCode: '105102', lastSource: 'Q' })])
    expect((await get()).body.data.effect).toBe('decide')
    readVoice().mockResolvedValue([serviceView({ lastKind: 'C', lastCode: '305101', lastSource: 'Q' })])
    expect((await get()).body.data.effect).toBe('cancel')
    lifeRows = [{ invoiceId: 7400, invoiceDeleted: 'N', lifeEvent: 1, lastEvent: 2, lastKind: 'C' }]
    expect((await get()).body.data).toMatchObject({ effect: 'none', invoiceCancelled: true })
  })
  it('nota soft-deletada (pendente cancelada — D3) → "none" SEM ler a voz; nota sem vida (sincronizada) → "none"', async () => {
    lifeRows = [{ invoiceId: 7400, invoiceDeleted: 'S', lifeEvent: 1, lastEvent: 2, lastKind: 'C' }]
    expect((await get()).body.data).toMatchObject({ effect: 'none', cancelWaiver: null })
    expect(readVoice()).not.toHaveBeenCalled()
    lifeRows = [{ invoiceId: 7400, invoiceDeleted: 'N', lifeEvent: null, lastEvent: null, lastKind: null }]
    expect((await get()).body.data).toMatchObject({ effect: 'none', lifeEvent: null })
    expect(readVoice()).not.toHaveBeenCalled()
  })
  it('nota inexistente → 404 INVOICE_NOT_FOUND; orderId inválido → 400 INVALID_ID antes de qualquer leitura da nota', async () => {
    lifeRows = []
    expect((await get()).body).toMatchObject({ code: 'INVOICE_NOT_FOUND' })
    for (const bad of ['abc', '0', '-1', '1.5', '99999999999999999999']) {
      const res = await get(bad)
      expect([bad, res.status, res.body.code]).toEqual([bad, 400, 'INVALID_ID'])
    }
    expect(q.mock.calls.some(c => /vw_invoice_life/.test(String(c[0])))).toBe(true)   // só do 1º caso
  })
  it('sem JWT → 401', async () => {
    expect((await request(app).get('/api/billing/7400/fiscal-effect')).status).toBe(401)
  })
})

describe('GET /api/billing/:orderId/cancel-plan (D-F29/D-F115 — consultivo)', () => {
  const PLAN = {
    orderId: 7400, invoice: { id: 7400, number: '17', serie: '1', model: 'SE', value: 250, status: '0', lifeEvent: 1, lastEvent: 1, lastKind: 'E' },
    blocks: [{ field: 'fiscal', ref: '2', message: 'NFS-e 710 autorizada no fisco (tentativa 2) — cancele a NFS-e no fisco primeiro' }],
    bankSlipsToCancel: [9], releasedTitles: [], serviceOrder: null,
    checksToReverse: [{ checkId: 42, event: 1, number: 'A' }], commissionEntries: [{}, {}], touchesCash: true, fiscalRecord: true,
  }
  const get = () => request(app).get('/api/billing/7400/cancel-plan').set('Authorization', AUTH)

  it('devolve o MESMO plano do POST (bloqueios + destino + o que seria desfeito) e DESFAZ a transação — nada gravado, nunca commit', async () => {
    ;(cancelPiece.buildCancelPlan as jest.Mock).mockResolvedValue(PLAN)
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      orderId: 7400, invoiceNumber: '17', cancellable: false, blocks: PLAN.blocks, fiscalRecord: true,
      effects: { bankSlipsToCancel: [9], releasedTitles: [], checksToReverse: [{ checkId: 42, number: 'A' }], commissionsToCompensate: 2, touchesCash: true },
    })
    expect((cancelPiece.buildCancelPlan as jest.Mock).mock.calls[0].slice(1)).toEqual(['setes_setes', 1, 7400])
    expect(conn.beginTransaction).toHaveBeenCalled(); expect(conn.rollback).toHaveBeenCalled()
    expect(conn.commit).not.toHaveBeenCalled(); expect(conn.release).toHaveBeenCalled()
  })
  it('recusa do plano (pedido não faturado) vira o 409 do POST, com a transação desfeita e a conexão devolvida', async () => {
    ;(cancelPiece.buildCancelPlan as jest.Mock).mockRejectedValue(new HttpError(409, 'Pedido 7400 não está faturado', undefined, 'INVOICE_NOT_CANCELLABLE'))
    const res = await get()
    expect(res.status).toBe(409); expect(res.body.code).toBe('INVOICE_NOT_CANCELLABLE')
    expect(conn.rollback).toHaveBeenCalled(); expect(conn.commit).not.toHaveBeenCalled(); expect(conn.release).toHaveBeenCalled()
  })
  it('sem nada bloqueando → cancellable=true (o app segue: nfse-api → POST /billing/cancel)', async () => {
    ;(cancelPiece.buildCancelPlan as jest.Mock).mockResolvedValue({ ...PLAN, blocks: [], touchesCash: false, checksToReverse: [], fiscalRecord: false })
    expect((await get()).body.data).toMatchObject({ cancellable: true, blocks: [], fiscalRecord: false })
  })
})

describe('as 14 rotas fiscais do setes-api MORRERAM (D-F4/D-F12) — o app fala com a nfse-api', () => {
  it.each([
    ['post', '/api/billing/transmit'], ['post', '/api/billing/fiscal/transmit-batch'], ['get', '/api/billing/fiscal/pending'],
    ['post', '/api/billing/fiscal/refresh'], ['post', '/api/billing/fiscal/cancel'], ['post', '/api/billing/fiscal/7400/refresh'],
    ['get', '/api/billing/fiscal/7400'], ['get', '/api/billing/fiscal/7400/xml'], ['get', '/api/billing/fiscal/7400/danfse'],
    ['get', '/api/establishment/issuer'], ['put', '/api/establishment/issuer/certificate'], ['delete', '/api/establishment/issuer/certificate'],
    ['put', '/api/establishment/issuer/SE'], ['delete', '/api/establishment/issuer/SE'],
  ] as const)('%s %s → 404', async (method, url) => {
    const res = await (request(app) as any)[method](url).set('Authorization', ADMIN).send({ orderId: 7400 })
    expect(res.status).toBe(404)
  })
})
