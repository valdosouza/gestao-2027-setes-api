/// <reference types="jest" />
// RE-GATE testar-adversarial do RETRABALHO da costura A1 (passo 4 do plano 10-21 — bloco de privilégios + costura A1 da frente auth-api;
// `Infra-IA/prompts/prompt_frente_auth_api.md`; skill `Infra-IA/skills-genericas/testar-adversarial.md`). 2026-11-01.
// Delta atacado: PAD SPACE nas views (sql/70 + 075) e na biblioteca, A-PV26 (`exactName`/`collidesWith`), 503 SESSION_UNAVAILABLE,
// `upsertInterfaceConfig` com o par CONFIGURAR, D-PV61 (seed 72), D-PV62, `auth.routes.fail` com `code`/`fields`, 1ª senha opcional no app.
//   [RESISTIU] = `it` que passa (a defesa segurou);
//   [ACHADO]   = `it.failing` com a asserção SEGURA (o código de hoje a quebra; vira `it` com a correção).
// O comportamento REAL do MariaDB 10.4 (views do delta com PAD SPACE/Unicode/NULL/D-PV62; o escritor REAL da config com revive, ordem do
// ON DUPLICATE KEY UPDATE, FK e 6 salvamentos simultâneos × 8 rodadas; os seeds 64/65/68/72 em 7 ordens) foi provado em bancos
// DESCARTÁVEIS por `scripts/adv-a1-delta-probe.ts` (views · upsert · seeds) — tudo apagado no fim. A sessão aqui é a REAL
// (`jest.requireActual('@shared/access')`) contra o dublê do pool (molde: adversarial-a1-gate.test.ts).
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
  __esModule: true, newCrashRef: jest.fn(() => 'REFADV2'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))

import pool from '../shared/db/connection'
import app from '../app'
import { md5Password } from '../shared/auth/password'
import { privilegeCatalogViolations, privilegeCatalogProblems } from '../shared/auth/privilege-catalog'
import { PRIVILEGE_FATURAR } from '../shared/auth/privileges'
import { upsertInterfaceConfig } from '../modules/interfaces/interfaces.repository'
import { userUpdateDto } from '../modules/users/users.dto'

const q = (pool as any).query as jest.Mock
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const SESSION_RE = /FROM setes_central\.vw_user_link WHERE tb_user_id = \? AND tb_institution_id = \? AND schema_name = \?/

beforeEach(() => {
  q.mockReset()
  q.mockImplementation(async () => [[], []])
})

describe('[RESISTIU] o envelope do login com o `fail()` novo — nenhum canal NOVO entre "senha errada" e "conta existe"', () => {
  // D-EA6 (decidida 2026-10-31, NÃO executada nesta onda): "Usuário inativo" (401) e "sem institution ativa" (403) com a senha CERTA
  // seguem distintos — achado PRÉ-EXISTENTE, já decidido; o `fail()` do delta não lhes acrescenta `code`/`fields`.
  const users: Record<string, { id: number; password: string | null; active: string }> = {
    'ok@x.com': { id: 1, password: md5Password('certa123'), active: 'S' },
    'inativo@x.com': { id: 2, password: md5Password('certa123'), active: 'N' },
    'semsenha@x.com': { id: 3, password: null, active: 'N' },
  }
  beforeEach(() => {
    q.mockImplementation(async (sql: string, params: any[] = []) => {
      const t = norm(sql)
      if (/FROM setes_central\.tb_user u INNER JOIN setes_central\.tb_entity_has_mailing/.test(t)) {
        const u = users[String(params[0])]
        return [u ? [{ ...u, loginEmail: params[0] }] : [], []]
      }
      return [[], []]                                         // nenhum vínculo vivo (vw_user_link)
    })
  })
  const login = (email: string, password: string) => request(app).post('/auth/login').send({ email, password })

  it('senha errada, e-mail inexistente e conta sem credencial (sync) → o MESMO 401, sem `code` nem `fields`', async () => {
    const replies = [await login('ok@x.com', 'errada99'), await login('nao@x.com', 'errada99'), await login('semsenha@x.com', 'qualquer')]
    for (const r of replies) expect([r.status, r.body]).toEqual([401, { error: 'Email ou senha inválidos' }])
  })

  it('com a senha CERTA: inativo (401) e sem vínculo (403) — o `fail()` não lhes dá `code`/`fields` (D-EA6 pendente, pré-existente)', async () => {
    const inactive = await login('inativo@x.com', 'certa123')
    const noLink = await login('ok@x.com', 'certa123')
    expect([inactive.status, Object.keys(inactive.body), noLink.status, Object.keys(noLink.body)]).toEqual([401, ['error'], 403, ['error']])
  })
})

