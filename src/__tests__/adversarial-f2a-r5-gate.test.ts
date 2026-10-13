/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA da Rodada 5 da F2a/F2b (2026-10-13 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §7 D-F151…D-F154, §22.18). Alvo: setes-api-f2a `1a5af8e..22388d9`:
//   D-F151 — a porta da voz separa FONTE × CONTRATO (`voiceFailureCause`) e o alarme leva o AUTOR (`@shared/request-actor`, fixado no
//            `authMiddleware`);
//   D-F152 — `scripts/f2a-reapply-freeze.ts` (reaplicar a trava do schema X);
//   D-F153 — a LÁPIDE do aborto (`scripts/f2a-abort-before-cutover.ts`) e a recusa do runner (`src/migrations/runner.ts` + `f2a-names.ts`).
// Convenção: achado CONFIRMADO = `it.failing('[ACHADO R5-ADV-NN SEV] …')` (o teste descreve o comportamento CERTO e hoje falha);
// `it('[RESISTIU] …')` = o ataque foi barrado; `it('[CENÁRIO] …')` = prova que o cenário de um achado se monta (falha de verdade se não se
// montar); `it('[FATO …]')` = comportamento atual que depende de decisão (questão no relatório).
// Banco MOCKADO na fronteira na parte 1 (pool/conn/fs). A parte VIVA (opt-in, F2A_ADV_LIVE=1) só toca bancos DESCARTÁVEIS `f2a_advr5_*`,
// criados e apagados aqui (o schema real é só LIDO: CREATE TABLE … LIKE). Nada aqui escreve em setes_* nem no fiscal_api.
import fs from 'fs'
import path from 'path'
import request from 'supertest'
import { testToken } from '../test-setup/test-token'
import { rawServiceRow } from '../test-setup/fiscal-voice-rows'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVR5'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))

import pool from '../shared/db/connection'
import * as crash from '../shared/errors/crash.repository'
import { readServiceVoiceOfLife, voiceFailureCause, FiscalVoiceUnavailableError } from '../shared/fiscal-voice'
import { runAsActor } from '../shared/request-actor'
import { assertAppliedMatchFiles, runMigrationsForSchema, splitStatements } from '../migrations/runner'
import { f2aFreezeTriggerSpecs, f2aFreezeTriggersMissingIn, F2A_TOMBSTONE_NAME, F2A_PASSIVO_NAME } from '../migrations/f2a-freeze-triggers'
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import app from '../app'

const REPO = path.join(__dirname, '..', '..')
const SQL_DIR = path.join(REPO, 'src', 'migrations', 'sql')
const PASSIVO_SQL = fs.readFileSync(path.join(SQL_DIR, '069_f2a_fiscal_passivo.sql'), 'utf8')
// scripts/ fica fora do rootDir do tsc (src) — require com o tipo usado
// eslint-disable-next-line @typescript-eslint/no-var-requires
const reapply = require(path.join(REPO, 'scripts', 'f2a-reapply-freeze')) as {
  reapplyF2aFreeze: (c: any, schema: string, o: { vai: boolean }) => Promise<{ missing: string[]; executed: number }>
}

/** ADV_SHOW=1 roda os achados como `it` comum — para LER a mensagem da falha (o motivo certo, não erro de mock). */
const failing: jest.It['failing'] = process.env.ADV_SHOW === '1' ? (it as any) : it.failing
const q = (pool as any).query as jest.Mock
const getConn = (pool as any).getConnection as jest.Mock
const ORDER = 7400
const err = (code: string, errno: number, msg = code) => Object.assign(new Error(msg), { code, errno })
const denied = err('ER_TABLEACCESS_DENIED_ERROR', 1142, "SELECT command denied to user 'setes'@'%' for table 'vw_invoice_service_transmission'")

beforeEach(() => {
  jest.clearAllMocks()
  resetPrivilegeCache()
})

