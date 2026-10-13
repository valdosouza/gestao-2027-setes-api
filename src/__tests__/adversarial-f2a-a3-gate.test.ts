/// <reference types="jest" />
// GATE ADVERSARIAL independente da etapa A3 da F2a (2026-10-13 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §22.11/§22.12). Alvo: o delta f5eee3b..f2a da worktree setes-api-f2a —
//   porta @shared/fiscal-voice (único leitor do fiscal_api), barreira do cancelamento local / veredito / registro fiscal pelos
//   predicados do núcleo (invoice-fiscal-effect), plano CONSULTIVO (GET …/cancel-plan — D-F128), efeito (GET …/fiscal-effect — D-F114),
//   "manter a nota" (cancel-waiver), selo em lote da lista de OS, conferência do boot (D-F113/D-F127) e a migration
//   069_f2a_fiscal_passivo (gatilhos de TRAVA — D-F110/D-F129, PADROES §11 regra 15) contra o ATO de nfse-api/scripts/cutover-erp.ts.
// Convenção: achado CONFIRMADO = `it.failing('[ACHADO F2A3-ADV-NN SEV] …')` (o teste descreve o comportamento CERTO e hoje falha);
// `it('[RESISTIU] …')` = o ataque foi barrado; `it('[FATO …]')` = comportamento atual que depende de decisão (questão no relatório).
// Banco MOCKADO na fronteira (pool/conn) na parte 1; a parte VIVA (opt-in, F2A_ADV_LIVE=1) só toca bancos DESCARTÁVEIS `f2a_adv_a3_*`,
// criados e apagados aqui (o schema real é só LIDO: CREATE TABLE … LIKE).
import fs from 'fs'
import path from 'path'
import request from 'supertest'
import { testToken } from '../test-setup/test-token'
import { rawServiceRow, serviceView, TEST_KEY } from '../test-setup/fiscal-voice-rows'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVA3'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../shared/check', () => ({
  __esModule: true, ...jest.requireActual('../shared/check'), isCheckEventCurrent: jest.fn(), reverseCheckEvent: jest.fn(),
}))
jest.mock('../shared/commission', () => ({
  __esModule: true, ...jest.requireActual('../shared/commission'), getCommissionBalanceByItem: jest.fn(), insertCommissions: jest.fn(),
}))
jest.mock('../shared/bank-slip', () => ({ __esModule: true, ...jest.requireActual('../shared/bank-slip'), cancelBankSlip: jest.fn() }))
jest.mock('../modules/service-orders/service-orders.repository', () => ({
  __esModule: true, ...jest.requireActual('../modules/service-orders/service-orders.repository'), listOrders: jest.fn(),
}))

import pool from '../shared/db/connection'
import * as chk from '../shared/check'
import * as com from '../shared/commission'
import * as soRepo from '../modules/service-orders/service-orders.repository'
import {
  buildCancelPlan, cancelInvoice, waiveSubstitutedCancel, fiscalEffectOf, fiscalCancelBarrier, readInvoiceFiscal,
} from '../shared/invoice'
import { readServiceVoiceOfLife, readServiceVoicesOfLives, assertFiscalVoiceReadable } from '../shared/fiscal-voice'
import { fetchOrders } from '../modules/service-orders/service-orders.service'
import { handleError } from '../shared/http/controller-utils'
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import { splitStatements } from '../migrations/runner'
import app from '../app'

/** ADV_SHOW=1 roda os achados como `it` comum — para LER a mensagem da falha (o motivo certo, não erro de mock). */
const failing: jest.It['failing'] = process.env.ADV_SHOW === '1' ? (it as any) : it.failing
const q = (pool as any).query as jest.Mock
const getConn = (pool as any).getConnection as jest.Mock
const NFSE_API_DIR = process.env.NFSE_API_DIR ?? path.join(__dirname, '..', '..', '..', 'nfse-api')

// =================================================================================================
// banco de mentira — pool (guardas, vidas em lote, dispensa, voz) e a conexão da transação (o plano)
// =================================================================================================
const CATALOG: Record<string, number> = { orders: 29, 'service-orders': 20, 'order-returns': 31 }
const BRANCH: Record<number, string> = { 100: 'orders', 7400: 'service-orders', 300: 'order-returns' }
let contracted: Set<number>
let privileged: Set<string>
let lifeRows: any[]
let waiverRows: any[]
let fiscalRows: any[]
let fiscalError: any
let poolSql: string[]

function routePool(): void {
  q.mockImplementation(async (sql: string, params: any[] = []) => {
    poolSql.push(String(sql))
    if (/FROM setes_central\.tb_interface WHERE i18n_key/.test(sql)) { const id = CATALOG[String(params[0])]; return [id ? [{ id }] : []] }
    if (/tb_institution_has_interface/.test(sql)) return [contracted.has(Number(params[1])) ? [{ 1: 1 }] : []]
    if (/tb_user_has_privilege/.test(sql)) return [privileged.has(`${params[0]}:${params[1]}:${params[2]}`) ? [{ 1: 1 }] : []]
    if (/vw_order_interface/.test(sql)) { const k = BRANCH[Number(params[1])]; return [k ? [{ k }] : []] }
    if (/tb_invoice_cancel_waiver/.test(sql)) return [waiverRows]
    if (/vw_invoice_life/.test(sql)) { const ids: number[] = (params[1] ?? []).map(Number); return [lifeRows.filter(r => ids.includes(Number(r.invoiceId)))] }
    if (/`fiscal_api`\.vw_invoice_service_transmission/.test(sql)) { if (fiscalError) throw fiscalError; return [fiscalRows] }
    throw new Error(`SQL inesperado no pool: ${String(sql).slice(0, 90)}`)
  })
}

/** Conexão de transação roteada por SQL: devolve as linhas do cenário e REGISTRA toda escrita (o GET nunca pode escrever). */
interface PlanScenario {
  order?: any[]; invoice?: any[]; life?: any[]; anchor?: any[]; serviceOrder?: any[]; financial?: any[]; receipts?: any[]
  payments?: any[]; slips?: any[]; released?: any[]; returns?: any[]; fiscal?: any[]; failOn?: RegExp; failWith?: any
}
function planConn(sc: PlanScenario = {}) {
  const writes: string[] = []
  const sqls: string[] = []
  const conn: any = {
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn().mockResolvedValue(undefined), release: jest.fn(),
    query: jest.fn(async (sql: string) => {
      sqls.push(String(sql))
      if (sc.failOn && sc.failOn.test(sql)) throw sc.failWith
      if (/^SET (@setes_plan_prev_lw|SESSION innodb_lock_wait_timeout)/.test(sql)) return [{}]   // D-F131: espera curta do plano consultivo
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) { writes.push(String(sql).trim().slice(0, 80)); return [{ affectedRows: 1, insertId: 0 }] }
      if (/FROM `setes_setes`\.tb_invoice_cancel_waiver/.test(sql)) return [[]]
      if (/SELECT COALESCE\(MAX\(event\), 0\) \+ 1 AS nextEvent/.test(sql)) return [[{ nextEvent: 2 }]]
      if (/FROM `setes_setes`\.tb_order\s+WHERE id = \?/.test(sql)) return [sc.order ?? [{ status: 'F' }]]
      if (/FROM `setes_setes`\.tb_invoice\s+WHERE id = \?/.test(sql)) return [sc.invoice ?? [{ id: 100, number: '17', serie: '1', model: 'SE', value: '250.00', status: '0' }]]
      if (/FROM `setes_setes`\.vw_invoice_life/.test(sql)) return [sc.life ?? [{ lifeEvent: 1, lastEvent: 1, lastKind: 'E' }]]
      if (/tb_order_stock_adjust_return\s+WHERE id = \?/.test(sql)) return [sc.anchor ?? []]
      if (/tb_service_order c/.test(sql)) return [sc.serviceOrder ?? []]
      if (/FROM `setes_setes`\.tb_financial\s+WHERE/.test(sql)) return [sc.financial ?? [{ parcel: 1 }]]
      if (/tb_check_event e/.test(sql)) return [sc.receipts ?? []]
      if (/tb_financial_payment/.test(sql)) return [sc.payments ?? []]
      if (/tb_bank_slip_title t\s+JOIN/.test(sql)) return [sc.slips ?? []]
      if (/tb_bank_slip_title\s+WHERE tb_institution_id = \? AND tb_bank_slip_id IN/.test(sql)) return [sc.released ?? []]
      if (/tb_order_stock_adjust_return r/.test(sql)) return [sc.returns ?? []]
      if (/`fiscal_api`\.vw_invoice_service_transmission/.test(sql)) return [sc.fiscal ?? []]
      // F2A3-SOC-12 (correção da sessão): o GET do plano confere o caixa do operador quando toca o caixa (D16 — o que o POST diria)
      if (/FROM `setes_setes`\.tb_cashier/.test(sql)) return [[{ id: 3 }]]
      throw new Error(`SQL inesperado na transação: ${String(sql).slice(0, 90)}`)
    }),
  }
  return { conn, writes, sqls }
}

