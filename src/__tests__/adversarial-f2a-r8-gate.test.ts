/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA da Rodada 8 da F2a/F2b (2026-10-13 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §7 D-F153/D-F162, §22.13 roteiro do ABORTO). O delta do setes-api é só teste (`f5d2be2..6dbb5af`); aqui
// fica a PROVA AO VIVO da cadeia que a correção R7-ADV-04 da nfse-api promete ("lápide + gatilhos de pé = o aborto ficou pela METADE →
// rode o aborto de novo; só depois o `--retirar-lapide`"), com o aborto do setes-api INTERROMPIDO de verdade no meio dos DROPs e a função
// REAL do ato da nfse-api (`f2aFreezeTriggersMissing`, `../nfse-api/scripts/cutover-erp.ts`) lendo o `information_schema` do MariaDB.
// Convenção: `it('[RESISTIU] …')` = o ataque foi barrado; `it('[FATO …]')` = comportamento atual registrado.
// Parte 1 sempre roda (sem banco). Parte 2 (opt-in F2A_ADV_LIVE=1): bancos DESCARTÁVEIS `f2a_advr8_*` criados e apagados aqui — o schema
// real `setes_setes` é só LIDO (CREATE TABLE … LIKE e o SELECT das linhas do `_migrations`).
import fs from 'fs'
import path from 'path'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))

import * as f2aRunner from '../migrations/runner'
import { f2aFreezeTriggerSpecs, F2A_TOMBSTONE_NAME, F2A_TOMBSTONE_VERSION, F2A_PASSIVO_NAME } from '../migrations/f2a-freeze-triggers'

const REPO = path.join(__dirname, '..', '..')
const NFSE = path.resolve(REPO, '..', 'nfse-api')
const F2A_SQL = path.join(REPO, 'src', 'migrations', 'sql')
const PASSIVO_SQL = fs.readFileSync(path.join(F2A_SQL, '069_f2a_fiscal_passivo.sql'), 'utf8')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const abortTool = require(path.join(REPO, 'scripts', 'f2a-abort-before-cutover')) as {
  abortF2aPassivo: (c: any, s: string, i: number, o: { vai: boolean; fiscalDb: string; centralDb?: string }) => Promise<any>
  removeF2aTombstone: (c: any, s: string, i: number, o: { vai: boolean; fiscalDb: string; centralDb?: string }) => Promise<any>
}
const NFSE_CUTOVER = path.join(NFSE, 'scripts', 'cutover-erp.ts')
const ATO = path.join(NFSE, 'scripts', 'migrate-from-setes-api.ts')

