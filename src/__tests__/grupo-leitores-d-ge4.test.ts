/// <reference types="jest" />
// Frente do GRUPO de estabelecimentos — D-GE4 (Valdo, 2026-10-18: "siga as recomendações"): os quatro leitores
// com defeito LATENTE do inventário (`prompt_frente_grupo_estabelecimentos-inventario.md` §2 A3/A4/A6/B8) —
// inofensivos com 1 institution por schema, vazam quando matriz e filial dividem o schema — corrigidos JÁ, sem DDL.
// Cada bloco põe DUAS institutions no MESMO schema (`test-setup/two-institutions`: o pool falso devolve as linhas
// das duas e só aplica o filtro de institution que o PRÓPRIO SQL expressa) e fixa o que cada uma enxerga.
// Escrito ANTES da correção (skill testar-adversarial — achado confirmado vira teste): vermelho em f53a618.
// Pela superfície que NÃO muda de assinatura (serviço/HTTP), para o mesmo teste provar o antes e o depois.
// ⚠️ Contratos DIFERENTES para matriz e filial não são estado de negócio (D-GE22: o contrato é do GRUPO) — são a
// forma de provar que o leitor escopa pela CHAVE e nunca lê o schema inteiro; na onda 1 a chave passa a ser a do grupo.
import request from 'supertest'
import app from '../app'
import pool from '../shared/db/connection'
import { bearer } from '../test-setup/test-token'
import {
  GROUP_SCHEMA, MATRIZ, FILIAL, normalizeSql, paramOf, scopedByInstitution, joinsByInstitution,
} from '../test-setup/two-institutions'
import { accessAnswer, AccessModel } from '../test-setup/access-model'
import { getInstitutionInterfaces, setInstitutionInterface } from '../modules/admin/admin.service'
import { getMenus, getSessionInfo } from '../modules/core/core.service'
import { getRuleObservationNotes } from '../modules/billing/billing.repository'
import { setWebhookProcessor } from '../modules/bank-channel-webhook/bank-channel-webhook.routes'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
const mockQuery   = (pool as any).query as jest.Mock
const mockGetConn = (pool as any).getConnection as jest.Mock

// ── O schema `setes_acme` com a matriz (7) e a filial (8) ──────────────────────────────────────────────────────
const INSTITUTIONS = [
  { id: MATRIZ, name: 'Matriz Acme', schemaName: GROUP_SCHEMA },
  { id: FILIAL, name: 'Filial Acme', schemaName: GROUP_SCHEMA },
]
/** setes_central.tb_interface — três telas vendáveis, fora do grupo Super. */
const CATALOG = [
  { id: 10, description: 'Clientes',     groupDefault: 'Comercial', kind: 'T', i18nKey: 'customers' },
  { id: 20, description: 'Fornecedores', groupDefault: 'Compras',   kind: 'T', i18nKey: 'providers' },
  { id: 30, description: 'Pedidos',      groupDefault: 'Comercial', kind: 'T', i18nKey: 'orders' },
]
/** tb_institution_has_interface — 10 só da matriz, 20 só da filial, 30 das duas. */
const CONTRACT = [
  { tb_institution_id: MATRIZ, tb_interface_id: 10 },
  { tb_institution_id: FILIAL, tb_interface_id: 20 },
  { tb_institution_id: MATRIZ, tb_interface_id: 30 },
  { tb_institution_id: FILIAL, tb_interface_id: 30 },
]
/** tb_module + tb_module_has_interface — do GRUPO (D-GE5): um módulo "Vendas" com as telas 10 e 30. */
const MENU = { id: 1, description: 'Vendas', icon: 'store', interfaceIds: [10, 30] }
/** tb_tax_rule (PK = id do schema) e tb_observation (PK = id + institution). */
const RULES = [
  { id: 5, tb_institution_id: MATRIZ, tb_observation_id: 1 },
  { id: 6, tb_institution_id: FILIAL, tb_observation_id: 1 },
  { id: 9, tb_institution_id: FILIAL, tb_observation_id: 3 },
]
const OBSERVATIONS = [
  { id: 1, tb_institution_id: MATRIZ, note: 'Texto da matriz' },
  { id: 1, tb_institution_id: FILIAL, note: 'Texto da filial' },
  { id: 3, tb_institution_id: MATRIZ, note: 'Só a matriz tem a observação 3' },
]
/** tb_bank_account_channel — a conta 1 de cada uma (o id da conta é MAX+1 POR institution). */
const TOKEN_MATRIZ = 'M'.repeat(48)
const TOKEN_FILIAL = 'F'.repeat(48)
const CHANNELS = [
  { tb_bank_account_id: 1, tb_institution_id: MATRIZ, inbound_token: TOKEN_MATRIZ },
  { tb_bank_account_id: 1, tb_institution_id: FILIAL, inbound_token: TOKEN_FILIAL },
]