// =================================================================================================
// 1. D-F151 — FONTE × CONTRATO com erros REAIS do mysql2 (sem banco: o próprio driver os produz)
// =================================================================================================
describe('1 — D-F151: a classificação contra o que o mysql2 3.22 REALMENTE lança', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mysql = jest.requireActual('mysql2/promise') as typeof import('mysql2/promise')

  it('[RESISTIU] conexão recusada de verdade (ECONNREFUSED — errno negativo + fatal) = FONTE: 503 "tente de novo em instantes"', async () => {
    const p = mysql.createPool({ host: '127.0.0.1', port: 1, connectionLimit: 1 })
    try {
      const e: any = await p.query('SELECT 1').catch(x => x)
      expect([e.code, typeof e.errno, e.fatal]).toEqual(['ECONNREFUSED', 'number', true])
      expect(voiceFailureCause(e)).toBe('source')
      const r: any = await readServiceVoiceOfLife(p as any, 1, ORDER, 1).catch(x => x)
      expect(r).toBeInstanceOf(FiscalVoiceUnavailableError)
      expect([r.statusCode, r.code, r.failureCause]).toEqual([503, 'FISCAL_VOICE_UNAVAILABLE', 'source'])
      expect(r.message).toMatch(/tente de novo em instantes/)
    } finally { await p.end() }
  })

  it('[CORRIGIDO R5-ADV-03 LOW] "Pool is closed." (o erro REAL do mysql2 3.22 — `new Error` SEM code/errno/fatal) é falha da FONTE (o pool fechou), mas `voiceFailureCause` o põe como CONTRATO: 503 "INCOERENTE — tentar de novo não resolve"; os códigos POOL_CLOSED/POOL_ENQUEUELIMIT do `CONNECTION_CODES` são do driver `mysql` (v1) — o mysql2 nunca os põe', async () => {
    const p = mysql.createPool({ host: '127.0.0.1', port: 1, connectionLimit: 1 })
    await p.end()
    const e: any = await p.query('SELECT 1').catch(x => x)
    expect(e.message).toBe('Pool is closed.')                                           // o driver: sem code, sem errno, sem fatal
    expect([e.code, e.errno, e.fatal]).toEqual([undefined, undefined, undefined])
    expect(voiceFailureCause(e)).toBe('source')
  })

  it('[CORRIGIDO] (base do R5-ADV-03) o mysql2 instalado não tem os códigos POOL_CLOSED / POOL_ENQUEUELIMIT — e a porta não os declara mais', () => {
    const lib = path.join(REPO, 'node_modules', 'mysql2', 'lib')
    const all = [path.join(lib, 'base', 'pool.js'), path.join(lib, 'pool.js'), path.join(lib, 'promise', 'pool.js')]
      .filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f, 'utf8')).join('\n')
    expect(all).toMatch(/new Error\('Pool is closed\.'\)/)
    expect(all).not.toMatch(/POOL_CLOSED|POOL_ENQUEUELIMIT/)
    const port = fs.readFileSync(path.join(REPO, 'src', 'shared', 'fiscal-voice', 'fiscal-voice.ts'), 'utf8')
    expect(port).not.toMatch(/'POOL_CLOSED'|'POOL_ENQUEUELIMIT'/)
  })

  it('[FATO — analisado] ER_PARSE_ERROR (1064 — só nasce de SQL NOSSO torto, um bug) é classificado FONTE ("tente de novo em instantes"): pela letra da D-F151 ("erro do driver/servidor") está certo; tentar de novo não resolve', () => {
    expect(voiceFailureCause(err('ER_PARSE_ERROR', 1064))).toBe('source')
  })
})

