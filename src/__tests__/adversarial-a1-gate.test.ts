/// <reference types="jest" />
// GATE testar-adversarial do delta do PASSO 4 (bloco de privilégios + costura A1 da frente auth-api — D-AU3/D-AU6/D-AU8/D-AU12, D-EA7,
// D-PV48, D-PV58; Infra-IA/prompts/prompt_frente_auth_api.md §5; skill Infra-IA/skills-genericas/testar-adversarial.md). 2026-10-31.
//   [RESISTIU] = `it` que passa (a defesa segurou);
//   [ACHADO]   = a asserção SEGURA — nasceu `it.failing` (o código de então a quebrava) e virou `it` com a correção (2026-11-01);
// Banco DUBLADO aqui; o comportamento REAL do MariaDB (PAD SPACE do utf8mb4_bin, sombra do curinga do GRANT, corrida da 1ª senha) foi
// provado em banco/usuários DESCARTÁVEIS por `scripts/adv-a1-probe.ts` (grant · views · race).
//
// Diferente da suíte: aqui a SESSÃO é a REAL (`jest.requireActual('@shared/access')` — o setup global a dubla para todo o resto), lida
// pela biblioteca única `fiscal-api/access` contra o dublê do pool.
import fs from 'fs'
import path from 'path'
import request from 'supertest'
import { testToken } from '../test-setup/test-token'

jest.mock('@shared/access', () => jest.requireActual('@shared/access'))
jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADV'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))

import pool from '../shared/db/connection'
import app from '../app'
import { accessVerdict } from '@shared/access'
import { privilegeCatalogViolations, privilegeCatalogProblems } from '../shared/auth/privilege-catalog'
import { PRIVILEGE_FATURAR } from '../shared/auth/privileges'

const q = (pool as any).query as jest.Mock

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const SESSION_RE = /FROM setes_central\.vw_user_link WHERE tb_user_id = \? AND tb_institution_id = \? AND schema_name = \? AND \(password_set_at IS NULL OR password_set_at <= \?\) LIMIT 2/

/** O "banco": vínculos vivos por (usuário, institution) — perfil, schema e o instante da senha (D-EA7). */
interface LinkRow { profile: string; vendor: 'S' | 'N'; schema: string; passwordSetAt: string | null; rows?: number }
let links: Record<string, LinkRow>
let sessionReads: any[][]
let dbDown: boolean

function answer(sql: string, params: any[] = []): any {
  const t = norm(sql)
  if (SESSION_RE.test(t)) {
    sessionReads.push(params)
    if (dbDown) { const e: any = new Error('connect ECONNREFUSED 127.0.0.1:3306'); e.code = 'ECONNREFUSED'; e.errno = -4078; throw e }
    const l = links[`${params[0]}:${params[1]}`]
    if (!l || l.schema !== params[2]) return [[], []]
    if (l.passwordSetAt !== null && !(l.passwordSetAt <= String(params[3]))) return [[], []]   // DATETIME × literal 'YYYY-MM-DD HH:MM:SS'
    const row = { profile: l.profile, vendor: l.vendor }
    return [Array.from({ length: l.rows ?? 1 }, () => row), []]
  }
  // login/seleção: vínculos vivos pela view (getInstitutionsForUser)
  if (/FROM setes_central\.vw_user_link l INNER JOIN setes_central\.tb_entity e/.test(t)) {
    const out = Object.entries(links).filter(([k]) => k.startsWith(`${params[0]}:`))
      .map(([k, l]) => ({ institutionId: Number(k.split(':')[1]), schemaName: l.schema, name: 'X', profile: l.profile }))
    return [out, []]
  }
  return [[], []]
}

beforeEach(() => {
  links = {}
  sessionReads = []
  dbDown = false
  q.mockReset()
  q.mockImplementation(async (sql: string, params?: any[]) => answer(sql, params))
  ;(pool as any).getConnection.mockImplementation(async () => ({
    query: async (sql: string, params?: any[]) => answer(sql, params), release: () => undefined,
    beginTransaction: async () => undefined, commit: async () => undefined, rollback: async () => undefined,
  }))
})

const tok = (p: object, iat?: number) => `Bearer ${testToken(iat === undefined ? p : { ...p, iat })}`
const SETES_USER = { institutionId: 1, userId: 9, schemaName: 'setes_setes' }
const CLIENT_ADMIN = { institutionId: 7, userId: 30, schemaName: 'setes_cliente' }

