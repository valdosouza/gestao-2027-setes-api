/// <reference types="jest" />
// Gate ADVERSARIAL da D-GE4 (2026-10-18, score 0,84 — leitores latentes corrigidos, frente do grupo de estabelecimentos;
// registro no §12 do `Infra-IA/prompts/prompt_frente_grupo_estabelecimentos.md`). Os ataques que a entrega aguentou ficam
// como CERCA. O único achado acima de LOW (MEDIUM: bloco @swagger do webhook quebrado no meio da entrega) está coberto
// pela `swagger-parse.test.ts` e pelo caso SW abaixo. Mesma fixture do teste principal (`grupo-leitores-d-ge4.test.ts`).
import request from 'supertest'
import swaggerJsdoc from 'swagger-jsdoc'
import app from '../app'
import pool from '../shared/db/connection'
import { bearer } from '../test-setup/test-token'
import { swaggerOptions } from '../shared/swagger/swagger-config'
import {
  GROUP_SCHEMA, MATRIZ, FILIAL, normalizeSql, paramOf, scopedByInstitution, joinsByInstitution,
} from '../test-setup/two-institutions'
import { getMenus, getSessionInfo } from '../modules/core/core.service'
import { getRuleObservationNotes } from '../modules/billing/billing.repository'
import { setWebhookProcessor } from '../modules/bank-channel-webhook/bank-channel-webhook.routes'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
const mockQuery   = (pool as any).query as jest.Mock
const mockGetConn = (pool as any).getConnection as jest.Mock

const OTHER_SCHEMA = 'setes_outro'
const OUTRA = 50 // institution viva de OUTRO schema
const INSTITUTIONS = [
  { id: MATRIZ, name: 'Matriz Acme', schemaName: GROUP_SCHEMA },
  { id: FILIAL, name: 'Filial Acme', schemaName: GROUP_SCHEMA },
  { id: OUTRA,  name: 'Outra Ltda',  schemaName: OTHER_SCHEMA },
]
const CATALOG = [
  { id: 10, description: 'Clientes',     groupDefault: 'Comercial', kind: 'T', i18nKey: 'customers' },
  { id: 20, description: 'Fornecedores', groupDefault: 'Compras',   kind: 'T', i18nKey: 'providers' },
  { id: 30, description: 'Pedidos',      groupDefault: 'Comercial', kind: 'T', i18nKey: 'orders' },
]
const CONTRACT = [
  { tb_institution_id: MATRIZ, tb_interface_id: 10 },
  { tb_institution_id: FILIAL, tb_interface_id: 20 },
  { tb_institution_id: MATRIZ, tb_interface_id: 30 },
  { tb_institution_id: FILIAL, tb_interface_id: 30 },
]
/** tb_user_has_privilege (sem institution — latente conhecido, fora desta entrega): o usuário 9 vê 20 e 30. */
const USER_PRIV = [{ userId: 9, interfaceId: 20 }, { userId: 9, interfaceId: 30 }]
/** Módulos do GRUPO: 1 = "Vendas" [10, 30, 20] (a 20 foi vinculada pela FILIAL), 2 = "Vazio" []. */
let MODULES: Array<{ id: number; description: string; interfaceIds: number[] }> = []

const RULES = [
  { id: 5, tb_institution_id: MATRIZ, tb_observation_id: 4 },
]
const OBSERVATIONS = [
  { id: 4, tb_institution_id: FILIAL, note: 'Só a filial tem a observação 4' },
]

const TOKEN_MATRIZ = 'M'.repeat(48)
const TOKEN_FILIAL = 'F'.repeat(48)
const TOKEN_FILIAL_INATIVO = 'I'.repeat(48)
const TOKEN_FILIAL_EXCLUIDO = 'D'.repeat(48)
const TOKEN_OUTRA = 'O'.repeat(48)
const CHANNELS = [
  { tb_bank_account_id: 1, tb_institution_id: MATRIZ, inbound_token: TOKEN_MATRIZ, active: 'S', deleted: 'N', schema: GROUP_SCHEMA },
  { tb_bank_account_id: 1, tb_institution_id: FILIAL, inbound_token: TOKEN_FILIAL, active: 'S', deleted: 'N', schema: GROUP_SCHEMA },
  { tb_bank_account_id: 2, tb_institution_id: FILIAL, inbound_token: TOKEN_FILIAL_INATIVO, active: 'N', deleted: 'N', schema: GROUP_SCHEMA },
  { tb_bank_account_id: 3, tb_institution_id: FILIAL, inbound_token: TOKEN_FILIAL_EXCLUIDO, active: 'S', deleted: 'S', schema: GROUP_SCHEMA },
  { tb_bank_account_id: 1, tb_institution_id: OUTRA,  inbound_token: TOKEN_OUTRA, active: 'S', deleted: 'N', schema: OTHER_SCHEMA },
]