// =================================================================================================
// 2. D-F151 — o AUTOR do alarme sob requisições CONCORRENTES (app real, banco mockado)
// =================================================================================================
describe('2 — D-F151: `@shared/request-actor` não cruza autores entre requisições', () => {
  const CATALOG: Record<string, number> = { orders: 29, 'service-orders': 20, 'order-returns': 31 }
  type Gate = { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  let gates: Gate[]
  let refSeq: number
  beforeEach(() => {
    gates = []
    refSeq = 0
    ;(crash.newCrashRef as jest.Mock).mockImplementation(() => `REFR5${String(++refSeq).padStart(3, '0')}`)
    q.mockImplementation(async (sql: string, params: any[] = []) => {
      if (/FROM setes_central\.tb_interface WHERE i18n_key/.test(sql)) { const id = CATALOG[String(params[0])]; return [id ? [{ id }] : []] }
      if (/tb_institution_has_interface/.test(sql)) return [[{ 1: 1 }]]
      if (/tb_user_has_privilege/.test(sql)) return [[]]
      if (/vw_order_interface/.test(sql)) return [[{ k: 'service-orders' }]]
      if (/tb_invoice_cancel_waiver/.test(sql)) return [[]]
      if (/vw_invoice_life/.test(sql)) return [[{ invoiceId: ORDER, invoiceDeleted: 'N', lifeEvent: 1, lastEvent: 1, lastKind: 'E' }]]
      if (/`fiscal_api`\.vw_invoice_service_transmission/.test(sql)) return new Promise((resolve, reject) => gates.push({ resolve, reject }))
      throw new Error(`SQL inesperado no pool: ${String(sql).slice(0, 90)}`)
    })
  })
  afterEach(() => (crash.newCrashRef as jest.Mock).mockImplementation(() => 'REFADVR5'))

  const effectAs = (userId: number) => request(app).get(`/api/billing/${ORDER}/fiscal-effect`)
    .set('Authorization', `Bearer ${testToken({ institutionId: 1, userId, role: 'admin', schemaName: 'setes_setes' })}`)
  const until = async (cond: () => boolean) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise(r => setTimeout(r, 5)) }

  it('[RESISTIU] 2 requisições SIMULTÂNEAS de autores diferentes, falhas resolvidas na ordem INVERSA: cada alarme leva o SEU autor e o ref que a SUA resposta mostra', async () => {
    const a = effectAs(7).then(r => r)
    const b = effectAs(8).then(r => r)
    await until(() => gates.length === 2)
    expect(gates).toHaveLength(2)
    gates[1].reject(denied)                                 // a 2ª a chegar falha PRIMEIRO
    await new Promise(r => setTimeout(r, 20))
    gates[0].reject(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -4077, fatal: true }))
    const [ra, rb] = await Promise.all([a, b])
    expect([ra.status, ra.body.code, rb.status, rb.body.code]).toEqual([503, 'FISCAL_VOICE_UNAVAILABLE', 503, 'FISCAL_VOICE_UNAVAILABLE'])
    const byRef = new Map((crash.recordCrash as jest.Mock).mock.calls.map(([c]) => [c.ref, c.userId]))
    expect(byRef.size).toBe(2)
    expect([byRef.get(ra.body.ref), byRef.get(rb.body.ref)]).toEqual([7, 8])
  })

  it('[RESISTIU] o autor não VAZA: a porta chamada fora de requisição logo depois (rotina/script) grava usuário 0; dentro de outro `runAsActor`, o dele', async () => {
    const qq = { query: jest.fn().mockRejectedValue(denied) } as any
    await expect(readServiceVoiceOfLife(qq, 1, ORDER, 1)).rejects.toBeInstanceOf(FiscalVoiceUnavailableError)
    await runAsActor({ institutionId: 1, userId: 99 }, () => expect(readServiceVoiceOfLife(qq, 1, ORDER, 1)).rejects.toBeInstanceOf(FiscalVoiceUnavailableError))
    expect((crash.recordCrash as jest.Mock).mock.calls.map(([c]) => c.userId)).toEqual([0, 99])
  })

  it('[RESISTIU] rota SEM `authMiddleware` que alcance a porta: nenhuma — `/auth` e `/hooks/bank-channel` (as montadas antes do `/api`) não importam, nem transitivamente, `@shared/fiscal-voice` nem `@shared/invoice`', () => {
    const SRC = path.join(REPO, 'src')
    const resolve = (from: string, spec: string): string | null => {
      let base: string | null = null
      if (spec.startsWith('@shared/')) base = path.join(SRC, 'shared', spec.slice(8))
      else if (spec.startsWith('@modules/')) base = path.join(SRC, 'modules', spec.slice(9))
      else if (spec.startsWith('@gateway/')) base = path.join(SRC, 'gateway', spec.slice(9))
      else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec)
      if (!base) return null
      for (const c of [`${base}.ts`, path.join(base, 'index.ts')]) if (fs.existsSync(c)) return c
      return null
    }
    const reach = (entry: string): Set<string> => {
      const seen = new Set<string>([entry]); const stack = [entry]
      while (stack.length) {
        const f = stack.pop()!
        for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:from|require\()\s*['"]([^'"]+)['"]/g)) {
          const r = resolve(f, m[1]); if (r && !seen.has(r)) { seen.add(r); stack.push(r) }
        }
      }
      return seen
    }
    const app = fs.readFileSync(path.join(SRC, 'app.ts'), 'utf8')
    expect(app.indexOf("app.use('/auth'")).toBeLessThan(app.indexOf("app.use('/api', authMiddleware)"))
    for (const entry of ['modules/auth/auth.routes.ts', 'modules/bank-channel-webhook/bank-channel-webhook.routes.ts']) {
      const files = [...reach(path.join(SRC, entry))].map(f => path.relative(SRC, f).replace(/\\/g, '/'))
      expect([entry, files.filter(f => /^shared\/(fiscal-voice|invoice)\//.test(f))]).toEqual([entry, []])
    }
  })
})