describe('[RESISTIU] A-PV26 — o nome do verbo consumido é EXATO; a outra linha colide na comparação mais frouxa', () => {
  it('renomear o FATURAR (consumido) para qualquer variante de caixa/espaço/Unicode de borda → 409', () => {
    for (const d of ['faturar', 'Faturar', 'FATURAR ', ' FATURAR', 'FATURAR\t', 'FATURAR ', 'FATURAR\n', 'FATURAR​', 'ＦＡＴＵＲＡＲ', '']) {
      expect([d, privilegeCatalogViolations(PRIVILEGE_FATURAR, d).map(v => v.code)]).toEqual([d, ['PRIVILEGE_IN_USE']])
    }
    expect(privilegeCatalogViolations(PRIVILEGE_FATURAR, 'FATURAR')).toEqual([])          // o conserto (gravar o nome certo) segue aberto
  })

  it("criar OUTRA linha 'faturar' / ' FATURAR ' / 'FATURAR\\u00A0' / 'faturar\\t' → 409; as que o banco nunca iguala passam", () => {
    for (const d of ['faturar', ' FATURAR ', 'FATURAR ', 'faturar\t', 'Faturar']) {
      expect([d, privilegeCatalogViolations(null, d).map(v => v.code)]).toEqual([d, ['PRIVILEGE_IN_USE']])
    }
    // largura total e espaço de largura zero: nem a view (binário, sem PAD SPACE) nem a biblioteca (vocabulário fechado) as leem como
    // FATURAR — provado ao vivo (sonda, item (p)); um 2º verbo inofensivo
    for (const d of ['ＦＡＴＵＲＡＲ', 'FATURAR​']) expect(privilegeCatalogViolations(null, d)).toEqual([])
  })

  it('o boot acusa o FATURAR com caixa trocada (misnamed) e as linhas "quase FATURAR" (duplicateNames)', () => {
    const problems = privilegeCatalogProblems({ catalog: [], screens: [], configurable: [], privileges: [
      { id: PRIVILEGE_FATURAR, description: 'FATURAR' }, { id: 90, description: 'FATURAR ' }, { id: 91, description: ' faturar' },
      { id: 92, description: 'FATURAR ' },
    ] as any })
    expect(problems.misnamed.map(m => m.privilege)).not.toContain('FATURAR')
    expect(problems.duplicateNames.find(d => d.privilege === 'FATURAR')?.otherIds).toEqual([90, 91, 92])
  })
})

describe('[ACHADO LOW] o vocabulário da biblioteca é mais largo que a guarda: um 2º CATALOGAR (verbo lido pelo NOME) é aceito', () => {
  // `fiscal-api/access` lê QUALQUER linha de tb_privilege com description = 'CATALOGAR' como o verbo CATALOGAR (PRIVILEGE_NAMES); a guarda
  // da tela Privilégios (A-PV26) só protege os verbos CONSUMIDOS — e neste branch o CATALOGAR não é consumido (é do branch `merchandise`,
  // seed 66 com id FIXO 10). Hoje o Super cria 'CATALOGAR' (ou 'catalogar ') em qualquer id (MAX+1) sem 409; quando o merchandise entrar,
  // o INSERT IGNORE do seed 66 pode calar a colisão de id e a concessão do 2º id valeria como CATALOGAR pelo nome. O boot só acusa
  // duplicata de verbo USADO. Latente (só o Super, e só até o merge do merchandise).
  it('criar OUTRA linha com o nome de QUALQUER verbo do vocabulário fechado (CATALOGAR) → 409', () => {
    expect(privilegeCatalogViolations(null, 'CATALOGAR').map(v => v.code)).toContain('PRIVILEGE_IN_USE')
  })
})

