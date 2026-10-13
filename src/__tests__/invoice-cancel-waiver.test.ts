/// <reference types="jest" />
// "Manter a nota" — Rodada 13 das APIs fiscais (D-F67/D-F72/D-F73/D-F74, Valdo 2026-10-10): peça
// `@shared/invoice.waiveSubstitutedCancel` + rota POST /api/billing/cancel-waiver. Banco mockado na fronteira (conn/pool);
// a nota vem do lockInvoice mockado e a voz do fisco da PORTA `@shared/fiscal-voice` mockada (F2a, etapa A3: o setes-api LÊ a voz no
// banco fiscal_api — linhas REAIS da view passadas pelo mapa da família); a dispensa vive numa loja em memória com a MESMA chave da tabela.
import { testToken } from '../test-setup/test-token'   // D-F13 (F2a A2): RS256 com kid
import { serviceView, unrecorded, TEST_KEY } from '../test-setup/fiscal-voice-rows'
import request from 'supertest'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFWAIVER'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../shared/db/deadlock-retry', () => ({ __esModule: true, withDeadlockRetry: (_l: any, _c: any, _n: any, fn: any) => fn() }))
jest.mock('../shared/invoice/invoice', () => {
  const actual = jest.requireActual('../shared/invoice/invoice')
  return { __esModule: true, ...actual, lockInvoice: jest.fn() }
})
jest.mock('../shared/fiscal-voice', () => ({ __esModule: true, readServiceVoiceOfLife: jest.fn(), readServiceVoicesOfLives: jest.fn() }))
jest.mock('../modules/billing/billing.interface-resolver', () => {
  const resolveOrderInterface = jest.fn(async (_s: string, _i: number, _o: number) => 'service-orders')
  return {
    __esModule: true, resolveOrderInterface,
    resolveFromBody: (req: any) => resolveOrderInterface(req.institution.schemaName, req.institution.institutionId, Number(req.body?.orderId)),
    resolveFromParam: (req: any) => resolveOrderInterface(req.institution.schemaName, req.institution.institutionId, Number(req.params?.orderId)),
  }
})

import pool from '../shared/db/connection'
import * as invoiceModule from '../shared/invoice/invoice'
import * as voicePort from '../shared/fiscal-voice'
import { waiveSubstitutedCancel } from '../shared/invoice'
import { ErrorCodes } from '../shared/errors/error-codes'
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import app from '../app'

const S = { schema: 'setes_setes', inst: 1, user: 7 }
const INVOICE = 7400
const KEY = TEST_KEY
const q = (pool as any).query as jest.Mock
const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }

/** Voz vigente: NFS-e de produção cancelada por SUBSTITUIÇÃO no fisco (C 105102), vida 1 da nota. */
const tx = (over: any = {}) => serviceView({ invoiceId: INVOICE, lastEvent: 2, lastKind: 'C', lastCode: '105102', lastSource: 'Q', ...over })
const readVoice = () => voicePort.readServiceVoiceOfLife as jest.Mock

/** Loja da `tb_invoice_cancel_waiver`: PK (institution, invoice, terminal, access_key). */
let waivers: Map<string, { reason: string; userId: number; deleted: 'N' | 'S'; createdAt: string }>
const wk = (inv: number, key: string) => `${S.inst}|${inv}|0|${key}`
let lockOrder: string[]