/** D-F130 (Rodada 4 da F2a): a falha da leitura da voz sai da PORTA tipada (503 FISCAL_VOICE_UNAVAILABLE + ref); a causa fica em causeMessage. */
const voiceDown = (cause: RegExp) => expect.objectContaining({ statusCode: 503, code: 'FISCAL_VOICE_UNAVAILABLE', causeMessage: expect.stringMatching(cause) })

const USER = { institutionId: 1, userId: 7, role: 'user', schemaName: 'setes_setes' }
const ADMIN = { ...USER, role: 'admin' }
const SUPER = { ...USER, role: 'super' }
const bearer = (p: object) => `Bearer ${testToken(p)}`
const lockWait = Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 })
const deadlock = Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 })

const ENV0 = { ...process.env }
beforeEach(() => {
  jest.clearAllMocks()
  resetPrivilegeCache()
  contracted = new Set(Object.values(CATALOG)); privileged = new Set(); poolSql = []
  lifeRows = [{ invoiceId: 100, invoiceDeleted: 'N', lifeEvent: 1, lastEvent: 1, lastKind: 'E' }]
  waiverRows = []; fiscalRows = []; fiscalError = undefined
  routePool()
  ;(chk.isCheckEventCurrent as jest.Mock).mockResolvedValue(true)
  ;(com.getCommissionBalanceByItem as jest.Mock).mockResolvedValue([])
  ;(com.insertCommissions as jest.Mock).mockResolvedValue([1])
})
afterEach(() => { process.env = { ...ENV0 } })

/** Linha da view (crua, como o driver devolve) na nota 100, vida 1. */
const row = (over: any = {}) => rawServiceRow({ invoiceId: 100, lifeEvent: 1, ...over })
const unrec = (over: any = {}) => row({ accessKey: null, authorityRecorded: 'N', nfseNumber: null, dhProc: null, ...over })

// =================================================================================================
// 1. Cancelamento LOCAL de NFS-e AUTORIZADA em PRODUÇÃO — plano e POST pela porta da voz
// =================================================================================================
describe('1 — cancelamento local de NFS-e autorizada em produção (barreira, veredito, registro fiscal)', () => {
  const plan = async (fiscal: any[], sc: PlanScenario = {}) => buildCancelPlan(planConn({ ...sc, fiscal }).conn, 'setes_setes', 1, 100)
  const fiscalBlocks = (p: any) => p.blocks.filter((b: any) => b.field === 'fiscal')

  it('[RESISTIU] vidas MISTURADAS: a view devolve a vida H antiga (registrada/cancelada) junto da vida nova em P → falha ALTO (D-F119), nunca decide', async () => {
    const mixed = [row({ lifeEvent: 1, attempt: 1, environment: 'H', lastKind: 'C', lastCode: '101101' }), unrec({ lifeEvent: 3, attempt: 2, lastKind: 'F', lastSource: 'Q', lastEventAt: '2026-10-10 12:10:00' })]
    await expect(plan(mixed, { life: [{ lifeEvent: 3, lastEvent: 3, lastKind: 'E' }] })).rejects.toEqual(voiceDown(/vida|não foi pedida|mistura/))
    // e o veredito do núcleo recusa a lista mista mesmo que alguém a monte à mão
    expect(() => fiscalCancelBarrier({ service: mixed.map((r: any) => serviceView(r)), current: null })).toThrow(/mistura/)
  })

  it('[RESISTIU] a vida vem do lockInvoice (D-F126): view de vida com 2 linhas → 409 RESOURCE_BUSY antes de ler a voz', async () => {
    const { conn, sqls } = planConn({ life: [{ lifeEvent: 1, lastEvent: 2, lastKind: 'C' }, { lifeEvent: 3, lastEvent: 3, lastKind: 'E' }], fiscal: [row()] })
    await expect(buildCancelPlan(conn, 'setes_setes', 1, 100)).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
    expect(sqls.some(s => /fiscal_api/.test(s))).toBe(false)
  })

  it('[RESISTIU] prova FORJADA: E2404 anterior à última apresentação, instante fora do formato, irmã sem voz de OUTRA identidade → nunca "provada"', async () => {
    const f = { lastKind: 'F', lastSource: 'Q', createdAt: '2026-10-10 12:00:00', lastEventAt: '2026-10-10 12:10:00' }
    // E2404 anterior à reapresentação do mesmo Id (outra tentativa da vida, mesma identidade)
    expect(fiscalBlocks(await plan([unrec({ attempt: 1, ...f, nfseNotGeneratedAt: '2026-10-10 13:00:00' }), unrec({ attempt: 2, lastKind: 'R', lastSource: 'P', createdAt: '2026-10-10 14:00:00', lastEventAt: '2026-10-10 14:00:05' })])))
      .toEqual([expect.objectContaining({ message: expect.stringMatching(/apresentada-depois/) })])
    // E2404 igual ao instante do F (a consulta que GEROU o F não prova) e em ISO com T/Z
    for (const at of ['2026-10-10 12:10:00', '2026-10-11T08:00:00Z']) {
      expect(fiscalBlocks(await plan([unrec({ ...f, nfseNotGeneratedAt: at })]))).toHaveLength(1)
    }
    // tentativa VIVA de OUTRA identidade (outro Id do DPS) na mesma vida → em andamento (barreira antes da prova)
    expect(fiscalBlocks(await plan([unrec({ attempt: 1, ...f, nfseNotGeneratedAt: '2026-10-11 08:00:00' }),
      unrec({ attempt: 2, dpsId: 'DPS999', lastEvent: null, lastKind: null, lastCode: null, lastSource: null, lastDh: null, lastEventAt: null })])))
      .toEqual([expect.objectContaining({ message: expect.stringMatching(/em andamento/) })])
  })

  it('[RESISTIU] códigos/kinds em minúsculas ou fora do domínio: "a"/"c"/"n" = viva (bloqueia), ambiente "p" e registro "s"/NULL = falha ALTO', async () => {
    for (const k of ['a', 'c', 'n', 'se', 'X']) expect(fiscalBlocks(await plan([row({ lastKind: k })]))).toHaveLength(1)
    await expect(plan([row({ environment: 'p' })])).rejects.toEqual(voiceDown(/environment/))
    await expect(plan([row({ authorityRecorded: 's' })])).rejects.toEqual(voiceDown(/authority_recorded/))
    await expect(plan([row({ authorityRecorded: null })])).rejects.toEqual(voiceDown(/authority_recorded/))
    // C do fisco com minúscula não "libera o efeito": 'c' é viva → o POST recusa (409), nada gravado
    const { conn, writes } = planConn({ fiscal: [row({ lastKind: 'c', lastCode: '101101' })] })
    await expect(cancelInvoice(conn, 'setes_setes', 1, 7, { orderId: 100, reason: 'x' })).rejects.toMatchObject({ code: 'INVOICE_CANCEL_BLOCKED' })
    expect(writes).toEqual([])
  })

  it('[RESISTIU] voz C vigente (101101) em P = o caminho do efeito: cancela SEM apagar a nota (registro fiscal → nota fica, pedido C); substituição/de ofício idem', async () => {
    for (const code of ['101101', '105102', '305101', null]) {
      const { conn, writes } = planConn({ fiscal: [row({ lastKind: 'C', lastCode: code, lastSource: 'Q' })] })
      await cancelInvoice(conn, 'setes_setes', 1, 7, { orderId: 100, reason: 'efeito do fisco' })
      expect(writes.some(w => /tb_invoice SET deleted = 'S'/.test(w))).toBe(false)
      expect(writes.some(w => /UPDATE `setes_setes`\.tb_order SET status = 'C'/.test(w))).toBe(true)
    }
  })

  it('[RESISTIU] nota sem voz nenhuma (nunca transmitida) e nota sincronizada (sem vida) → caminho da pendente / recusa "cancele na origem"', async () => {
    const p = await plan([])
    expect(p.blocks).toEqual([]); expect(p.fiscalRecord).toBe(false)
    const { conn } = planConn({ life: [{ lifeEvent: null, lastEvent: null, lastKind: null }] })
    await expect(buildCancelPlan(conn, 'setes_setes', 1, 100)).rejects.toMatchObject({ code: 'INVOICE_NOT_CANCELLABLE' })
  })

  it('[DECIDIDO — D-F136 (= Q-F144 (a)); era ACHADO F2A3-ADV-01 MEDIUM] voz A/N (AUTORIZADA) em PRODUÇÃO sem `authority_recorded` (linha incoerente — não há CHECK "A ⇒ chave") NÃO bloqueava: o POST /billing/cancel soft-deletava a nota — agora o MAPA do núcleo falha ALTO (o invariante da D-NE61 para a autorizada)', async () => {
    // antes (f5eee3b): `(isLive || isAuthorized) && !(isAuthorized && environment === 'H')` → bloqueava; hoje só bloqueia se isFiscalRecord
    for (const k of ['A', 'N']) {
      const { conn, writes } = planConn({ fiscal: [unrec({ lastKind: k, lastSource: 'P', environment: 'P' })] })
      let outcome: any
      try { await cancelInvoice(conn, 'setes_setes', 1, 7, { orderId: 100, reason: 'teste' }); outcome = 'cancelou' } catch (e: any) { outcome = e }
      // CERTO: falha fechado — bloqueio `fiscal` (409) ou falha ALTA do mapa (invariante da família, como a D-NE61 para D) — nunca soft-delete
      expect(writes.filter(w => /tb_invoice SET deleted = 'S'/.test(w))).toEqual([])
      expect(outcome).not.toBe('cancelou')
      expect(outcome).toEqual(voiceDown(/autorizada\) SEM registro.*D-F136/))   // D-F130: o mapa recusa → a porta tipa (fechado)
    }
  })
})

