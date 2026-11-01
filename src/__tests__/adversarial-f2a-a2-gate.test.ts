/// <reference types="jest" />
// GATE ADVERSARIAL independente da etapa A2 da F2a (2026-10-12 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §22.3/§22.8). Alvo: o delta 6bd6f83..f2a da worktree setes-api-f2a —
//   D-F13 (JWT RS256 com kid: product-token, auth.middleware, login/select/switch),
//   D-F37 (licença para TODOS nas guardas de require-privilege),
//   D-F32 (resolveOrderInterface / lockInvoice / LAST_INVOICE_EVENT_KIND_SQL / CURRENT_RETURN_SQL pelas views da 065)
//   e a migration 068 (COLLATE utf8mb4_bin em vw_order_interface.interface_key).
// Convenção: achado CONFIRMADO = `it.failing('[ACHADO …]')` (o teste descreve o comportamento CERTO e hoje falha);
// `it('[RESISTIU] …')` = o ataque foi barrado. Banco MOCKADO na fronteira (pool/conn); a parte viva (opt-in,
// F2A_ADV_LIVE=1) só toca um banco DESCARTÁVEL `f2a_adv_a2_*`, criado e apagado no próprio teste.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as cryptoSign } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { testToken } from '../test-setup/test-token'
import { accessAnswer, ModelProfile } from '../test-setup/access-model'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVA2'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
// F2a, etapa A3: as rotas fiscais do setes-api morreram (o app fala com a nfse-api — D-F4). As rotas de prova passam a ser as que
// FICAM no billing, com o serviço mockado (a autenticação e as guardas são o alvo aqui)
jest.mock('../modules/billing/billing.service', () => ({
  __esModule: true,
  ...jest.requireActual('../modules/billing/billing.service'),
  getOrderFiscalEffect: jest.fn(),
  getOrderCancelPlan: jest.fn(),
  cancelOrderInvoice: jest.fn(),
}))
// o RAMO do pedido vem por tabela fixa (a lógica real do resolver tem testes próprios abaixo, via requireActual)
const BRANCH: Record<number, string> = { 501: 'service-orders', 502: 'orders', 503: 'order-returns' }
jest.mock('../modules/billing/billing.interface-resolver', () => {
  const resolveOrderInterface = jest.fn(async (_s: string, _i: number, o: number) => BRANCH[o] ?? 'orders')
  return {
    __esModule: true, resolveOrderInterface,
    resolveFromBody: (req: any) => resolveOrderInterface(req.institution.schemaName, req.institution.institutionId, Number(req.body?.orderId)),
    resolveFromParam: (req: any) => resolveOrderInterface(req.institution.schemaName, req.institution.institutionId, Number(req.params?.orderId)),
  }
})

import pool from '../shared/db/connection'
import * as billingService from '../modules/billing/billing.service'
import { lockInvoice, LAST_INVOICE_EVENT_KIND_SQL } from '../shared/invoice/invoice'
import { CURRENT_RETURN_SQL } from '../shared/order-return/order-return'
import {
  requirePrivilege, requirePrivilegeFor, requireInterfaceFor, } from '../shared/auth/require-privilege'
import {
  loadJwtKeyRing, resetJwtKeyRing, assertJwtKeys, signFinalToken, signSelectionToken, verifyFinalToken,
} from '../shared/auth/product-token'
import { PRIVILEGE_CANCELAR } from '../shared/auth/privileges'
import { PRIVILEGE_NAME_BY_ID } from '../shared/access'
import { runMigrationsForSchema } from '../migrations/runner'
import app from '../app'

const q = (pool as any).query as jest.Mock
/** ADV_SHOW=1 roda os achados como `it` comum — para LER a mensagem da falha (o motivo certo, não erro de mock). */
const failing: jest.It['failing'] = process.env.ADV_SHOW === '1' ? (it as any) : it.failing
const getConn = (pool as any).getConnection as jest.Mock