describe('[RESISTIU] D-EA7 + 503 — a seleção pela sessão viva; a rota /api com o banco fora', () => {
  it('select-institution com token anterior à troca de senha → 401 COM code SESSION_REVOKED (o envelope do `fail()` novo)', async () => {
    const T_SEC = Math.floor(Date.now() / 1000) - 20
    const T = new Date(T_SEC * 1000).toISOString().slice(0, 19).replace('T', ' ')
    q.mockImplementation(async (sql: string, params: any[] = []) => {
      const t = norm(sql)
      if (/FROM setes_central\.vw_user_link l INNER JOIN setes_central\.tb_entity e/.test(t)) {
        return [[{ institutionId: 7, schemaName: 'setes_cliente', name: 'X', profile: 'admin' }], []]
      }
      if (SESSION_RE.test(t)) return [String(params[3]) >= T ? [{ profile: 'admin', vendor: 'N' }] : [], []]
      return [[], []]
    })
    const sel = testToken({ userId: 30, scope: 'select-institution', iat: T_SEC - 5 }, { expiresIn: '5m' })
    const r = await request(app).post('/auth/select-institution').set('Authorization', `Bearer ${sel}`).send({ institutionId: 7 })
    expect([r.status, r.body.code, r.body.token]).toEqual([401, 'SESSION_REVOKED', undefined])
  })
})

describe('[ACHADO LOW → corrigido em voo] erro do driver SEM código na leitura da sessão: 401 no setes-api × 503 na nfse-api', () => {
  // Provado CONTRA O DELTA (61e3cdf, cópia isolada): `auth.middleware.isDbFailure` reconhecia o erro do banco por `errno`/`sqlState`/`code`;
  // o mysql2 3.22 lança SEM nenhum deles "Can't add new command when connection is in closed state" (`fatal: true`) e "Pool is closed." —
  // o setes-api respondia 401 UNAUTHORIZED "Token inválido ou expirado" (o app DERRUBA o login), enquanto o `productAuth` do núcleo
  // (nfse-api) responde 503 SESSION_UNAVAILABLE ao MESMO erro (fiscal-api/src/__tests__/adversarial-a1-delta-gate.test.ts).
  // Em 2026-11-01 a árvore de trabalho já trazia (NÃO commitada, outra sessão — re-gate socrático L1) a correção: UM classificador em
  // `sessionOf` (503 HttpError) e o adaptador traduzindo para o HttpError do setes-api. Por isso aqui é `it` — contra 61e3cdf ele FALHA.
  for (const thrown of [Object.assign(new Error("Can't add new command when connection is in closed state"), { fatal: true }), new Error('Pool is closed.')]) {
    it(`sessão ilegível por "${thrown.message}" → 503 SESSION_UNAVAILABLE (nunca 401: o login segue valendo)`, async () => {
      q.mockImplementation(async (sql: string) => {
        if (SESSION_RE.test(norm(sql))) throw thrown
        return [[], []]
      })
      const r = await request(app).get('/api/core/me')
        .set('Authorization', `Bearer ${testToken({ institutionId: 7, userId: 30, schemaName: 'setes_cliente', role: 'admin' })}`)
      expect([r.status, r.body.code]).toEqual([503, 'SESSION_UNAVAILABLE'])
    })
  }
})