// =================================================================================================
// 2. "Manter a nota" (cancel-waiver) fora da substituição em produção
// =================================================================================================
describe('2 — "manter a nota" (D-F67/D-F80) só na SUBSTITUIÇÃO em PRODUÇÃO', () => {
  const waive = (fiscal: any[], sc: PlanScenario = {}) => {
    const pc = planConn({ ...sc, fiscal })
    return { pc, run: () => waiveSubstitutedCancel(pc.conn, 'setes_setes', 1, 7, { orderId: 100, reason: 'substituta no portal' }) }
  }
  it('[RESISTIU] H, sem voz C, C por NOSSO pedido (101101), sem código, DE OFÍCIO (305101), voz viva, R/F → 409 NOT_APPLICABLE, nada gravado', async () => {
    const cases = [
      row({ environment: 'H', lastKind: 'C', lastCode: '105102' }), row(), row({ lastKind: 'C', lastCode: '101101' }), row({ lastKind: 'C', lastCode: null }),
      row({ lastKind: 'C', lastCode: '305101' }), row({ lastKind: 'K' }), unrec({ lastKind: 'R' }), unrec({ lastKind: 'F', lastSource: 'Q' }),
      row({ lastKind: 'c', lastCode: '105102' }),
    ]
    for (const r of cases) {
      const { pc, run } = waive([r])
      await expect(run()).rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_CANCEL_WAIVER_NOT_APPLICABLE' })
      expect(pc.writes).toEqual([])
    }
    const { pc, run } = waive([])
    await expect(run()).rejects.toMatchObject({ code: 'INVOICE_CANCEL_WAIVER_NOT_APPLICABLE' }); expect(pc.writes).toEqual([])
  })
  it('[RESISTIU] OUTRA vida (a substituição é da vida antiga) → a leitura escopada falha ALTO; nota cancelada → 409; nota soft-deletada → 404', async () => {
    await expect(waive([row({ lifeEvent: 9, lastKind: 'C', lastCode: '105102' })]).run()).rejects.toEqual(voiceDown(/não foi pedida/))
    await expect(waive([row({ lastKind: 'C', lastCode: '105102' })], { life: [{ lifeEvent: 1, lastEvent: 2, lastKind: 'C' }] }).run())
      .rejects.toMatchObject({ code: 'INVOICE_CANCEL_WAIVER_NOT_APPLICABLE' })
    await expect(waive([row({ lastKind: 'C', lastCode: '105102' })], { invoice: [] }).run()).rejects.toMatchObject({ statusCode: 404, code: 'INVOICE_NOT_FOUND' })
  })
  it('[RESISTIU] a voz é lida DEPOIS da trava da nota (D-F121) e só a substituição em P grava — uma linha, chave da VIGENTE', async () => {
    const { pc, run } = waive([row({ lastKind: 'C', lastCode: '105102', lastSource: 'Q' })])
    const out = await run()
    expect(out).toMatchObject({ orderId: 100, accessKey: TEST_KEY, alreadyWaived: false })
    const lockAt = pc.sqls.findIndex(s => /FROM `setes_setes`\.tb_invoice\s+WHERE id = \?[\s\S]*FOR UPDATE/.test(s))
    const voiceAt = pc.sqls.findIndex(s => /fiscal_api/.test(s))
    expect(lockAt).toBe(0); expect(voiceAt).toBeGreaterThan(lockAt)
    expect(pc.writes).toHaveLength(1); expect(pc.writes[0]).toMatch(/INSERT INTO `setes_setes`\.tb_invoice_cancel_waiver/)
  })
})

