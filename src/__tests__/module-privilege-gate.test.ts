/// <reference types="jest" />
// D-PV2 (Valdo 2026-10-18 — prompt_privilegios_interfaces.md): guarda de privilégio POR ROTEADOR do módulo.
// GET → VISUALIZAR · POST → INSERIR · PUT → ALTERAR · DELETE → EXCLUIR na interface do módulo; atos de processo pelo
// marcador `privilegeAct` na rota; exceções nomeadas por `openRoute`. Licença antes do privilégio (D-F37); o super passa
// as duas (A-PV1); admin passa o privilégio; regular precisa do vínculo.
import express, { Router } from 'express'
import request from 'supertest'
import pool from '../shared/db/connection'
import logger from '../shared/logger/logger'
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import {
  gatedModule, privilegeAct, openRoute, matchModuleRoute, listGatedRoutes, PRIVILEGE_BY_METHOD,
} from '../shared/auth/module-privilege-gate'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
const mockQuery = (pool as any).query as jest.Mock

const CATALOG: Record<string, number> = { widgets: 50, partnerships: 18, 'general-configs': 11, 'interface-configs': 10 }
let contracted: Set<number>
let privileged: Set<string>                         // `${userId}:${interfaceId}:${privilegeId}`
function routeDb(): void {
  mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
    if (/FROM setes_central\.tb_interface WHERE i18n_key/.test(sql)) {
      const id = CATALOG[String(params[0])]
      return [id ? [{ id }] : []]
    }
    if (/tb_institution_has_interface/.test(sql)) return [contracted.has(Number(params[1])) ? [{ 1: 1 }] : []]
    if (/tb_user_has_privilege/.test(sql)) return [privileged.has(`${params[0]}:${params[1]}:${params[2]}`) ? [{ 1: 1 }] : []]
    throw new Error(`SQL inesperado: ${sql}`)
  })
}
const sqlCalls = (re: RegExp) => mockQuery.mock.calls.filter(c => re.test(String(c[0])))

