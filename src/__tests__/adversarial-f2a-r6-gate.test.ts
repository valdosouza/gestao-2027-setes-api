/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA da Rodada 6 da F2a (2026-10-13 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §7 D-F162, §22.13 roteiro do ABORTO, §22.20). Alvo: setes-api-f2a `b271e03..99da896` — a LÁPIDE do aborto
// com versão SENTINELA `F2A-ABORT` (nunca ocupa o número), recusa do código da F2a pelo NOME, linha + lápide juntas = recusa.
// Convenção: achado CONFIRMADO = `it.failing('[ACHADO R6-ADV-NN SEV] …')`; `it('[RESISTIU] …')` = o ataque foi barrado;
// `it('[FATO …]')` = comportamento atual registrado.
// Parte 1: o runner REAL do `main` (a ÁRVORE VIVA D:\Gestao2027\setes-api — SÓ LIDA: importado, nunca escrito) e o da F2a, com o banco
// MOCKADO na fronteira. Parte 2 (opt-in F2A_ADV_LIVE=1): bancos DESCARTÁVEIS `f2a_advr6_*` criados e apagados aqui — o schema real
// `setes_setes` é só LIDO (CREATE TABLE … LIKE e o SELECT das linhas do `_migrations`).
import fs from 'fs'
import path from 'path'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))

import pool from '../shared/db/connection'
import * as f2aRunner from '../migrations/runner'
import { F2A_TOMBSTONE_NAME, F2A_TOMBSTONE_VERSION, F2A_PASSIVO_NAME } from '../migrations/f2a-freeze-triggers'

const REPO = path.join(__dirname, '..', '..')
const MAIN = path.resolve(REPO, '..', 'setes-api')                       // a árvore VIVA (produção) — só leitura
const MAIN_SQL = path.join(MAIN, 'src', 'migrations', 'sql')
const F2A_SQL = path.join(REPO, 'src', 'migrations', 'sql')
const PASSIVO_SQL = fs.readFileSync(path.join(F2A_SQL, '069_f2a_fiscal_passivo.sql'), 'utf8')
// O "código ANTIGO" (o main de ANTES da janela) é um FIXTURE congelado: depois do merge o runner da árvore viva É o da F2a (2026-10-14)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mainRunner = require(path.join(__dirname, '..', 'test-setup', 'runner-main-pre-f2a')) as typeof import('../migrations/runner')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const abortTool = require(path.join(REPO, 'scripts', 'f2a-abort-before-cutover')) as {
  abortF2aPassivo: (c: any, s: string, i: number, o: { vai: boolean; fiscalDb: string; centralDb?: string }) => Promise<any>
  removeF2aTombstone: (c: any, s: string, i: number, o: { vai: boolean; fiscalDb: string; centralDb?: string }) => Promise<any>
}

const getConn = (pool as any).getConnection as jest.Mock
type Row = { version: string; name: string }
const filesOf = (dir: string) => fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  .map(file => { const [version, ...rest] = file.replace('.sql', '').split('_'); return { version, name: rest.join('_'), file } })

/** Um runner REAL (`runMigrationsForSchema` de [runner]) num schema cujo `_migrations` tem [applied] e cujo diretório tem + [extra]. */
async function runWith(runner: typeof import('../migrations/runner'), sqlDir: string, extra: Record<string, string>, applied: Row[], drop: string[] = []) {
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
  const realReaddir = fs.readdirSync, realRead = fs.readFileSync
  const rd = jest.spyOn(fs, 'readdirSync').mockImplementation(((d: any, o?: any) =>
    path.resolve(String(d)) === path.resolve(sqlDir)
      ? [...((realReaddir as any)(d, o) as string[]).filter(f => !drop.includes(f)), ...Object.keys(extra)] : (realReaddir as any)(d, o)) as any)
  const rf = jest.spyOn(fs, 'readFileSync').mockImplementation(((f: any, o?: any) =>
    path.resolve(path.dirname(String(f))) === path.resolve(sqlDir) && extra[path.basename(String(f))] !== undefined
      ? extra[path.basename(String(f))] : (realRead as any)(f, o)) as any)
  try {
    await runner.runMigrationsForSchema('setes_setes')
    return { ok: true as const, executed, error: '' }
  } catch (e: any) {
    return { ok: false as const, executed, error: String(e?.message ?? e) }
  } finally { rd.mockRestore(); rf.mockRestore() }
}