const iface = (id: number) => CATALOG.find(c => c.id === id)!
const menuRow = (id: number, module: { id: number; description: string } | null) => ({
  moduleId: module?.id ?? null, moduleDescription: module?.description ?? iface(id).groupDefault,
  moduleIcon: null, interfaceId: id, interfaceDescription: iface(id).description, i18nKey: iface(id).i18nKey,
})
const linked = () => new Set(MODULES.flatMap(m => m.interfaceIds))

/** Privilégio do usuário regular avaliado pelo parâmetro que o PRÓPRIO SQL liga ao `uhp.tb_user_id`. */
function privileged(t: string, params: any[], interfaceId: number): boolean {
  const user = paramOf(t, params, 'uhp.tb_user_id')
  if (user === undefined) return true
  return USER_PRIV.some(p => p.userId === Number(user) && p.interfaceId === interfaceId)
}

const sqlLog: Array<{ sql: string; params: any[] }> = []

async function fakeQuery(sql: string, params: any[] = []): Promise<[any, unknown]> {
  const t = normalizeSql(sql)
  sqlLog.push({ sql: t, params })
  if (/^(INSERT|UPDATE)\b/.test(t)) {
    const m = /^UPDATE \w+\.tb_module SET description/.exec(t)
    if (m) {
      const id = Number(params[3])
      return [{ affectedRows: MODULES.some(x => x.id === id) ? 1 : 0 }, null]
    }
    return [{ affectedRows: 1 }, null]
  }

  if (/FROM setes_central\.tb_institution i INNER JOIN setes_central\.tb_entity e/.test(t)) {
    const id = paramOf(t, params, 'i.id')
    const schema = paramOf(t, params, 'i.schema_name')
    return [INSTITUTIONS
      .filter(i => (id === undefined || i.id === Number(id)) && (schema === undefined || i.schemaName === schema))
      .map(i => ({ id: i.id, name: i.name, companyName: `${i.name} Ltda`, active: 'S' })), null]
  }
  if (/SELECT schema_name AS schemaName FROM setes_central\.tb_institution WHERE id = \?/.test(t)) {
    return [INSTITUTIONS.filter(i => i.id === Number(params[0])).map(i => ({ schemaName: i.schemaName })), null]
  }
  // D-PV34 — a marca única confere a interface viva e trava a linha do par
  if (/FROM setes_central\.tb_interface WHERE id = \? AND deleted = 'N'/.test(t)) {
    const i = CATALOG.find(c => c.id === Number(params[0]))
    return [i ? [{ id: i.id, k: i.i18nKey, kind: i.kind, groupDefault: i.groupDefault }] : [], null]
  }
  if (/FROM \w+\.tb_institution_has_interface WHERE tb_institution_id = \? AND tb_interface_id = \? FOR UPDATE/.test(t)) {
    return [CONTRACT.filter(c => c.tb_institution_id === Number(params[0]) && c.tb_interface_id === Number(params[1]))
      .map(() => ({ active: 'S', deleted: 'N' })), null]
  }
  if (/FROM setes_central\.tb_feature_flag/.test(t)) {
    return [[{ institutionId: Number(params[0]), moduleKey: 'modules', enabled: 1 }], null]
  }
  if (/FROM setes_central\.tb_entity e WHERE e\.id = \?/.test(t)) {
    return [[{ nickTrade: 'Valdo', nameCompany: null }], null]
  }

  // contrato — tela do Super
  if (/FROM setes_central\.tb_interface i LEFT JOIN \w+\.tb_institution_has_interface ihi/.test(t)) {
    const ihi = scopedByInstitution(t, params, 'ihi', CONTRACT)
    return [CATALOG.flatMap(i => {
      const hits = ihi.filter(c => c.tb_interface_id === i.id)
      const base = { id: i.id, description: i.description, groupDefault: i.groupDefault, kind: i.kind }
      return hits.length > 0 ? hits.map(() => ({ ...base, granted: 1 })) : [{ ...base, granted: 0 }]
    }), null]
  }
  // menu — telas em módulo
  if (/FROM \w+\.tb_module m INNER JOIN \w+\.tb_module_has_interface mhi/.test(t)) {
    const ihi = scopedByInstitution(t, params, 'ihi', CONTRACT)
    return [MODULES.flatMap(m => m.interfaceIds.flatMap(id =>
      ihi.filter(c => c.tb_interface_id === id && privileged(t, params, id)).map(() => menuRow(id, m)))), null]
  }
  // detalhe do módulo
  if (/FROM \w+\.tb_module m WHERE m\.id = \?/.test(t)) {
    const m = MODULES.find(x => x.id === Number(params[0]))
    return [m ? [{ id: m.id, description: m.description, position: m.id, imageIcon: null,
      interfaceIds: m.interfaceIds.join(',') || null }] : [], null]
  }
  if (/FROM \w+\.tb_institution_has_interface ihi INNER JOIN setes_central\.tb_interface i/.test(t)) {
    const ihi = scopedByInstitution(t, params, 'ihi', CONTRACT)
    if (/NOT EXISTS/.test(t)) {
      return [ihi.filter(c => !linked().has(c.tb_interface_id) && privileged(t, params, c.tb_interface_id))
        .map(c => menuRow(c.tb_interface_id, null)), null]
    }
    if (/i\.id IN \(\?\)/.test(t)) {
      const wanted = params[params.length - 1] as number[]
      return [ihi.filter(c => wanted.includes(c.tb_interface_id)).map(c => ({ id: c.tb_interface_id })), null]
    }
    return [ihi.map(c => {
      const i = iface(c.tb_interface_id)
      return { id: i.id, description: i.description, i18nKey: i.i18nKey, groupDefault: i.groupDefault }
    }), null]
  }
  if (/FROM \w+\.tb_user_has_privilege uhp INNER JOIN setes_central\.tb_privilege/.test(t)) return [[], null]
  if (/FROM setes_central\.tb_interface_has_privilege ihp/.test(t)) return [[], null]
  if (/AS nextId/.test(t)) return [[{ nextId: 3 }], null]
  if (/AS nextPos/.test(t)) return [[{ nextPos: 3 }], null]

  if (/FROM \w+\.tb_tax_rule r LEFT JOIN \w+\.tb_observation o/.test(t)) {
    const ids = params[params.length - 1] as number[]
    const same = joinsByInstitution(t, 'o', 'r')
    return [RULES.filter(r => ids.includes(r.id)).flatMap((r): Array<{ ruleId: number; note: string | null }> => {
      const hits = OBSERVATIONS.filter(o => o.id === r.tb_observation_id && (!same || o.tb_institution_id === r.tb_institution_id))
      return hits.length > 0 ? hits.map(o => ({ ruleId: r.id, note: o.note })) : [{ ruleId: r.id, note: null }]
    }), null]
  }

  if (/FROM (\w+)\.tb_bank_account_channel c/.test(t)) {
    const schema = /FROM (\w+)\.tb_bank_account_channel c/.exec(t)![1]
    const token = paramOf(t, params, 'c.inbound_token')
    const onlyLive = /c\.deleted = 'N'/.test(t)
    return [scopedByInstitution(t, params, 'c', CHANNELS)
      .filter(c => c.schema === schema && c.inbound_token === token && (!onlyLive || c.deleted === 'N'))
      .map(c => ({
        bankAccountId: c.tb_bank_account_id, institutionId: c.tb_institution_id, environment: 'S',
        clientId: 'cli', inboundToken: c.inbound_token, active: c.active, bankNumber: '077',
        accountNumber: '1', accountNumberDv: null,
      })), null]
  }
  return [[], null]
}