const SUPER = { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' }
const ADMIN = { institutionId: 2, userId: 7, role: 'admin', schemaName: 'setes_x' }
const USER = { institutionId: 2, userId: 9, role: 'user', schemaName: 'setes_x' }

/** Módulo de mentira com o desenho real: CRUD pelo verbo + atos + exceção + interface trocada + interface dinâmica. */
function widgetsRouter(): Router {
  const r = Router()
  const ok = (_req: any, res: any) => res.json({ ok: true, params: _req.params })
  r.get('/', ok)
  r.get('/key/:k', openRoute('motor de toda tela'), ok)
  r.post('/', ok)
  r.post('/reversal', privilegeAct(3), ok)
  r.route('/multi').get(privilegeAct(4), ok).post(ok)                     // marcador só no GET (antes de /:id — 1º casamento vence)
  r.get('/:id', ok)
  r.put('/:id', ok)
  r.delete('/:id', ok)
  r.post('/:id/cancel', privilegeAct(7), ok)
  r.get('/:id/pdf', privilegeAct(4), ok)
  r.get('/:id/partnership', privilegeAct(6, 'partnerships'), ok)
  r.put('/:id/partnership', privilegeAct(2, 'partnerships'), ok)
  r.put('/:id/panel', privilegeAct(2, {
    possible: ['interface-configs', 'general-configs'],
    resolve: async (p) => (p.id === '11' ? ['interface-configs', 'general-configs'] : ['interface-configs']),
  }), ok)
  return r
}

let inst: any
function app() {
  const a = express()
  a.use(express.json())
  a.use((req: any, _res, next) => { req.institution = inst; next() })
  const api = Router()
  api.use('/widgets', ...gatedModule('widgets', widgetsRouter()))
  a.use('/api', api)
  return a
}

beforeEach(() => {
  jest.clearAllMocks(); resetPrivilegeCache()
  contracted = new Set(Object.values(CATALOG)); privileged = new Set()
  routeDb()
  inst = USER
})

describe('mapa do verbo (D-PV2)', () => {
  it('GET/HEAD → 6 · POST → 1 · PUT/PATCH → 2 · DELETE → 3', () => {
    expect(PRIVILEGE_BY_METHOD).toEqual({ GET: 6, HEAD: 6, POST: 1, PUT: 2, PATCH: 2, DELETE: 3 })
  })

  it.each([
    ['get', '/api/widgets', 6], ['post', '/api/widgets', 1], ['get', '/api/widgets/5', 6],
    ['put', '/api/widgets/5', 2], ['delete', '/api/widgets/5', 3],
  ] as const)('regular: %s %s exige o privilégio %i — sem ele 403 PRIVILEGE_REQUIRED, com ele passa', async (m, url, pid) => {
    const denied = await (request(app()) as any)[m](url)
    expect([denied.status, denied.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
    privileged.add(`9:50:${pid}`)
    const ok = await (request(app()) as any)[m](url)
    expect(ok.status).toBe(200)
    expect(sqlCalls(/tb_user_has_privilege/).map(c => c[1][2])).toEqual([pid, pid])
  })

  it('HEAD de uma rota GET confere VISUALIZAR', async () => {
    expect((await request(app()).head('/api/widgets/5')).status).toBe(403)
    privileged.add('9:50:6')
    expect((await request(app()).head('/api/widgets/5')).status).toBe(200)
  })

  it('privilégio de OUTRO verbo não abre a rota (ALTERAR não exclui)', async () => {
    privileged.add('9:50:2')
    expect((await request(app()).delete('/api/widgets/5')).body.code).toBe('PRIVILEGE_REQUIRED')
  })

  it('rota inexistente: confere o privilégio do verbo e só depois o 404 do Express (nunca libera por não casar)', async () => {
    expect((await request(app()).post('/api/widgets/5/nada')).status).toBe(403)
    privileged.add('9:50:1')
    expect((await request(app()).post('/api/widgets/5/nada')).status).toBe(404)
  })
})

describe('atos de processo e exceções declarados na rota', () => {
  it('privilegeAct troca o privilégio: POST /reversal = EXCLUIR, não INSERIR', async () => {
    privileged.add('9:50:1')
    expect((await request(app()).post('/api/widgets/reversal')).body.code).toBe('PRIVILEGE_REQUIRED')
    privileged.add('9:50:3')
    expect((await request(app()).post('/api/widgets/reversal')).status).toBe(200)
  })

  it('a rota de ato com parâmetro casa pela mesma regexp do Express (POST /:id/cancel = CANCELAR; GET /:id/pdf = IMPRIMIR)', async () => {
    privileged.add('9:50:7'); privileged.add('9:50:4')
    expect((await request(app()).post('/api/widgets/12/cancel')).status).toBe(200)
    expect((await request(app()).get('/api/widgets/12/pdf')).status).toBe(200)
    expect(sqlCalls(/tb_user_has_privilege/).map(c => c[1][2])).toEqual([7, 4])
  })

  it('openRoute: nenhum privilégio, nenhuma consulta de licença', async () => {
    const r = await request(app()).get('/api/widgets/key/customers')
    expect(r.status).toBe(200)
    expect(sqlCalls(/tb_institution_has_interface|tb_user_has_privilege/)).toHaveLength(0)
  })

  it('privilegeAct com outra interface: a aba Parceria confere `partnerships`, não o módulo', async () => {
    privileged.add('9:50:6'); privileged.add('9:50:2')                     // tudo no módulo — não basta
    expect((await request(app()).get('/api/widgets/3/partnership')).body.code).toBe('PRIVILEGE_REQUIRED')
    privileged.add('9:18:6')
    expect((await request(app()).get('/api/widgets/3/partnership')).status).toBe(200)
    expect((await request(app()).put('/api/widgets/3/partnership')).body.code).toBe('PRIVILEGE_REQUIRED')
    privileged.add('9:18:2')
    expect((await request(app()).put('/api/widgets/3/partnership')).status).toBe(200)
  })

  it('interface dinâmica pelos parâmetros: o painel 11 aceita general-configs; outro painel só interface-configs', async () => {
    privileged.add('9:11:2')
    expect((await request(app()).put('/api/widgets/11/panel')).status).toBe(200)
    expect((await request(app()).put('/api/widgets/40/panel')).body.code).toBe('PRIVILEGE_REQUIRED')
    privileged.add('9:10:2')
    expect((await request(app()).put('/api/widgets/40/panel')).status).toBe(200)
  })

  it('o marcador vale para o VERBO dele: router.route(x).get(privilegeAct(4)).post(h) — o POST segue INSERIR, não herda o 4', async () => {
    privileged.add('9:50:4')
    expect((await request(app()).get('/api/widgets/multi')).status).toBe(200)
    expect((await request(app()).post('/api/widgets/multi')).body.code).toBe('PRIVILEGE_REQUIRED')
    privileged.add('9:50:1')
    expect((await request(app()).post('/api/widgets/multi')).status).toBe(200)
    expect((await request(app()).head('/api/widgets/multi')).status).toBe(200)       // HEAD cai no GET (marcador do GET)
  })

  it('os params decodificados chegam ao resolvedor (o mesmo valor que o Express entrega à rota)', () => {
    const m = matchModuleRoute(widgetsRouter(), 'PUT', '/1%31/panel')
    expect(m?.params).toEqual({ id: '11' })
    expect(matchModuleRoute(widgetsRouter(), 'PATCH', '/5')).toBeNull()
  })
})

describe('perfis: licença (D-F37) × A-PV1 × admin', () => {
  it('admin passa o privilégio sem consultar vínculo — com a interface CONTRATADA', async () => {
    inst = ADMIN
    for (const [m, url] of [['get', '/api/widgets'], ['post', '/api/widgets'], ['delete', '/api/widgets/5'], ['post', '/api/widgets/9/cancel']] as const) {
      expect((await (request(app()) as any)[m](url)).status).toBe(200)
    }
    expect(sqlCalls(/tb_user_has_privilege/)).toHaveLength(0)
  })

  it('interface NÃO contratada: 403 INTERFACE_NOT_ALLOWED para admin e regular com o vínculo', async () => {
    contracted.delete(50); privileged.add('9:50:6')
    for (const who of [ADMIN, USER]) {
      inst = who
      const r = await request(app()).get('/api/widgets')
      expect([who.role, r.status, r.body.code]).toEqual([who.role, 403, 'INTERFACE_NOT_ALLOWED'])
    }
  })

  it('A-PV1: o super passa a interface NÃO contratada (sem consultar o contrato nem o vínculo)', async () => {
    contracted.clear(); inst = SUPER
    for (const [m, url] of [['get', '/api/widgets'], ['put', '/api/widgets/5'], ['get', '/api/widgets/3/partnership']] as const) {
      expect((await (request(app()) as any)[m](url)).status).toBe(200)
    }
    expect(sqlCalls(/tb_institution_has_interface|tb_user_has_privilege/)).toHaveLength(0)
  })

  it('A-PV1 não é "interface inexistente": chave fora do catálogo central nega também para o super', async () => {
    delete CATALOG.partnerships
    try {
      inst = SUPER
      const r = await request(app()).get('/api/widgets/3/partnership')
      expect([r.status, r.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    } finally { CATALOG.partnerships = 18 }
  })

  it('a negação deixa RASTRO (quem, interface, privilégio, veredito, rota) — insumo da conferência depois da janela (Q-PV23)', async () => {
    await request(app()).delete('/api/widgets/5')
    expect((logger.warn as jest.Mock).mock.calls.find(c => /Privilégio negado/.test(c[0]))?.[1]).toEqual({
      institutionId: 2, userId: 9, role: 'user', interfaces: ['widgets'], privilegeId: 3, verdict: 'no-privilege',
      method: 'DELETE', route: '/:id',
    })
  })

  it('sem JWT → 401', async () => {
    inst = undefined
    expect((await request(app()).get('/api/widgets')).status).toBe(401)
  })
})

describe('tabela das rotas guardadas (insumo da cerca D-PV9)', () => {
  it('lista cada verbo × caminho com o privilégio efetivo e a interface conferida', () => {
    const rows = listGatedRoutes().filter(r => r.moduleKey === 'widgets')
    const byRoute = Object.fromEntries(rows.map(r => [`${r.method} ${r.path}`, [r.privilegeId, r.interfaces.join('|'), r.dynamic]]))
    expect(byRoute).toEqual({
      'GET /': [6, 'widgets', false],
      'GET /key/:k': [null, 'widgets', false],
      'POST /': [1, 'widgets', false],
      'POST /reversal': [3, 'widgets', false],
      'GET /multi': [4, 'widgets', false],
      'POST /multi': [1, 'widgets', false],
      'GET /:id': [6, 'widgets', false],
      'PUT /:id': [2, 'widgets', false],
      'DELETE /:id': [3, 'widgets', false],
      'POST /:id/cancel': [7, 'widgets', false],
      'GET /:id/pdf': [4, 'widgets', false],
      'GET /:id/partnership': [6, 'partnerships', false],
      'PUT /:id/partnership': [2, 'partnerships', false],
      'PUT /:id/panel': [2, 'interface-configs|general-configs', true],
    })
  })

  it('módulo guardado com sub-roteador próprio é recusado (a guarda não o enxergaria)', () => {
    const r = Router()
    r.use('/sub', Router())
    gatedModule('com-sub', r)
    expect(() => listGatedRoutes()).toThrow(/com-sub tem sub-roteador/)
  })
})
