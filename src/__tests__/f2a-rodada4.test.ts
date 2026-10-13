/// <reference types="jest" />
// F2a — Rodada 4 (gates da A3), Valdo 2026-10-13: "siga as recomendações" (`prompt_apis_fiscais_isoladas.md` §22.13.2 → D-F130…D-F136;
// execução no §22.16). Aqui: D-F135 (o BOOT confere os gatilhos de TRAVA da `f2a_fiscal_passivo` pelo nome — a lista é a própria migration)
// e D-F130 na porta (a falha da leitura da voz sai TIPADA; contenção NÃO). D-F131/D-F141 estão em `f2a-a3-rotas.test.ts`; D-F136 no núcleo.
import fs from 'fs'
import path from 'path'

jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFR4XXX'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() } }))

import { f2aFreezeTriggerSpecs, f2aFreezeTriggersMissing, assertF2aFreezeTriggers } from '../migrations/f2a-freeze-triggers'
import { readServiceVoiceOfLife, FiscalVoiceUnavailableError } from '../shared/fiscal-voice'
import * as crash from '../shared/errors/crash.repository'

const SPECS = f2aFreezeTriggerSpecs()
const rowsOf = (over: Record<string, object> = {}, drop: string[] = []) => SPECS.filter(t => !drop.includes(t.name)).map(t => ({
  name: t.name, tbl: t.table, ev: t.event, timing: 'BEFORE', body: t.body, ...(over[t.name] ?? {}),
}))

describe('D-F135 — o boot confere os gatilhos de TRAVA da F2a pelo NOME (a lista é a própria migration)', () => {
  it('a lista vem dos CREATE TRIGGER da f2a_fiscal_passivo (pelo divisor do runner): os 9, nas 3 tabelas, nos 3 eventos', () => {
    expect(SPECS).toHaveLength(9)
    const byTable = (tb: string) => SPECS.filter(t => t.table === tb).map(t => t.event).sort()
    for (const tb of ['tb_invoice_service_transmission', 'tb_invoice_service_transmission_event', 'tb_establishment_issuer']) {
      expect([tb, byTable(tb)]).toEqual([tb, ['DELETE', 'INSERT', 'UPDATE']])
    }
    expect(SPECS.every(t => /^tg_f2a_freeze_/.test(t.name))).toBe(true)
  })
  it('pasta sem a migration (antes da F2a) → lista vazia e o boot diz isso (não falha) ', async () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'f2a-r4-'))
    fs.writeFileSync(path.join(tmp, '068_order_interface_view_bin.sql'), 'SELECT 1;')
    expect(f2aFreezeTriggerSpecs(tmp)).toEqual([])
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  it('todos presentes → nada falta; a consulta é escopada pelo schema e pelos nomes', async () => {
    const q = { query: jest.fn(async () => [rowsOf(), []]) }
    expect(await f2aFreezeTriggersMissing(q, 'setes_setes')).toEqual([])
    const [sql, params] = (q.query.mock.calls[0] as unknown) as [string, unknown[]]
    expect(sql).toMatch(/FROM information_schema\.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = \? AND TRIGGER_NAME IN \(\?\)/)   // F2AR4-SOC-04
    expect(params).toEqual(['setes_setes', SPECS.map(t => t.name)])
  })
  it('DROP TRIGGER → ausente; corpo sem SIGNAL / AFTER / outro evento / outra tabela → diferente; nenhum visível (sem o privilégio TRIGGER) → os 9', async () => {
    const one = SPECS[4].name
    expect(await f2aFreezeTriggersMissing({ query: jest.fn(async () => [rowsOf({}, [one])]) }, 'setes_setes')).toEqual([`${one} ausente`])
    for (const over of [{ body: 'BEGIN END' }, { timing: 'AFTER' }, { ev: 'X' }, { tbl: 'tb_outra' }]) {
      const out = await f2aFreezeTriggersMissing({ query: jest.fn(async () => [rowsOf({ [one]: over })]) }, 'setes_setes')
      expect(out).toHaveLength(1); expect(out[0]).toMatch(new RegExp(`^${one} diferente`))
    }
    expect(await f2aFreezeTriggersMissing({ query: jest.fn(async () => [[]]) }, 'setes_setes')).toHaveLength(9)
    await expect(f2aFreezeTriggersMissing({ query: jest.fn() }, 'x`; DROP')).rejects.toThrow()       // schema hostil: recusa antes do SQL
  })
  it('assertF2aFreezeTriggers: todo schema ATIVO conferido; um com gatilho faltando → o boot FALHA ALTO nomeando o schema e o gatilho', async () => {
    const q = { query: jest.fn(async (sql: string, p?: unknown[]) => {
      if (/FROM setes_central\.tb_institution/.test(sql)) return [[{ schema_name: 'setes_setes' }, { schema_name: 'setes_outro' }]]
      return [(p as any[])[0] === 'setes_outro' ? rowsOf({}, ['tg_f2a_freeze_issuer_se_bu']) : rowsOf()]
    }) }
    await expect(assertF2aFreezeTriggers(q)).rejects.toThrow(/D-F135[\s\S]*setes_outro: tg_f2a_freeze_issuer_se_bu ausente/)
    const ok = { query: jest.fn(async (sql: string) => (/tb_institution/.test(sql) ? [[{ schema_name: 'setes_setes' }]] : [rowsOf()])) }
    expect(await assertF2aFreezeTriggers(ok)).toBe('9 gatilho(s) em 1 schema(s)')
  })
  it('o boot roda a conferência DEPOIS das migrations e ANTES de subir a porta, dentro do try que derruba o processo', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8')
    const mig = src.indexOf('await runMigrationsForAllInstitutions()'), chk = src.indexOf('await assertF2aFreezeTriggers()'), listen = src.indexOf('app.listen(')
    expect(mig).toBeGreaterThan(0); expect(chk).toBeGreaterThan(mig); expect(listen).toBeGreaterThan(chk)
    expect(src.slice(src.indexOf('try {'), src.indexOf('} catch (err)'))).toContain('assertF2aFreezeTriggers()')
  })
})

