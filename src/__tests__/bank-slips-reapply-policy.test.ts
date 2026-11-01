/// <reference types="jest" />
// D-PV27 (Valdo 2026-10-20 — prompt_privilegios_interfaces.md, fecha a Q-PV22 = (b)): "reaplicar a voz do banco" exige o privilégio
// do EFEITO reaplicado — ALTERAR quando a voz é R (liquidação), CANCELAR quando é C/V (cancelamento) — decidido pela voz do evento
// ANTES de executar; a rota é aberta por nome na guarda e a POLÍTICA do controller decide. Princípio: o verbo nomeia a finalidade.
// D-PV40: `refresh` por boleto e `/refresh` (passada) = CONSULTAR (12); `register`/`pay-sandbox` = TRANSMITIR (9).
import request from 'supertest'
import { bearer } from '../test-setup/test-token'
import { accessAnswer, AccessModel } from '../test-setup/access-model'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() } }))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({ __esModule: true, newCrashRef: jest.fn(() => 'REF'), recordCrash: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../modules/bank-slips/bank-slips.registration.service', () => {
  const { HttpError } = jest.requireActual('../shared/errors/http-error')
  return {
    __esModule: true,
    registerSlip: jest.fn(async () => ({ slipId: 5, attempt: 1 })),
    refreshSlip: jest.fn(async () => ({ slipId: 5, attempt: 1, changed: false })),
    refreshAll: jest.fn(async () => ({ checked: 0, changed: 0, reconciled: 0, errors: [], stoppedEarly: false })),
    fetchSlipPdf: jest.fn(async () => ({ pdfBase64: 'QUJD', requestCode: 'x' })),
    paySandbox: jest.fn(async () => ({ slipId: 5, attempt: 1, changed: true })),
    peekReapplyEvent: jest.fn(async (_id: number, _attempt: number, event: number) => {
      if (event === 404) throw new HttpError(404, 'Evento não encontrado', undefined, 'BANK_SLIP_REGISTRATION_EVENT_NOT_FOUND')
      return { attempt: 1, event, kind: EVENT_KIND[event] ?? 'S' }
    }),
    reapplyEffect: jest.fn(async (id: number, attempt: number, event: number) => ({ slipId: id, attempt, event, reapplyEvent: 9, slipEvent: 3 })),
  }
})
// voz do evento por número: 1 = R (recebido → L), 2 = C (cancelado → C), 3 = V (expirado → C), 4 = S (sem efeito)
const EVENT_KIND: Record<number, string> = { 1: 'R', 2: 'C', 3: 'V', 4: 'S' }

import pool from '../shared/db/connection'
import { listGatedRoutes } from '../shared/auth/module-privilege-gate'
import * as reg from '../modules/bank-slips/bank-slips.registration.service'
import { reapplyPrivilegeFor, reapplyEffectVerdict } from '../modules/bank-slips/bank-slips.reapply-policy'
import { PRIVILEGE_ALTERAR, PRIVILEGE_CANCELAR, PRIVILEGE_CONSULTAR, PRIVILEGE_TRANSMITIR } from '../shared/auth/privileges'
import { PRIVILEGE_NAME_BY_ID } from '../shared/access'
import app from '../app'

