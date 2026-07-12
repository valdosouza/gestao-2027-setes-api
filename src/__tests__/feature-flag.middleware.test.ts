import express from 'express'
import request from 'supertest'
import { isModuleEnabled } from '../feature-flags/flag.service'
import { featureFlagMiddleware } from '../gateway/feature-flag.middleware'
import { InstitutionPayload } from '../shared/types/express'

// Mock do repositório para não depender do banco nos testes unitários
jest.mock('../feature-flags/flag.repository', () => ({
  getFlagsForInstitution: jest.fn(async (institutionId: number) => {
    if (institutionId === 2) {
      return [
        { institutionId: 2, moduleKey: 'core', enabled: true },
        { institutionId: 2, moduleKey: 'erp',  enabled: true },
      ]
    }
    if (institutionId === 4) return [] // nenhum módulo habilitado
    return [
      { institutionId: 3, moduleKey: 'core', enabled: true },
      { institutionId: 3, moduleKey: 'erp',  enabled: false },
    ]
  }),
}))

describe('flag.service', () => {
  it('institution da Setes (id 1) tem acesso a qualquer módulo', async () => {
    const result = await isModuleEnabled(1, 'erp')
    expect(result).toBe(true)
  })

  it('institution com erp habilitado retorna true', async () => {
    const result = await isModuleEnabled(2, 'erp')
    expect(result).toBe(true)
  })

  it('institution sem erp habilitado retorna false', async () => {
    const result = await isModuleEnabled(3, 'erp')
    expect(result).toBe(false)
  })

  it('módulo core está habilitado para ambas', async () => {
    expect(await isModuleEnabled(2, 'core')).toBe(true)
    expect(await isModuleEnabled(3, 'core')).toBe(true)
  })
})

// Reproduz a montagem real do app.ts: app.use('/api', featureFlagMiddleware).
// O Express remove o prefixo '/api' do req.path dentro do middleware, então
// /api/erp/status chega como /erp/status — o moduleKey é o segmento [1].
describe('featureFlagMiddleware (montado em /api, como no app.ts)', () => {
  function buildApp(institution?: InstitutionPayload) {
    const app = express()
    app.use((req, _res, next) => { req.institution = institution; next() })
    app.use('/api', featureFlagMiddleware)
    app.get('/api/erp/status', (_req, res) => { res.json({ ok: true }) })
    app.get('/api/core/menus', (_req, res) => { res.json({ ok: true }) })
    return app
  }

  const cliente = (institutionId: number): InstitutionPayload => ({
    institutionId,
    userId: 10,
    role: 'user',
    schemaName: 'setes_cliente',
  })

  it('cliente com erp habilitado acessa /api/erp/status (moduleKey = erp, não status)', async () => {
    const res = await request(buildApp(cliente(2))).get('/api/erp/status')
    expect(res.status).toBe(200)
  })

  it('cliente com erp desabilitado recebe 403 citando o módulo erp', async () => {
    const res = await request(buildApp(cliente(3))).get('/api/erp/status')
    expect(res.status).toBe(403)
    expect(res.body.error).toContain('"erp"')
  })

  it('core é isento de flag — cliente sem nenhum módulo habilitado acessa /api/core/menus', async () => {
    const res = await request(buildApp(cliente(4))).get('/api/core/menus')
    expect(res.status).toBe(200)
  })

  it('super da Setes passa direto mesmo sem flags', async () => {
    const superPayload: InstitutionPayload = {
      institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes',
    }
    const res = await request(buildApp(superPayload)).get('/api/erp/status')
    expect(res.status).toBe(200)
  })
})