// =================================================================================================
// 1. Sem banco: a regra do ato (como o fonte da nfse-api a escreve) × o que o aborto do setes-api deixa
// =================================================================================================
describe('1 — a regra da "metade" no ato × os gatilhos do setes-api (sem banco)', () => {
  it('[RESISTIU — cerca] a lista de gatilhos que o ATO confere (`F2A_FREEZE_TRIGGERS` da nfse-api, o módulo REAL) é a MESMA — nome, tabela, evento e corpo normalizado — que a migration da F2a cria e o aborto derruba (`f2aFreezeTriggerSpecs`): a conta "9 − ausentes" da "metade" no ato só vale se as duas listas forem iguais', () => {
    if (!fs.existsSync(NFSE_CUTOVER)) return
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { F2A_FREEZE_TRIGGERS } = require(NFSE_CUTOVER) as { F2A_FREEZE_TRIGGERS: Record<string, readonly [string, string, string]> }
    const ato = Object.entries(F2A_FREEZE_TRIGGERS).map(([name, [table, event, body]]) => ({ name, table, event, body }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const ours = f2aFreezeTriggerSpecs().map(t => ({ name: t.name, table: t.table, event: t.event, body: t.body }))
      .sort((a, b) => a.name.localeCompare(b.name))
    expect(ato).toHaveLength(9)
    expect(ato).toEqual(ours)
    const atoSrc = fs.existsSync(ATO) ? fs.readFileSync(ATO, 'utf8') : ''
    expect(atoSrc).toMatch(/Object\.keys\(F2A_FREEZE_TRIGGERS\)\.length - \(await f2aFreezeTriggersMissing\(pool, s\)\)\.filter\(m => m\.endsWith\(' ausente'\)\)\.length/)
  })
})

// =================================================================================================
// 2. PARTE VIVA (opt-in): F2A_ADV_LIVE=1 — bancos DESCARTÁVEIS f2a_advr8_*, criados e apagados aqui
// =================================================================================================
const live = process.env.F2A_ADV_LIVE === '1'
if (!live) it('ao vivo desligado (F2A_ADV_LIVE=1 liga a parte 2)', () => { expect(live).toBe(false) })
if (live) describe('ao vivo (MariaDB do dev, bancos descartáveis f2a_advr8_*)', () => {
  jest.setTimeout(180_000)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mysql = jest.requireActual('mysql2/promise') as typeof import('mysql2/promise')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv') as typeof import('dotenv')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cutoverErp = require(NFSE_CUTOVER) as {
    f2aFreezeTriggersMissing: (q: { query: (sql: string, p?: unknown[]) => Promise<any> }, s: string) => Promise<string[]>
    F2A_FREEZE_TRIGGERS: Record<string, unknown>
  }
  const env = dotenv.parse(fs.readFileSync(path.join(REPO, '.env')))
  const TAG = Date.now().toString(36)
  const E = `f2a_advr8_${TAG}_erp`
  const F = `f2a_advr8_${TAG}_fis`
  const C = `f2a_advr8_${TAG}_cen`
  const INST = 1
  const opts = { fiscalDb: F, centralDb: C }
  let c: any
  const triggers = async () => Number(((await c.query(`SELECT COUNT(*) n FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ?`, [E]))[0] as any[])[0].n)
  const f2aRows = async () => ((await c.query(`SELECT version, name FROM \`${E}\`._migrations WHERE name LIKE 'f2a%' ORDER BY name`))[0] as any[])
    .map(r => ({ version: String(r.version), name: String(r.name) }))
  const apply069 = async () => {
    await c.query(`USE \`${E}\``)
    for (const s of f2aRunner.splitStatements(PASSIVO_SQL)) await c.query(s)
    await c.query(`INSERT INTO \`${E}\`._migrations (version, name) VALUES ('069', ?)`, [F2A_PASSIVO_NAME])
  }
  /** As leituras do ATO da nfse-api (`setesApiF2aApplied` / `setesApiF2aAborted` — as MESMAS consultas) + a conta da "metade" dele. */
  const atoSees = async () => {
    const applied = ((await c.query(`SELECT 1 AS x FROM \`${E}\`._migrations WHERE name = ? LIMIT 1`, [F2A_PASSIVO_NAME]))[0] as any[]).length > 0
    const tomb = ((await c.query(`SELECT name FROM \`${E}\`._migrations WHERE name = ? LIMIT 1`, [F2A_TOMBSTONE_NAME]))[0] as any[])
      .some(r => r?.name === F2A_TOMBSTONE_NAME)
    const missing = await cutoverErp.f2aFreezeTriggersMissing(c, E)
    const halfway = tomb && !applied ? Object.keys(cutoverErp.F2A_FREEZE_TRIGGERS).length - missing.filter(m => m.endsWith(' ausente')).length : 0
    return { applied, tomb, missing: missing.length, halfway }
  }

  beforeAll(async () => {
    c = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD })
    for (const db of [E, F, C]) {
      if (!/^f2a_advr8_/.test(db)) throw new Error(`banco fora do prefixo descartável: ${db}`)
      await c.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    }
    for (const t of ['tb_establishment_issuer', 'tb_invoice_service', 'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event', '_migrations']) {
      await c.query(`CREATE TABLE \`${E}\`.\`${t}\` LIKE setes_setes.\`${t}\``)           // a FORMA de produção
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
    const [left] = await c.query(`SHOW DATABASES LIKE 'f2a\\_advr8%'`)
    await c.end()
    if ((left as any[]).length) throw new Error(`sobrou banco descartável: ${JSON.stringify(left)}`)
  })

  it('[RESISTIU — a cadeia do R7-ADV-04 ao vivo] 069 aplicada (o ato vê a F2a e os 9 gatilhos IGUAIS à migration — 0 "diferente" no MariaDB real) → aborto com a conexão CAINDO no 6º DROP (sobram lápide + 4 gatilhos) → o ato diz "PELA METADE (4)", o runner da F2a recusa, o `--retirar-lapide` recusa → o aborto rodado DE NOVO termina (0 gatilhos, só a lápide sentinela) → o ato passa à frase do `--retirar-lapide`, que agora ACEITA → a F2a pode voltar', async () => {
    await apply069()
    expect(await atoSees()).toEqual({ applied: true, tomb: false, missing: 0, halfway: 0 })
    let drops = 0
    const flaky = {
      query: async (sql: string, p?: unknown[]) => {
        if (/^\s*DROP TRIGGER/i.test(sql) && ++drops === 6) throw Object.assign(new Error('Lost connection to MySQL server during query'), { code: 'PROTOCOL_CONNECTION_LOST' })
        return c.query(sql, p)
      },
    }
    const err: any = await abortTool.abortF2aPassivo(flaky, E, INST, { vai: true, ...opts }).catch(x => x)
    expect(err?.code).toBe('PROTOCOL_CONNECTION_LOST')
    expect([await triggers(), await f2aRows()]).toEqual([4, [{ version: F2A_TOMBSTONE_VERSION, name: F2A_TOMBSTONE_NAME }]])
    expect(await atoSees()).toEqual({ applied: false, tomb: true, missing: 5, halfway: 4 })
    const files = fs.readdirSync(F2A_SQL).filter(f => f.endsWith('.sql')).sort()
      .map(file => { const [version, ...rest] = file.replace('.sql', '').split('_'); return { version, name: rest.join('_'), file } })
    const appliedNow = ((await c.query(`SELECT version, name FROM \`${E}\`._migrations`))[0] as any[]).map(r => ({ version: String(r.version), name: String(r.name) }))
    expect(() => f2aRunner.assertAppliedMatchFiles(files as any, appliedNow, E)).toThrow(/ABORTADA/)
    await expect(abortTool.removeF2aTombstone(c, E, INST, { vai: true, ...opts })).rejects.toThrow(/lápide COM gatilho/)
    expect(await triggers()).toBe(4)                                                       // a recusa não mexeu em nada
    const again = await abortTool.abortF2aPassivo(c, E, INST, { vai: true, ...opts })
    expect([again.migrationRow, again.triggers.length, again.tombstone, await triggers()]).toEqual([false, 4, true, 0])
    expect(await atoSees()).toEqual({ applied: false, tomb: true, missing: 9, halfway: 0 })
    const rm = await abortTool.removeF2aTombstone(c, E, INST, { vai: true, ...opts })
    expect([rm.tombstone, await f2aRows()]).toEqual([false, []])
  })

  it('[RESISTIU] lápide NUMÉRICA antiga (versão "069", forma anterior à D-F162) + 2 gatilhos de pé: o ato a reconhece pelo NOME e conta a metade (2); o aborto rodado de novo termina sem trocar a versão (a lápide antiga fica como está)', async () => {
    await c.query(`USE \`${E}\``)
    for (const s of f2aRunner.splitStatements(PASSIVO_SQL)) await c.query(s)
    const names = f2aFreezeTriggerSpecs().map(t => t.name).sort()
    for (const n of names.slice(2)) await c.query(`DROP TRIGGER \`${E}\`.\`${n}\``)
    await c.query(`INSERT INTO \`${E}\`._migrations (version, name) VALUES ('069', ?)`, [F2A_TOMBSTONE_NAME])
    expect(await atoSees()).toEqual({ applied: false, tomb: true, missing: 7, halfway: 2 })
    const ab = await abortTool.abortF2aPassivo(c, E, INST, { vai: true, ...opts })
    expect([ab.triggers.length, await triggers(), await f2aRows()]).toEqual([2, 0, [{ version: '069', name: F2A_TOMBSTONE_NAME }]])
    await abortTool.removeF2aTombstone(c, E, INST, { vai: true, ...opts })
    expect(await f2aRows()).toEqual([])
  })
})
