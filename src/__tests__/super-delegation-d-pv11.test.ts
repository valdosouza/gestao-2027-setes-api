/// <reference types="jest" />
// D-PV10/D-PV11 (Valdo 2026-10-18 — prompt_privilegios_interfaces.md): a Setes é cliente como os outros e só o SUPER tem tudo; a tela
// "Interfaces dos clientes" (vínculo estabelecimento × interfaces) é delegável pelo Super a usuário da Setes — por usuário, só o Super
// libera (até o admin da Setes precisa estar marcado), o liberado não mexe na própria Setes, e só essa tela é delegável.
import express, { Router } from 'express'
import request from 'supertest'
import { bearer } from '../test-setup/test-token'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFD11'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))

import pool from '../shared/db/connection'
import { gatedModule } from '../shared/auth/module-privilege-gate'
import { PRIVILEGE_NAME_BY_ID } from '../shared/access'
import { accessAnswer, AccessModel, ModelProfile } from '../test-setup/access-model'
import app from '../app'

const q = (pool as any).query as jest.Mock
const getConn = (pool as any).getConnection as jest.Mock
let granted: Set<string>                                              // `${schema}:${userId}:${privilegeId}` na delegável
let contractedKeys: string[]                                          // licença viva das institutions (a delegável fica FORA dela por construção)
let saved: Array<{ institutionId: number; ids: number[] }>
/** Vínculo vivo (`vw_user_link`): o 31 tem kind 'super' na institution 7 — fora da Setes a view dá 'user'. */
const LINKS: Record<string, ModelProfile> = { '1:1': 'super', '2:1': 'admin', '9:1': 'user', '30:7': 'admin', '31:7': 'user' }
const SCHEMA_OF: Record<number, string> = { 1: 'setes_setes', 7: 'setes_cliente' }
function modelFor(userId: number, institutionId: number): AccessModel | null {
  const profile = LINKS[`${userId}:${institutionId}`]
  const schema = SCHEMA_OF[institutionId]
  if (!profile || !schema) return null
  const verbs = [...granted].filter(g => g.startsWith(`${schema}:${userId}:`)).map(g => PRIVILEGE_NAME_BY_ID[Number(g.split(':')[2])])
  return { profile, vendor: institutionId === 1, contracted: contractedKeys, granted: { 'institution-interfaces': verbs } }
}
const viewReads = (view: 'access' | 'reach') => q.mock.calls.filter(c => new RegExp(`vw_user_${view}`).test(String(c[0]))).map(c => c[1])
const conn = {
  beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  query: jest.fn(async (sql: string, params: any[]) => {
    if (/INSERT INTO `setes_\w+`\.tb_institution_has_interface/.test(sql)) saved.push({ institutionId: params[0], ids: [params[1]] })   // D-PV34: uma marca
    return [[]]
  }),
}

beforeEach(() => {
  jest.clearAllMocks();  granted = new Set(); contractedKeys = ['customers']; saved = []
  getConn.mockResolvedValue(conn)
  q.mockImplementation(async (sql: string, params: any[] = []) => {
    const a = accessAnswer(sql, params, modelFor)                       // o veredito (costura A1): as views
    if (a) return [a, []]
    if (/FROM setes_central\.tb_institution i\s+INNER JOIN setes_central\.tb_entity/.test(sql)) return [[{ id: 7, name: 'Cliente X', active: 'S' }]]
    if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: 1 }]]
    if (/SELECT schema_name AS schemaName/.test(sql)) return [[{ schemaName: params[0] === 1 ? 'setes_setes' : 'setes_cliente' }]]
    if (/SELECT id, i18n_key AS k, kind, group_default AS groupDefault\s+FROM setes_central\.tb_interface WHERE id = \?/.test(sql)) {
      const id = Number(params[0]); return [id < 100 ? [{ id, k: id === 9 ? 'customers' : `iface-${id}`, kind: 'T', groupDefault: 'Registers' }] : []]
    }
    if (/LEFT JOIN `setes_\w+`\.tb_institution_has_interface/.test(sql)) return [[{ id: 9, description: 'Clientes', groupDefault: 'Cadastros', kind: 'T', granted: 1 }]]
    return [[]]
  })
})