describe('[RESISTIU] autorização com token legítimo e perfil adulterado/antigo — o perfil VIVO manda', () => {
  it("role 'super' no token de um usuário da Setes cujo vínculo vivo é 'user' → superGuard nega (403)", async () => {
    links['9:1'] = { profile: 'user', vendor: 'S', schema: 'setes_setes', passwordSetAt: null }
    const r = await request(app).get('/api/interfaces').set('Authorization', tok({ ...SETES_USER, role: 'super' }))
    expect(r.status).toBe(403)
    expect(sessionReads).toHaveLength(1)
  })

  it("role 'admin' no token, vínculo vivo 'user' (rebaixado depois do login) → adminGuard nega na hora", async () => {
    links['30:7'] = { profile: 'user', vendor: 'N', schema: 'setes_cliente', passwordSetAt: null }
    const r = await request(app).get('/api/users').set('Authorization', tok({ ...CLIENT_ADMIN, role: 'admin' }))
    expect(r.status).toBe(403)
  })

  it('o /api/core/me devolve o PERFIL VIVO, não o do token (promoção e rebaixamento valem na hora)', async () => {
    links['30:7'] = { profile: 'admin', vendor: 'N', schema: 'setes_cliente', passwordSetAt: null }
    const r = await request(app).get('/api/core/me').set('Authorization', tok({ ...CLIENT_ADMIN, role: 'user' }))
    expect([r.status, r.body.data?.role]).toEqual([200, 'admin'])
  })

  it('schemaName trocado no token (a institution 7 apontando o schema da Setes) → 401 SESSION_REVOKED', async () => {
    links['30:7'] = { profile: 'admin', vendor: 'N', schema: 'setes_cliente', passwordSetAt: null }
    const r = await request(app).get('/api/core/me').set('Authorization', tok({ ...CLIENT_ADMIN, schemaName: 'setes_setes', role: 'admin' }))
    expect([r.status, r.body.code]).toEqual([401, 'SESSION_REVOKED'])
  })

  it('institutionId trocado (vínculo inexistente com a institution 1) → 401 SESSION_REVOKED', async () => {
    links['30:7'] = { profile: 'admin', vendor: 'N', schema: 'setes_cliente', passwordSetAt: null }
    const r = await request(app).get('/api/core/me').set('Authorization', tok({ userId: 30, institutionId: 1, schemaName: 'setes_setes', role: 'super' }))
    expect([r.status, r.body.code]).toEqual([401, 'SESSION_REVOKED'])
  })

  it('vínculo inativado/credencial inativa/estabelecimento inativo (a view não traz a linha) → 401 SESSION_REVOKED em rota aberta', async () => {
    const r = await request(app).get('/api/core/menus').set('Authorization', tok({ ...CLIENT_ADMIN, role: 'admin' }))
    expect([r.status, r.body.code]).toEqual([401, 'SESSION_REVOKED'])
  })

  it('a view devolvendo DUAS linhas (adulterada) ou perfil fora do domínio → 401 (falha fechada)', async () => {
    links['30:7'] = { profile: 'admin', vendor: 'N', schema: 'setes_cliente', passwordSetAt: null, rows: 2 }
    const two = await request(app).get('/api/core/me').set('Authorization', tok({ ...CLIENT_ADMIN, role: 'admin' }))
    links['30:7'] = { profile: 'Admin', vendor: 'N', schema: 'setes_cliente', passwordSetAt: null }
    const caps = await request(app).get('/api/core/me').set('Authorization', tok({ ...CLIENT_ADMIN, role: 'admin' }))
    links['30:7'] = { profile: 'root', vendor: 'N', schema: 'setes_cliente', passwordSetAt: null }
    const root = await request(app).get('/api/core/me').set('Authorization', tok({ ...CLIENT_ADMIN, role: 'admin' }))
    expect([two.status, caps.status, root.status]).toEqual([401, 401, 401])
  })

  it('iat fracionário, zero, negativo ou texto (exp válido) → 401 sem ler a sessão', async () => {
    links['30:7'] = { profile: 'admin', vendor: 'N', schema: 'setes_cliente', passwordSetAt: null }
    const now = Math.floor(Date.now() / 1000)
    const key = fs.readFileSync(process.env.JWT_PRIVATE_KEY_PATH!, 'utf8')
    // assinatura "à mão" (o jsonwebtoken recusa iat não numérico no sign): só quem tem a chave privada forja — a forma tem de ser recusada
    const raw = (iat: unknown) => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
      const head = b64({ alg: 'RS256', typ: 'JWT', kid: process.env.JWT_KID })
      const body = b64({ ...CLIENT_ADMIN, role: 'admin', iat, exp: now + 3600 })
      const sig = require('crypto').createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url')
      return `Bearer ${head}.${body}.${sig}`
    }
    const statuses: number[] = []
    for (const iat of [now + 0.5, 0, -5, String(now), null]) {
      statuses.push((await request(app).get('/api/core/me').set('Authorization', raw(iat))).status)
    }
    statuses.push((await request(app).get('/api/core/me').set('Authorization', raw(now))).status)   // controle: o mesmo token com iat inteiro passa
    expect(statuses).toEqual([401, 401, 401, 401, 401, 200])
    expect(sessionReads).toHaveLength(1)
  })
})

