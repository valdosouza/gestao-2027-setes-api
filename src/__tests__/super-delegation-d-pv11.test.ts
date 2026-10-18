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
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import { gatedModule } from '../shared/auth/module-privilege-gate'
import app from '../app'

const q = (pool as any).query as jest.Mock
const getConn = (pool as any).getConnection as jest.Mock
const IFACE = 41                                                      // id de 'institution-interfaces' no dublê
let granted: Set<string>                                              // `${schema}:${userId}:${privilegeId}`
let contractQueries: number
let saved: Array<{ institutionId: number; ids: number[] }>
const conn = {
  beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  query: jest.fn(async (sql: string, params: any[]) => {
    if (/INSERT INTO `setes_\w+`\.tb_institution_has_interface/.test(sql)) saved.push({ institutionId: params[0][0][0], ids: params[0].map((v: any[]) => v[1]) })
    return [[]]
  }),
}

beforeEach(() => {
  jest.clearAllMocks(); resetPrivilegeCache()
  granted = new Set(); contractQueries = 0; saved = []
  getConn.mockResolvedValue(conn)
  q.mockImplementation(async (sql: string, params: any[] = []) => {
    if (/FROM setes_central\.tb_interface WHERE i18n_key/.test(sql)) return [params[0] === 'institution-interfaces' ? [{ id: IFACE }] : []]
    if (/tb_institution_has_interface/.test(sql) && !/LEFT JOIN/.test(sql)) { contractQueries++; return [[]] }   // nada contratado
    if (/tb_user_has_privilege/.test(sql) && /tb_privilege_id = \?/.test(sql)) {
      const schema = /`(setes_\w+)`/.exec(sql)?.[1]
      return [granted.has(`${schema}:${params[0]}:${params[2]}`) && params[1] === IFACE ? [{ 1: 1 }] : []]
    }
    if (/FROM setes_central\.tb_institution i\s+INNER JOIN setes_central\.tb_entity/.test(sql)) return [[{ id: 7, name: 'Cliente X', active: 'S' }]]
    if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: 1 }]]
    if (/SELECT schema_name AS schemaName/.test(sql)) return [[{ schemaName: params[0] === 1 ? 'setes_setes' : 'setes_cliente' }]]
    if (/SELECT id FROM setes_central\.tb_interface WHERE deleted = 'N' AND id IN/.test(sql)) return [params[0].filter((id: number) => id < 100).map((id: number) => ({ id }))]
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
  it('o super passa sempre — sem consultar contrato nem vínculo', async () => {
    expect((await request(app).get('/api/institution-interfaces').set('Authorization', SUPER)).status).toBe(200)
    expect((await request(app).put('/api/institution-interfaces/7').set('Authorization', SUPER).send({ interfaceIds: [9] })).status).toBe(200)
    expect(contractQueries).toBe(0)
  })

  it('D-PV11 (b): o ADMIN da Setes SEM a liberação do Super é barrado (exceção à regra "admin passa o privilégio")', async () => {
    const r = await request(app).get('/api/institution-interfaces').set('Authorization', SETES_ADMIN)
    expect([r.status, r.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
  })

  it('com a liberação: VISUALIZAR abre a lista e o detalhe; ALTERAR é preciso para gravar (admin ou usuário comum)', async () => {
    for (const [token, userId] of [[SETES_ADMIN, 2], [SETES_USER, 9]] as const) {
      granted = new Set([`setes_setes:${userId}:6`])
      expect((await request(app).get('/api/institution-interfaces').set('Authorization', token)).status).toBe(200)
      expect((await request(app).get('/api/institution-interfaces/7').set('Authorization', token)).status).toBe(200)
      expect((await request(app).put('/api/institution-interfaces/7').set('Authorization', token).send({ interfaceIds: [9] })).body.code)
        .toBe('PRIVILEGE_REQUIRED')
      granted.add(`setes_setes:${userId}:2`)
      expect((await request(app).put('/api/institution-interfaces/7').set('Authorization', token).send({ interfaceIds: [9, 9] })).status).toBe(200)
    }
    expect(saved).toEqual([{ institutionId: 7, ids: [9] }, { institutionId: 7, ids: [9] }])   // repetidos tirados
    expect(contractQueries).toBe(0)                                                            // a licença não entra
  })

  it('D-PV11 (c): o usuário liberado NÃO mexe nas interfaces da PRÓPRIA Setes (só o Super) e nem a vê na lista', async () => {
    granted = new Set(['setes_setes:2:6', 'setes_setes:2:2'])
    const r = await request(app).put('/api/institution-interfaces/1').set('Authorization', SETES_ADMIN).send({ interfaceIds: [9] })
    expect([r.status, r.body.code]).toEqual([403, 'SETES_INTERFACES_SUPER_ONLY'])
    expect(saved).toEqual([])
    await request(app).get('/api/institution-interfaces').set('Authorization', SETES_ADMIN)
    const listSql = q.mock.calls.find(c => /FROM setes_central\.tb_institution i\s+INNER JOIN/.test(String(c[0])) && /LIMIT/.test(String(c[0])))!
    expect(listSql[1].slice(0, 2)).toEqual([1, 1])                                             // exclui a institution 1
    expect((await request(app).put('/api/institution-interfaces/1').set('Authorization', SUPER).send({ interfaceIds: [9] })).status).toBe(200)
  })

  it('a tela não existe para os clientes: admin de outra institution (mesmo com vínculo no schema dele) e "super" fora da Setes → 403', async () => {
    granted = new Set(['setes_cliente:30:6', 'setes_cliente:31:6'])
    for (const token of [OTHER_ADMIN, FAKE_SUPER]) {
      const r = await request(app).get('/api/institution-interfaces').set('Authorization', token)
      expect([r.status, r.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    }
  })

  it('interface fora do catálogo → 400 no campo interfaceIds, nada gravado', async () => {
    const r = await request(app).put('/api/institution-interfaces/7').set('Authorization', SUPER).send({ interfaceIds: [9, 500] })
    expect([r.status, r.body.code, r.body.fields?.[0]?.field]).toEqual([400, 'VALIDATION_FAILED', 'interfaceIds'])
    expect(saved).toEqual([])
  })

  it('D-PV11 (d): montar como delegável uma tela que NÃO está na lista lança na montagem', () => {
    expect(() => gatedModule('institutions', Router(), { delegatedSuper: true })).toThrow(/DELEGABLE_SUPER_INTERFACES/)
    void express
  })
})