const iface = (id: number) => CATALOG.find(c => c.id === id)!
/** tb_user_has_privilege — o usuário regular 9 tem VISUALIZAR nas três telas (quem recorta o menu dele é o contrato da CHAVE). */
let REGULAR_GRANTS: Record<string, string[]> = {}
/**
 * Costura A1 (D-AU3/D-AU6, 2026-10-31): o veredito — e o recorte do menu — é a `vw_user_access` lida pela CHAVE (usuário, institution).
 * O dublê responde pela institution que a PRÓPRIA leitura liga ao `tb_institution_id = ?`: o contrato dela (CONTRACT), nunca o do schema.
 */
function accessModelOf(userId: number, institutionId: number): AccessModel | null {
  if (!INSTITUTIONS.some(i => i.id === institutionId)) return null
  const contracted = CONTRACT.filter(c => c.tb_institution_id === institutionId).map(c => iface(c.tb_interface_id).i18nKey)
  const interfaceIds = Object.fromEntries(CATALOG.map(c => [c.i18nKey, c.id]))
  if (userId === 5) return { profile: 'admin', contracted, interfaceIds }
  if (userId === 9) return { profile: 'user', contracted, granted: REGULAR_GRANTS, interfaceIds }
  return null
}
const menuRow = (id: number, module: typeof MENU | null) => ({
  moduleId: module?.id ?? null, moduleDescription: module?.description ?? iface(id).groupDefault,
  moduleIcon: module?.icon ?? null, interfaceId: id, interfaceDescription: iface(id).description,
  i18nKey: iface(id).i18nKey,
})

