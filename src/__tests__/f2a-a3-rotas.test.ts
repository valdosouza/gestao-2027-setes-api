/// <reference types="jest" />
// F2a, etapa A3 — D-F115 (= Q-F121 (b)): duas rotas do ERP para o app — `GET /api/billing/:orderId/cancel-plan` (CONSULTIVA: o mesmo
// plano do POST numa transação SEMPRE desfeita) e `GET /api/billing/:orderId/fiscal-effect` (D-F79/D-F114: o efeito da voz do fisco na
// nota + a dispensa vigente). HTTP real (app + guardas); banco e porta da voz mockados na fronteira.
import request from 'supertest'
import { testToken } from '../test-setup/test-token'
import { serviceView, TEST_KEY } from '../test-setup/fiscal-voice-rows'
import { accessAnswer, AccessModel, ModelProfile } from '../test-setup/access-model'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFA3'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../shared/db/deadlock-retry', () => ({ __esModule: true, withDeadlockRetry: (_l: any, _c: any, _n: any, fn: any) => fn() }))
jest.mock('../shared/fiscal-voice', () => ({
  __esModule: true, ...jest.requireActual('../shared/fiscal-voice'), readServiceVoiceOfLife: jest.fn(), readServiceVoicesOfLives: jest.fn(),
}))
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
import { FiscalVoiceUnavailableError } from '../shared/fiscal-voice'
import app from '../app'

const q = (pool as any).query as jest.Mock
const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn().mockResolvedValue(undefined), release: jest.fn() }
const AUTH = `Bearer ${testToken({ institutionId: 1, userId: 7, role: 'user', schemaName: 'setes_setes' })}`
const ADMIN = `Bearer ${testToken({ institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes' })}`   // /establishment tem adminGuard
const readVoice = () => voicePort.readServiceVoiceOfLife as jest.Mock
// costura A1 (D-AU3): o veredito lê as views pelo vínculo (user 7 × institution 1) — o perfil do vínculo é o do token da requisição
// (a sessão viva devolve o do token — `access-session.mock`); D-F37: as interfaces do ramo CONTRATADAS, o regular sem concessão
let profile: ModelProfile = 'admin'
const asSession = (auth: string) => { profile = auth === ADMIN ? 'admin' : 'user'; return auth }
const accessModel = (): AccessModel => ({ profile, contracted: ['orders', 'service-orders'], granted: {} })