function fakeConn() {
  const conn = {
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    query: jest.fn(fakeQuery),
  }
  mockGetConn.mockResolvedValue(conn)
  return conn
}

const adminOf = (institutionId: number, schemaName = GROUP_SCHEMA) =>
  ({ institutionId, userId: 5, role: 'admin', schemaName })
const shape = (menus: Awaited<ReturnType<typeof getMenus>>) =>
  menus.map(m => [m.module.description, m.interfaces.map(i => i.id)])

let conn: ReturnType<typeof fakeConn>
beforeEach(() => {
  jest.clearAllMocks()
  sqlLog.length = 0
  MODULES = [
    { id: 1, description: 'Vendas', interfaceIds: [10, 30, 20] },
    { id: 2, description: 'Vazio',  interfaceIds: [] },
  ]
  mockQuery.mockImplementation(fakeQuery)
  conn = fakeConn()
})

// ── SW — contrato publicado ─────────────────────────────────────────────────────────────────────────────────────────
describe('SW — Swagger do webhook alterado', () => {
  it('a rota do webhook segue publicada no /api-docs (sem failOnErrors um bloco quebrado some em silêncio)', () => {
    const spec = swaggerJsdoc(swaggerOptions) as any
    expect(spec.paths['/hooks/bank-channel/{institutionId}/{token}']?.post).toBeDefined()
  })
})