// =================================================================================================
// 3. Rotas novas: GET …/cancel-plan e GET …/fiscal-effect
// =================================================================================================
describe('3 — GET /api/billing/:orderId/cancel-plan e /fiscal-effect (D-F115/D-F128/D-F37)', () => {
  const plan = (id: string | number = 100, who: object = ADMIN) => request(app).get(`/api/billing/${id}/cancel-plan`).set('Authorization', bearer(who))
  const effect = (id: string | number = 100, who: object = ADMIN) => request(app).get(`/api/billing/${id}/fiscal-effect`).set('Authorization', bearer(who))

  it('[RESISTIU] ramo NÃO contratado → 403 INTERFACE_NOT_ALLOWED para usuário, admin e super (D-F37) — nas duas rotas, antes de abrir transação', async () => {
    contracted.delete(CATALOG['service-orders'])
    for (const who of [USER, ADMIN, SUPER]) {
      for (const r of [await plan(7400, who), await effect(7400, who)]) expect([r.status, r.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    }
    expect(getConn).not.toHaveBeenCalled()
  })

  it('[RESISTIU] orderId torto (abc, 0, -1, 1.5, 1e3, 0x10, " 12", 2^53+1, 20 dígitos) → 400 INVALID_ID, sem transação nem leitura da nota', async () => {
    for (const bad of ['abc', '0', '-1', '1.5', '1e3', '0x10', '%2012', '9007199254740993', '99999999999999999999']) {
      for (const r of [await plan(bad), await effect(bad)]) expect([bad, r.status, r.body.code]).toEqual([bad, 400, 'INVALID_ID'])
    }
    expect(getConn).not.toHaveBeenCalled()
    expect(poolSql.some(s => /vw_invoice_life/.test(s))).toBe(false)
  })

  it('[RESISTIU] pedido de OUTRA institution / inexistente → 404 (toda leitura escopada pelo JWT), sem vazar', async () => {
    lifeRows = []
    expect((await effect(555)).body).toMatchObject({ code: 'INVOICE_NOT_FOUND' })
    const { conn } = planConn({ order: [] }); getConn.mockResolvedValue(conn)
    const r = await plan(555)
    expect([r.status, r.body.code]).toEqual([404, 'ORDER_NOT_FOUND'])
    const orderRead = conn.query.mock.calls.find((c: any[]) => /FROM `setes_setes`\.tb_order\s+WHERE id = \?/.test(String(c[0])))!
    expect(orderRead[1]).toEqual([555, 1])                                // (id, institution do JWT) — os SET da espera curta vêm antes (D-F131)
  })

  it('[RESISTIU] D-F128: o GET do plano percorre TODOS os ramos (cheque em custódia, boleto agrupado, baixa, devolução, voz) e NUNCA escreve nem comita', async () => {
    const { conn, writes } = planConn({
      receipts: [{ checkId: 42, event: 1, parcel: 1, paymentEvent: 1, settledCode: 9, number: 'A1' }],
      payments: [{ parcel: 1, event: 1, paidValue: '100.00' }, { parcel: 2, event: 1, paidValue: '50.00' }],
      slips: [{ id: 9, lastKind: 'E', otherOrders: 1 }, { id: 10, lastKind: 'L', otherOrders: 0 }],
      released: [{ bankSlipId: 9, orderId: 200, parcel: 1 }], returns: [{ id: 300 }], fiscal: [row()],
    })
    getConn.mockResolvedValue(conn)
    ;(com.getCommissionBalanceByItem as jest.Mock).mockResolvedValue([{ orderItemId: 1, orderItemKind: 'S', customerId: 3, salesmanId: 4, aliq: 5, balance: 2.5 }])
    const r = await plan()
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ cancellable: false, fiscalRecord: true, effects: { bankSlipsToCancel: [9], checksToReverse: [{ checkId: 42, number: 'A1' }], touchesCash: true } })
    expect(r.body.data.blocks.map((b: any) => b.field).sort()).toEqual(['bankSlip', 'fiscal', 'return', 'title'])
    expect(writes).toEqual([])
    expect(conn.commit).not.toHaveBeenCalled(); expect(conn.rollback).toHaveBeenCalled(); expect(conn.release).toHaveBeenCalled()
    expect(chk.reverseCheckEvent).not.toHaveBeenCalled(); expect(com.insertCommissions).not.toHaveBeenCalled()
  })

  it('[RESISTIU] contenção: lock wait no meio do plano → 409 RESOURCE_BUSY (nunca 500), transação desfeita, conexão devolvida, nada gravado', async () => {
    const { conn, writes } = planConn({ failOn: /FROM `setes_setes`\.tb_financial\s+WHERE/, failWith: lockWait })
    getConn.mockResolvedValue(conn)
    const r = await plan()
    expect([r.status, r.body.code]).toEqual([409, 'RESOURCE_BUSY'])
    expect(writes).toEqual([]); expect(conn.commit).not.toHaveBeenCalled()
    expect(conn.rollback).toHaveBeenCalled(); expect(conn.release).toHaveBeenCalled()
  })

  it('[RESISTIU] deadlock persistente → reexecuta 3× (D-G4) e sai 409 RESOURCE_BUSY; cada tentativa desfeita e devolvida', async () => {
    const { conn } = planConn({ failOn: /tb_check_event e/, failWith: deadlock })
    getConn.mockResolvedValue(conn)
    const r = await plan()
    expect([r.status, r.body.code]).toEqual([409, 'RESOURCE_BUSY'])
    expect(getConn).toHaveBeenCalledTimes(3)
    expect(conn.rollback).toHaveBeenCalledTimes(3); expect(conn.release).toHaveBeenCalledTimes(3); expect(conn.commit).not.toHaveBeenCalled()
  })

  it('[RESISTIU] OS × venda × devolução: devolução → 409 do plano (nasce na tela de devoluções); fiscal-effect de nota sem voz → none', async () => {
    const { conn } = planConn({ anchor: [{ 1: 1 }] }); getConn.mockResolvedValue(conn)
    const r = await plan(300)
    expect([r.status, r.body.code]).toEqual([409, 'INVOICE_NOT_CANCELLABLE'])
    lifeRows = [{ invoiceId: 300, invoiceDeleted: 'N', lifeEvent: 4, lastEvent: 4, lastKind: 'E' }]
    expect((await effect(300)).body.data).toMatchObject({ effect: 'none', lifeEvent: 4 })
  })

  it('[DECIDIDO — D-F131 (= Q-F139 (a)); era FATO Q-F141-ADV] usuário SEM o privilégio CANCELAR NÃO roda o plano consultivo: 403 PRIVILEGE_REQUIRED antes de abrir conexão — as travas FOR UPDATE do plano (inclusive títulos de OUTROS pedidos do boleto agrupado) ficam fora do alcance de quem não pode cancelar', async () => {
    const { conn, sqls } = planConn({ slips: [{ id: 9, lastKind: 'E', otherOrders: 1 }], released: [{ bankSlipId: 9, orderId: 200, parcel: 1 }] })
    getConn.mockResolvedValue(conn)
    const r = await plan(100, USER)                                       // `privileged` vazio: nenhum CANCELAR
    expect([r.status, r.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
    expect(getConn).not.toHaveBeenCalled()
    expect(sqls).toEqual([])
  })

  it('[RESISTIU] fiscal-effect é leitura pura: nenhuma transação, nenhuma trava, nenhuma escrita (só SELECT no pool)', async () => {
    fiscalRows = [row({ lastKind: 'C', lastCode: '105102', lastSource: 'Q' })]
    const r = await effect()
    expect(r.body.data).toMatchObject({ effect: 'decide' })
    expect(getConn).not.toHaveBeenCalled()
    expect(poolSql.every(s => /^\s*SELECT/i.test(s) && !/FOR UPDATE|LOCK IN SHARE MODE/.test(s))).toBe(true)
  })
})

// =================================================================================================
// 4. Efeito (D-F114) e selo em lote da lista de OS
// =================================================================================================
describe('4 — efeito da voz (D-F114) e selo em lote da lista de OS', () => {
  it('[CORRIGIDO na sessão — F2A3-ADV-02 LOW] código de cancelamento com espaço ("105102 ") passava no CHECK _ci do fiscal_api e o ERP classificava "apply" em vez de "decide" (D-F64) — agora o valor NÃO chega: a 006 da nfse-api (CHECK exato), a sonda do boot e a conferência da origem do `migrate:setes` o recusam; a classificação continua EXATA', () => {
    const nfse = (...p: string[]) => fs.readFileSync(path.join(NFSE_API_DIR, ...p), 'utf8')
    expect(nfse('src', 'migrations', 'sql', '006_cancel_event_code_exact.sql')).toMatch(/CHAR_LENGTH\(`authority_code`\) = 6 AND `authority_code` COLLATE utf8mb4_bin IN/)
    expect(nfse('src', 'nfse', 'voice-family.ts')).toMatch(/code\(5, '105102 '\)/)
    expect(nfse('scripts', 'migrate-from-setes-api.ts')).toMatch(/CHAR_LENGTH\(ev\.authority_code\) <> 6/)
    expect(fiscalEffectOf(serviceView({ lastKind: 'C', lastCode: '105102', lastSource: 'Q' }), 'E', false)).toBe('decide')
  })

  it('[RESISTIU] selo: nota sem vida (sincronizada) e nota sem tentativa → none; a vida pedida é a da view de política (pares nota × vida)', async () => {
    ;(soRepo.listOrders as jest.Mock).mockResolvedValue({ rows: [
      { id: 100, status: 'F', webIssued: 1, invoiceNumber: 17 }, { id: 101, status: 'F', webIssued: 1, invoiceNumber: 18 },
      { id: 102, status: 'F', webIssued: 0, invoiceNumber: 19 },
    ], total: 3 })
    lifeRows = [{ invoiceId: 100, invoiceDeleted: 'N', lifeEvent: 1, lastEvent: 1, lastKind: 'E' }, { invoiceId: 101, invoiceDeleted: 'N', lifeEvent: null, lastEvent: null, lastKind: null }]
    fiscalRows = [row()]
    const out = await fetchOrders('', { page: 1, pageSize: 25 } as any, { schemaName: 'setes_setes', institutionId: 1, userId: 7 })
    expect(out.rows.map((r: any) => [r.id, r.fiscalState])).toEqual([[100, 'authorized'], [101, 'none'], [102, null]])
    const voiceCall = q.mock.calls.find(c => /fiscal_api/.test(String(c[0])))!
    expect(voiceCall[1]).toEqual([1, 0, [[100, 1]]])                     // só o par pedido; a nota sem vida nem entra
  })

  it('[RESISTIU + D-F130] selo: linha de vida NÃO pedida vinda da view → nunca um selo de outra vida (D-F119): a lista DEGRADA para "unavailable"', async () => {
    ;(soRepo.listOrders as jest.Mock).mockResolvedValue({ rows: [{ id: 100, status: 'F', webIssued: 1, invoiceNumber: 17 }], total: 1 })
    fiscalRows = [row({ lifeEvent: 7 })]
    // D-F130 (Rodada 4): a LISTA degrada — selo `unavailable` (nunca um selo de outra vida, nunca 500); o alarme fica no crashlytics
    const out = await fetchOrders('', { page: 1, pageSize: 25 } as any, { schemaName: 'setes_setes', institutionId: 1, userId: 7 })
    expect(out.rows.map((r: any) => [r.id, r.fiscalState, r.fiscalEnvironment, r.nfseNumber])).toEqual([[100, 'unavailable', null, null]])
  })

  it('[DECIDIDO — D-F130 (= Q-F138 (b)); era ACHADO F2A3-ADV-03 MEDIUM] fiscal_api ILEGÍVEL em EXECUÇÃO (view recriada/sem GRANT/coluna nova faltando depois do boot) → a lista de OS INTEIRA cai em 500 com crashlytics; a conferência do boot (D-F113) só protege a subida', async () => {
    ;(soRepo.listOrders as jest.Mock).mockResolvedValue({ rows: [{ id: 100, status: 'F', webIssued: 1, invoiceNumber: 17 }], total: 1 })
    for (const err of [
      Object.assign(new Error("SELECT command denied to user 'setes'@'%' for table 'vw_invoice_service_transmission'"), { code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 }),
      Object.assign(new Error("Table 'fiscal_api.vw_invoice_service_transmission' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 }),
    ]) {
      fiscalError = err
      const res: any = { statusCode: 0, body: null, req: { institution: USER }, status(c: number) { this.statusCode = c; return this }, json(b: any) { this.body = b; return this } }
      try { const out = await fetchOrders('', { page: 1, pageSize: 25 } as any, { schemaName: 'setes_setes', institutionId: 1, userId: 7 }); res.status(200).json(out) } catch (e) { handleError(res, e, 'service-orders GET') }
      // CERTO (decisão Q-F139-ADV): a lista não cai inteira por causa do selo — degrada (selo desconhecido + alarme) ou responde com código TIPADO
      expect(res.statusCode).not.toBe(500)
    }
  })
})

// =================================================================================================
// 5/6. Estáticos: a ordem do boot e a conferência dos gatilhos pelo ATO da virada
// =================================================================================================
describe('5/6 — boot e o ato da virada (estático, leitura dos arquivos)', () => {
  it('[RESISTIU] boot: a conferência das views (D-F113/D-F127) roda ANTES das migrations e dentro do try que derruba o processo (exit 1) — nunca 500 na 1ª lista', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8')
    const at = src.indexOf('assertFiscalVoiceReadable(pool)'), mig = src.indexOf('runMigrationsForAllInstitutions()'), listen = src.indexOf('app.listen(')
    expect(at).toBeGreaterThan(0); expect(at).toBeLessThan(mig); expect(mig).toBeLessThan(listen)
    expect(src.slice(src.indexOf('try {'), src.indexOf('} catch (err)'))).toContain('assertFiscalVoiceReadable(pool)')
    expect(src).toMatch(/process\.exit\(1\)/)
  })

  it('[RESISTIU] boot: view sem a coluna/GRANT → a conferência rejeita com a causa (D-F113)', async () => {
    const fake = { query: jest.fn().mockRejectedValue(Object.assign(new Error("Unknown column 'v.authority_recorded'"), { code: 'ER_BAD_FIELD_ERROR', errno: 1054 })) }
    await expect(assertFiscalVoiceReadable(fake)).rejects.toThrow(/authority|coluna faltando|D-F113/)
  })

  it('[CORRIGIDO na sessão — F2A3-ADV-04 MEDIUM, lado do ATO] o ATO da virada conferia só `_migrations.name = f2a_fiscal_passivo` — nunca os 9 gatilhos (D-F110: "o ensaio da virada confere os triggers"); agora confere pelo NOME no information_schema (bloqueio no ensaio, recusa no ato). O boot do setes-api conferir também = questão do Valdo', () => {
    const act = fs.readFileSync(path.join(NFSE_API_DIR, 'scripts', 'cutover-erp.ts'), 'utf8')
    const run = fs.readFileSync(path.join(NFSE_API_DIR, 'scripts', 'migrate-from-setes-api.ts'), 'utf8')
    expect(act).toMatch(/information_schema\.TRIGGERS/)
    for (const name of ['tg_f2a_freeze_tx_bi', 'tg_f2a_freeze_voice_bd', 'tg_f2a_freeze_issuer_se_bu']) expect(act).toContain(name)
    expect(run).toMatch(/const triggersMissing = f2aMissing \? \[\] : await f2aFreezeTriggersMissing\(pool, s\)/)
    expect(run).toMatch(/if \(triggersMissing\.length && !DRY\)/)
  })

  it('[RESISTIU] o ATO exato de nfse-api/scripts/cutover-erp.ts é UM UPDATE N→S por (institution, modelo) — o que a 069 deixa passar (provado ao vivo abaixo)', () => {
    const src = fs.readFileSync(path.join(NFSE_API_DIR, 'scripts', 'cutover-erp.ts'), 'utf8')
    expect(cutoverSql(src)).toBe("UPDATE `${schema}`.tb_establishment_issuer SET deleted = 'S', updated_at = NOW() WHERE tb_institution_id = ? AND model = ? AND deleted = 'N'")
  })
})

/** O SQL LITERAL do ato da virada (template de `retireErpServiceIssuer`), lido do arquivo do nfse-api — nada reescrito à mão. */
function cutoverSql(src: string): string {
  const m = src.match(/`(UPDATE \\`\$\{schema\}\\`\.tb_establishment_issuer[\s\S]*?)`,\s*\[institutionId, model\]/)
  if (!m) throw new Error('cutover-erp.ts: UPDATE do ato não encontrado')
  return m[1].replace(/\\`/g, '`').replace(/\s+/g, ' ').trim()
}

// =================================================================================================
// PARTE VIVA (opt-in): F2A_ADV_LIVE=1 — bancos DESCARTÁVEIS f2a_adv_a3_*, criados e apagados aqui
// =================================================================================================
const live = process.env.F2A_ADV_LIVE === '1'
;(live ? describe : describe.skip)('ao vivo (MariaDB do dev, bancos descartáveis f2a_adv_a3_*)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mysql = jest.requireActual('mysql2/promise') as typeof import('mysql2/promise')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv') as typeof import('dotenv')
  const env = dotenv.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.env')))
  const TAG = Date.now().toString(36)
  const DBE = `f2a_adv_a3_${TAG}_erp`                 // cópia da FORMA das tabelas do ERP + a 069
  const DBF = `f2a_adv_a3_${TAG}_fis`                 // banco fiscal descartável com as migrations 001–005 da nfse-api
  const cfg = () => ({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD })
  let admin: any
  const opened: any[] = []
  const connTo = async (db: string, extra: object = {}) => {
    const c = await mysql.createConnection({ ...cfg(), ...extra }); opened.push(c); await c.query(`USE \`${db}\``)
    const [[cur]] = await c.query<any[]>('SELECT DATABASE() AS db')
    if (cur.db !== db || !/^f2a_adv_a3_/.test(cur.db)) throw new Error(`conexão fora do banco descartável: ${cur.db}`)   // nunca setes_*
    return c
  }
  const snapshot = async (c: any) => {
    const out: Record<string, unknown> = {}
    for (const t of ['tb_establishment_issuer', 'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event']) {
      const [rows] = await c.query(`SELECT * FROM \`${t}\` ORDER BY 1, 2, 3, 4`); out[t] = JSON.stringify(rows)
    }
    return out
  }
  /** Executa o ataque; devolve errno (ou 0 se o banco aceitou) — o veredito é "nada mudou" (snapshot igual). */
  const attack = async (c: any, sql: string, params: unknown[] = []) => {
    try { await c.query(sql, params); return 0 } catch (err: any) { return Number(err?.errno ?? -1) }
  }
  const nfseSql = (f: string) => splitStatements(fs.readFileSync(path.join(NFSE_API_DIR, 'src', 'migrations', 'sql', f), 'utf8'))
  const f069 = () => splitStatements(fs.readFileSync(path.join(__dirname, '..', 'migrations', 'sql', '069_f2a_fiscal_passivo.sql'), 'utf8'))
  const KEY2 = '41069022123456780001990000000000123202610100000999'

  beforeAll(async () => {
    admin = await mysql.createConnection(cfg())
    for (const db of [DBE, DBF]) await admin.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    // ---- ERP descartável: a FORMA real (CREATE TABLE … LIKE só LÊ setes_setes) + o FK voz → tentativa (o LIKE não copia FK)
    const e = await connTo(DBE)
    for (const t of ['tb_establishment_issuer', 'tb_invoice_service', 'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event']) {
      await e.query(`CREATE TABLE \`${t}\` LIKE setes_setes.\`${t}\``)
    }
    await e.query(`ALTER TABLE tb_invoice_service_transmission_event ADD CONSTRAINT fk_adv_ev_tx FOREIGN KEY (tb_institution_id, tb_invoice_id, terminal, attempt)
                   REFERENCES tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt)`)
    await e.query(`CREATE TABLE _migrations (id INT AUTO_INCREMENT PRIMARY KEY, version VARCHAR(10) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`)
    const ins = `INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, created_at, updated_at, deleted) VALUES `
    await e.query(`${ins} (1, 'SE', 'P', '1', 10, NOW(), NOW(), 'N'), (1, '55', 'H', '1', 0, NOW(), NOW(), 'N'), (2, 'SE', 'H', '1', 3, NOW(), NOW(), 'S')`)
    await e.query(`INSERT INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, environment, invoice_event, dps_id, access_key, nfse_number, created_at, updated_at, deleted)
                   VALUES (1, 100, 0, 1, 'P', 1, 'DPS1', ?, '710', NOW(), NOW(), 'N'), (1, 101, 0, 1, 'H', 1, 'DPS2', NULL, NULL, NOW(), NOW(), 'N')`, [TEST_KEY])
    await e.query(`INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, message, dh, source, created_at, updated_at, deleted)
                   VALUES (1, 100, 0, 1, 1, 'A', 'autorizada', '2026-10-10 12:00:05', 'P', NOW(), NOW(), 'N'), (1, 101, 0, 1, 1, 'R', 'E0116', NULL, 'P', NOW(), NOW(), 'N')`)
    for (const s of f069()) await e.query(s)
    await e.query(`INSERT INTO _migrations (version, name) VALUES ('069', 'f2a_fiscal_passivo')`)
    // ---- fiscal descartável: as migrations da nfse-api como estão no disco (001–005)
    const f = await connTo(DBF)
    for (const file of ['001_nfse_baseline.sql', '002_cancel_event_code.sql', '003_transmission_nfse_not_generated.sql']) for (const s of nfseSql(file)) await f.query(s)
  }, 60000)

  afterAll(async () => {
    for (const c of opened) { try { await c.end() } catch { /* */ } }
    if (admin) {
      for (const db of [DBE, DBF]) await admin.query(`DROP DATABASE IF EXISTS \`${db}\``)
      const [left] = await admin.query(`SHOW DATABASES LIKE 'f2a_adv_a3%'`)
      await admin.end()
      if ((left as any[]).length) throw new Error(`sobrou banco descartável: ${JSON.stringify(left)}`)
    }
  })

  // ------------------------------------------------------------------ boot × views da família
  it('[RESISTIU] boot (D-F113): banco fiscal só com 001–003 (view SEM authority_recorded) → a conferência REJEITA; com 004–006 → passa', async () => {
    process.env.FISCAL_DB_NAME = DBF
    const c = await connTo(DBF)
    await expect(assertFiscalVoiceReadable(c)).rejects.toThrow(/D-F113/)
    // 006 = correção da sessão (F2A3-ADV-02: CHECK EXATO do código da voz C — sem PAD SPACE)
    for (const file of ['004_transmission_common_projection.sql', '005_service_transmission_domains.sql', '006_cancel_event_code_exact.sql']) for (const s of nfseSql(file)) await c.query(s)
    await expect(assertFiscalVoiceReadable(c)).resolves.toContain(DBF)
    // conexão em utf8mb4_general_ci (o padrão do mysql2) lê a view sem 1267 (COLLATE fixo da 004)
    const g = await connTo(DBF); await g.query('SET NAMES utf8mb4 COLLATE utf8mb4_general_ci')
    await expect(assertFiscalVoiceReadable(g)).resolves.toBeDefined()
  })

  // ------------------------------------------------------------------ porta da voz contra a view REAL
  describe('porta @shared/fiscal-voice contra a view real da nfse-api', () => {
    let f: any
    beforeAll(async () => {
      f = await connTo(DBF)
      await f.query(`INSERT INTO tb_invoice_service_dps (tb_institution_id, tb_invoice_id, terminal, life_event, serie, dps_number, dps_id, created_at, updated_at, deleted)
                     VALUES (1, 100, 0, 1, '1', 10, 'DPSA', NOW(), NOW(), 'N'), (1, 101, 0, 1, '1', 11, 'DPSB1', NOW(), NOW(), 'N'), (1, 101, 0, 2, '1', 12, 'DPSB2', NOW(), NOW(), 'N'),
                            (1, 102, 0, 1, '1', 13, 'DPSC', NOW(), NOW(), 'N'), (1, 103, 0, 1, '1', 14, 'DPSD', NOW(), NOW(), 'N')`)
      const tx = `INSERT INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, access_key, nfse_number, created_at, updated_at, deleted) VALUES `
      await f.query(`${tx} (1, 100, 0, 1, 1, 'P', ?, '710', NOW(), NOW(), 'N'), (1, 101, 0, 1, 1, 'H', NULL, NULL, NOW(), NOW(), 'N'), (1, 101, 0, 2, 2, 'P', NULL, NULL, NOW(), NOW(), 'N'),
                            (1, 102, 0, 1, 1, 'P', NULL, NULL, NOW(), NOW(), 'N'), (1, 103, 0, 1, 1, 'P', ?, '711', NOW(), NOW(), 'N')`, [TEST_KEY, KEY2])
      const ev = `INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, message, dh, source, created_at, updated_at, deleted) VALUES `
      await f.query(`${ev} (1, 100, 0, 1, 1, 'A', NULL, 'ok', '2026-10-10 12:00:05', 'P', NOW(), NOW(), 'N'), (1, 101, 0, 1, 1, 'R', 'E0116', 'r', NULL, 'P', NOW(), NOW(), 'N'),
                           (1, 101, 0, 2, 1, 'F', NULL, 'f', NULL, 'Q', NOW(), NOW(), 'N')`)
    })
    beforeEach(() => { process.env.FISCAL_DB_NAME = DBF })

    it('[RESISTIU] lote por PARES nota × vida (tupla IN no driver real): só as vidas pedidas voltam; vida não pedida da mesma nota fica fora', async () => {
      const rows = await readServiceVoicesOfLives(f, 1, [{ invoiceId: 100, lifeEvent: 1 }, { invoiceId: 101, lifeEvent: 2 }])
      expect(rows.map(r => [r.invoiceId, r.lifeEvent, r.attempt, r.lastKind, r.authorityRecorded])).toEqual([[100, 1, 1, 'A', true], [101, 2, 2, 'F', false]])
      const one = await readServiceVoiceOfLife(f, 1, 101, 1)
      expect(one.map(r => r.attempt)).toEqual([1])
    })

    it('[RESISTIU] o CHECK binário do fiscal_api (D-F107/D-F120) recusa kind/source/ambiente em minúscula — a voz "a"/"c" nunca chega à decisão', async () => {
      const bad = [
        `INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, message, source, created_at, deleted) VALUES (1, 102, 0, 1, 1, 'a', 'x', 'P', NOW(), 'N')`,
        `INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, message, source, created_at, deleted) VALUES (1, 102, 0, 1, 1, 'C', 'x', 'q', NOW(), 'N')`,
        `UPDATE tb_invoice_service_transmission SET environment = 'p' WHERE tb_invoice_id = 102`,
      ]
      for (const sql of bad) expect(await attack(f, sql)).toBe(4025)
    })

    it('[DECIDIDO — D-F136, prova viva; era ACHADO F2A3-ADV-01 MEDIUM] o fiscal_api ACEITA voz A em PRODUÇÃO numa tentativa SEM chave (nenhum CHECK "A ⇒ registro") — a porta agora recusa a linha no MAPA (falha alta), nunca entrega ao plano uma autorizada sem registro', async () => {
      await f.query(`INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, message, dh, source, created_at, deleted)
                     VALUES (1, 102, 0, 1, 1, 'A', 'sem chave', '2026-10-12 10:00:00', 'P', NOW(), 'N')`)
      let blocked = false, cause = ''
      try {
        const reading = await readInvoiceFiscal(f, 1, 102, 1)
        blocked = fiscalCancelBarrier(reading).kind !== 'none'
      } catch (e: any) { blocked = true; cause = String(e?.causeMessage ?? e?.message) }   // falha ALTA do mapa, TIPADA pela porta (D-F130)
      expect(blocked).toBe(true)
      expect(cause).toMatch(/D-F136/)
    })

    it('[CORRIGIDO na sessão — F2A3-ADV-02 LOW, prova viva] o CHECK do código de cancelamento (colação _ci PAD SPACE, sem COLLATE bin nem REGEXP) aceitava "105102 " — e o ERP lia "apply" em vez de "decide" (a 006 da nfse-api recusa)', async () => {
      const errno = await attack(f, `INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, message, dh, source, created_at, deleted)
                                    VALUES (1, 103, 0, 1, 1, 'C', '105102 ', 'substituida', '2026-10-12 11:00:00', 'Q', NOW(), 'N')`)
      if (errno === 0) {
        const { current } = await readInvoiceFiscal(f, 1, 103, 1)
        expect(fiscalEffectOf(current, 'E', false)).toBe('decide')
      }
      expect(errno).toBe(4025)
    })
  })

  // ------------------------------------------------------------------ 069: furar os gatilhos de TRAVA
  describe('069_f2a_fiscal_passivo — furar os gatilhos (banco descartável com a forma das tabelas do ERP)', () => {
    let e: any
    let before: Record<string, unknown>
    beforeAll(async () => { e = await connTo(DBE) })
    beforeEach(async () => { before = await snapshot(e) })

    it('[RESISTIU] os 9 gatilhos estão lá e o ATO EXATO do cutover-erp.ts (N→S) PASSA — e é idempotente (2ª vez = 0 linha)', async () => {
      const [trg] = await e.query(`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY 1`, [DBE])
      expect((trg as any[]).map(t => t.TRIGGER_NAME)).toHaveLength(9)
      const act = cutoverSql(fs.readFileSync(path.join(NFSE_API_DIR, 'scripts', 'cutover-erp.ts'), 'utf8')).replace('${schema}', DBE)
      const [r1] = await e.query(act, [1, 'SE'])
      expect(r1.affectedRows).toBe(1)
      const [r2] = await e.query(act, [1, 'SE'])
      expect(r2.affectedRows).toBe(0)
      const [[se]] = await e.query(`SELECT deleted FROM tb_establishment_issuer WHERE tb_institution_id = 1 AND model = 'SE'`)
      expect(se.deleted).toBe('S')
    })

    it('[RESISTIU] tentativas/vozes: INSERT IGNORE (VALUES e SELECT), REPLACE, ON DUPLICATE KEY UPDATE, UPDATE IGNORE, DELETE IGNORE, UPDATE/DELETE multi-tabela e UPDATE que não muda nada → nada muda', async () => {
      const attacks = [
        `INSERT IGNORE INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, environment, created_at, deleted) VALUES (1, 100, 0, 2, 'P', NOW(), 'N')`,
        `INSERT IGNORE INTO tb_invoice_service_transmission SELECT tb_institution_id, tb_invoice_id, terminal, attempt + 10, environment, invoice_event, dps_id, NULL, NULL, dh_proc, last_queried_at, tb_user_id, created_at, updated_at, deleted FROM tb_invoice_service_transmission`,
        `INSERT IGNORE INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, message, source, created_at, deleted) VALUES (1, 100, 0, 1, 2, 'C', 'x', 'Q', NOW(), 'N')`,
        `REPLACE INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, message, source, created_at, deleted) VALUES (1, 100, 0, 1, 1, 'C', 'trocada', 'Q', NOW(), 'N')`,
        `INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, message, source, created_at, deleted) VALUES (1, 100, 0, 1, 1, 'A', 'x', 'P', NOW(), 'N') ON DUPLICATE KEY UPDATE kind = 'C'`,
        `INSERT INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, environment, created_at, deleted) VALUES (1, 100, 0, 1, 'P', NOW(), 'N') ON DUPLICATE KEY UPDATE access_key = NULL`,
        `UPDATE IGNORE tb_invoice_service_transmission SET access_key = NULL`,
        `UPDATE tb_invoice_service_transmission_event SET deleted = deleted`,
        `DELETE IGNORE FROM tb_invoice_service_transmission_event`,
        `UPDATE tb_invoice_service_transmission t JOIN tb_invoice_service_transmission_event v ON v.tb_invoice_id = t.tb_invoice_id AND v.attempt = t.attempt SET t.last_queried_at = NOW(), v.message = 'x'`,
        `DELETE v FROM tb_invoice_service_transmission_event v JOIN tb_invoice_service_transmission t ON t.tb_invoice_id = v.tb_invoice_id AND t.attempt = v.attempt`,
        `DELETE t, v FROM tb_invoice_service_transmission t JOIN tb_invoice_service_transmission_event v ON v.tb_invoice_id = t.tb_invoice_id AND v.attempt = t.attempt`,
      ]
      const errnos: number[] = []
      for (const sql of attacks) errnos.push(await attack(e, sql))
      if (process.env.ADV_SHOW === '1') process.stdout.write(`errnos dos ataques: ${JSON.stringify(errnos)}\n`)
      expect(await snapshot(e)).toEqual(before)
      // registro do comportamento do motor (para o relatório): 1644 = SIGNAL do gatilho; 0 = o IGNORE rebaixou a aviso, mas NADA entrou
      expect(errnos.every(n => n === 1644 || n === 0 || n === 1451)).toBe(true)
    })

    it('[RESISTIU] a sessão não desliga o gatilho: sql_mode vazio, foreign_key_checks=0, check_constraint_checks=0, unique_checks=0', async () => {
      const s = await connTo(DBE)
      for (const set of [`SET SESSION sql_mode = ''`, 'SET SESSION foreign_key_checks = 0', 'SET SESSION check_constraint_checks = 0', 'SET SESSION unique_checks = 0']) await s.query(set)
      expect(await attack(s, `INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, message, source, created_at, deleted) VALUES (1, 100, 0, 1, 9, 'C', 'x', 'Q', NOW(), 'N')`)).toBe(1644)
      expect(await attack(s, `DELETE FROM tb_invoice_service_transmission WHERE tb_invoice_id = 101`)).toBe(1644)
      expect(await snapshot(e)).toEqual(before)
    })

    it('[RESISTIU] LOAD DATA LOCAL INFILE nas tabelas congeladas → recusado (servidor ou gatilho); nada entra', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Readable } = require('stream')
      const errno = await (async () => {
        try {
          await e.query({ sql: `LOAD DATA LOCAL INFILE 'adv.csv' INTO TABLE tb_invoice_service_transmission_event FIELDS TERMINATED BY ','
                                (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, message, source, deleted)`,
            infileStreamFactory: () => Readable.from([Buffer.from('1,100,0,1,7,C,carregada,Q,N\n')]) } as any)
          return 0
        } catch (err: any) { return Number(err?.errno ?? -1) }
      })()
      if (process.env.ADV_SHOW === '1') process.stdout.write(`errno do LOAD DATA: ${errno}\n`)
      expect(errno).not.toBe(0)
      expect(await snapshot(e)).toEqual(before)
    })

    it("[RESISTIU] habilitação SE: INSERT de 'SE'/'se'/'Se'/'SE '/'ＳＥ' (largura total) e REPLACE/ON DUPLICATE de SE → recusados; 55 continua livre", async () => {
      const ins = (model: string, inst: number) => `INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, created_at, updated_at, deleted) VALUES (${inst}, '${model}', 'H', '1', 0, NOW(), NOW(), 'N')`
      let inst = 50
      for (const m of ['SE', 'se', 'Se', 'SE ', 'ＳＥ']) expect([m, await attack(e, ins(m, inst++))]).toEqual([m, 1644])
      expect(await attack(e, `REPLACE INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, deleted) VALUES (1, 'SE', 'P', '1', 999, 'N')`)).toBe(1644)
      expect(await attack(e, `INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, deleted) VALUES (1, '55', 'H', '1', 0, 'N') ON DUPLICATE KEY UPDATE model = 'SE'`)).toBe(1644)
      expect(await snapshot(e)).toEqual(before)
      expect(await attack(e, `UPDATE tb_establishment_issuer SET serie = '2', environment = 'P' WHERE tb_institution_id = 1 AND model = '55'`)).toBe(0)
      await e.query(`UPDATE tb_establishment_issuer SET serie = '1', environment = 'H' WHERE tb_institution_id = 1 AND model = '55'`)
    })

    it("[RESISTIU] habilitação SE (sql_mode NÃO estrito do servidor): 'SEX' truncado para 'SE' em varchar(2) — o gatilho vê o valor JÁ convertido e recusa", async () => {
      const s = await connTo(DBE)
      await s.query(`SET SESSION sql_mode = ''`)
      expect(await attack(s, `INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, deleted) VALUES (60, 'SEX', 'H', '1', 0, 'N')`)).toBe(1644)
      expect(await attack(s, `UPDATE tb_establishment_issuer SET model = 'SEX' WHERE tb_institution_id = 1 AND model = '55'`)).toBe(1644)
      expect(await snapshot(e)).toEqual(before)
    })

    it("[RESISTIU] SE aposentada: revive S→N (também 'n'), mudar ambiente/contador/modelo, DELETE físico (também multi-tabela) → recusados", async () => {
      const attacks = [
        `UPDATE tb_establishment_issuer SET deleted = 'N' WHERE tb_institution_id = 2 AND model = 'SE'`,
        `UPDATE tb_establishment_issuer SET deleted = 'n' WHERE tb_institution_id = 2 AND model = 'SE'`,
        `UPDATE tb_establishment_issuer SET environment = 'P' WHERE tb_institution_id = 2 AND model = 'SE'`,
        `UPDATE tb_establishment_issuer SET dps_last_number = 0 WHERE tb_institution_id = 2 AND model = 'SE'`,
        `UPDATE tb_establishment_issuer SET model = '65' WHERE tb_institution_id = 2 AND model = 'SE'`,
        `DELETE FROM tb_establishment_issuer WHERE model = 'SE'`,
        `DELETE i FROM tb_establishment_issuer i JOIN tb_invoice_service_transmission t ON t.tb_institution_id = i.tb_institution_id WHERE i.model = 'SE'`,
      ]
      for (const sql of attacks) expect([sql.slice(0, 60), await attack(e, sql)]).toEqual([sql.slice(0, 60), 1644])
      expect(await snapshot(e)).toEqual(before)
    })

    it('[CORRIGIDO na sessão — F2A3-ADV-05 LOW] habilitação SE: trocar a PK (tb_institution_id) passa no gatilho — a linha SE "muda de dono": some de uma institution (DELETE disfarçado) e nasce noutra (INSERT disfarçado), sem SIGNAL', async () => {
      const errno = await attack(e, `UPDATE tb_establishment_issuer SET tb_institution_id = 77 WHERE tb_institution_id = 2 AND model = 'SE'`)
      try { expect(errno).toBe(1644); expect(await snapshot(e)).toEqual(before) } finally {
        if (errno === 0) {                                                   // desfaz para os próximos ataques (só possível porque o gatilho deixou)
          await e.query(`UPDATE tb_establishment_issuer SET tb_institution_id = 2 WHERE tb_institution_id = 77 AND model = 'SE'`)
        }
      }
    })

    it('[CONHECIMENTO NEGATIVO — F2A3-ADV-06 LOW] TRUNCATE NÃO dispara gatilho de DELETE: a voz congelada some inteira (e a tentativa também, com foreign_key_checks=0) — o gatilho não protege contra DDL nem contra quem tem ALL; a perda é FECHADA pela re-sincronia do ato ("fato que a origem não tem") — PADROES §11 regra 15', async () => {
      const s = await connTo(DBE)
      const r1 = await attack(s, 'TRUNCATE TABLE tb_invoice_service_transmission_event')
      await s.query('SET SESSION foreign_key_checks = 0')
      const r2 = await attack(s, 'TRUNCATE TABLE tb_invoice_service_transmission')
      expect([r1, r2]).toEqual([0, 0])                                         // fixa a semântica do motor (ninguém "conserta" com gatilho)
    })

    it('[FATO — ligado ao F2A3-ADV-04] DROP TRIGGER com o usuário do setes-api apaga a trava e `_migrations` continua dizendo f2a_fiscal_passivo — a escrita volta a passar; o ATO da virada (correção da sessão) ACUSA o gatilho que falta pelo nome', async () => {
      await e.query('DROP TRIGGER tg_f2a_freeze_issuer_se_bu')
      const [[m]] = await e.query(`SELECT COUNT(*) AS n FROM _migrations WHERE name = 'f2a_fiscal_passivo'`)
      expect(Number(m.n)).toBe(1)
      expect(await attack(e, `UPDATE tb_establishment_issuer SET deleted = 'N' WHERE tb_institution_id = 1 AND model = 'SE'`)).toBe(0)   // revive S→N
      // a conferência REAL do ato (nfse-api/scripts/cutover-erp.ts), contra o banco descartável, com o usuário do .env (dono — vê os gatilhos)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { f2aFreezeTriggersMissing } = require(path.join(NFSE_API_DIR, 'scripts', 'cutover-erp'))
      expect(await f2aFreezeTriggersMissing(e, DBE)).toEqual(['tg_f2a_freeze_issuer_se_bu ausente'])
    })
  })
})