beforeEach(() => jest.clearAllMocks())

// =================================================================================================
// 1. A lápide SENTINELA diante dos DOIS runners (o do main — produção depois do aborto — e o da F2a)
// =================================================================================================
describe('1 — D-F162: o runner do MAIN (árvore viva) e o da F2a diante da lápide sentinela', () => {
  // o `_migrations` de PRODUÇÃO depois de um aborto: as do main aplicadas (o que a árvore viva tem) + a LÁPIDE sentinela
  // o main ANTES da janela = as migrations até a 068 (a 069 é a da F2a e o que vier depois é posterior): o cenário é histórico e não pode
  // depender do estado da árvore viva de hoje (que já tem a 069 e terá a 070…)
  const OLD_MAIN_LAST = 68
  const mainFiles = filesOf(MAIN_SQL).filter(f => Number(f.version) <= OLD_MAIN_LAST)
  const afterOldMain = filesOf(MAIN_SQL).filter(f => Number(f.version) > OLD_MAIN_LAST).map(f => f.file)   // somem do diretório simulado
  const applied: Row[] = [...mainFiles.map(f => ({ version: f.version, name: f.name })), { version: F2A_TOMBSTONE_VERSION, name: F2A_TOMBSTONE_NAME }]
  const nextNumber = String(Number(mainFiles[mainFiles.length - 1].version) + 1).padStart(3, '0')

  it('[RESISTIU] o código ANTIGO (o main que roda depois do aborto) sobe com a lápide e a PRÓXIMA migration do main — com o número que a F2a tinha — RODA (nada de "duas migrations com o mesmo número")', async () => {
    expect(nextNumber).toBe('069')                                          // o número que a F2a ocupava é o próximo livre do main hoje
    const r = await runWith(mainRunner, MAIN_SQL, { [`${nextNumber}_ibscbs_ib2.sql`]: 'SELECT 1;' }, applied, afterOldMain)
    expect([r.ok, r.error]).toEqual([true, ''])
    expect(r.executed.filter(s => /INSERT INTO _migrations/.test(s))).toEqual([`INSERT INTO _migrations (version, name) VALUES (?, ?) ["${nextNumber}","ibscbs_ib2"]`])
    expect(r.executed.some(s => /CREATE TRIGGER/.test(s))).toBe(false)
  })

  it('[RESISTIU] o código da F2a (mesmo renumerado depois do main andar) RECUSA subir sobre a lápide sentinela e não executa nada', async () => {
    for (const f2aFile of ['069_f2a_fiscal_passivo.sql', '071_f2a_fiscal_passivo.sql']) {
      const mainNext = { [`${nextNumber}_ibscbs_ib2.sql`]: 'SELECT 1;' }
      const extra = f2aFile.startsWith('069') ? {} : mainNext
      const appl = f2aFile.startsWith('069') ? applied : [...applied, { version: nextNumber, name: 'ibscbs_ib2' }]
      // renumerada = o arquivo 069 da F2a sai do diretório (rebase sobre o main) e entra o 071
      const r = await runWith(f2aRunner, F2A_SQL, f2aFile.startsWith('069') ? extra : { ...extra, [f2aFile]: PASSIVO_SQL }, appl,
        f2aFile.startsWith('069') ? [] : ['069_f2a_fiscal_passivo.sql'])
      expect([f2aFile, r.ok, /ABORTADA[\s\S]*F2A-ABORT[\s\S]*D-F153/.test(r.error)]).toEqual([f2aFile, false, true])
      expect(r.executed.filter(s => /CREATE TRIGGER|INSERT INTO _migrations/.test(s))).toEqual([])
    }
  })

  it('[FATO — residual da forma ANTIGA] uma lápide NUMÉRICA (aborto feito antes da D-F162) + a migration do main com o mesmo número: o runner do MAIN cai na frase genérica ("duas migrations com o mesmo número") — só existe em banco descartável (o aborto nunca rodou em produção — 0 linhas `f2a%` no `_migrations` do dev em 2026-10-13)', async () => {
    const old = [...mainFiles.map(f => ({ version: f.version, name: f.name })), { version: nextNumber, name: F2A_TOMBSTONE_NAME }]
    const r = await runWith(mainRunner, MAIN_SQL, { [`${nextNumber}_ibscbs_ib2.sql`]: 'SELECT 1;' }, old, afterOldMain)
    expect([r.ok, /aplicada como "f2a_fiscal_passivo_abortada"[\s\S]*Renumere/.test(r.error)]).toEqual([false, true])
  })
})