// ── W — webhook ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('W — webhook: token só vale dentro da institution do path', () => {
  const processed: Array<{ schema: string; inst: number }> = []
  const body = [{ codigoSolicitacao: 'uuid-0001-aaaa' }]
  const flush = () => new Promise(r => setTimeout(r, 5))
  beforeAll(() => setWebhookProcessor(async (schema, inst) => { processed.push({ schema, inst }); return {} }))
  afterAll(() => setWebhookProcessor(null))
  beforeEach(() => { processed.length = 0 })

  const post = (inst: string | number, token: string) =>
    request(app).post(`/hooks/bank-channel/${inst}/${token}`).send(body)
  const strip = (h: Record<string, string>) => {
    const { date, etag, ...rest } = h
    void date; void etag
    return Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('ratelimit')))
  }

  it('token da filial na URL da matriz ≡ token desconhecido: status, corpo, cabeçalhos e nº de consultas', async () => {
    sqlLog.length = 0
    const crossed = await post(MATRIZ, TOKEN_FILIAL)
    const crossedQueries = sqlLog.length
    sqlLog.length = 0
    const unknown = await post(MATRIZ, 'Z'.repeat(48))
    const unknownQueries = sqlLog.length
    expect(crossed.status).toBe(404)
    expect(crossed.body).toEqual(unknown.body)
    expect(strip(crossed.headers)).toEqual(strip(unknown.headers))
    expect(crossedQueries).toBe(unknownQueries)
    await flush()
    expect(processed).toEqual([])
  })

  it('token de institution de OUTRO schema na URL da matriz → 404 igual; e o inverso também', async () => {
    const a = await post(MATRIZ, TOKEN_OUTRA)
    const b = await post(OUTRA, TOKEN_MATRIZ)
    const unknown = await post(MATRIZ, 'Z'.repeat(48))
    expect([a.status, b.status]).toEqual([404, 404])
    expect(a.body).toEqual(unknown.body)
    expect(b.body).toEqual(unknown.body)
    await flush()
    expect(processed).toEqual([])
  })

  it.each(['0', '-8', 'abc', '8.5', '99999999999999999999', '9007199254740993', 'NaN', 'Infinity'])(
    'institutionId inválido/gigante %s com o token da filial → 404 com o corpo do desconhecido, nada processado',
    async inst => {
      const res = await post(inst, TOKEN_FILIAL)
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'Não encontrado', code: 'NOT_FOUND' })
      await flush()
      expect(processed).toEqual([])
    })

  it('canal INATIVO e canal EXCLUÍDO da filial → 404 com o mesmo corpo', async () => {
    const inactive = await post(FILIAL, TOKEN_FILIAL_INATIVO)
    const deleted = await post(FILIAL, TOKEN_FILIAL_EXCLUIDO)
    expect([inactive.status, deleted.status]).toEqual([404, 404])
    expect(inactive.body).toEqual(deleted.body)
    await flush()
    expect(processed).toEqual([])
  })

  it('formas alternativas do MESMO id (8.0, 0x8, " 8") só alcançam o canal da própria filial (alias inofensivo)', async () => {
    for (const inst of ['8.0', '0x8', '%208']) {
      const res = await post(inst, TOKEN_FILIAL)
      expect(res.status).toBe(200)
    }
    const cross = await post('7.0', TOKEN_FILIAL)
    expect(cross.status).toBe(404)
    await flush()
    expect(processed.every(p => p.inst === FILIAL && p.schema === GROUP_SCHEMA)).toBe(true)
  })

  it('o SQL do canal liga o token e a institution aos parâmetros certos (sem troca de ordem)', async () => {
    await post(FILIAL, TOKEN_FILIAL)
    const q = sqlLog.find(s => /tb_bank_account_channel c/.test(s.sql))!
    expect(paramOf(q.sql, q.params, 'c.inbound_token')).toBe(TOKEN_FILIAL)
    expect(paramOf(q.sql, q.params, 'c.tb_institution_id')).toBe(FILIAL)
  })
})