describe('[RESISTIU] D-EA7 — a troca de senha derruba o token anterior (final e de SELEÇÃO); fronteira do segundo', () => {
  // T recente (o `exp` do jsonwebtoken sai de iat + TTL: um T fixo no passado venceria o token)
  const T_SEC = Math.floor(Date.now() / 1000) - 20
  const T = new Date(T_SEC * 1000).toISOString().slice(0, 19).replace('T', ' ')

  it('token final com iat = T-1 → 401 SESSION_REVOKED; iat = T → vale (limite conhecido fixado)', async () => {
    links['30:7'] = { profile: 'admin', vendor: 'N', schema: 'setes_cliente', passwordSetAt: T }
    const before = await request(app).get('/api/core/me').set('Authorization', tok({ ...CLIENT_ADMIN, role: 'admin' }, T_SEC - 1))
    const same = await request(app).get('/api/core/me').set('Authorization', tok({ ...CLIENT_ADMIN, role: 'admin' }, T_SEC))
    expect([before.status, before.body.code, same.status]).toEqual([401, 'SESSION_REVOKED', 200])
    expect(sessionReads.map(p => p[3])).toEqual([new Date((T_SEC - 1) * 1000).toISOString().slice(0, 19).replace('T', ' '), T])
  })

  it('token de SELEÇÃO emitido antes da troca de senha não cunha o token final', async () => {
    links['30:7'] = { profile: 'admin', vendor: 'N', schema: 'setes_cliente', passwordSetAt: T }
    links['30:8'] = { profile: 'user', vendor: 'N', schema: 'setes_outro', passwordSetAt: T }
    const sel = testToken({ userId: 30, scope: 'select-institution', iat: T_SEC - 5 }, { expiresIn: '5m' })
    const r = await request(app).post('/auth/select-institution').set('Authorization', `Bearer ${sel}`).send({ institutionId: 7 })
    expect(r.status).toBe(401)
    expect(r.body.token).toBeUndefined()
    // controle: o token de seleção emitido DEPOIS da troca cunha
    const fresh = testToken({ userId: 30, scope: 'select-institution', iat: T_SEC + 1 }, { expiresIn: '5m' })
    const ok = await request(app).post('/auth/select-institution').set('Authorization', `Bearer ${fresh}`).send({ institutionId: 7 })
    expect([ok.status, typeof ok.body.token]).toEqual([200, 'string'])
  })

  it('o switch-institution com token ANTERIOR à troca não troca (o middleware barra antes)', async () => {
    links['30:7'] = { profile: 'admin', vendor: 'N', schema: 'setes_cliente', passwordSetAt: T }
    links['30:8'] = { profile: 'user', vendor: 'N', schema: 'setes_outro', passwordSetAt: T }
    const r = await request(app).post('/auth/switch-institution')
      .set('Authorization', tok({ ...CLIENT_ADMIN, role: 'admin' }, T_SEC - 1)).send({ institutionId: 8 })
    expect([r.status, r.body.code]).toEqual([401, 'SESSION_REVOKED'])
  })
})

