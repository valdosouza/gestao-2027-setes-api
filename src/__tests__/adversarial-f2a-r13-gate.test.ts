/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA da Rodada 13 da F2a/F2b (2026-10-13 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §7 D-F190, §22.13 roteiro do ABORTO, §22.40). Alvo no setes-api: `f67f459..0db9310` — D-F190: o
// `abortF2aPassivo` RECUSA quando QUALQUER institution da instalação já virou (`cutover_at` no `fiscal_api`); o `--retirar-lapide` não
// tem a guarda.
// Convenção: `it('[FATO R13-ADV-NN]')` = comportamento atual registrado (a prova executável); `it('[RESISTIU] …')` = o ataque foi barrado.
// O que exige decisão vira Q-F196-ADV-NN (no relatório do gate) — não há `it.failing` aqui: o código cumpre a LETRA da D-F190; o achado é
// a PREMISSA dela ("cutover_at em qualquer linha = o código da F2a já está na árvore principal").
// DECIDIDO (Valdo 2026-10-13, "Q-F196 - siga recomendações"): D-F192 (= Q-F196-SOC-01 (a) = Q-F196-ADV-01 (a)) — a guarda FICA pelo fato
// `cutover_at` e o ROTEIRO a protege (o ensaio do aborto no passo 3 da janela tem de responder sem recusa; nenhuma habilitação SE criada
// pela nfse-api no `fiscal_api` de produção até a 1ª janela) — os FATOs abaixo fixam a semântica do limite.
// Parte 1 sempre roda (banco falso). Parte 2 (opt-in F2A_ADV_LIVE=1): bancos DESCARTÁVEIS `f2a_advr13_*` criados e apagados aqui; o
// `setes_setes` e o `fiscal_api` reais só são LIDOS (CREATE TABLE … LIKE e um SELECT da habilitação SE do ERP pela peça do núcleo).
import fs from 'fs'
import path from 'path'

jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() } }))

import { f2aFreezeTriggerSpecs } from '../migrations/f2a-freeze-triggers'

const REPO = path.join(__dirname, '..', '..')
const CORE = path.resolve(REPO, '..', 'fiscal-api')
const CORE_ISSUER_SRC = path.join(CORE, 'src', 'establishment', 'establishment.repository.ts')
const CORE_ISSUER_DIST = path.join(CORE, 'dist', 'establishment', 'establishment.repository.js')
const ATO_SRC = path.resolve(REPO, '..', 'nfse-api', 'scripts', 'migrate-from-setes-api.ts')
// scripts/ fica fora do rootDir do tsc (src) — require com o tipo usado
// eslint-disable-next-line @typescript-eslint/no-var-requires
const abort = require(path.join(REPO, 'scripts', 'f2a-abort-before-cutover')) as {
  abortF2aPassivo: (c: any, schema: string, id: number, o: { vai: boolean; fiscalDb: string; centralDb?: string }) => Promise<any>
}
const D_F190 = /a instalação já tem institution VIRADA[\s\S]*D-F190/

/** Uma linha da habilitação no `fiscal_api` (o que o aborto lê dela). */
type FiscalRow = { inst: number; model: string; cutover: boolean; deleted?: 'N' | 'S' }

/** Banco falso: as donas de cada schema, a SE do ERP de cada institution, as linhas do `fiscal_api` — as consultas REAIS do script. */
function fakeDb(o: { owners: Record<string, number[]>; erpSe: Record<number, 'N' | 'S'>; fiscal: FiscalRow[]; installationQueryError?: Error }) {
  const sqls: string[] = []
  const c = { query: jest.fn(async (sql: string, p: any[] = []) => {
    sqls.push(sql)
    let m = /FROM `setes_central`\.tb_institution WHERE schema_name = \?/.exec(sql)
    if (m) return [(o.owners[p[0]] ?? []).map(id => ({ id }))]
    m = /FROM `(\w+)`\.tb_establishment_issuer WHERE tb_institution_id = \? AND model = 'SE'/.exec(sql)
    if (m && m[1] !== 'fiscal_api') return [o.erpSe[p[0]] ? [{ deleted: o.erpSe[p[0]] }] : []]
    if (/fiscal_api`\.tb_establishment_issuer WHERE tb_institution_id = \? AND cutover_at IS NOT NULL/.test(sql)) {
      return [[{ n: o.fiscal.filter(r => r.inst === p[0] && r.cutover).length }]]
    }
    if (/fiscal_api`\.tb_establishment_issuer WHERE cutover_at IS NOT NULL/.test(sql)) {
      if (o.installationQueryError) throw o.installationQueryError
      return [[{ n: o.fiscal.filter(r => r.cutover).length }]]
    }
    if (/information_schema\.TRIGGERS/.test(sql)) return [f2aFreezeTriggerSpecs().map(t => ({ name: t.name }))]
    if (/^SELECT name FROM `setes_\w+`\._migrations/.test(sql)) return [[{ name: 'f2a_fiscal_passivo' }]]
    throw new Error(`SQL inesperado: ${sql.slice(0, 100)}`)
  }) }
  return { c, sqls, writes: () => sqls.filter(s => /^\s*(UPDATE|DROP|INSERT|DELETE)/i.test(s)) }
}