// ------------------------------------------------------------------------------------------------
// banco de mentira das guardas: costura A1 da auth-api (D-AU3/D-AU6, 2026-10-31) — o veredito é a pilha de views lida pela biblioteca
// `fiscal-api/access`; o dublê (`test-setup/access-model`) responde às views a partir do catálogo, do contrato e dos vínculos abaixo
// ------------------------------------------------------------------------------------------------
const CATALOG: Record<string, number> = { orders: 29, 'service-orders': 20, 'order-returns': 31, settlements: 21 }
const KEY_OF: Record<number, string> = Object.fromEntries(Object.entries(CATALOG).map(([k, id]) => [id, k]))
let contracted: Set<number>
let privileged: Set<string>                       // `${userId}:${interfaceId}:${privilegeId}`
/** o perfil do vínculo (usuário, institution) é o do token/payload da vez — a sessão viva devolve o do token (`access-session.mock`) */
let profile: ModelProfile = 'user'
const session = <P extends { role: string }>(p: P): P => { profile = p.role as ModelProfile; return p }
function grantsOf(userId: number): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const g of privileged) {
    const [u, i, p] = g.split(':').map(Number)
    if (u !== userId || !KEY_OF[i]) continue
    ;(out[KEY_OF[i]] ??= []).push(PRIVILEGE_NAME_BY_ID[p])
  }
  return out
}
function routeDb(): void {
  q.mockImplementation(async (sql: string, params: any[] = []) => {
    // as views só conhecem a interface VIVA do catálogo central (`vw_interface_catalog`): chave fora dele não tem linha — nem para o super
    const live = Array.isArray(params[2]) ? [params[0], params[1], params[2].filter((k: string) => k in CATALOG), ...params.slice(3)] : params
    const a = accessAnswer(sql, live, (userId: number) => ({
      profile, contracted: [...contracted].map(id => KEY_OF[id]).filter(Boolean), granted: grantsOf(userId),
    }))
    if (a) return [a, []]
    throw new Error(`SQL inesperado: ${String(sql).slice(0, 90)}`)
  })
}