// ── M — menu e módulos de menu ──────────────────────────────────────────────────────────────────────────────────────
describe('M — menu do grupo × contrato lido pela chave (D-GE4; do grupo pela D-GE22)', () => {
  it('usuário regular: os `?` ligam a institution ao ihi e o usuário ao uhp, nas DUAS consultas do menu', async () => {
    const regular = { institutionId: FILIAL, userId: 9, role: 'user', schemaName: GROUP_SCHEMA }
    const menus = await getMenus(regular)
    const inModule = sqlLog.find(s => /FROM \w+\.tb_module m INNER JOIN/.test(s.sql))!
    const ungrouped = sqlLog.find(s => /NOT EXISTS/.test(s.sql) && /tb_institution_has_interface ihi/.test(s.sql))!
    for (const q of [inModule, ungrouped]) {
      expect(paramOf(q.sql, q.params, 'ihi.tb_institution_id')).toBe(FILIAL)
      expect(paramOf(q.sql, q.params, 'uhp.tb_user_id')).toBe(9)
      expect((q.sql.match(/\?/g) ?? []).length).toBe(q.params.length)
    }
    // a filial contratou 20 e 30; o módulo do grupo tem as duas
    expect(shape(menus)).toEqual([['Vendas', [30, 20]]])
  })

  it('matriz: a tela 20 (contrato só da filial) não aparece no menu da matriz mesmo estando no módulo do grupo', async () => {
    expect(shape(await getMenus(adminOf(MATRIZ)))).toEqual([['Vendas', [10, 30]]])
  })

  it('interface-lookup da matriz: só 10 e 30, sem duplicar a 30 contratada pelas duas', async () => {
    const res = await request(app).get('/api/modules/interface-lookup').set('Authorization', bearer(adminOf(MATRIZ)))
    expect(res.status).toBe(200)
    expect(res.body.data.map((r: any) => r.id)).toEqual([10, 30])
  })

  it('PUT do módulo do grupo pela matriz preservando a 20 (vinculada pela filial) → 200 (grandfathering da Q5)', async () => {
    const res = await request(app).put('/api/modules/1').set('Authorization', bearer(adminOf(MATRIZ)))
      .send({ description: 'Vendas', interfaceIds: [10, 30, 20] })
    expect(res.status).toBe(200)
    const ineligible = sqlLog.filter(s => /i\.id IN \(\?\)/.test(s.sql))
    expect(ineligible.every(s => (s.params[s.params.length - 1] as number[]).length === 0 || s.params[0] === MATRIZ))
      .toBe(true)
  })

  it('PUT de OUTRO módulo pela matriz acrescentando a 20 (contrato só da filial) → 422 com o id em fields[]', async () => {
    const res = await request(app).put('/api/modules/2').set('Authorization', bearer(adminOf(MATRIZ)))
      .send({ description: 'Vazio', interfaceIds: [20] })
    expect(res.status).toBe(422)
    expect(res.body.fields).toEqual([{ field: 'interfaceIds', message: '20' }])
  })

  it('POST com a 20 pela matriz e repetindo pela filial: 422 × 201 (a elegibilidade segue o JWT, não o schema)', async () => {
    const m = await request(app).post('/api/modules').set('Authorization', bearer(adminOf(MATRIZ)))
      .send({ description: 'X', interfaceIds: [30, 20] })
    const f = await request(app).post('/api/modules').set('Authorization', bearer(adminOf(FILIAL)))
      .send({ description: 'X', interfaceIds: [30, 20] })
    expect([m.status, f.status]).toEqual([422, 201])
    expect(m.body.fields).toEqual([{ field: 'interfaceIds', message: '20' }])
  })

  it('OBSERVAÇÃO (D-GE5): a matriz consegue TIRAR do módulo do grupo a tela que só a filial contratou', async () => {
    const res = await request(app).put('/api/modules/1').set('Authorization', bearer(adminOf(MATRIZ)))
      .send({ description: 'Vendas', interfaceIds: [10, 30] })
    expect(res.status).toBe(200) // por desenho: o menu é do grupo — a 20 volta ao agrupamento padrão no menu da filial
  })

  it('neutralidade: com UMA institution no schema o menu é o mesmo do leitor antigo (sem filtro)', async () => {
    const single = { institutionId: OUTRA, userId: 5, role: 'admin', schemaName: OTHER_SCHEMA }
    const before = CONTRACT.splice(0, CONTRACT.length)
    CONTRACT.push({ tb_institution_id: OUTRA, tb_interface_id: 10 }, { tb_institution_id: OUTRA, tb_interface_id: 20 })
    try {
      expect(shape(await getMenus(single))).toEqual([['Vendas', [10, 20]]])
    } finally {
      CONTRACT.splice(0, CONTRACT.length, ...before)
    }
  })
})