// =================================================================================================
// 1. Banco falso
// =================================================================================================
describe('R13-ADV-03 — a premissa da D-F190 ("cutover_at em qualquer linha = o merge da 1ª janela aconteceu")', () => {
  it('[FATO R13-ADV-03 — o fato do núcleo] a habilitação que NASCE pela API fiscal nasce com `cutover_at = NOW()` (D-F39) — para uma institution que o ERP nunca habilitou (lacuna (b) fechada: sem SE no ERP) e para 55/65 (que "nascem virados e não dependem da SE": a réplica da SE NÃO barra a habilitação da NF-e da MESMA institution). Nenhuma dessas linhas depende do merge da F2a na árvore principal', () => {
    expect([CORE_ISSUER_SRC, fs.existsSync(CORE_ISSUER_SRC)]).toEqual([CORE_ISSUER_SRC, true])   // a cerca cruzada falha ALTO sem o núcleo
    const src = fs.readFileSync(CORE_ISSUER_SRC, 'utf8')
    expect(src).toContain("VALUES (?, ?, ?, ?, 0, ?, NOW(), NOW(), 'N', NOW())")
    expect(src).toContain('habilitação que NASCE pela API fiscal nasce virada (cutover_at = NOW())')
    expect(src).toContain('55/65 nascem virados e não dependem')
    // e o ATO da nfse-api diz "virada" pela LINHA SE (D-F57 / ADV-R8-08) — uma 55/65 virada NÃO é a virada da SE
    expect(fs.readFileSync(ATO_SRC, 'utf8')).toContain('"já VIRADA" pela LINHA SE (uma 55/65 que nasceu virada não é a virada da SE)')
  })

  it('[FATO R13-ADV-03] ANTES da 1ª janela (a institution 1 — Setes — com a SE réplica; o código da F2a só na worktree) uma 2ª institution habilitada DIRETO na nfse-api (a SE dela nasceu virada — o ERP nunca a habilitou) faz o aborto da institution 1 RECUSAR pela D-F190 ("o código da F2a está na árvore principal desde a 1ª janela") — no ensaio E no --vai: o plano B da 1ª janela (§22.13) some sem que a F2a tenha saído da worktree', async () => {
    for (const vai of [false, true]) {
      const f = fakeDb({ owners: { setes_setes: [1], setes_cliente2: [2] }, erpSe: { 1: 'N' },
        fiscal: [{ inst: 1, model: 'SE', cutover: false }, { inst: 2, model: 'SE', cutover: true }] })
      await expect(abort.abortF2aPassivo(f.c, 'setes_setes', 1, { vai, fiscalDb: 'fiscal_api' })).rejects.toThrow(D_F190)
      expect(f.writes()).toEqual([])
    }
  })

  it('[FATO R13-ADV-03 — a mesma classe, ANTERIOR ao delta (Rodada 4)] uma habilitação 55 da PRÓPRIA institution 1 nascida virada (a nfe-api futura — D-F42; a SE segue réplica) faz o passo 1 do aborto recusar como "a institution 1 já VIROU (cutover_at)" — o ATO da nfse-api, para a mesma linha, diz que NÃO virou (pela linha SE)', async () => {
    const f = fakeDb({ owners: { setes_setes: [1] }, erpSe: { 1: 'N' },
      fiscal: [{ inst: 1, model: 'SE', cutover: false }, { inst: 1, model: '55', cutover: true }] })
    await expect(abort.abortF2aPassivo(f.c, 'setes_setes', 1, { vai: false, fiscalDb: 'fiscal_api' }))
      .rejects.toThrow(/a institution 1 já VIROU \(cutover_at\)/)
    expect(f.writes()).toEqual([])
  })

  it('[RESISTIU] a D-F190 falha FECHADO: a leitura da instalação que dá erro (tabela ausente, sem SELECT no `fiscal_api`) derruba o aborto com o erro — nada escrito, no ensaio e no --vai; e a linha VIRADA soft-deletada também conta (quem virou continua virado)', async () => {
    for (const vai of [false, true]) {
      const err = Object.assign(new Error("SELECT command denied to user 'setes'@'localhost' for table 'tb_establishment_issuer'"), { errno: 1142 })
      const f = fakeDb({ owners: { setes_setes: [1] }, erpSe: { 1: 'N' }, fiscal: [{ inst: 1, model: 'SE', cutover: false }], installationQueryError: err })
      await expect(abort.abortF2aPassivo(f.c, 'setes_setes', 1, { vai, fiscalDb: 'fiscal_api' })).rejects.toThrow(/SELECT command denied/)
      expect(f.writes()).toEqual([])
    }
    const g = fakeDb({ owners: { setes_setes: [1], setes_cliente2: [2] }, erpSe: { 1: 'N' },
      fiscal: [{ inst: 1, model: 'SE', cutover: false }, { inst: 2, model: 'SE', cutover: true, deleted: 'S' }] })
    await expect(abort.abortF2aPassivo(g.c, 'setes_setes', 1, { vai: true, fiscalDb: 'fiscal_api' })).rejects.toThrow(D_F190)
    expect(g.writes()).toEqual([])
  })

  it('[RESISTIU] a ORDEM das recusas: a virada de uma DONA do schema recusa com a frase dela (passo 1 — "a institution N já VIROU") antes da D-F190; a D-F190 roda antes de qualquer leitura do estado do schema (gatilhos/_migrations) — o operador da 2ª janela nunca lê "nada a desfazer"', async () => {
    const f = fakeDb({ owners: { setes_cliente2: [2, 3] }, erpSe: { 2: 'N', 3: 'N' },
      fiscal: [{ inst: 2, model: 'SE', cutover: false }, { inst: 3, model: 'SE', cutover: true }, { inst: 1, model: 'SE', cutover: true }] })
    await expect(abort.abortF2aPassivo(f.c, 'setes_cliente2', 2, { vai: false, fiscalDb: 'fiscal_api' })).rejects.toThrow(/a institution 3 já VIROU/)
    const g = fakeDb({ owners: { setes_cliente2: [2] }, erpSe: { 2: 'N' },
      fiscal: [{ inst: 2, model: 'SE', cutover: false }, { inst: 1, model: 'SE', cutover: true }] })
    await expect(abort.abortF2aPassivo(g.c, 'setes_cliente2', 2, { vai: false, fiscalDb: 'fiscal_api' })).rejects.toThrow(D_F190)
    expect(g.sqls.some(s => /information_schema\.TRIGGERS|_migrations/.test(s))).toBe(false)
  })
})