describe('D-F130 — a porta da voz: falha de LEITURA sai tipada (503 + ref + alarme); CONTENÇÃO segue crua', () => {
  beforeEach(() => jest.clearAllMocks())
  it('GRANT revogado (1142) / view sumida (1146) / coluna faltando (1054) → FiscalVoiceUnavailableError com o alarme gravado (causa no log, nunca na mensagem)', async () => {
    for (const [errno, code] of [[1142, 'ER_TABLEACCESS_DENIED_ERROR'], [1146, 'ER_NO_SUCH_TABLE'], [1054, 'ER_BAD_FIELD_ERROR']] as const) {
      const q = { query: jest.fn().mockRejectedValue(Object.assign(new Error(`${code} detalhe interno`), { errno, code })) }
      const err: any = await readServiceVoiceOfLife(q, 1, 7400, 1).catch(e => e)
      expect(err).toBeInstanceOf(FiscalVoiceUnavailableError)
      expect([err.statusCode, err.code, err.ref]).toEqual([503, 'FISCAL_VOICE_UNAVAILABLE', 'REFR4XXX'])
      expect(err.message).not.toMatch(/detalhe interno/); expect(err.causeMessage).toMatch(/detalhe interno/)
    }
    expect(crash.recordCrash).toHaveBeenCalledTimes(3)
    expect(crash.recordCrash).toHaveBeenCalledWith(expect.objectContaining({ code: 'FISCAL_VOICE_UNAVAILABLE', statusCode: 503, institutionId: 1 }))
  })
  it('lock wait (1205) e deadlock (1213) NÃO são voz ilegível: sobem CRUS (o retry e o 409 de sempre), sem alarme', async () => {
    for (const code of ['ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK']) {
      const raw = Object.assign(new Error(code), { code })
      await expect(readServiceVoiceOfLife({ query: jest.fn().mockRejectedValue(raw) }, 1, 7400, 1)).rejects.toBe(raw)
    }
    expect(crash.recordCrash).not.toHaveBeenCalled()
  })
})