/** O "MySQL" do schema: cada leitor recebe o que o SEU SQL pede — com ou sem o filtro de institution. */
async function fakeQuery(sql: string, params: any[] = []): Promise<[any, unknown]> {
  const t = normalizeSql(sql)
  if (/^(INSERT|UPDATE)\b/.test(t)) return [{ affectedRows: 1 }, null]
  const access = accessAnswer(sql, params, accessModelOf)
  if (access) return [access, null]

  // setes_central.tb_institution (core: info da institution; admin/webhook: schema do alvo)
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
  if (/FROM setes_central\.tb_feature_flag/.test(t)) {
    return [[{ institutionId: Number(params[0]), moduleKey: 'modules', enabled: 1 }], null]
  }
  if (/FROM setes_central\.tb_entity e WHERE e\.id = \?/.test(t)) {
    return [[{ nickTrade: 'Valdo', nameCompany: null }], null]
  }

  // A3 — contrato de interfaces
  if (/FROM setes_central\.tb_interface i LEFT JOIN \w+\.tb_institution_has_interface ihi/.test(t)) {
    const ihi = scopedByInstitution(t, params, 'ihi', CONTRACT)
    return [CATALOG.flatMap(i => {
      const hits = ihi.filter(c => c.tb_interface_id === i.id)
      const base = { id: i.id, description: i.description, groupDefault: i.groupDefault, kind: i.kind }
      return hits.length > 0 ? hits.map(() => ({ ...base, granted: 1 })) : [{ ...base, granted: 0 }]
    }), null]
  }
  // menu (costura A1): o repositório só dá o ARRANJO do grupo — módulos × telas e as telas sem módulo, sem contrato nem privilégio
  if (/FROM \w+\.tb_module m INNER JOIN \w+\.tb_module_has_interface mhi/.test(t)) {
    return [MENU.interfaceIds.map(id => menuRow(id, MENU)), null]
  }
  if (/FROM setes_central\.tb_interface i WHERE .*NOT EXISTS \(SELECT 1 FROM \w+\.tb_module_has_interface mhi/.test(t)) {
    return [CATALOG.filter(c => !MENU.interfaceIds.includes(c.id)).map(c => menuRow(c.id, null)), null]
  }
  if (/FROM \w+\.tb_institution_has_interface ihi INNER JOIN setes_central\.tb_interface i/.test(t)) {
    const ihi = scopedByInstitution(t, params, 'ihi', CONTRACT)
    if (/i\.id IN \(\?\)/.test(t)) {
      const wanted = params[params.length - 1] as number[]
      return [ihi.filter(c => wanted.includes(c.tb_interface_id)).map(c => ({ id: c.tb_interface_id })), null]
    }
    return [ihi.map(c => {
      const i = iface(c.tb_interface_id)
      return { id: i.id, description: i.description, i18nKey: i.i18nKey, groupDefault: i.groupDefault }
    }), null]
  }
  // D-PV34 — a marca única confere a interface viva e trava a linha do par (aqui inexistente)
  if (/FROM setes_central\.tb_interface WHERE id = \? AND deleted = 'N'/.test(t)) {
    const i = CATALOG.find(c => c.id === Number(params[0]))
    return [i ? [{ id: i.id, k: i.i18nKey, kind: i.kind, groupDefault: i.groupDefault }] : [], null]
  }
  if (/FROM \w+\.tb_institution_has_interface WHERE tb_institution_id = \? AND tb_interface_id = \? FOR UPDATE/.test(t)) {
    return [CONTRACT.filter(c => c.tb_institution_id === Number(params[0]) && c.tb_interface_id === Number(params[1]))
      .map(() => ({ active: 'S', deleted: 'N' })), null]
  }
  if (/AS nextId/.test(t)) return [[{ nextId: 2 }], null]
  if (/AS nextPos/.test(t)) return [[{ nextPos: 1 }], null]

  // A4 — observação fiscal da regra
  if (/FROM \w+\.tb_tax_rule r LEFT JOIN \w+\.tb_observation o/.test(t)) {
    const ids = params[params.length - 1] as number[]
    const sameInstitution = joinsByInstitution(t, 'o', 'r')
    return [RULES.filter(r => ids.includes(r.id)).flatMap((r): Array<{ ruleId: number; note: string | null }> => {
      const hits = OBSERVATIONS.filter(o => o.id === r.tb_observation_id
        && (!sameInstitution || o.tb_institution_id === r.tb_institution_id))
      return hits.length > 0
        ? hits.map(o => ({ ruleId: r.id, note: o.note }))
        : [{ ruleId: r.id, note: null }]
    }), null]
  }

  // A6 — canal bancário achado pelo token do webhook
  if (/FROM \w+\.tb_bank_account_channel c/.test(t)) {
    const token = paramOf(t, params, 'c.inbound_token')
    return [scopedByInstitution(t, params, 'c', CHANNELS)
      .filter(c => c.inbound_token === token)
      .map(c => ({
        bankAccountId: c.tb_bank_account_id, institutionId: c.tb_institution_id, environment: 'S',
        clientId: 'cli', inboundToken: c.inbound_token, active: 'S', bankNumber: '077',
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

const adminOf = (institutionId: number) =>
  ({ institutionId, userId: 5, role: 'admin', schemaName: GROUP_SCHEMA })
const shape = (menus: Awaited<ReturnType<typeof getMenus>>) =>
  menus.map(m => [m.module.description, m.interfaces.map(i => i.id)])

let conn: ReturnType<typeof fakeConn>
beforeEach(() => {
  jest.clearAllMocks()
  REGULAR_GRANTS = { customers: ['VISUALIZAR'], providers: ['VISUALIZAR'], orders: ['VISUALIZAR'] }
  mockQuery.mockImplementation(fakeQuery)
  conn = fakeConn()
})
/** Parâmetros de cada leitura da `vw_user_access` (o recorte do menu) — a CHAVE (usuário, institution) da sessão. */
const accessReads = () => mockQuery.mock.calls
  .filter(c => /vw_user_access/.test(String(c[0]))).map(c => c[1])

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('A3 — contrato de interfaces lido pela institution do escopo', () => {
  it('tela do Super: o "contratado" é o da institution ALVO — sem o da outra, sem duplicar a tela das duas', async () => {
    const matriz = await getInstitutionInterfaces(MATRIZ)
    expect(matriz).toHaveLength(CATALOG.length)
    expect(Object.fromEntries(matriz.map(g => [g.id, g.granted]))).toEqual({ 10: true, 20: false, 30: true })

    const filial = await getInstitutionInterfaces(FILIAL)
    expect(filial).toHaveLength(CATALOG.length)
    expect(Object.fromEntries(filial.map(g => [g.id, g.granted]))).toEqual({ 10: false, 20: true, 30: true })
  })

  it('marcar uma tela na matriz grava SÓ a linha da matriz (D-PV34: uma marca por vez — a lista inteira saiu)', async () => {
    const change = await setInstitutionInterface(MATRIZ, 20, true)
    expect(change).toEqual({ interfaceId: 20, linked: true, changed: true })

    const lock = conn.query.mock.calls.find(c => /FOR UPDATE/.test(String(c[0]))) as any[]
    expect(lock[1]).toEqual([MATRIZ, 20])
    const insert = conn.query.mock.calls.find(c => /INSERT INTO/.test(String(c[0]))) as any[]
    expect(insert[1]).toEqual([MATRIZ, 20])
  })

  it('menu do admin: o menu do GRUPO filtrado pelo contrato lido pela CHAVE da sessão (D-GE5/D-GE4)', async () => {
    expect(shape(await getMenus(adminOf(MATRIZ)))).toEqual([['Vendas', [10, 30]]])
    expect(shape(await getMenus(adminOf(FILIAL)))).toEqual([['Vendas', [30]], ['Compras', [20]]])
    // costura A1: o recorte é UMA leitura da view por menu, pela chave da sessão — nunca o contrato do schema inteiro
    expect(accessReads()).toEqual([[5, MATRIZ], [5, FILIAL]])
  })

  it('menu do usuário regular: mesmo recorte, com o filtro de privilégio junto (a mesma leitura da view, pela chave da sessão)', async () => {
    const regular = { institutionId: FILIAL, userId: 9, role: 'user', schemaName: GROUP_SCHEMA }
    // VISUALIZAR nas três; a 10 (contrato só da matriz) fica fora pelo contrato da CHAVE
    expect(shape(await getMenus(regular))).toEqual([['Vendas', [30]], ['Compras', [20]]])
    expect(accessReads()).toEqual([[9, FILIAL]])
    // sem o VISUALIZAR de Pedidos, a 30 sai — o privilégio filtra junto
    REGULAR_GRANTS = { providers: ['VISUALIZAR'] }
    expect(shape(await getMenus(regular))).toEqual([['Compras', [20]]])
  })

  it('Menus — telas elegíveis ao vínculo: só o contrato da chave do JWT, sem duplicar', async () => {
    const res = await request(app).get('/api/modules/interface-lookup')
      .set('Authorization', bearer(adminOf(FILIAL)))
    expect(res.status).toBe(200)
    expect(res.body.data.map((r: any) => r.id).sort()).toEqual([20, 30])
  })

  it('Menus — vincular a tela que só a OUTRA institution contratou → 422 (não contratada AQUI)', async () => {
    const refused = await request(app).post('/api/modules')
      .set('Authorization', bearer(adminOf(MATRIZ)))
      .send({ description: 'Compras', interfaceIds: [20] })
    expect(refused.status).toBe(422)
    expect(refused.body.fields).toEqual([{ field: 'interfaceIds', message: '20' }])

    const accepted = await request(app).post('/api/modules')
      .set('Authorization', bearer(adminOf(FILIAL)))
      .send({ description: 'Compras', interfaceIds: [20, 30] })
    expect(accepted.status).toBe(201)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('A4 — observação fiscal da regra juntada pela PK inteira (id + institution da REGRA)', () => {
  it('cada regra leva o texto da PRÓPRIA institution; id que só existe na outra = sem observação', async () => {
    const notes = await getRuleObservationNotes(GROUP_SCHEMA, [5, 6, 9])
    expect(notes.get(5)).toBe('Texto da matriz')
    expect(notes.get(6)).toBe('Texto da filial')
    expect(notes.get(9)).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('A6 — webhook do banco confere a institution da URL', () => {
  const processed: Array<{ schema: string; inst: number; codes: string[] }> = []
  const flush = () => new Promise(r => setTimeout(r, 5))
  const body = [{ codigoSolicitacao: 'uuid-0001-aaaa' }]
  beforeAll(() => setWebhookProcessor(async (schema, inst, codes) => { processed.push({ schema, inst, codes }); return {} }))
  afterAll(() => setWebhookProcessor(null))
  beforeEach(() => { processed.length = 0 })

  it('token da FILIAL na URL da MATRIZ → a MESMA resposta do token desconhecido; nada processado', async () => {
    const crossed = await request(app).post(`/hooks/bank-channel/${MATRIZ}/${TOKEN_FILIAL}`).send(body)
    const unknown = await request(app).post(`/hooks/bank-channel/${MATRIZ}/${'Z'.repeat(48)}`).send(body)
    expect(crossed.status).toBe(404)
    expect(crossed.body).toEqual(unknown.body)
    await flush()
    expect(processed).toEqual([])
  })

  it('token de cada uma na PRÓPRIA URL → processa sob a institution dona do canal', async () => {
    expect((await request(app).post(`/hooks/bank-channel/${FILIAL}/${TOKEN_FILIAL}`).send(body)).status).toBe(200)
    expect((await request(app).post(`/hooks/bank-channel/${MATRIZ}/${TOKEN_MATRIZ}`).send(body)).status).toBe(200)
    await flush()
    expect(processed).toEqual([
      { schema: GROUP_SCHEMA, inst: FILIAL, codes: ['uuid-0001-aaaa'] },
      { schema: GROUP_SCHEMA, inst: MATRIZ, codes: ['uuid-0001-aaaa'] },
    ])
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B8 — /api/core/info e /api/core/me pela institution do JWT (o schema não identifica a institution)', () => {
  it('GET /api/core/info da filial devolve a FILIAL (não a 1ª linha do schema)', async () => {
    const res = await request(app).get('/api/core/info').set('Authorization', bearer(adminOf(FILIAL)))
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: FILIAL, name: 'Filial Acme' })
  })

  it('/me: o nome da institution é o da sessão', async () => {
    expect((await getSessionInfo(adminOf(FILIAL))).institutionName).toBe('Filial Acme')
    expect((await getSessionInfo(adminOf(MATRIZ))).institutionName).toBe('Matriz Acme')
  })
})