// =================================================================================================
// 2. PARTE VIVA (opt-in): F2A_ADV_LIVE=1 — bancos DESCARTÁVEIS f2a_advr13_*, criados e apagados aqui
// =================================================================================================
const live = process.env.F2A_ADV_LIVE === '1'
if (!live) it('ao vivo desligado (F2A_ADV_LIVE=1 liga a parte 2)', () => { expect(live).toBe(false) })
if (live) describe('ao vivo (MariaDB do dev, bancos descartáveis f2a_advr13_*)', () => {
  jest.setTimeout(120_000)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mysql = jest.requireActual('mysql2/promise') as typeof import('mysql2/promise')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv') as typeof import('dotenv')
  const env = dotenv.parse(fs.readFileSync(path.join(REPO, '.env')))
  const TAG = Date.now().toString(36)
  const E = `f2a_advr13_${TAG}_erp`
  const F = `f2a_advr13_${TAG}_fis`
  const C = `f2a_advr13_${TAG}_cen`
  let admin: any
  let fisc: any
  // a peça REAL do núcleo que cria a habilitação (a borda `PUT /v1/emitter/issuers/:model` da nfse-api chega nela pelo `writeIssuer`)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const core = require(CORE_ISSUER_DIST) as {
    upsertIssuer: (conn: any, schemaName: string, institutionId: number, model: string, input: { environment: 'H' | 'P'; serie: string | null; userId: number | null }) => Promise<any>
  }

  beforeAll(async () => {
    const cfg = { host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD }
    admin = await mysql.createConnection(cfg)
    for (const db of [E, F, C]) {
      if (!/^f2a_advr13_/.test(db)) throw new Error(`banco fora do prefixo descartável: ${db}`)
      await admin.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    }
    await admin.query(`CREATE TABLE \`${E}\`.tb_establishment_issuer LIKE setes_setes.tb_establishment_issuer`)   // a FORMA de produção (só lida)
    await admin.query(`CREATE TABLE \`${E}\`._migrations LIKE setes_setes._migrations`)                         // vazio: a F2a nunca aplicada aqui
    await admin.query(`INSERT INTO \`${E}\`.tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, created_at, updated_at, deleted)
                       VALUES (1, 'SE', 'P', '1', 10, NOW(), NOW(), 'N')`)
    await admin.query(`CREATE TABLE \`${F}\`.tb_establishment_issuer LIKE fiscal_api.tb_establishment_issuer`)     // a FORMA de produção (só lida)
    await admin.query(`INSERT INTO \`${F}\`.tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, created_at, updated_at, deleted, cutover_at)
                       VALUES (1, 'SE', 'P', '1', 10, NOW(), NOW(), 'N', NULL)`)                                  // a Setes: SE RÉPLICA (antes da 1ª janela)
    await admin.query(`CREATE TABLE \`${C}\`.tb_institution (id INT PRIMARY KEY, schema_name VARCHAR(64) NOT NULL)`)
    await admin.query(`INSERT INTO \`${C}\`.tb_institution VALUES (1, ?)`, [E])
    // a conexão da peça do núcleo: o banco PADRÃO dela é o fiscal DESCARTÁVEL (as consultas da peça não qualificam o banco)
    fisc = await mysql.createConnection({ ...cfg, database: F })
    const [[db]] = await fisc.query('SELECT DATABASE() AS d')
    if ((db as any).d !== F) throw new Error(`a conexão da peça não está no descartável: ${(db as any).d}`)
  })

  afterAll(async () => {
    if (fisc) await fisc.end()
    if (!admin) return
    for (const db of [E, F, C]) await admin.query(`DROP DATABASE IF EXISTS \`${db}\``)
    const [left] = await admin.query(`SHOW DATABASES LIKE 'f2a\\_advr13%'`)
    await admin.end()
    if ((left as any[]).length) throw new Error(`sobrou banco descartável: ${JSON.stringify(left)}`)
  })

  it('[FATO R13-ADV-03 — ao vivo] a SE de uma institution que o ERP nunca habilitou, criada pela PEÇA REAL do núcleo (`upsertIssuer` — a lacuna (b) conferida no ERP: `setes_setes` não tem SE da institution 2), NASCE virada no MariaDB; o ensaio do aborto da Setes (SE réplica, nenhuma virada) passa a RECUSAR pela D-F190. Sem ela, o ensaio relata normalmente', async () => {
    const opts = { vai: false, fiscalDb: F, centralDb: C }
    // sem a migration no schema descartável o ensaio só RELATA (nada para desfazer) — o ponto é: passa da D-F190
    const before = await abort.abortF2aPassivo(admin, E, 1, opts)
    expect([before.dryRun, before.owners, before.triggers, before.migrationRow, before.tombstone]).toEqual([true, [1], [], false, false])
    await core.upsertIssuer(fisc, 'setes_setes', 2, 'SE', { environment: 'H', serie: '1', userId: null })
    const [rows] = await admin.query(`SELECT tb_institution_id AS i, model, cutover_at IS NOT NULL AS born FROM \`${F}\`.tb_establishment_issuer ORDER BY 1`)
    expect((rows as any[]).map(r => [r.i, r.model, Number(r.born)])).toEqual([[1, 'SE', 0], [2, 'SE', 1]])
    await expect(abort.abortF2aPassivo(admin, E, 1, opts)).rejects.toThrow(D_F190)
    await admin.query(`DELETE FROM \`${F}\`.tb_establishment_issuer WHERE tb_institution_id = 2`)
  })

  it('[FATO R13-ADV-03 — ao vivo, a classe anterior ao delta] a habilitação 55 da PRÓPRIA Setes criada pela peça REAL do núcleo com a SE ainda RÉPLICA (D-NE10: a réplica da SE não barra a NF-e) nasce virada — e o aborto da Setes recusa como "a institution 1 já VIROU"', async () => {
    await core.upsertIssuer(fisc, 'setes_setes', 1, '55', { environment: 'H', serie: '1', userId: null })
    await expect(abort.abortF2aPassivo(admin, E, 1, { vai: false, fiscalDb: F, centralDb: C })).rejects.toThrow(/a institution 1 já VIROU \(cutover_at\)/)
    await admin.query(`DELETE FROM \`${F}\`.tb_establishment_issuer WHERE model = '55'`)
  })
})
