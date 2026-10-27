/// <reference types="jest" />
// D-PV36 (Valdo 2026-10-20 — prompt_privilegios_interfaces.md): a flag técnica (tb_feature_flag) MORRE para os módulos que passam
// pela guarda por roteador — o vínculo tb_institution_has_interface é a ÚNICA licença (D-F37/D-PV2). Etapa 1: o middleware ignora a
// flag nesses módulos e o onboarding não cria flag para eles. CERCA: flag sem consumidor é defeito — a lista fechada das flags do
// onboarding (`FLAG_ONLY_MODULES`) não cruza com `listGatedModules()` e todo item dela está montado no gateway.
import fs from 'fs'
import path from 'path'
import express from 'express'
import request from 'supertest'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() } }))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(false), invalidateCache: jest.fn() }))

import router from '../gateway/router'
import { listGatedModules } from '../shared/auth/module-privilege-gate'
import { featureFlagMiddleware, flagApplies, FLAG_EXEMPT_MODULES } from '../gateway/feature-flag.middleware'
import { FLAG_ONLY_MODULES } from '../modules/institutions/institutions.repository'
import { isModuleEnabled } from '../feature-flags/flag.service'

void router                                                     // montar o gateway registra as guardas
const gated = new Set(listGatedModules())
const gatewaySrc = fs.readFileSync(path.join(__dirname, '..', 'gateway', 'router.ts'), 'utf8')
const mounted = new Set([...gatewaySrc.matchAll(/^\s*router\.use\(\s*'\/([a-z0-9-]+)'/gm)].map(m => m[1]))

describe('cerca: as flags do onboarding × os módulos guardados', () => {
  it('nenhuma flag padrão é de módulo guardado (flag sem consumidor = defeito)', () => {
    expect(FLAG_ONLY_MODULES.filter(k => gated.has(k))).toEqual([])
  })
  it('toda flag padrão tem consumidor: módulo montado no gateway (ou o `core`, que o app precisa para carregar)', () => {
    expect(FLAG_ONLY_MODULES.filter(k => !mounted.has(k))).toEqual([])
    expect(FLAG_ONLY_MODULES.length).toBeGreaterThan(0)
  })
  it('a lista fechada de hoje (mudar = decidir): core, users, modules, establishment, billing, state-tax-rates', () => {
    expect([...FLAG_ONLY_MODULES].sort()).toEqual(['billing', 'core', 'establishment', 'modules', 'state-tax-rates', 'users'])
  })
  it('isento e guardado não se confundem: nenhum guardado está na lista de isentos por nome (a isenção dele é a guarda)', () => {
    // interface-fields/interface-configs eram isentos ANTES da guarda — seguem na lista histórica, mas o motivo hoje é a guarda
    for (const k of gated) if (FLAG_EXEMPT_MODULES.has(k)) expect(['interface-fields', 'interface-configs']).toContain(k)
  })
})

describe('flagApplies', () => {
  it('módulo guardado: a flag não se aplica; perfil admin/billing/state-tax-rates: aplica; isentos: não', () => {
    for (const k of ['customers', 'orders', 'bank-slips', 'institution-interfaces', 'interface-configs']) expect([k, flagApplies(k)]).toEqual([k, false])
    for (const k of ['users', 'modules', 'establishment', 'billing', 'state-tax-rates', 'erp', 'admin']) expect([k, flagApplies(k)]).toEqual([k, true])
    for (const k of ['core', 'entities', 'countries']) expect([k, flagApplies(k)]).toEqual([k, false])
  })
})

describe('featureFlagMiddleware (montado em /api como no app.ts)', () => {
  function buildApp() {
    const a = express()
    a.use((req: any, _res, next) => { req.institution = { institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' }; next() })
    a.use('/api', featureFlagMiddleware)
    a.get('/api/customers', (_req, res) => { res.json({ ok: true }) })
    a.get('/api/users', (_req, res) => { res.json({ ok: true }) })
    return a
  }
  it('módulo GUARDADO com a flag DESLIGADA passa pelo middleware sem consultar a flag (quem decide é a guarda do roteador)', async () => {
    const res = await request(buildApp()).get('/api/customers')
    expect(res.status).toBe(200)
    expect(isModuleEnabled).not.toHaveBeenCalled()
  })
  it('módulo do perfil admin (não guardado) segue pela flag: desligada = 403 MODULE_NOT_ENABLED', async () => {
    const res = await request(buildApp()).get('/api/users')
    expect([res.status, res.body.code]).toEqual([403, 'MODULE_NOT_ENABLED'])
    expect(isModuleEnabled).toHaveBeenCalledWith(2, 'users')
  })
})