const SUPER = bearer({ institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' })
const SETES_ADMIN = bearer({ institutionId: 1, userId: 2, role: 'admin', schemaName: 'setes_setes' })
const SETES_USER = bearer({ institutionId: 1, userId: 9, role: 'user', schemaName: 'setes_setes' })
const OTHER_ADMIN = bearer({ institutionId: 7, userId: 30, role: 'admin', schemaName: 'setes_cliente' })
const FAKE_SUPER = bearer({ institutionId: 7, userId: 31, role: 'super', schemaName: 'setes_cliente' })

describe('guarda DELEGADA da tela "Interfaces dos clientes"', () => {
  it('o super passa sempre — sem contrato nem concessão; uma leitura da vw_user_access por requisição, sem ler o motivo', async () => {
    contractedKeys = []
    expect((await request(app).get('/api/institution-interfaces').set('Authorization', SUPER)).status).toBe(200)
    expect((await request(app).put('/api/institution-interfaces/7/interfaces/9').set('Authorization', SUPER).send({ linked: true })).status).toBe(200)
    expect(viewReads('access')).toEqual([[1, 1, ['institution-interfaces'], 'VISUALIZAR'], [1, 1, ['institution-interfaces'], 'ALTERAR']])
    expect(viewReads('reach')).toEqual([])
  })

  it('D-PV11 (b): o ADMIN da Setes SEM a liberação do Super é barrado (exceção à regra "admin passa o privilégio") — nem a licença abre', async () => {
    contractedKeys = ['customers', 'institution-interfaces']           // a tela vinculada ao contrato da Setes NÃO conta (fora da licença)
    const r = await request(app).get('/api/institution-interfaces').set('Authorization', SETES_ADMIN)
    expect([r.status, r.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
  })

  it('com a liberação: VISUALIZAR abre a lista e o detalhe; ALTERAR é preciso para gravar (admin ou usuário comum) — sem licença', async () => {
    contractedKeys = []                                                 // a licença não entra: nada contratado, só a concessão do Super
    for (const [token, userId] of [[SETES_ADMIN, 2], [SETES_USER, 9]] as const) {
      granted = new Set([`setes_setes:${userId}:6`])
      expect((await request(app).get('/api/institution-interfaces').set('Authorization', token)).status).toBe(200)
      expect((await request(app).get('/api/institution-interfaces/7').set('Authorization', token)).status).toBe(200)
      expect((await request(app).put('/api/institution-interfaces/7/interfaces/9').set('Authorization', token).send({ linked: true })).body.code)
        .toBe('PRIVILEGE_REQUIRED')
      granted.add(`setes_setes:${userId}:2`)
      expect((await request(app).put('/api/institution-interfaces/7/interfaces/9').set('Authorization', token).send({ linked: true })).status).toBe(200)
    }
    expect(saved).toEqual([{ institutionId: 7, ids: [9] }, { institutionId: 7, ids: [9] }])   // D-PV34: uma marca por chamada
  })

  it('D-PV11 (c): o usuário liberado NÃO mexe nas interfaces da PRÓPRIA Setes (só o Super) e nem a vê na lista', async () => {
    granted = new Set(['setes_setes:2:6', 'setes_setes:2:2'])
    const r = await request(app).put('/api/institution-interfaces/1/interfaces/9').set('Authorization', SETES_ADMIN).send({ linked: true })
    expect([r.status, r.body.code]).toEqual([403, 'SETES_INTERFACES_SUPER_ONLY'])
    // D-PV38: nem LER
    expect((await request(app).get('/api/institution-interfaces/1').set('Authorization', SETES_ADMIN)).body.code).toBe('SETES_INTERFACES_SUPER_ONLY')
    expect(saved).toEqual([])
    await request(app).get('/api/institution-interfaces').set('Authorization', SETES_ADMIN)
    const listSql = q.mock.calls.find(c => /FROM setes_central\.tb_institution i\s+INNER JOIN/.test(String(c[0])) && /LIMIT/.test(String(c[0])))!
    expect(listSql[1].slice(0, 2)).toEqual([1, 1])                                             // exclui a institution 1
    expect((await request(app).put('/api/institution-interfaces/1/interfaces/9').set('Authorization', SUPER).send({ linked: true })).status).toBe(200)
  })

  it('a tela não existe para os clientes: admin de outra institution (mesmo com vínculo no schema dele e a tela no contrato) e "super" fora da Setes → 403', async () => {
    granted = new Set(['setes_cliente:30:6', 'setes_cliente:31:6'])
    contractedKeys = ['customers', 'institution-interfaces']
    for (const token of [OTHER_ADMIN, FAKE_SUPER]) {
      const r = await request(app).get('/api/institution-interfaces').set('Authorization', token)
      expect([r.status, r.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    }
  })

  it('interface fora do catálogo → 400 no campo interfaceId, nada gravado (D-PV34)', async () => {
    const r = await request(app).put('/api/institution-interfaces/7/interfaces/500').set('Authorization', SUPER).send({ linked: true })
    expect([r.status, r.body.code, r.body.fields?.[0]?.field]).toEqual([400, 'VALIDATION_FAILED', 'interfaceId'])
    expect(saved).toEqual([])
  })

  it('D-PV11 (d): montar como delegável uma tela que NÃO está na lista lança na montagem', () => {
    expect(() => gatedModule('institutions', Router(), { delegatedSuper: true })).toThrow(/DELEGABLE_SUPER_INTERFACES/)
    void express
  })
})