describe('[ACHADO LOW] o 401 da seleção perde o código SESSION_REVOKED (envelope do Framework de Mensagens)', () => {
  // `auth.routes.fail` responde só `{ error }` — o `code` que `issueForInstitution` pôs no HttpError (SESSION_REVOKED) não chega ao app;
  // o middleware das rotas /api devolve `{ error, code }`. Mesma causa, dois envelopes.
  it('select-institution com token de seleção anterior à troca de senha → 401 COM code SESSION_REVOKED', async () => {
    const T_SEC = Math.floor(Date.now() / 1000) - 20
    links['30:7'] = { profile: 'admin', vendor: 'N', schema: 'setes_cliente',
      passwordSetAt: new Date(T_SEC * 1000).toISOString().slice(0, 19).replace('T', ' ') }
    const sel = testToken({ userId: 30, scope: 'select-institution', iat: T_SEC - 5 }, { expiresIn: '5m' })
    const r = await request(app).post('/auth/select-institution').set('Authorization', `Bearer ${sel}`).send({ institutionId: 7 })
    expect([r.status, r.body.code]).toEqual([401, 'SESSION_REVOKED'])
  })
})

describe('[RESISTIU] falha do banco na leitura da sessão — fechada, sem derrubar o login', () => {
  it('banco fora → 503 SESSION_UNAVAILABLE e a rota NÃO é executada', async () => {
    dbDown = true
    const r = await request(app).get('/api/core/me').set('Authorization', tok({ ...CLIENT_ADMIN, role: 'admin' }))
    expect([r.status, r.body.code]).toEqual([503, 'SESSION_UNAVAILABLE'])
    // nenhuma outra leitura além da sessão (a rota não rodou)
    expect(q.mock.calls.filter(([sql]) => !SESSION_RE.test(norm(String(sql))))).toHaveLength(0)
  })
})

describe('[ACHADO LOW] PAD SPACE: a chave com espaço no fim passa no veredito e não no alcance', () => {
  // Provado ao vivo (scripts/adv-a1-probe.ts views, item (a)): no MariaDB 10.4 o `utf8mb4_bin` é PAD SPACE — `interface_key IN ('orders ')`
  // casa 'orders'. reachableKeys/grantedKeys refiltram EXATO em JS; accessVerdict (SELECT 1 … LIMIT 1) não refiltra: as leituras discordam.
  // Hoje nenhuma chave vem do cliente (constantes/registro) — latente. O dublê responde como o MariaDB respondeu.
  const padSpaceDb = {
    query: jest.fn(async (sql: string, params: any[]) => {
      const keys: string[] = params[2] ?? []
      const hit = keys.some(k => k.replace(/ +$/, '') === 'orders')        // PAD SPACE: espaços à direita não contam
      return [/vw_user_access/.test(sql) && hit ? [{ 1: 1 }] : [], []]
    }),
  }
  it("accessVerdict(['orders ']) não é 'ok' (o mesmo julgamento EXATO do reachableKeys)", async () => {
    // pelo ADAPTADOR (o único que importa `fiscal-api/access` — cerca F2a/D-AU6), com o pool respondendo como o MariaDB respondeu
    q.mockImplementation(padSpaceDb.query)
    const v = await accessVerdict({ userId: 3, institutionId: 2, schemaName: 'setes_cliente', role: 'user' } as any, ['orders '], 'FATURAR')
    expect(v).not.toBe('ok')
    expect(padSpaceDb.query).not.toHaveBeenCalled()                     // a chave fora da forma canônica nem chega ao banco
  })
})

describe("[ACHADO LOW] PAD SPACE no `kind`: 'admin ' / 'super ' (espaço no fim) viram perfil", () => {
  // Provado ao vivo (scripts/adv-a1-probe.ts views, item (b)): kind 'admin ' → profile 'admin'; kind 'super ' na Setes → profile 'super'.
  // O resto do sistema compara EXATO em JS (`users.service.assertAccountManageable`: `l.kind === 'super'` — a conta "super " ficaria fora
  // da proteção da D-PV12 e com o escape total pela view). Hoje nenhum escritor HTTP grava espaço (DTO z.enum) — latente (escrita direta
  // no banco / outro escritor). A asserção segura: a comparação do `kind` na vw_user_link NÃO é PAD SPACE.
  const SQL70 = path.resolve(__dirname, '../../../sql/70_user_access_central_views.sql')
  it('sql/70 compara o kind sem PAD SPACE (nopad_bin, BINARY ou igualdade de comprimento)', () => {
    const sql = fs.readFileSync(SQL70, 'utf8')
    const kindCmps = sql.match(/ihu\.`kind`[^\n]*= '(super|admin)'/g) ?? []
    expect(kindCmps.length).toBeGreaterThan(0)
    for (const c of kindCmps) expect(c).toMatch(/nopad_bin|BINARY|LENGTH/i)
  })
})