// ── A — tela do Super ───────────────────────────────────────────────────────────────────────────────────────────────
describe('A — tela do Super num schema com duas institutions', () => {
  const superToken = () => bearer({ institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' })

  it('GET /api/admin/institutions/8/interfaces → o contratado da filial, sem duplicar a 30', async () => {
    const res = await request(app).get(`/api/admin/institutions/${FILIAL}/interfaces`).set('Authorization', superToken())
    expect(res.status).toBe(200)
    expect(res.body.data.map((r: any) => [r.id, r.granted])).toEqual([[10, false], [20, true], [30, true]])
  })

  it('PUT /api/admin/institutions/8/interfaces/30 {linked:false} revoga SÓ a linha da filial (D-PV34 — a matriz fica intacta)', async () => {
    const res = await request(app).put(`/api/admin/institutions/${FILIAL}/interfaces/30`).set('Authorization', superToken())
      .send({ linked: false })
    expect(res.status).toBe(200)
    const writes = conn.query.mock.calls.filter(c => /^UPDATE/.test(normalizeSql(String(c[0]))))
    expect(writes).toHaveLength(1)
    expect(normalizeSql(String(writes[0][0]))).toMatch(/WHERE tb_institution_id = \? AND tb_interface_id = \?$/)
    expect(writes[0][1]).toEqual([FILIAL, 30])
  })
})

// ── C — /api/core/info e /me ────────────────────────────────────────────────────────────────────────────────────────
describe('C — /api/core/info e /me com JWT incoerente (institution × schema)', () => {
  it('JWT da filial com schema de OUTRO grupo: não devolve dado de ninguém (o antigo devolveria a 1ª linha do schema)', async () => {
    const res = await request(app).get('/api/core/info').set('Authorization', bearer(adminOf(FILIAL, OTHER_SCHEMA)))
    expect(JSON.stringify(res.body)).not.toMatch(/Acme|Outra/)
    expect(res.status).not.toBe(200)
  })

  it('/me com o mesmo JWT incoerente → 200 com institutionName null (sem nome da outra)', async () => {
    const info = await getSessionInfo(adminOf(FILIAL, OTHER_SCHEMA))
    expect(info.institutionName).toBeNull()
    const outra = await getSessionInfo({ institutionId: OUTRA, userId: 5, role: 'admin', schemaName: GROUP_SCHEMA })
    expect(outra.institutionName).toBeNull()
  })
})

// ── O — observação fiscal da regra ──────────────────────────────────────────────────────────────────────────────────
describe('O — observação da regra pela PK inteira', () => {
  it('regra da matriz apontando uma observação que só existe na filial → sem observação (nunca o texto da filial)', async () => {
    const notes = await getRuleObservationNotes(GROUP_SCHEMA, [5, 5, 5])
    expect(notes.get(5)).toBeNull()
    expect(notes.size).toBe(1)
  })
})