const q = (pool as any).query as jest.Mock
/** concessões (ids do catálogo) do usuário regular 9 na tela de boletos */
let granted: Set<number>
// costura A1 (D-AU3): o veredito lê as views — a tela de boletos CONTRATADA para a institution 2; o 7 é admin, o 9 regular com as
// concessões de `granted` (o verbo pelo NOME — D-PV53)
const accessModel = (userId: number, institutionId: number): AccessModel | null => {
  if (institutionId !== 2) return null
  if (userId === 7) return { profile: 'admin', contracted: ['bank-slips'] }
  if (userId === 9) return { profile: 'user', contracted: ['bank-slips'], granted: { 'bank-slips': [...granted].map(id => PRIVILEGE_NAME_BY_ID[id]) } }
  return null
}
beforeEach(() => {
  jest.clearAllMocks()
  granted = new Set()
  q.mockImplementation(async (sql: string, params: any[] = []) => {
    const a = accessAnswer(sql, params, accessModel)
    if (a) return [a, []]
    return [[]]
  })
})
const USER = bearer({ institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' })
const ADMIN = bearer({ institutionId: 2, userId: 7, role: 'admin', schemaName: 'setes_x' })
const grant = (...privs: number[]) => privs.forEach(p => granted.add(p))
const reapply = (token: string, event: number) => request(app).post('/api/bank-slips/5/reapply').set('Authorization', token).send({ attempt: 1, event })

describe('mapa do efeito → privilégio', () => {
  it('R → ALTERAR; C e V → CANCELAR; voz sem efeito → o mais exigente (CANCELAR) — a peça recusa de todo jeito', () => {
    expect(reapplyPrivilegeFor('R')).toBe(PRIVILEGE_ALTERAR)
    expect(reapplyPrivilegeFor('C')).toBe(PRIVILEGE_CANCELAR)
    expect(reapplyPrivilegeFor('V')).toBe(PRIVILEGE_CANCELAR)
    expect(reapplyPrivilegeFor('S')).toBe(PRIVILEGE_CANCELAR)
    expect(reapplyPrivilegeFor(null)).toBe(PRIVILEGE_CANCELAR)
  })
  it('o veredito confere o par na tela de boletos', async () => {
    const inst = { institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' }
    expect((await reapplyEffectVerdict(inst, { kind: 'R' })).verdict).toBe('no-privilege')
    grant(PRIVILEGE_ALTERAR)
    expect(await reapplyEffectVerdict(inst, { kind: 'R' })).toMatchObject({ verdict: 'ok', privilegeId: PRIVILEGE_ALTERAR, interfaces: ['bank-slips'] })
    expect((await reapplyEffectVerdict(inst, { kind: 'C' })).verdict).toBe('no-privilege')
  })
})

describe('POST /api/bank-slips/:id/reapply pela borda real (guarda aberta por nome + política no controller)', () => {
  it('na guarda do roteador a rota pede só VISUALIZAR (chegar ao boleto); o EFEITO é da política — nenhuma rota de boleto é aberta', () => {
    const rows = listGatedRoutes().filter(r => r.moduleKey === 'bank-slips')
    expect(rows.filter(r => r.privilegeId === null)).toEqual([])
    expect(rows.find(r => r.method === 'POST' && r.path === '/:id/reapply')!.privilegeId).toBe(6)
  })
  it('quem não tem nem VISUALIZAR em boletos não sonda a existência do evento (403 da guarda antes do 404)', async () => {
    const r = await reapply(USER, 404)
    expect([r.status, r.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
    expect(reg.peekReapplyEvent).not.toHaveBeenCalled()
  })
  it('regular só com VISUALIZAR: 403 PRIVILEGE_REQUIRED e NADA executado (a voz foi lida, o efeito não)', async () => {
    grant(6)
    const r = await reapply(USER, 1)
    expect([r.status, r.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
    expect(reg.peekReapplyEvent).toHaveBeenCalledTimes(1)
    expect(reg.reapplyEffect).not.toHaveBeenCalled()
  })
  it('voz R (liquidação): ALTERAR basta; CANCELAR sozinho não serve', async () => {
    grant(6, PRIVILEGE_CANCELAR)
    expect((await reapply(USER, 1)).status).toBe(403)
    grant(PRIVILEGE_ALTERAR)
    const ok = await reapply(USER, 1)
    expect([ok.status, ok.body.data.slipEvent]).toEqual([201, 3])
    expect(reg.reapplyEffect).toHaveBeenCalledTimes(1)
  })
  it('voz C e V (cancelamento): CANCELAR basta; ALTERAR sozinho não serve', async () => {
    grant(6, PRIVILEGE_ALTERAR)
    expect((await reapply(USER, 2)).status).toBe(403)
    expect((await reapply(USER, 3)).status).toBe(403)
    grant(PRIVILEGE_CANCELAR)
    expect((await reapply(USER, 2)).status).toBe(201)
    expect((await reapply(USER, 3)).status).toBe(201)
  })
  it('TRANSMITIR não abre mais o reaplicar (A-PV7 emendada pela D-PV27)', async () => {
    grant(6, PRIVILEGE_TRANSMITIR, PRIVILEGE_CONSULTAR)
    expect((await reapply(USER, 1)).status).toBe(403)
    expect((await reapply(USER, 2)).status).toBe(403)
    expect(reg.reapplyEffect).not.toHaveBeenCalled()
  })
  it('admin passa o privilégio do efeito; evento inexistente → 404 sem executar (para quem já vê a tela)', async () => {
    expect((await reapply(ADMIN, 2)).status).toBe(201)
    grant(6)
    const r = await reapply(USER, 404)
    expect(r.status).toBe(404)
    expect(reg.reapplyEffect).toHaveBeenCalledTimes(1)
  })
})

describe('D-PV40 — consultar ≠ transmitir nos boletos', () => {
  const at = (method: string, path: string) => listGatedRoutes().find(r => r.moduleKey === 'bank-slips' && r.method === method && r.path === path)!.privilegeId
  it('refresh (por boleto e passada) = CONSULTAR; register e pay-sandbox = TRANSMITIR', () => {
    expect(at('POST', '/refresh')).toBe(PRIVILEGE_CONSULTAR)
    expect(at('POST', '/:id/refresh')).toBe(PRIVILEGE_CONSULTAR)
    expect(at('POST', '/:id/register')).toBe(PRIVILEGE_TRANSMITIR)
    expect(at('POST', '/:id/pay-sandbox')).toBe(PRIVILEGE_TRANSMITIR)
  })
  it('pela borda: TRANSMITIR não consulta e CONSULTAR não registra', async () => {
    grant(PRIVILEGE_TRANSMITIR)
    expect((await request(app).post('/api/bank-slips/5/refresh').set('Authorization', USER)).status).toBe(403)
    expect((await request(app).post('/api/bank-slips/5/register').set('Authorization', USER)).status).toBe(201)
    granted.clear(); grant(PRIVILEGE_CONSULTAR)
    expect((await request(app).post('/api/bank-slips/5/refresh').set('Authorization', USER)).status).toBe(200)
    expect((await request(app).post('/api/bank-slips/refresh').set('Authorization', USER).send({})).status).toBe(200)
    expect((await request(app).post('/api/bank-slips/5/register').set('Authorization', USER)).status).toBe(403)
  })
})