describe('[ACHADO MEDIUM] o NOME do verbo: a guarda do catálogo (D-PV15) compara SEM caixa; o leitor do veredito (D-PV53) compara BINÁRIO', () => {
  // Provado ao vivo (scripts/adv-a1-probe.ts views, item (h)): `UPDATE tb_privilege SET description = 'faturar' WHERE id = 5` →
  // accessVerdict(…, 'FATURAR') = 'no-privilege' para o SUPER, o admin e o regular — todo faturamento/validação negado em todos os
  // clientes, e o menu perde o botão (accessRows descarta verbo fora do vocabulário exato). Antes da A1 a API decidia pelo ID e o app
  // comparava sem caixa — a guarda `sameName` (toLowerCase) e a conferência do boot foram escritas para ESSA regra. A tela Privilégios
  // (PUT /api/privileges/:id, só o Super) aceita o rename; o boot também não acusa.
  it("PUT do privilégio FATURAR (consumido) com o nome 'faturar' → 409 PRIVILEGE_IN_USE", () => {
    expect(privilegeCatalogViolations(PRIVILEGE_FATURAR, 'faturar').map(v => v.code)).toContain('PRIVILEGE_IN_USE')
  })
  it("a conferência do boot acusa o FATURAR gravado como 'faturar' (misnamed)", () => {
    const problems = privilegeCatalogProblems({ catalog: [], privileges: [{ id: PRIVILEGE_FATURAR, description: 'faturar' } as any], screens: [], configurable: [] })
    expect(problems.misnamed.map(m => m.privilege)).toContain('FATURAR')
  })
  it('[controle] a conferência do boot acusa o FATURAR com OUTRO nome (a regra do misnamed alcança o FATURAR)', () => {
    const problems = privilegeCatalogProblems({ catalog: [], privileges: [{ id: PRIVILEGE_FATURAR, description: 'FATURAMENTO' } as any], screens: [], configurable: [] })
    expect(problems.misnamed.map(m => m.privilege)).toContain('FATURAR')
  })
  it('[RESISTIU] renomear o consumido para OUTRO nome, ou com espaço no fim, é recusado', () => {
    expect(privilegeCatalogViolations(PRIVILEGE_FATURAR, 'FATURAMENTO').map(v => v.code)).toContain('PRIVILEGE_IN_USE')
    expect(privilegeCatalogViolations(PRIVILEGE_FATURAR, 'FATURAR ').map(v => v.code)).toContain('PRIVILEGE_IN_USE')
  })
})

describe("[ACHADO LOW] um 2º privilégio 'FATURAR ' (espaço no fim) passa na guarda e vale como FATURAR no veredito (PAD SPACE)", () => {
  // Provado ao vivo (scripts/adv-a1-probe.ts views, item (g)): privilégio novo 'FATURAR ' (outro id, sem UNIQUE na description), registrado
  // em orders e concedido ao regular → accessVerdict(…, 'FATURAR') = 'ok' (o `privilege = ?` do utf8mb4_bin é PAD SPACE), mas o menu NÃO
  // mostra o botão (o JS compara exato). Sem escalada além do que o admin já concede; é um 2º verbo que o sistema confunde com o FATURAR.
  it("POST /api/privileges com 'FATURAR ' → 409 (nome PAD-igual a um verbo consumido)", () => {
    expect(privilegeCatalogViolations(null, 'FATURAR ').map(v => v.code)).toContain('PRIVILEGE_IN_USE')
  })
})

describe('[CORRIGIDO — re-gate socrático L1] UM classificador da falha de ler a sessão: o mesmo 503 no middleware e na seleção', () => {
  it('banco fora na troca do token de SELEÇÃO → 503 SESSION_UNAVAILABLE com o código (era 500 "Erro interno")', async () => {
    links['30:7'] = { profile: 'admin', vendor: 'N', schema: 'setes_cliente', passwordSetAt: null }
    dbDown = true
    const sel = testToken({ userId: 30, scope: 'select-institution' }, { expiresIn: '5m' })
    const r = await request(app).post('/auth/select-institution').set('Authorization', `Bearer ${sel}`).send({ institutionId: 7 })
    expect([r.status, r.body.code]).toEqual([503, 'SESSION_UNAVAILABLE'])
    expect(JSON.stringify(r.body)).not.toMatch(/ECONNREFUSED|3306/)
  })
})