// =================================================================================================
// 3. D-F153 — a LÁPIDE contra a renumeração planejada da migration (o runner REAL, fs e banco mockados)
// =================================================================================================
describe('3 — D-F153: a lápide é presa à VERSÃO; a F2a renumera a migration na janela (§22.11 passo 4)', () => {
  const realReaddir = fs.readdirSync
  const realRead = fs.readFileSync
  const SQL = path.resolve(SQL_DIR)
  /** O runner REAL num schema cujo `_migrations` tem [applied], com [files] no diretório das migrations. */
  async function runRunner(files: Record<string, string>, applied: { version: string; name: string }[]) {
    const executed: string[] = []
    const conn = {
      query: jest.fn(async (sql: string, p?: unknown[]) => {
        if (/^SELECT version, name FROM _migrations/.test(sql)) return [applied]
        executed.push(p ? `${sql} ${JSON.stringify(p)}` : sql)
        return [{}]
      }),
      release: jest.fn(),
    }
    getConn.mockResolvedValue(conn)
    const rd = jest.spyOn(fs, 'readdirSync').mockImplementation(((d: any, o?: any) =>
      path.resolve(String(d)) === SQL ? Object.keys(files) : (realReaddir as any)(d, o)) as any)
    const rf = jest.spyOn(fs, 'readFileSync').mockImplementation(((f: any, o?: any) =>
      path.resolve(path.dirname(String(f))) === SQL && files[path.basename(String(f))] !== undefined ? files[path.basename(String(f))] : (realRead as any)(f, o)) as any)
    try {
      await runMigrationsForSchema('setes_setes')
      return { ok: true as const, executed }
    } catch (e: any) {
      return { ok: false as const, executed, error: String(e?.message ?? e) }
    } finally { rd.mockRestore(); rf.mockRestore() }
  }
  // o estado de PRODUÇÃO depois de um aborto: 068 da F2a (já no main) + a LÁPIDE — com a versão SENTINELA desde a D-F162 (= Q-F170 (a));
  // ABORTED_069 = a forma anterior (lápide no número), mantida para provar que ela também recusa pelo nome
  const ABORTED = [{ version: '068', name: 'order_interface_view_bin' }, { version: 'F2A-ABORT', name: F2A_TOMBSTONE_NAME }]
  const ABORTED_069 = [{ version: '068', name: 'order_interface_view_bin' }, { version: '069', name: F2A_TOMBSTONE_NAME }]

  it('[RESISTIU] o código da F2a recusa subir sobre a lápide (sentinela ou na mesma versão 069) e não executa nada', async () => {
    for (const applied of [ABORTED, ABORTED_069]) {
      const r = await runRunner({ '068_order_interface_view_bin.sql': 'SELECT 1;', '069_f2a_fiscal_passivo.sql': PASSIVO_SQL }, applied)
      expect([r.ok, (r as any).error]).toEqual([false, expect.stringMatching(/ABORTADA[\s\S]*D-F153/)])
      expect(r.executed.some(s => /CREATE TRIGGER/.test(s))).toBe(false)
    }
  })

  it('[CORRIGIDO] (base do R5-ADV-01) depois do aborto o main ganha migrations (a IB-2) e a F2a é RENUMERADA (071): o runner do código da F2a RECUSA subir pela lápide (pelo NOME) e não executa NADA — o ERP nunca volta a ser congelado calado', async () => {
    const applied = [...ABORTED, { version: '070', name: 'ibscbs_ib2' }]
    const r = await runRunner({
      '068_order_interface_view_bin.sql': 'SELECT 1;', '070_ibscbs_ib2.sql': 'SELECT 1;', '071_f2a_fiscal_passivo.sql': PASSIVO_SQL,
    }, applied)
    expect([r.ok, (r as any).error]).toEqual([false, expect.stringMatching(/ABORTADA[\s\S]*arquivo da F2a: 071_f2a_fiscal_passivo\.sql/)])
    expect(r.executed.filter(s => /CREATE TRIGGER|INSERT INTO _migrations/.test(s))).toEqual([])
  })

  it('[CORRIGIDO R5-ADV-01 MEDIUM] a LÁPIDE só vale para a MESMA versão: com a migration da F2a renumerada (069 → 071 — o roteiro da janela manda conferir o número contra o main e renumerar; o teste exige que ela seja a última DA F2a) o runner do código da F2a NÃO a vê e re-congela o ERP calado — a promessa da D-F153 ("um restart acidental do código novo nunca re-congela calado") cai. Correção: a recusa por NOME (qualquer linha `f2a_fiscal_passivo_abortada` + arquivo `*_f2a_fiscal_passivo`), independente da versão', () => {
    expect(() => assertAppliedMatchFiles(
      [{ version: '071', name: F2A_PASSIVO_NAME, file: '071_f2a_fiscal_passivo.sql' }],
      [...ABORTED_069, { version: '070', name: 'ibscbs_ib2' }], 'setes_setes',
    )).toThrow(/ABORTADA[\s\S]*D-F153/)
  })

  it('[CORRIGIDO — R5-ADV-02 LOW, D-F162 (= Q-F170 (a))] lápide com versão SENTINELA: o número fica livre e a próxima migration do main com ele RODA; a forma anterior (lápide no número) segue dizendo RESERVADA — a lápide OCUPA a versão 069 no `_migrations` de PRODUÇÃO depois do aborto: a próxima migration do main com esse número (a IB-2 escolhe "o próximo livre" = 069) derruba o boot do código ANTIGO (tsx watch = produção fora ao salvar) com a mensagem genérica de número repetido — que não diz que é a F2a abortada nem o que fazer', async () => {
    const free = await runRunner({ '068_order_interface_view_bin.sql': 'SELECT 1;', '069_ibscbs_ib2.sql': 'SELECT 1;' }, ABORTED)
    expect(free.ok).toBe(true)
    expect(free.executed.some(s => /INSERT INTO _migrations/.test(s) && s.includes('"069","ibscbs_ib2"'))).toBe(true)
    const old = await runRunner({ '068_order_interface_view_bin.sql': 'SELECT 1;', '069_ibscbs_ib2.sql': 'SELECT 1;' }, ABORTED_069)
    expect(old.ok).toBe(false)
    expect((old as any).error).toMatch(/versão 069 está RESERVADA pela lápide da F2a abortada \(D-F153[\s\S]*Renumere o arquivo/)
  })
})

// =================================================================================================
// 4. PARTE VIVA (opt-in): F2A_ADV_LIVE=1 — bancos DESCARTÁVEIS f2a_advr5_*, criados e apagados aqui
// =================================================================================================
const live = process.env.F2A_ADV_LIVE === '1'
;(live ? describe : describe.skip)('ao vivo (MariaDB do dev, bancos descartáveis f2a_advr5_*)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mysql = jest.requireActual('mysql2/promise') as typeof import('mysql2/promise')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv') as typeof import('dotenv')
  const env = dotenv.parse(fs.readFileSync(path.join(REPO, '.env')))
  const TAG = Date.now().toString(36)
  const DBF = `f2a_advr5_${TAG}_fis`                 // a "voz": uma TABELA com as colunas da view publicada (nada lido do fiscal_api)
  const DBE = `f2a_advr5_${TAG}_erp`                 // a FORMA das tabelas do ERP + a 069 (o schema real só é LIDO: CREATE TABLE … LIKE)
  const cfg = () => ({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD })
  const opened: any[] = []
  let admin: any
  const connTo = async (db: string) => {
    const c = await mysql.createConnection(cfg()); opened.push(c); await c.query(`USE \`${db}\``)
    const [[cur]] = await c.query<any[]>('SELECT DATABASE() AS db')
    if (cur.db !== db || !/^f2a_advr5_/.test(cur.db)) throw new Error(`conexão fora do banco descartável: ${cur.db}`)   // nunca setes_*
    return c
  }
  const VIEW_COLS = `tb_institution_id INT NOT NULL, tb_invoice_id INT NOT NULL, terminal INT NOT NULL, attempt INT NOT NULL,
    life_event INT NOT NULL, environment CHAR(1) NOT NULL, serie VARCHAR(5) NOT NULL, dps_number INT NOT NULL, dps_id VARCHAR(45) NOT NULL,
    access_key VARCHAR(50) NULL, authority_recorded VARCHAR(1) NOT NULL, nfse_number VARCHAR(13) NULL, dh_proc DATETIME NULL,
    last_queried_at DATETIME NULL, nfse_not_generated_at DATETIME NULL, created_at DATETIME NULL, last_event INT NULL, last_kind CHAR(1) NULL,
    last_code VARCHAR(10) NULL, last_message VARCHAR(255) NULL, last_source CHAR(1) NULL, last_dh DATETIME NULL, last_event_at DATETIME NULL`
  const insertRow = (c: any, over: Record<string, unknown>) => {
    const r: Record<string, unknown> = {
      tb_institution_id: 1, tb_invoice_id: ORDER, terminal: 0, attempt: 1, life_event: 1, environment: 'P', serie: '1', dps_number: 10,
      dps_id: 'DPS1', access_key: rawServiceRow().accessKey, authority_recorded: 'S', nfse_number: '710', dh_proc: '2026-10-10 12:00:05',
      last_queried_at: null, nfse_not_generated_at: null, created_at: '2026-10-10 12:00:00', last_event: 1, last_kind: 'A', last_code: null,
      last_message: null, last_source: 'P', last_dh: '2026-10-10 12:00:05', last_event_at: '2026-10-10 12:00:05', ...over,
    }
    return c.query(`INSERT INTO vw_invoice_service_transmission (${Object.keys(r).join(', ')}) VALUES (?)`, [Object.values(r)])
  }
  const ENV0 = process.env.FISCAL_DB_NAME

  beforeAll(async () => {
    admin = await mysql.createConnection(cfg())
    for (const db of [DBF, DBE]) await admin.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    process.env.FISCAL_DB_NAME = DBF
  }, 60000)

  afterAll(async () => {
    if (ENV0 === undefined) delete process.env.FISCAL_DB_NAME; else process.env.FISCAL_DB_NAME = ENV0
    for (const c of opened) { try { await c.end() } catch { /* */ } }
    if (admin) {
      for (const db of [DBF, DBE]) await admin.query(`DROP DATABASE IF EXISTS \`${db}\``)
      const [left] = await admin.query(`SHOW DATABASES LIKE 'f2a\\_advr5%'`)
      await admin.end()
      if ((left as any[]).length) throw new Error(`sobrou banco descartável: ${JSON.stringify(left)}`)
    }
  }, 60000)

  describe('D-F151 — FONTE × CONTRATO pela porta REAL contra o servidor REAL', () => {
    it('[RESISTIU] view ausente (1146) e coluna sumida (1054) = FONTE; linha que o mapa recusa (C sem registro — D-F154) = CONTRATO; linha boa lê', async () => {
      const c = await connTo(DBF)
      const out: string[] = []
      const read = async () => {
        const e: any = await readServiceVoiceOfLife(c, 1, ORDER, 1).then(() => null, x => x)
        out.push(e ? `${e.statusCode}:${e.failureCause}:${/em instantes/.test(e.message) ? 'instantes' : /INCOERENTE/.test(e.message) ? 'incoerente' : '?'}` : 'ok')
      }
      await read()                                                                                 // sem a "view"
      await c.query(`CREATE TABLE vw_invoice_service_transmission (${VIEW_COLS})`)
      await c.query('ALTER TABLE vw_invoice_service_transmission DROP COLUMN authority_recorded')
      await read()                                                                                 // coluna sumida
      await c.query(`ALTER TABLE vw_invoice_service_transmission ADD COLUMN authority_recorded VARCHAR(1) NOT NULL DEFAULT 'S' AFTER access_key`)
      await insertRow(c, { last_kind: 'C', access_key: null, authority_recorded: 'N', nfse_number: null })
      await read()                                                                                 // C sem registro
      await c.query('DELETE FROM vw_invoice_service_transmission')
      await insertRow(c, {})
      await read()                                                                                 // linha boa
      expect(out).toEqual(['503:source:instantes', '503:source:instantes', '503:contract:incoerente', 'ok'])
    })

    it('[RESISTIU] conexão MORTA por KILL = FONTE (o mysql2 marca fatal); trava de METADADOS (1205 do lock_wait_timeout) NÃO é voz ilegível — sobe crua para o 409', async () => {
      const k = await connTo(DBF)
      const [[{ id }]] = await k.query<any[]>('SELECT CONNECTION_ID() AS id')
      await admin.query(`KILL ${Number(id)}`)
      await new Promise(r => setTimeout(r, 200))
      const dead: any = await readServiceVoiceOfLife(k, 1, ORDER, 1).catch(x => x)
      expect([dead.statusCode, dead.failureCause]).toEqual([503, 'source'])
      const holder = await connTo(DBF)
      const reader = await connTo(DBF)
      await reader.query('SET SESSION lock_wait_timeout = 1')
      await holder.query(`LOCK TABLES vw_invoice_service_transmission WRITE`)
      try {
        const mdl: any = await readServiceVoiceOfLife(reader, 1, ORDER, 1).catch(x => x)
        expect(mdl).not.toBeInstanceOf(FiscalVoiceUnavailableError)
        expect(mdl.errno).toBe(1205)
      } finally { await holder.query('UNLOCK TABLES') }
    })
  })

  describe('D-F152 — reaplicar a trava abre uma janela SEM trava (também nos gatilhos que estavam certos)', () => {
    const apply069 = async (e: any) => {
      for (const s of splitStatements(PASSIVO_SQL)) await e.query(s)
      await e.query(`INSERT INTO _migrations (version, name) VALUES ('069', 'f2a_fiscal_passivo') ON DUPLICATE KEY UPDATE name = VALUES(name)`)
    }
    let e: any
    beforeAll(async () => {
      e = await connTo(DBE)
      for (const t of ['tb_establishment_issuer', 'tb_invoice_service', 'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event']) {
        await e.query(`CREATE TABLE \`${t}\` LIKE setes_setes.\`${t}\``)
      }
      await e.query(`CREATE TABLE _migrations (id INT AUTO_INCREMENT PRIMARY KEY, version VARCHAR(10) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`)
      await e.query(`INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, created_at, updated_at, deleted)
                     VALUES (1, 'SE', 'P', '1', 10, NOW(), NOW(), 'N')`)
      await apply069(e)
    }, 60000)

    it('[CORRIGIDO R5-ADV-04 LOW] `--vai` com UM gatilho faltando derruba e recria os NOVE, um a um, em comandos separados (DDL = commit implícito): entre o DROP e o CREATE de cada um a escrita congelada PASSA — um escritor concorrente no contador da SE (gatilho que NÃO faltava) grava. Correção: só os que faltam/diferem, ou `CREATE OR REPLACE TRIGGER` (MariaDB ≥ 10.1.4 — troca sob a mesma trava de metadados)', async () => {
      const writer = await connTo(DBE)
      const tool = await connTo(DBE)
      let slipped = 0
      let blocked = 0
      for (let round = 0; round < 8 && slipped === 0; round++) {
        await e.query('DROP TRIGGER IF EXISTS `tg_f2a_freeze_issuer_se_bd`')                       // o que "falta" (outro, não o do UPDATE)
        let done = false
        const hammer = (async () => {
          while (!done) {
            try { await writer.query(`UPDATE tb_establishment_issuer SET dps_last_number = dps_last_number + 1 WHERE tb_institution_id = 1 AND model = 'SE'`); slipped++ }
            catch (x: any) { if (Number(x?.errno) === 1644) blocked++; else throw x }
          }
        })()
        const r = await reapply.reapplyF2aFreeze(tool, DBE, { vai: true })
        done = true
        await hammer
        expect(r.missing).toEqual(['tg_f2a_freeze_issuer_se_bd ausente'])
        expect(await f2aFreezeTriggersMissingIn(e, DBE)).toEqual([])                                 // depois: a trava inteira de volta
      }
      expect(blocked).toBeGreaterThan(0)                                                             // o escritor rodou contra a trava
      expect(slipped).toBe(0)
    }, 120000)

    it('[RESISTIU] a pós-condição confere pela MESMA conferência do boot (corpo normalizado): depois do `--vai`, 9/9 iguais à migration', async () => {
      await e.query('DROP TRIGGER IF EXISTS `tg_f2a_freeze_issuer_se_bu`')
      expect(await f2aFreezeTriggersMissingIn(e, DBE)).toEqual(['tg_f2a_freeze_issuer_se_bu ausente'])
      const tool = await connTo(DBE)
      const r = await reapply.reapplyF2aFreeze(tool, DBE, { vai: true })
      expect([r.executed, await f2aFreezeTriggersMissingIn(e, DBE)]).toEqual([2, []])                 // R5-ADV-04: só o DROP+CREATE do que faltava
    })
  })
})