let lifeRows: any[]
let waiverRows: any[]
beforeEach(() => {
  jest.clearAllMocks()
  lifeRows = [{ invoiceId: 7400, invoiceDeleted: 'N', lifeEvent: 1, lastEvent: 1, lastKind: 'E' }]
  waiverRows = []
  ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
  q.mockImplementation(async (sql: string, params: any[]) => {
    const a = accessAnswer(sql, params, accessModel)
    if (a) return [a, []]
    if (/tb_invoice_cancel_waiver/.test(sql)) return [waiverRows]          // antes: a consulta da dispensa também cita a vw_invoice_life
    if (/FROM `setes_setes`\.vw_invoice_life/.test(sql)) return [lifeRows]
    throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`)
  })
  readVoice().mockResolvedValue([])
})

describe('GET /api/billing/:orderId/fiscal-effect (D-F114/D-F115)', () => {
  const get = (id: string | number = 7400) => request(app).get(`/api/billing/${id}/fiscal-effect`).set('Authorization', asSession(AUTH))

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
  it('[D-F130] voz do fisco ILEGÍVEL → 503 FISCAL_VOICE_UNAVAILABLE com o ref do alarme — nunca "nada pendente" calado nem 500 genérico', async () => {
    readVoice().mockRejectedValue(new FiscalVoiceUnavailableError("SELECT command denied to user 'setes'", 'REFVOZ02'))
    const res = await get()
    expect([res.status, res.body.code, res.body.ref]).toEqual([503, 'FISCAL_VOICE_UNAVAILABLE', 'REFVOZ02'])
    expect(res.body.error).not.toMatch(/SELECT command denied/)                // a causa vai para o log, nunca para o usuário
  })
})

describe('GET /api/billing/:orderId/cancel-plan (D-F29/D-F115 — consultivo; D-F131 guarda + espera curta; D-F141 barreira tipada)', () => {
  const PLAN = {
    orderId: 7400, invoice: { id: 7400, number: '17', serie: '1', model: 'SE', value: 250, status: '0', lifeEvent: 1, lastEvent: 1, lastKind: 'E' },
    blocks: [{ field: 'fiscal', ref: '2', barrier: { kind: 'authorized', attempt: 2 }, message: 'NFS-e 710 autorizada no fisco (tentativa 2) — cancele a NFS-e no fisco primeiro' }],
    bankSlipsToCancel: [9], releasedTitles: [], serviceOrder: null,
    checksToReverse: [{ checkId: 42, event: 1, number: 'A' }], commissionEntries: [{}, {}], touchesCash: true, fiscalRecord: true,
  }
  // D-F131: a guarda é a do POST (CANCELAR) — o admin passa só o privilégio; o usuário comum precisa do vínculo
  const get = (auth = ADMIN) => request(app).get('/api/billing/7400/cancel-plan').set('Authorization', asSession(auth))
  let cashierRows: any[]
  let failRestore: boolean
  beforeEach(() => {
    cashierRows = [{ id: 3 }]; failRestore = false
    conn.query.mockImplementation(async (sql: string) => {
      if (/^SET SESSION innodb_lock_wait_timeout = @setes_plan_prev_lw/.test(sql) && failRestore) throw new Error('Connection lost')
      if (/^SET /.test(sql)) return [{}]
      if (/tb_cashier/.test(sql)) return [cashierRows]
      throw new Error(`SQL inesperado na transação: ${sql.slice(0, 80)}`)
    })
  })
  afterEach(() => { conn.query.mockReset(); delete (conn as any).destroy })
  const sqls = () => conn.query.mock.calls.map(c => String(c[0]))

  it('devolve o MESMO plano do POST (bloqueios + destino + o que seria desfeito) e DESFAZ a transação — nada gravado, nunca commit; o bloco fiscal traz a barreira TIPADA (D-F141)', async () => {
    ;(cancelPiece.buildCancelPlan as jest.Mock).mockResolvedValue(PLAN)
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      orderId: 7400, invoiceNumber: '17', cancellable: false, blocks: PLAN.blocks, fiscalRecord: true,
      effects: { bankSlipsToCancel: [9], releasedTitles: [], checksToReverse: [{ checkId: 42, number: 'A' }], commissionsToCompensate: 2, touchesCash: true, cashierOpen: true },
    })
    expect(res.body.data.blocks[0].barrier).toEqual({ kind: 'authorized', attempt: 2 })
    const cashier = conn.query.mock.calls.find(c => /tb_cashier/.test(String(c[0])))!
    expect(cashier[1]).toEqual([1, 7])                                    // o caixa é o do OPERADOR que consulta
    expect((cancelPiece.buildCancelPlan as jest.Mock).mock.calls[0].slice(1)).toEqual(['setes_setes', 1, 7400])
    expect(conn.beginTransaction).toHaveBeenCalled(); expect(conn.rollback).toHaveBeenCalled()
    expect(conn.commit).not.toHaveBeenCalled(); expect(conn.release).toHaveBeenCalled()
  })
  it('[D-F131] a consulta espera trava no máximo 3 s: a espera da SESSÃO é encurtada ANTES da transação e DEVOLVIDA ao valor anterior depois do rollback', async () => {
    ;(cancelPiece.buildCancelPlan as jest.Mock).mockResolvedValue({ ...PLAN, blocks: [], touchesCash: false, checksToReverse: [], fiscalRecord: false })
    expect((await get()).status).toBe(200)
    const s = sqls()
    expect(s[0]).toBe('SET @setes_plan_prev_lw = @@session.innodb_lock_wait_timeout, @setes_plan_prev_mdl = @@session.lock_wait_timeout')
    expect(s[1]).toBe('SET SESSION innodb_lock_wait_timeout = ?, lock_wait_timeout = ?'); expect(conn.query.mock.calls[1][1]).toEqual([3, 3])   // F2AR4-ADV-03: metadados também
    expect(s[s.length - 1]).toBe('SET SESSION innodb_lock_wait_timeout = @setes_plan_prev_lw, lock_wait_timeout = @setes_plan_prev_mdl')
    const calls = conn.query.mock.invocationCallOrder
    expect(calls[1]).toBeLessThan(conn.beginTransaction.mock.invocationCallOrder[0])
    expect(conn.rollback.mock.invocationCallOrder[0]).toBeLessThan(calls[calls.length - 1])
    expect(conn.release).toHaveBeenCalled()
  })
  it('[D-F131] devolução da espera que FALHA → a conexão é DESCARTADA (nunca volta ao pool encurtada)', async () => {
    ;(cancelPiece.buildCancelPlan as jest.Mock).mockResolvedValue({ ...PLAN, blocks: [], touchesCash: false, checksToReverse: [], fiscalRecord: false })
    failRestore = true
    ;(conn as any).destroy = jest.fn()
    await get()
    expect((conn as any).destroy).toHaveBeenCalled(); expect(conn.release).not.toHaveBeenCalled()
  })
  it('[D-F131] usuário comum SEM o privilégio CANCELAR → 403 PRIVILEGE_REQUIRED antes de abrir conexão (não segura trava nenhuma)', async () => {
    q.mockImplementation(async (sql: string, params: any[]) => {
      const a = accessAnswer(sql, params, accessModel)                    // ramo contratado, nenhuma concessão
      if (a) return [a, []]
      throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`)
    })
    const res = await get(AUTH)
    expect([res.status, res.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
    expect((pool as any).getConnection).not.toHaveBeenCalled()
    // o veredito perguntou à view o verbo CANCELAR na interface do ramo (e o alcance, só na negação, para o motivo)
    const verdict = q.mock.calls.find(c => /vw_user_access/.test(String(c[0])))!
    expect(verdict[1]).toEqual([7, 1, ['service-orders'], 'CANCELAR'])
    expect(q.mock.calls.some(c => /vw_user_reach/.test(String(c[0])))).toBe(true)
  })
  it('recusa do plano (pedido não faturado) vira o 409 do POST, com a transação desfeita e a conexão devolvida', async () => {
    ;(cancelPiece.buildCancelPlan as jest.Mock).mockRejectedValue(new HttpError(409, 'Pedido 7400 não está faturado', undefined, 'INVOICE_NOT_CANCELLABLE'))
    const res = await get()
    expect(res.status).toBe(409); expect(res.body.code).toBe('INVOICE_NOT_CANCELLABLE')
    expect(conn.rollback).toHaveBeenCalled(); expect(conn.commit).not.toHaveBeenCalled(); expect(conn.release).toHaveBeenCalled()
  })
  it('[D-F130] voz do fisco ILEGÍVEL no plano → 503 FISCAL_VOICE_UNAVAILABLE com o ref; nada gravado, conexão devolvida', async () => {
    ;(cancelPiece.buildCancelPlan as jest.Mock).mockRejectedValue(new FiscalVoiceUnavailableError('view sem coluna', 'REFVOZ03'))
    const res = await get()
    expect([res.status, res.body.code, res.body.ref]).toEqual([503, 'FISCAL_VOICE_UNAVAILABLE', 'REFVOZ03'])
    expect(conn.commit).not.toHaveBeenCalled(); expect(conn.release).toHaveBeenCalled()
  })
  it('sem nada bloqueando → cancellable=true (o app segue: nfse-api → POST /billing/cancel); sem linha de caixa, cashierOpen=null', async () => {
    ;(cancelPiece.buildCancelPlan as jest.Mock).mockResolvedValue({ ...PLAN, blocks: [], touchesCash: false, checksToReverse: [], fiscalRecord: false })
    const data = (await get()).body.data
    expect(data).toMatchObject({ cancellable: true, blocks: [], fiscalRecord: false })
    expect(data.effects.cashierOpen).toBeNull()
    expect(sqls().some(s => /tb_cashier/.test(s))).toBe(false)              // não tocar o caixa = não consultar o caixa
  })
  it('[F2A3-SOC-12] sem bloqueio mas com linha de caixa (D16) e SEM caixa aberto do operador → cancellable=false (o POST recusaria NO_OPEN_CASHIER)', async () => {
    ;(cancelPiece.buildCancelPlan as jest.Mock).mockResolvedValue({ ...PLAN, blocks: [] })
    cashierRows = []
    const data = (await get()).body.data
    expect(data).toMatchObject({ cancellable: false, blocks: [] })
    expect(data.effects).toMatchObject({ touchesCash: true, cashierOpen: false })
    expect(conn.commit).not.toHaveBeenCalled(); expect(conn.rollback).toHaveBeenCalled()
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