describe('[ACHADO LOW] upsertInterfaceConfig confia que o id 11 é o CONFIGURAR (registra o par com QUALQUER verbo que ocupe o id)', () => {
  // Provado ao vivo (sonda, item (u7)): com tb_privilege.id 11 = 'APROVAR' (o Super cria privilégio pela tela com MAX+1 — hoje o catálogo
  // vivo vai até o id 9 — e o seed 68 faz INSERT IGNORE de (11,'CONFIGURAR') e confere só o COUNT dos ids 11/12, calando a colisão), salvar
  // uma config registra (interface × APROVAR). O resto da casa lê o verbo pelo NOME (D-PV53): o par certo nunca nasce e o boot só ALARMA
  // (misnamed). A asserção segura: o escritor confere o verbo pelo NOME exato antes de registrar o par.
  it("com o id 11 ocupado por 'APROVAR' o escritor NÃO registra par nenhum", async () => {
    const calls: string[] = []
    const conn = {
      beginTransaction: jest.fn(async () => undefined), commit: jest.fn(async () => undefined),
      rollback: jest.fn(async () => undefined), release: jest.fn(),
      query: jest.fn(async (sql: string, params: any[] = []) => {
        const t = norm(sql)
        calls.push(t)
        if (/FROM setes_central\.tb_privilege/.test(t)) {
          const row = { id: 11, description: 'APROVAR', deleted: 'N' }   // o "banco"
          const asksName = /description/.test(t)
          const wanted = asksName ? (params.find(p => typeof p === 'string') ?? (/'CONFIGURAR'/.test(t) ? 'CONFIGURAR' : null)) : null
          return [asksName && wanted !== row.description ? [] : [{ 1: 1 }], []]
        }
        return [{ affectedRows: 1 }, []]
      }),
    }
    ;(pool.getConnection as jest.Mock).mockResolvedValue(conn)
    await upsertInterfaceConfig(7, 'page_size', { description: 'x', kind: 'Text', options: null, defaultContent: 'a', scope: 'U' } as any)
    expect(calls.some(c => /INSERT INTO setes_central\.tb_interface_has_privilege/.test(c))).toBe(false)
  })
})

describe('[ACHADO LOW] seeds fora de ordem: o 68 ANTES do 65 deixa a institution-interfaces com config e SEM CONFIGURAR', () => {
  // Provado ao vivo (sonda, item (s)) na CÓPIA do catálogo: as ordens 72→68→65, 68→72→65 e 68→65→72 rodam SEM erro e terminam com o
  // alarme da D-PV9 "institution-interfaces com config sem CONFIGURAR" (o 65 cria a config `page_size` e só registra os pares 2 e 6; o 68
  // calcula o conjunto ANTES e a conferência dele não o vê). Com a D-PV62 nem o super nem o admin gravam o valor da institution dessa
  // config. As outras 4 ordens (e 65→68→72→64→68→72) terminam com ZERO alarme — o 72 é independente de ordem e o 64 não revive.
  // A asserção segura (a regra que o escritor HTTP já cumpre desde este delta — config ⇒ CONFIGURAR na MESMA entrega): o seed que cria a
  // config também garante o par (interface × CONFIGURAR, id 11) quando o verbo existe.
  it('o seed 65 registra o CONFIGURAR da interface cuja config ele cria', () => {
    const sql65 = fs.readFileSync(path.resolve(__dirname, '../../../sql/65_institution_interfaces_seed.sql'), 'utf8')
    const pairInserts = sql65.replace(/--[^\n]*\n/g, '\n').split(';').filter(s => /INSERT[\s\S]*tb_interface_has_privilege/.test(s))
    expect(pairInserts.some(s => /\b11\b/.test(s))).toBe(true)
  })
})

describe('[ACHADO LOW] a 1ª senha opcional: na aba Usuários do Estabelecimento um campo SÓ DE ESPAÇOS vira a credencial', () => {
  // setes-app `institution_users_tab.dart` (delta de08b7ff7..de8eda8): sem o `required()` na edição, o `minLength(5)` PULA valor em branco
  // (`_ifFilled` usa `trim().isEmpty`) e o `_save` manda `_password.text` CRU quando `isNotEmpty` — '     ' passa no app e vai à API.
  // (A `user_page.dart` não sofre: a fábrica `RegisterFormPage` faz `trim()` dos valores → '' → null.) A API aceita
  // (`userUpdateDto.password = z.string().min(5)`) e grava a 1ª credencial = 5 espaços (D-PV48: depois só o titular troca). Analisado no
  // código do app (Dart não roda aqui); a ponta testável é a porta da API.
  it('[controle] o MESMO corpo com uma senha de verdade (ou sem senha) passa na validação', () => {
    const base = { nameCompany: 'Fulano', nickTrade: 'Fulano', email: 'fulano@x.com' }
    expect([userUpdateDto.safeParse({ ...base, password: 'abc12' }).success, userUpdateDto.safeParse({ ...base, password: null }).success])
      .toEqual([true, true])
  })
  it.failing('PUT /api/users/:id com password só de espaços é recusado na validação', () => {
    const parsed = userUpdateDto.safeParse({ nameCompany: 'Fulano', nickTrade: 'Fulano', email: 'fulano@x.com', password: '     ' })
    expect(parsed.success).toBe(false)
  })
})