function wireConn() {
  conn.query.mockImplementation(async (sql: string, params: any[]) => {
    if (/FROM `setes_setes`\.tb_invoice_cancel_waiver/.test(sql)) {
      lockOrder.push(/FOR UPDATE/.test(sql) ? 'waiver:FOR UPDATE' : 'waiver')
      const w = waivers.get(wk(Number(params[1]), String(params[2])))
      return [w && w.deleted === 'N' ? [{ accessKey: params[2], reason: w.reason, userId: w.userId, createdAt: w.createdAt }] : []]
    }
    if (/^INSERT INTO `setes_setes`\.tb_invoice_cancel_waiver/.test(sql.trim())) {
      const [inst, inv, key, reason, user] = params
      expect(inst).toBe(S.inst)
      waivers.set(wk(Number(inv), String(key)), { reason, userId: user, deleted: 'N', createdAt: '2026-10-11 00:10:00' })
      return [{ affectedRows: 1 }]
    }
    throw new Error(`SQL inesperado na peça: ${sql.slice(0, 80)}`)
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  resetPrivilegeCache()
  waivers = new Map(); lockOrder = []
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
  wireConn()
  ;(invoiceModule.lockInvoice as jest.Mock).mockReset().mockImplementation(async () => {
    lockOrder.push('nota'); return { id: INVOICE, number: '17', serie: '1', model: 'SE', value: 250, status: '0', lifeEvent: 1, lastEvent: 1, lastKind: 'E' }
  })
  readVoice().mockReset().mockImplementation(async (_q: any, inst: number, inv: number, life: number) => {
    lockOrder.push(`voz:${inst}/${inv}/vida ${life}`); return [tx()]
  })
  q.mockImplementation(async (sql: string, params: any[]) => {
    if (/setes_central\.tb_interface WHERE i18n_key/.test(sql)) return [[{ id: 30 }]]
    if (/tb_user_has_privilege/.test(sql)) return [privileged && Number(params?.[1]) === 30 ? [{ 1: 1 }] : []]
    if (/tb_institution_has_interface/.test(sql)) return [[{ 1: 1 }]]                 // D-F37 (F2a A2): licença para todos — contratada
    return [[]]
  })
})
let privileged = true

const waive = (reason = 'substituta emitida no portal — serviço segue faturado') =>
  waiveSubstitutedCancel(conn as any, S.schema, S.inst, S.user, { orderId: INVOICE, reason })
async function settle<T>(p: Promise<T>): Promise<any> { try { return await p } catch (e) { return e } }

describe('peça waiveSubstitutedCancel (D-F67/D-F73/D-F74)', () => {
  it('caminho feliz: grava UMA decisão (nota, chave) com motivo e autor; ordem trava da nota → voz da VIDA dela (porta) → dispensa', async () => {
    const r = await waive()
    expect(r).toEqual({ orderId: INVOICE, accessKey: KEY, createdAt: '2026-10-11 00:10:00', alreadyWaived: false })
    expect(waivers.get(wk(INVOICE, KEY))).toMatchObject({ reason: 'substituta emitida no portal — serviço segue faturado', userId: S.user })
    // D-F121: a voz é lida DEPOIS da trava da nota, escopada pela vida que o lockInvoice devolveu (D-F119/D-F126);
    // L3 do gate da Rodada 13: a dispensa não trava linha (a trava da NOTA serializa)
    expect(lockOrder.slice(0, 3)).toEqual(['nota', `voz:${S.inst}/${INVOICE}/vida 1`, 'waiver'])
    expect(readVoice().mock.calls[0][0]).toBe(conn)                // a MESMA conexão (transação) — nunca uma 2ª do pool
  })
  it('idempotente: a 2ª vez devolve alreadyWaived=true e não grava de novo (nem troca o motivo)', async () => {
    await waive()
    const r = await waive('outro motivo')
    expect(r).toMatchObject({ alreadyWaived: true, accessKey: KEY })
    expect(conn.query.mock.calls.filter((c: any[]) => /^INSERT/.test(String(c[0]).trim()))).toHaveLength(1)
    expect(waivers.get(wk(INVOICE, KEY))!.reason).toBe('substituta emitida no portal — serviço segue faturado')
  })
  it('D-F73: motivo em branco → 400 INVOICE_REASON_REQUIRED, nada lido nem gravado', async () => {
    const out = await settle(waive('   '))
    expect(out).toMatchObject({ statusCode: 400, code: ErrorCodes.INVOICE_REASON_REQUIRED })
    expect(invoiceModule.lockInvoice).not.toHaveBeenCalled(); expect(waivers.size).toBe(0)
  })
  it('nota já cancelada → 409 INVOICE_CANCEL_WAIVER_NOT_APPLICABLE', async () => {
    ;(invoiceModule.lockInvoice as jest.Mock).mockResolvedValue({ id: INVOICE, number: '17', lastEvent: 3, lastKind: 'C' })
    expect(await settle(waive())).toMatchObject({ statusCode: 409, code: ErrorCodes.INVOICE_CANCEL_WAIVER_NOT_APPLICABLE })
    expect(waivers.size).toBe(0)
  })
  it.each([
    ['cancelamento PELO CONTRIBUINTE (101101)', tx({ lastCode: '101101' })],
    ['cancelamento sem código (anterior à 067)', tx({ lastCode: null })],
    ['de OFÍCIO (305101)', tx({ lastCode: '305101' })],
    ['autorizada (A)', tx({ lastKind: 'A', lastCode: null })],
    ['em voo', unrecorded({ lastKind: null, lastCode: null, lastEvent: null, lastSource: null, lastDh: null, lastEventAt: null })],
    // "C 105102 sem chave" deixou de existir pela porta: o mapa da família RECUSA a voz C sem registro (D-F154 = Q-F159 (a)) — a porta
    // dá 503 FISCAL_VOICE_UNAVAILABLE ("contrato"), coberto no gate da Rodada 4 (adversarial-f2a-r4-gate, seção 6)
    ['nunca transmitida', null],
  ])('D-F74: %s → 409 (só a SUBSTITUIÇÃO se dispensa)', async (_l, row) => {
    readVoice().mockResolvedValue(row ? [row] : [])
    expect(await settle(waive())).toMatchObject({ statusCode: 409, code: ErrorCodes.INVOICE_CANCEL_WAIVER_NOT_APPLICABLE })
    expect(waivers.size).toBe(0)
  })
  it('D-F80 (= Q-F87 (a)): substituição em HOMOLOGAÇÃO → 409 (sem valor jurídico — cancele a nota), nada gravado', async () => {
    readVoice().mockResolvedValue([tx({ environment: 'H' })])
    const out = await settle(waive())
    expect(out).toMatchObject({ statusCode: 409, code: ErrorCodes.INVOICE_CANCEL_WAIVER_NOT_APPLICABLE })
    expect(String(out.message)).toMatch(/HOMOLOGAÇÃO/)
    expect(waivers.size).toBe(0)
  })
  it('nota sem vida (sincronizada da origem, sem evento E) → 409 sem ler a voz (nada transmitido pela web)', async () => {
    ;(invoiceModule.lockInvoice as jest.Mock).mockResolvedValue({ id: INVOICE, number: '17', lifeEvent: null, lastEvent: null, lastKind: null })
    expect(await settle(waive())).toMatchObject({ statusCode: 409, code: ErrorCodes.INVOICE_CANCEL_WAIVER_NOT_APPLICABLE })
    expect(readVoice()).not.toHaveBeenCalled()
  })
  it('a vigente é a REGISTRADA da vida (currentOf do núcleo): uma 2ª tentativa sem registro depois não tira a substituição', async () => {
    readVoice().mockResolvedValue([tx(), unrecorded({ attempt: 2, lastKind: 'R', lastCode: null, lastSource: 'P' })])
    expect(await waive()).toMatchObject({ alreadyWaived: false, accessKey: KEY })
  })
  it('lista que mistura vidas é recusada ALTO (D-F119 — o núcleo nunca escolhe "a vigente" de duas vidas)', async () => {
    readVoice().mockResolvedValue([tx(), tx({ attempt: 2, lifeEvent: 3 })])
    await expect(waive()).rejects.toThrow(/mistura lifeEvent/)
    expect(waivers.size).toBe(0)
  })
})

describe('rota POST /api/billing/cancel-waiver (D-F72: privilégio CANCELAR do ramo)', () => {
  const token = (role: string) => `Bearer ${testToken({ institutionId: S.inst, userId: S.user, role, schemaName: S.schema })}`
  it('admin → 200 { ok, data: { orderId, accessKey, createdAt, alreadyWaived } }, transação confirmada', async () => {
    const res = await request(app).post('/api/billing/cancel-waiver').set('Authorization', token('admin'))
      .send({ orderId: INVOICE, reason: 'substituta emitida no portal' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, data: { orderId: INVOICE, accessKey: KEY, alreadyWaived: false } })
    expect(conn.commit).toHaveBeenCalled(); expect(conn.release).toHaveBeenCalled()
  })
  it('usuário SEM o privilégio CANCELAR na interface do ramo → 403 PRIVILEGE_REQUIRED, nada gravado', async () => {
    privileged = false
    try {
      const res = await request(app).post('/api/billing/cancel-waiver').set('Authorization', token('user'))
        .send({ orderId: INVOICE, reason: 'x' })
      expect(res.status).toBe(403); expect(res.body.code).toBe(ErrorCodes.PRIVILEGE_REQUIRED)
      expect(waivers.size).toBe(0)
    } finally { privileged = true }
  })
  it('usuário COM o privilégio → 200', async () => {
    const res = await request(app).post('/api/billing/cancel-waiver').set('Authorization', token('user'))
      .send({ orderId: INVOICE, reason: 'substituta conferida' })
    expect(res.status).toBe(200)
  })
  it.each([
    [{ orderId: INVOICE, reason: '' }], [{ orderId: INVOICE, reason: '   ' }], [{ orderId: INVOICE }], [{ orderId: 'x', reason: 'a' }],
    [{ orderId: INVOICE, reason: 'a'.repeat(256) }], [{ orderId: -1, reason: 'a' }],
  ])('payload inválido %j → 400, nada gravado', async (body) => {
    const res = await request(app).post('/api/billing/cancel-waiver').set('Authorization', token('admin')).send(body)
    expect(res.status).toBe(400); expect(waivers.size).toBe(0)
  })
  it('recusa da peça vira 409 com o código no envelope e a transação desfeita', async () => {
    readVoice().mockResolvedValue([tx({ lastCode: '101101' })])
    const res = await request(app).post('/api/billing/cancel-waiver').set('Authorization', token('admin')).send({ orderId: INVOICE, reason: 'a' })
    expect(res.status).toBe(409); expect(res.body.code).toBe(ErrorCodes.INVOICE_CANCEL_WAIVER_NOT_APPLICABLE)
    expect(conn.rollback).toHaveBeenCalled()
  })
})