const SUPER = { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' }
const ADMIN = { institutionId: 2, userId: 9, role: 'admin', schemaName: 'setes_x' }
const USER = { institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' }
const bearer = (p: object) => {
  if (typeof (p as any).role === 'string') session(p as { role: string })
  return `Bearer ${testToken(p)}`
}

const ENV0 = { ...process.env }
beforeEach(() => {
  jest.clearAllMocks()
  contracted = new Set(Object.values(CATALOG)); privileged = new Set(); profile = 'user'
  routeDb()
  ;(billingService.getOrderFiscalEffect as jest.Mock).mockResolvedValue({ orderId: 502, lifeEvent: 1, invoiceCancelled: false, effect: 'none', cancelWaiver: null })
  ;(billingService.getOrderCancelPlan as jest.Mock).mockResolvedValue({ orderId: 502, cancellable: true, blocks: [] })
  ;(billingService.cancelOrderInvoice as jest.Mock).mockResolvedValue({ orderId: 501 })
})
afterEach(() => { process.env = { ...ENV0 }; resetJwtKeyRing() })

// ------------------------------------------------------------------------------------------------
// helpers de forja
// ------------------------------------------------------------------------------------------------
const b64u = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url')
const signerPem = () => fs.readFileSync(process.env.JWT_PRIVATE_KEY_PATH!, 'utf8')
/** JWT montado À MÃO (cabeçalho livre — kid não-string, alg trocado) e assinado RS256 com [keyPem]. */
function rawRs256(header: Record<string, unknown>, payload: Record<string, unknown>, keyPem = signerPem()): string {
  const input = `${b64u(header)}.${b64u(payload)}`
  return `${input}.${cryptoSign('RSA-SHA256', Buffer.from(input), keyPem).toString('base64url')}`
}
const exp = () => Math.floor(Date.now() / 1000) + 3600
const FINAL = { institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' }

/** Rota que só passa pela autenticação + licença do ramo 'orders' (contratado por padrão) e responde 200: o efeito fiscal (serviço mockado). */
const probe = (auth?: string) => {
  const r = request(app).get('/api/billing/502/fiscal-effect')
  return auth === undefined ? r : r.set('Authorization', auth)
}

// =================================================================================================
// D-F13 — JWT do produto
// =================================================================================================
describe('D-F13 — JWT RS256 com kid (ataques ao verificador)', () => {
  it('[RESISTIU] controle: token final RS256 válido passa (200) — a rota de prova é só autenticação', async () => {
    expect((await probe(bearer(FINAL))).status).toBe(200)
  })

  it('[RESISTIU] confusão de algoritmo: HS256 com a PEM PÚBLICA (e com a privada) como segredo → 401 em /api e no switch', async () => {
    const pub = createPublicKey(createPrivateKey(signerPem())).export({ type: 'spki', format: 'pem' }).toString()
    for (const secret of [pub, signerPem(), 'sua_chave_secreta_aqui']) {
      const forged = rawHs256(secret)
      expect((await probe(`Bearer ${forged}`)).status).toBe(401)
      expect((await request(app).post('/auth/switch-institution').set('Authorization', `Bearer ${forged}`).send({ institutionId: 2 })).status).toBe(401)
    }
    function rawHs256(secret: string): string {
      const input = `${b64u({ alg: 'HS256', typ: 'JWT', kid: process.env.JWT_KID })}.${b64u({ ...FINAL, exp: exp() })}`
      return `${input}.${require('crypto').createHmac('sha256', secret).update(input).digest('base64url')}`
    }
  })

  it('[RESISTIU] alg "none" (sem assinatura, com e sem kid) e alg RS512/PS256 → 401', async () => {
    for (const h of [{ alg: 'none', kid: process.env.JWT_KID }, { alg: 'none' }, { alg: 'NONE', kid: process.env.JWT_KID }]) {
      expect((await probe(`Bearer ${b64u(h)}.${b64u({ ...FINAL, exp: exp() })}.`)).status).toBe(401)
    }
    const pem = signerPem()
    for (const alg of ['RS512', 'PS256'] as const) {
      expect((await probe(`Bearer ${jwt.sign({ ...FINAL }, pem, { algorithm: alg, keyid: process.env.JWT_KID, expiresIn: '1h' })}`)).status).toBe(401)
    }
  })

  it('[RESISTIU] kid hostil — caminho, protótipo, vazio, não-string — nunca vira arquivo nem chave: 401', async () => {
    const kids: unknown[] = [
      '../../secrets/jwt/setes-api.private', '..\\..\\.env', '__proto__', 'constructor', 'hasOwnProperty', 'toString',
      '', ' ', `${process.env.JWT_KID} `, 123, true, null, [process.env.JWT_KID], { kid: process.env.JWT_KID },
    ]
    for (const kid of kids) {
      const t = rawRs256({ alg: 'RS256', typ: 'JWT', kid }, { ...FINAL, exp: exp() })
      expect([kid, (await probe(`Bearer ${t}`)).status]).toEqual([kid, 401])
    }
  })

  it('[RESISTIU] assinatura RSA VÁLIDA de outra chave com o kid certo (emissor forjado) → 401', async () => {
    const other = fs.readFileSync(process.env.TEST_JWT_OTHER_KEY_PATH!, 'utf8')
    expect((await probe(`Bearer ${rawRs256({ alg: 'RS256', kid: process.env.JWT_KID }, { ...FINAL, exp: exp() }, other)}`)).status).toBe(401)
  })

  it('[RESISTIU] marca própria: seleção não autentica /api nem /auth/switch-institution; final não serve em /auth/select-institution', async () => {
    const sel = signSelectionToken(9)
    expect((await probe(`Bearer ${sel}`)).status).toBe(401)
    expect((await request(app).post('/auth/switch-institution').set('Authorization', `Bearer ${sel}`).send({ institutionId: 2 })).status).toBe(401)
    const fin = signFinalToken(FINAL)
    const r = await request(app).post('/auth/select-institution').set('Authorization', `Bearer ${fin}`).send({ institutionId: 2 })
    expect(r.status).toBe(401)
    // seleção HÍBRIDA (scope + institutionId) — nem final nem seleção
    const hybrid = testToken({ ...FINAL, scope: 'select-institution' })
    expect((await probe(`Bearer ${hybrid}`)).status).toBe(401)
    expect((await request(app).post('/auth/select-institution').set('Authorization', `Bearer ${hybrid}`).send({ institutionId: 2 })).status).toBe(401)
  })

  it('[RESISTIU] payload com tipos trocados / fora do padrão → 401 (nunca 400/500 nem schema injetado)', async () => {
    const bad: Record<string, unknown>[] = [
      { ...FINAL, institutionId: '2' }, { ...FINAL, institutionId: 2.5 }, { ...FINAL, institutionId: 0 }, { ...FINAL, institutionId: -2 },
      { ...FINAL, institutionId: 2 ** 53 }, { ...FINAL, userId: -1 }, { ...FINAL, userId: '9' }, { ...FINAL, userId: null },
      { ...FINAL, role: '' }, { ...FINAL, role: 1 }, { ...FINAL, role: ['admin'] },
      { ...FINAL, schemaName: 'setes_x`; DROP DATABASE setes_central; --' }, { ...FINAL, schemaName: 'SETES_X' },
      { ...FINAL, schemaName: 'setes_' }, { ...FINAL, schemaName: 'information_schema' }, { ...FINAL, schemaName: ['setes_x'] },
      { ...FINAL, scope: null }, { ...FINAL, scope: '' }, { ...FINAL, scope: 'select-institution' },
      { institutionId: 2, userId: 9, role: 'user' },
    ]
    for (const p of bad) expect([p, (await probe(`Bearer ${testToken(p)}`)).status]).toEqual([p, 401])
    // claims extras não vazam para req.institution (só os 4 campos)
    expect(verifyFinalToken(testToken({ ...FINAL, isSuper: true, institution: 1, role: 'user' }))).toEqual(FINAL)
  })

  it('[RESISTIU] expirado e nbf no futuro → 401; lixo depois do token / cabeçalho null → 401', async () => {
    expect((await probe(`Bearer ${testToken(FINAL, { expiresIn: -10 })}`)).status).toBe(401)
    expect((await probe(`Bearer ${rawRs256({ alg: 'RS256', kid: process.env.JWT_KID }, { ...FINAL, exp: exp(), nbf: exp() })}`)).status).toBe(401)
    expect((await probe(`Bearer ${testToken(FINAL)} lixo`)).status).toBe(401)
    expect((await probe(`Bearer ${b64u('null')}.${b64u({ ...FINAL, exp: exp() })}.x`)).status).toBe(401)
    expect((await probe(`Bearer`)).status).toBe(401)
  })

  it('[CORRIGIDO na sessão — F2A2-ADV-07 LOW] token SEM `exp` assinado com a chave do produto vale PARA SEMPRE — o verificador não exige validade', async () => {
    const eternal = rawRs256({ alg: 'RS256', typ: 'JWT', kid: process.env.JWT_KID }, { ...FINAL })   // sem exp/iat
    expect((await probe(`Bearer ${eternal}`)).status).toBe(401)
  })

  it('[RESISTIU] boot: sem JWT_PRIVATE_KEY_PATH (só a JWT_SECRET antiga) ou com PEM CIFRADA → não sobe; e HS256 segue recusado', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-a2-'))
    try {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
      const enc = path.join(dir, 'enc.pem')
      fs.writeFileSync(enc, privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'x' }))
      expect(() => loadJwtKeyRing({ JWT_PRIVATE_KEY_PATH: enc })).toThrow(/ilegível|privada/)
      process.env = { ...ENV0, JWT_SECRET: 'segredo-antigo' }
      delete process.env.JWT_PRIVATE_KEY_PATH
      resetJwtKeyRing()
      expect(() => assertJwtKeys()).toThrow(/JWT_PRIVATE_KEY_PATH/)
      // mesmo que alguém pule o boot: o verificador NÃO cai para o segredo — HS256 com a JWT_SECRET → 401
      const hs = jwt.sign({ ...FINAL }, 'segredo-antigo', { algorithm: 'HS256', keyid: 'default', expiresIn: '1h' })
      expect((await probe(`Bearer ${hs}`)).status).toBe(401)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// =================================================================================================
// D-F37 — a licença vale para TODOS
// =================================================================================================
function res() {
  const r: any = { status: jest.fn(() => r), json: jest.fn(() => r) }
  return r
}

describe('D-F37 — licença (interface contratada) para todos', () => {
  // A-PV1 (Valdo 2026-10-18 — prompt_privilegios_interfaces.md): revê a D-F37 SÓ para o super — ele passa a licença
  // (teste próprio em require-privilege.test.ts); admin e regular seguem barrados aqui.
  it('[RESISTIU] as 3 guardas × admin/regular com a interface NÃO contratada → 403 INTERFACE_NOT_ALLOWED, sem next', async () => {
    contracted = new Set([CATALOG.settlements])          // nada do ramo contratado
    for (const inst of [ADMIN, USER]) {
      privileged.add(`${inst.userId}:${CATALOG.orders}:${PRIVILEGE_CANCELAR}`)   // vínculo "velho" não salva ninguém
      for (const guard of [
        requirePrivilege('orders', PRIVILEGE_CANCELAR),
        requirePrivilege(['service-orders', 'orders'], PRIVILEGE_CANCELAR),
        requirePrivilegeFor(PRIVILEGE_CANCELAR, async () => 'orders'),
        requireInterfaceFor(async () => 'orders'),
      ]) {
        const r = res(); const next = jest.fn()
        await guard({ institution: session(inst) } as any, r, next)
        expect([inst.role, r.status.mock.calls[0]?.[0], r.json.mock.calls[0]?.[0]?.code, next.mock.calls.length])
          .toEqual([inst.role, 403, 'INTERFACE_NOT_ALLOWED', 0])
      }
    }
  })

  it('[RESISTIU] interface fora do catálogo central (ou soft-deletada lá) → 403 INTERFACE_NOT_ALLOWED para o super (não 500, não passa)', async () => {
    const r = res(); const next = jest.fn()
    await requirePrivilegeFor(PRIVILEGE_CANCELAR, async () => 'interface-que-nao-existe')({ institution: session(SUPER) } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(403)
    expect(r.json.mock.calls[0][0].code).toBe('INTERFACE_NOT_ALLOWED')
    expect(next).not.toHaveBeenCalled()
  })

  // Costura A1 (D-AU8 — revê a D-PV29): o cache do catálogo/veredito MORREU; a licença é a `vw_user_reach` lida VIVA a cada pergunta, e
  // o contrato ATIVO e VIVO é predicado da VIEW (migration 075 — a semântica dela é provada ao vivo por `scripts/prove-user-access-views.ts`).
  it('[RESISTIU] a licença é lida VIVA a cada requisição (sem cache — D-AU8), pela chave (usuário, institution, interface); o contrato ATIVO e VIVO é predicado da view', async () => {
    for (let i = 0; i < 3; i++) await requireInterfaceFor(async () => 'orders')({ institution: session(ADMIN) } as any, res(), jest.fn())
    const reach = q.mock.calls.filter(c => /vw_user_reach/.test(String(c[0])))
    expect(reach).toHaveLength(3)
    for (const [sql, params] of reach) {
      expect(String(sql)).toMatch(/FROM `setes_x`\.vw_user_reach/)
      expect(params).toEqual([ADMIN.userId, ADMIN.institutionId, ['orders']])
    }
    expect(q.mock.calls.some(c => /tb_institution_has_interface|tb_user_has_privilege|tb_interface WHERE/.test(String(c[0])))).toBe(false)
    const view = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'sql', '075_user_access_views.sql'), 'utf8').replace(/`/g, '')
    expect(view).toMatch(/LEFT JOIN tb_institution_has_interface ihi[\s\S]*?ihi\.active = 'S' AND ihi\.deleted = 'N'/)
  })

  it('[RESISTIU] rota: admin cancelando documento do ramo service-orders NÃO contratado → 403 antes do serviço; o super passa (A-PV1)', async () => {
    contracted = new Set([CATALOG.orders])
    const r = await request(app).post('/api/billing/cancel').set('Authorization', bearer(ADMIN)).send({ orderId: 501, reason: 'teste adversarial' })
    expect([r.status, r.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    expect(billingService.cancelOrderInvoice).not.toHaveBeenCalled()
    const s = await request(app).post('/api/billing/cancel').set('Authorization', bearer(SUPER)).send({ orderId: 501, reason: 'teste adversarial' })
    expect(s.body.code).not.toBe('INTERFACE_NOT_ALLOWED')
    expect(billingService.cancelOrderInvoice).toHaveBeenCalledTimes(1)
  })

  it('[RESISTIU — F2a A3] as consultas novas (cancel-plan, fiscal-effect) exigem a LICENÇA do ramo (D-F37; o super passa — A-PV1): ramo não contratado → 403 antes do serviço', async () => {
    contracted = new Set([CATALOG.settlements])
    for (const inst of [ADMIN, USER]) {
      for (const url of ['/api/billing/501/cancel-plan', '/api/billing/501/fiscal-effect', '/api/billing/502/fiscal-effect']) {
        const r = await request(app).get(url).set('Authorization', bearer(inst))
        expect([inst.role, url, r.status, r.body.code]).toEqual([inst.role, url, 403, 'INTERFACE_NOT_ALLOWED'])
      }
    }
    expect(billingService.getOrderCancelPlan).not.toHaveBeenCalled()
    expect(billingService.getOrderFiscalEffect).not.toHaveBeenCalled()
  })


})

// (F2A2-ADV-01/01b/01c/06 e ADV-02b morreram com as rotas e o código fiscal do setes-api na A3 da F2a, `prompt_apis_fiscais_isoladas.md` §22.11)

// =================================================================================================
// D-F32 — leitores pelas views da 065
// =================================================================================================
describe('D-F32 — resolveOrderInterface / vida da nota / devolução vigente pelas views', () => {
  const real = jest.requireActual('../modules/billing/billing.interface-resolver') as typeof import('../modules/billing/billing.interface-resolver')

  it('[RESISTIU] resolveOrderInterface: id inválido não consulta; sem linha → orders; valor inesperado → orders; terminal 0 fixo; parâmetros por placeholder', async () => {
    q.mockReset()
    for (const bad of [0, -1, NaN, 1.5, Number('12abc'), Infinity]) expect(await real.resolveOrderInterface('setes_x', 2, bad)).toBe('orders')
    expect(q).not.toHaveBeenCalled()
    q.mockResolvedValueOnce([[]])
    expect(await real.resolveOrderInterface('setes_x', 2, 77)).toBe('orders')
    q.mockResolvedValueOnce([[{ k: 'ORDERS' }]])
    expect(await real.resolveOrderInterface('setes_x', 2, 77)).toBe('orders')
    q.mockResolvedValueOnce([[{ k: 'order-returns' }]])
    expect(await real.resolveOrderInterface('setes_x', 2, 78)).toBe('order-returns')
    for (const [sql, params] of q.mock.calls) {
      expect(String(sql)).toMatch(/FROM `setes_x`\.vw_order_interface\s+WHERE tb_institution_id = \? AND tb_order_id = \? AND terminal = 0/)
      expect(params).toEqual([2, expect.any(Number)])
    }
    await expect(real.resolveOrderInterface('setes_x`; --', 2, 77)).rejects.toThrow()
  })

  it('[RESISTIU] LAST_INVOICE_EVENT_KIND_SQL e CURRENT_RETURN_SQL leem a vw_invoice_life correlacionada pela linha (sem cópia de "último evento")', () => {
    const a = LAST_INVOICE_EVENT_KIND_SQL('setes_x', 'i')
    expect(a).toMatch(/FROM `setes_x`\.vw_invoice_life lv/)
    expect(a).toMatch(/lv\.tb_invoice_id = i\.id AND lv\.terminal = i\.terminal/)
    expect(a).not.toMatch(/tb_invoice_event|ORDER BY/)
    const b = CURRENT_RETURN_SQL('setes_x', 'r')
    expect(b).toMatch(/vw_invoice_life lv[\s\S]*lv\.tb_invoice_id = r\.tb_order_id[\s\S]*'E'\) <> 'C'/)
    expect(b).not.toMatch(/tb_invoice_event/)
  })

  // Fato do MariaDB 10.4.20 (provado no banco descartável — ver o bloco ao vivo abaixo): com um RETRATO do REPEATABLE READ
  // aberto ANTES da trava da nota, `vw_invoice_life ... LOCK IN SHARE MODE` lê as tabelas do JOIN em leitura CORRENTE e os
  // NOT EXISTS da view no RETRATO — a nota re-faturada no intervalo (E1, C2 → E3) devolve 4 linhas (vida × último).
  const STALE_ROWS = [
    { lifeEvent: 1, lastEvent: 2, lastKind: 'C' }, { lifeEvent: 1, lastEvent: 3, lastKind: 'E' },
    { lifeEvent: 3, lastEvent: 2, lastKind: 'C' }, { lifeEvent: 3, lastEvent: 3, lastKind: 'E' },
  ]
  it('[CORRIGIDO na sessão — F2A2-ADV-02 MEDIUM] lockInvoice com a view devolvendo VÁRIAS linhas (retrato aberto antes da trava) → 409 RESOURCE_BUSY (refazer abre retrato novo DEPOIS da trava) — nunca pega a 1ª', async () => {
    const conn: any = { query: jest.fn() }
    conn.query
      .mockResolvedValueOnce([[{ id: 20, number: '17', serie: '1', model: 'SE', value: 10, status: '0' }]])
      .mockResolvedValueOnce([STALE_ROWS])
    await expect(lockInvoice(conn, 'setes_x', 2, 20)).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
    // com a trava como 1º comando a view devolve 1 linha — o caminho normal segue igual
    conn.query
      .mockResolvedValueOnce([[{ id: 20, number: '17', serie: '1', model: 'SE', value: 10, status: '0' }]])
      .mockResolvedValueOnce([[STALE_ROWS[3]]])
    await expect(lockInvoice(conn, 'setes_x', 2, 20)).resolves.toMatchObject({ lifeEvent: 3, lastEvent: 3, lastKind: 'E' })
  })


})

// =================================================================================================
// migration 068 — número reservado × runner por VERSÃO
// =================================================================================================
describe('migration 068 — o runner decide pela VERSÃO', () => {
  it('[CORRIGIDO na sessão — F2A2-ADV-04 MEDIUM] duas migrations com o MESMO número na árvore → o boot FALHA ALTO (antes uma delas era pulada calada) — a 068 era RESERVADA ao `f2a_fiscal_passivo` (D-F110; §22.8 item 2 "combinar o número com a IB-2"): se OUTRA 068 (IB-2, árvore viva) chegar antes ao schema, a 068 da colação é PULADA calada', async () => {
    const realDir = fs.readdirSync(path.join(__dirname, '..', 'migrations', 'sql')).filter(f => f.endsWith('.sql'))
    const readdir = jest.spyOn(fs, 'readdirSync').mockReturnValue([...realDir, '068_ibscbs_outra_frente.sql'].sort() as any)
    const readFile = jest.spyOn(fs, 'readFileSync')
    const executed: string[] = []
    const conn = {
      query: jest.fn(async (sql: string) => {
        if (/SELECT version FROM _migrations/.test(sql)) return [realDir.map(f => ({ version: f.split('_')[0] })).filter(r => r.version <= '067').concat([{ version: '068' }])]
        executed.push(sql); return [[]]
      }),
      release: jest.fn(),
    }
    getConn.mockResolvedValue(conn)
    try {
      await expect(runMigrationsForSchema('setes_x')).rejects.toThrow(/MESMA versão 068/)
    } finally {
      readdir.mockRestore(); readFile.mockRestore()
    }
    expect(executed.some(s => /COLLATE utf8mb4_bin AS `interface_key`/.test(s))).toBe(false)   // nada roda
  })

  it('[CORRIGIDO na sessão — F2A2-ADV-04] a versão 068 já APLICADA com OUTRO nome (outra frente) e o arquivo daqui é outro → o boot FALHA ALTO, nada roda', async () => {
    const executed: string[] = []
    const conn = {
      query: jest.fn(async (sql: string) => {
        if (/SELECT version, name FROM _migrations/.test(sql)) return [[{ version: '067', name: 'fiscal_cancel_code_and_cancel_waiver' }, { version: '068', name: 'ibscbs_outra_frente' }]]
        executed.push(sql); return [[]]
      }),
      release: jest.fn(),
    }
    getConn.mockResolvedValue(conn)
    await expect(runMigrationsForSchema('setes_x')).rejects.toThrow(/068 foi aplicada como "ibscbs_outra_frente"/)
    expect(executed.filter(s => !/CREATE (SCHEMA|TABLE) IF NOT EXISTS|^USE /.test(s.trim()))).toEqual([])
  })
})

// =================================================================================================
// PARTE VIVA (opt-in): F2A_ADV_LIVE=1 — banco DESCARTÁVEL f2a_adv_a2_*, criado e apagado aqui
// =================================================================================================
const live = process.env.F2A_ADV_LIVE === '1'
;(live ? describe : describe.skip)('ao vivo (MariaDB do dev, banco descartável)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mysql = jest.requireActual('mysql2/promise') as typeof import('mysql2/promise')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') })
  const DB = `f2a_adv_a2_jest_${Date.now().toString(36)}`
  const cfg = () => ({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD })
  const stmts = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'migrations', 'sql', f), 'utf8')
    .replace(/--[^\n]*\n/g, '\n').split(';').map(s => s.trim()).filter(Boolean)
  let admin: any
  const opened: any[] = []
  const conn = async () => { const c = await mysql.createConnection(cfg()); opened.push(c); await c.query(`USE \`${DB}\``); return c }
  const LIFE = `SELECT life_event AS lifeEvent, last_event AS lastEvent, last_kind AS lastKind FROM vw_invoice_life
                 WHERE tb_institution_id = 1 AND tb_invoice_id = ? AND terminal = 0 LOCK IN SHARE MODE`
  const ev = (c: any, id: number, e: number, k: string) =>
    c.query(`INSERT INTO tb_invoice_event (tb_institution_id, tb_invoice_id, terminal, event, kind, dt_record, deleted) VALUES (1, ?, 0, ?, ?, '2026-10-12', 'N')`, [id, e, k])

  beforeAll(async () => {
    admin = await mysql.createConnection(cfg())
    await admin.query(`CREATE DATABASE \`${DB}\``)
    await admin.query(`USE \`${DB}\``)
    await admin.query(`CREATE TABLE tb_invoice (tb_institution_id INT NOT NULL, id INT NOT NULL, terminal INT NOT NULL DEFAULT 0,
                         deleted CHAR(1) NOT NULL DEFAULT 'N', PRIMARY KEY (id, tb_institution_id, terminal)) ENGINE=InnoDB`)
    await admin.query(`CREATE TABLE tb_invoice_event LIKE setes_setes.tb_invoice_event`)
    for (const t of ['tb_order', 'tb_service_order', 'tb_order_stock_adjust_return']) await admin.query(`CREATE TABLE \`${t}\` LIKE setes_setes.\`${t}\``)
    for (const s of stmts('065_fiscal_policy_views.sql')) await admin.query(s)
  }, 30000)
  afterAll(async () => {
    for (const c of opened) { try { await c.end() } catch { /* */ } }
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``); await admin.end() }
  })

  it('[RESISTIU — e conferido] 065 dá 1267 numa conexão general_ci; com a 068 a comparação com literal passa nas 5 colações de conexão', async () => {
    const gc = await conn(); await gc.query('SET NAMES utf8mb4 COLLATE utf8mb4_general_ci')
    await expect(gc.query(`SELECT 1 FROM vw_order_interface WHERE interface_key = 'orders'`)).rejects.toMatchObject({ errno: 1267 })
    for (const s of stmts('068_order_interface_view_bin.sql')) await admin.query(s)
    for (const names of ['utf8mb4 COLLATE utf8mb4_general_ci', 'utf8mb4 COLLATE utf8mb4_unicode_ci', 'utf8', 'latin1', 'utf8mb4 COLLATE utf8mb4_bin']) {
      const c = await conn(); await c.query(`SET NAMES ${names}`)
      await expect(c.query(`SELECT 1 FROM vw_order_interface WHERE COALESCE(interface_key, 'orders') IN ('orders')`)).resolves.toBeDefined()
    }
  })

  it('[CONHECIMENTO NEGATIVO — fato do MariaDB 10.4.20; o lockInvoice RECUSA (ADV-02 corrigido)] [ACHADO F2A2-ADV-02 — prova viva] retrato aberto por um FOR UPDATE com subconsulta (molde do latestTransmission) + re-faturamento no intervalo → a leitura "fresca" da vida devolve 4 linhas e a 1ª é velha', async () => {
    await admin.query(`INSERT INTO tb_invoice (tb_institution_id, id) VALUES (1, 40), (1, 41)`)
    await ev(admin, 40, 1, 'E'); await ev(admin, 40, 2, 'C')
    const A = await conn(), B = await conn()
    await A.query('START TRANSACTION')
    // 1º comando = FOR UPDATE com subconsulta DEPENDENTE em OUTRA linha (molde de latestTransmission(conn, …, true) + LIFE_WHERE)
    await A.query(`SELECT i.id FROM tb_invoice i WHERE i.tb_institution_id = 1 AND i.id = 41 AND i.terminal = 0 AND 0 <= COALESCE((SELECT MAX(ev.event) FROM tb_invoice_event ev
                    WHERE ev.tb_institution_id = i.tb_institution_id AND ev.tb_invoice_id = i.id AND ev.kind = 'E' AND ev.deleted = 'N'), 0) FOR UPDATE`)
    await B.query('START TRANSACTION')
    await B.query(`SELECT id FROM tb_invoice WHERE id = 40 FOR UPDATE`)
    await ev(B, 40, 3, 'E')
    await B.query('COMMIT')
    await A.query(`SELECT id FROM tb_invoice WHERE id = 40 AND tb_institution_id = 1 AND terminal = 0 AND deleted = 'N' FOR UPDATE`)
    const [rows] = await A.query(LIFE, [40])
    await A.query('ROLLBACK')
    // o motor: tabelas do JOIN na leitura CORRENTE, NOT EXISTS da view no RETRATO → várias linhas, a 1ª velha
    expect((rows as any[]).length).toBeGreaterThan(1)
    expect((rows as any[]).some(r => r.lifeEvent === 3 && r.lastEvent === 3 && r.lastKind === 'E')).toBe(true)
  })
})