// =================================================================================================
// 2. PARTE VIVA (opt-in): F2A_ADV_LIVE=1 — bancos DESCARTÁVEIS f2a_advr6_*, criados e apagados aqui
// =================================================================================================
const live = process.env.F2A_ADV_LIVE === '1'
if (!live) it('ao vivo desligado (F2A_ADV_LIVE=1 liga a parte 2)', () => { expect(live).toBe(false) })
if (live) describe('ao vivo (MariaDB do dev, bancos descartáveis f2a_advr6_*)', () => {
  jest.setTimeout(180_000)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mysql = jest.requireActual('mysql2/promise') as typeof import('mysql2/promise')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv') as typeof import('dotenv')
  const env = dotenv.parse(fs.readFileSync(path.join(REPO, '.env')))
  const TAG = Date.now().toString(36)
  const E = `f2a_advr6_${TAG}_erp`
  const F = `f2a_advr6_${TAG}_fis`
  const C = `f2a_advr6_${TAG}_cen`
  const INST = 1
  const opts = { fiscalDb: F, centralDb: C }
  let c: any
  const rows = async (): Promise<Row[]> => ((await c.query(`SELECT version, name FROM \`${E}\`._migrations ORDER BY version ASC`))[0] as any[])
    .map(r => ({ version: String(r.version), name: String(r.name) }))
  const triggers = async () => Number(((await c.query(`SELECT COUNT(*) n FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ?`, [E]))[0] as any[])[0].n)
  const apply069 = async (version: string) => {
    await c.query(`USE \`${E}\``)
    for (const s of f2aRunner.splitStatements(PASSIVO_SQL)) await c.query(s)
    await c.query(`INSERT INTO \`${E}\`._migrations (version, name) VALUES (?, 'f2a_fiscal_passivo')`, [version])
  }
  const dropTriggers = async () => {
    const [t] = await c.query(`SELECT TRIGGER_NAME n FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ?`, [E])
    for (const r of t as any[]) await c.query(`DROP TRIGGER \`${E}\`.\`${r.n}\``)
  }
  /** O D-F50 do ato da virada (nfse-api `scripts/migrate-from-setes-api.ts` — `setesApiF2aApplied`): a MESMA consulta. */
  const cutoverSeesF2a = async () => ((await c.query(`SELECT 1 AS x FROM \`${E}\`._migrations WHERE name = ? LIMIT 1`, ['f2a_fiscal_passivo']))[0] as any[]).length > 0
  const mainFiles = filesOf(MAIN_SQL)

  beforeAll(async () => {
    c = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD })
    for (const db of [E, F, C]) {
      if (!/^f2a_advr6_/.test(db)) throw new Error(`banco fora do prefixo descartável: ${db}`)
      await c.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    }
    for (const t of ['tb_establishment_issuer', 'tb_invoice_service', 'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event', '_migrations']) {
      await c.query(`CREATE TABLE \`${E}\`.\`${t}\` LIKE setes_setes.\`${t}\``)           // a FORMA de produção (o `_migrations` inclusive)
    }
    await c.query(`INSERT INTO \`${E}\`._migrations (version, name) SELECT version, name FROM setes_setes._migrations`)   // só LIDO
    await c.query(`INSERT INTO \`${E}\`.tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, created_at, updated_at, deleted)
                   VALUES (?, 'SE', 'P', '1', 10, NOW(), NOW(), 'N')`, [INST])
    await c.query(`CREATE TABLE \`${F}\`.tb_establishment_issuer (tb_institution_id INT NOT NULL, model VARCHAR(2) NOT NULL, cutover_at DATETIME NULL, PRIMARY KEY (tb_institution_id, model))`)
    await c.query(`INSERT INTO \`${F}\`.tb_establishment_issuer VALUES (?, 'SE', NULL)`, [INST])
    await c.query(`CREATE TABLE \`${C}\`.tb_institution (id INT PRIMARY KEY, schema_name VARCHAR(64) NOT NULL)`)
    await c.query(`INSERT INTO \`${C}\`.tb_institution VALUES (?, ?)`, [INST, E])
  })

  afterAll(async () => {
    if (!c) return
    for (const db of [E, F, C]) await c.query(`DROP DATABASE IF EXISTS \`${db}\``)
    const [left] = await c.query(`SHOW DATABASES LIKE 'f2a\\_advr6%'`)
    await c.end()
    if ((left as any[]).length) throw new Error(`sobrou banco descartável: ${JSON.stringify(left)}`)
  })

  it('[RESISTIU] o CICLO inteiro na forma de produção: 069 aplicada → aborto (lápide F2A-ABORT, 0 gatilhos, o ato da virada não vê a F2a) → o main publica a 069 dele e RODA → a F2a renumerada (070) recusa pela lápide → --retirar-lapide → a F2a sobe → 2º aborto e 2º retirar sem colisão da UNIQUE', async () => {
    await apply069('069')
    expect([await triggers(), await cutoverSeesF2a()]).toEqual([9, true])
    const ab1 = await abortTool.abortF2aPassivo(c, E, INST, { vai: true, ...opts })
    expect([ab1.tombstone, await triggers(), await cutoverSeesF2a()]).toEqual([true, 0, false])
    expect((await rows()).filter(r => /f2a/.test(r.name))).toEqual([{ version: 'F2A-ABORT', name: F2A_TOMBSTONE_NAME }])
    // o main (árvore viva) sobre o _migrations REAL deste schema + a 069 dele: confere e só a 069 fica pendente
    const withIb2 = [...mainFiles, { version: '069', name: 'ibscbs_ib2', file: '069_ibscbs_ib2.sql' }]
    const versions = new Set(await rowsSync())
    expect(() => mainRunner.assertAppliedMatchFiles(withIb2, rowsCache, E)).not.toThrow()
    expect(withIb2.filter(f => !versions.has(f.version)).map(f => f.file)).toEqual(['069_ibscbs_ib2.sql'])   // o `pending` do runner
    await c.query(`INSERT INTO \`${E}\`._migrations (version, name) VALUES ('069', 'ibscbs_ib2')`)          // o main aplicou a dele
    await rowsSync()
    // a F2a renumerada (070) sobre o schema abortado: recusa pelo NOME
    const f2aFiles = [...withIb2, { version: '070', name: F2A_PASSIVO_NAME, file: '070_f2a_fiscal_passivo.sql' }]
    expect(() => f2aRunner.assertAppliedMatchFiles(f2aFiles, rowsCache, E)).toThrow(/ABORTADA[\s\S]*F2A-ABORT/)
    // voltar à F2a (ato deliberado) — e a F2a NÃO renumerada esbarra na 069 do main
    const rm = await abortTool.removeF2aTombstone(c, E, INST, { vai: true, ...opts })
    expect(rm.tombstone).toBe(false)
    await rowsSync()
    expect(() => f2aRunner.assertAppliedMatchFiles(f2aFiles, rowsCache, E)).not.toThrow()
    expect(() => f2aRunner.assertAppliedMatchFiles([...mainFiles, { version: '069', name: F2A_PASSIVO_NAME, file: '069_f2a_fiscal_passivo.sql' }], rowsCache, E))
      .toThrow(/069 foi aplicada como "ibscbs_ib2"/)
    // a F2a sobe (070) e é abortada DE NOVO — a sentinela já saiu na retirada: sem colisão da UNIQUE
    await apply069('070')
    const ab2 = await abortTool.abortF2aPassivo(c, E, INST, { vai: true, ...opts })
    expect([ab2.tombstone, await triggers()]).toEqual([true, 0])
    expect((await rows()).filter(r => /f2a/.test(r.name))).toEqual([{ version: 'F2A-ABORT', name: F2A_TOMBSTONE_NAME }])
    await abortTool.removeF2aTombstone(c, E, INST, { vai: true, ...opts })
    expect((await rows()).filter(r => /f2a|ibscbs_ib2/.test(r.name))).toEqual([{ version: '069', name: 'ibscbs_ib2' }])
    await c.query(`DELETE FROM \`${E}\`._migrations WHERE name = 'ibscbs_ib2'`)
  })

  let rowsCache: Row[] = []
  async function rowsSync(): Promise<string[]> { rowsCache = await rows(); return rowsCache.map(r => r.version) }

  it('[RESISTIU — falha FECHADA, frase crua] a versão SENTINELA já ocupada por OUTRA linha (nome diferente — escrita à mão): o UPDATE da lápide bate na UNIQUE ANTES dos DROPs — nada cai (9 gatilhos, a linha da migration intacta); a mensagem é a do MariaDB (ER_DUP_ENTRY), sem dizer o que fazer', async () => {
    await apply069('069')
    await c.query(`INSERT INTO \`${E}\`._migrations (version, name) VALUES ('F2A-ABORT', 'marcador_manual')`)
    const err: any = await abortTool.abortF2aPassivo(c, E, INST, { vai: true, ...opts }).catch(x => x)
    expect([err?.code, await triggers(), await cutoverSeesF2a()]).toEqual(['ER_DUP_ENTRY', 9, true])
    await c.query(`DELETE FROM \`${E}\`._migrations WHERE name IN ('marcador_manual', 'f2a_fiscal_passivo')`)
    await dropTriggers()
  })

  it('[RESISTIU] DUAS lápides (a numérica antiga + a sentinela): o aborto não duplica nem colide (gatilhos sem linha só caem); o --retirar-lapide leva AS DUAS; linha + lápide = recusa sem tocar em nada', async () => {
    await c.query(`INSERT INTO \`${E}\`._migrations (version, name) VALUES ('900', ?), ('F2A-ABORT', ?)`, [F2A_TOMBSTONE_NAME, F2A_TOMBSTONE_NAME])
    await c.query(`USE \`${E}\``)
    for (const s of f2aRunner.splitStatements(PASSIVO_SQL)) await c.query(s)                       // gatilhos SEM a linha (lápide já lá)
    const ab = await abortTool.abortF2aPassivo(c, E, INST, { vai: true, ...opts })
    expect([ab.tombstone, await triggers(), (await rows()).filter(r => r.name === F2A_TOMBSTONE_NAME).length]).toEqual([true, 0, 2])
    // linha + lápide (alguém reaplicou sem tirar a lápide): o aborto RECUSA e nada cai
    await apply069('069')
    const refused: any = await abortTool.abortF2aPassivo(c, E, INST, { vai: true, ...opts }).catch(x => x)
    expect([/E a lápide/.test(String(refused?.message)), await triggers()]).toEqual([true, 9])
    await dropTriggers()
    await c.query(`DELETE FROM \`${E}\`._migrations WHERE name = 'f2a_fiscal_passivo'`)
    await abortTool.removeF2aTombstone(c, E, INST, { vai: true, ...opts })
    expect((await rows()).filter(r => /f2a/.test(r.name))).toEqual([])
  })
})
