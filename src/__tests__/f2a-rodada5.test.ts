/// <reference types="jest" />
// F2a — Rodada 5 (questões dos gates do delta da Rodada 4 e da F2b), Valdo 2026-10-13: "siga as recomendações" (§7 D-F151…D-F154 do
// `prompt_apis_fiscais_isoladas.md`; execução no §22.18). Aqui, o lado do setes-api:
//   D-F151 — a porta da voz separa FONTE × CONTRATO (mesmo 503 e código para o app; mensagem e alarme honestos; o alarme leva o autor)
//   D-F152 — "reaplicar a trava do schema X" (scripts/f2a-reapply-freeze.ts) e o boot apontando para ela
//   D-F153 — o aborto deixa a LÁPIDE no _migrations; o runner do código novo recusa subir sobre ela; voltar = --retirar-lapide
// (D-F154 — C/K ⇒ registro — está no núcleo e no gate da Rodada 4.)
import fs from 'fs'
import path from 'path'

jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFR5XXX'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() } }))

import { readServiceVoiceOfLife, FiscalVoiceUnavailableError, voiceFailureCause } from '../shared/fiscal-voice'
import { runAsActor, currentActor } from '../shared/request-actor'
import * as crash from '../shared/errors/crash.repository'
import { assertAppliedMatchFiles } from '../migrations/runner'
import { f2aFreezeStatements, f2aFreezeTriggerSpecs, f2aPassivoVersion, F2A_TOMBSTONE_NAME, F2A_TOMBSTONE_VERSION } from '../migrations/f2a-freeze-triggers'

const REPO = path.join(__dirname, '..', '..')
// scripts/ fica fora do rootDir do tsc (src) — require com o tipo usado
// eslint-disable-next-line @typescript-eslint/no-var-requires
const abort = require(path.join(REPO, 'scripts', 'f2a-abort-before-cutover')) as {
  abortF2aPassivo: (c: any, schema: string, id: number, o: { vai: boolean; fiscalDb: string; centralDb?: string }) => Promise<any>
  removeF2aTombstone: (c: any, schema: string, id: number, o: { vai: boolean; fiscalDb: string; centralDb?: string }) => Promise<any>
  parseAbortArgs: (argv: string[]) => { schema: string; institutionId: number; vai: boolean; resume: boolean }
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const reapply = require(path.join(REPO, 'scripts', 'f2a-reapply-freeze')) as {
  reapplyF2aFreeze: (c: any, schema: string, o: { vai: boolean }) => Promise<any>
  parseReapplyArgs: (argv: string[]) => { schema: string; vai: boolean }
}

const err = (code: string, errno: number, msg = code) => Object.assign(new Error(msg), { code, errno })

describe('D-F151 — a voz ilegível diz se a FONTE falhou ou o CONTRATO não fecha (mesmo 503 e código para o app)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('classificação: erro do driver/servidor (errno, sqlState, fatal, ER_*, conexão) = fonte; o resto (mapa, argumento, TypeError) = contrato', () => {
    for (const e of [err('ER_TABLEACCESS_DENIED_ERROR', 1142), err('ER_NO_SUCH_TABLE', 1146), Object.assign(new Error('x'), { code: 'ECONNRESET' }),
      Object.assign(new Error('x'), { fatal: true }), Object.assign(new Error('x'), { sqlState: '42S22' }), Object.assign(new Error('x'), { code: 'PROTOCOL_CONNECTION_LOST' })]) {
      expect([e.message, voiceFailureCause(e)]).toEqual([e.message, 'source'])
    }
    for (const e of [new Error('Linha da view com voz A (autorizada) SEM registro (D-F136)'), new TypeError("Cannot read properties of undefined"),
      new Error('institutionId inválido'), 'texto', null, Object.assign(new Error('x'), { code: 'OUTRO' })]) {
      expect(voiceFailureCause(e)).toBe('contract')
    }
  })

  it('R5-SOC-04: os erros do POOL do mysql2 (sem code nem errno — só a mensagem) são a FONTE; os POOL_* do pacote mysql não existem aqui', () => {
    for (const m of ['Pool is closed.', 'No connections available.', 'Queue limit reached.']) expect(voiceFailureCause(new Error(m))).toBe('source')
    expect(voiceFailureCause(new Error('Pool is closed'))).toBe('contract')
    expect(voiceFailureCause(Object.assign(new Error('Queue limit reached.'), { code: 'OUTRO' }))).toBe('contract')
  })

  it('FONTE → "tente de novo em instantes"; CONTRATO → "INCOERENTE … tentar de novo não resolve"; os dois 503 FISCAL_VOICE_UNAVAILABLE com o ref', async () => {
    const source = readServiceVoiceOfLife({ query: jest.fn().mockRejectedValue(err('ER_TABLEACCESS_DENIED_ERROR', 1142, 'SELECT command denied')) } as any, 1, 7400, 1)
    await expect(source).rejects.toMatchObject({ statusCode: 503, code: 'FISCAL_VOICE_UNAVAILABLE', ref: 'REFR5XXX', failureCause: 'source',
      message: expect.stringMatching(/tente de novo em instantes/) })
    const contract = readServiceVoiceOfLife({ query: jest.fn().mockResolvedValue([[{ authorityRecorded: 'talvez' }], []]) } as any, 1, 7400, 1)
    await expect(contract).rejects.toBeInstanceOf(FiscalVoiceUnavailableError)
    await expect(readServiceVoiceOfLife({ query: jest.fn().mockResolvedValue([[{ authorityRecorded: 'talvez' }], []]) } as any, 1, 7400, 1))
      .rejects.toMatchObject({ statusCode: 503, code: 'FISCAL_VOICE_UNAVAILABLE', failureCause: 'contract',
        message: expect.stringMatching(/INCOERENTE[\s\S]*tentar de novo não resolve/) })
  })

  it('o ALARME leva o AUTOR da requisição (runAsActor) e a causa na origem; fora de uma requisição = usuário 0', async () => {
    const q = { query: jest.fn().mockRejectedValue(err('ER_NO_SUCH_TABLE', 1146)) } as any
    await runAsActor({ institutionId: 1, userId: 77 }, () => expect(readServiceVoiceOfLife(q, 1, 7400, 1)).rejects.toBeInstanceOf(FiscalVoiceUnavailableError))
    expect((crash.recordCrash as jest.Mock).mock.calls[0][0]).toMatchObject({ userId: 77, institutionId: 1, origen: expect.stringMatching(/\(fonte\)$/) })
    await expect(readServiceVoiceOfLife({ query: jest.fn().mockResolvedValue([[{}], []]) } as any, 1, 7400, 1)).rejects.toBeInstanceOf(FiscalVoiceUnavailableError)
    expect((crash.recordCrash as jest.Mock).mock.calls[1][0]).toMatchObject({ userId: 0, origen: expect.stringMatching(/\(contrato\)$/) })
  })

  it('o autor vale nas continuações assíncronas e some fora delas; o authMiddleware fixa o autor ao aceitar o token (cerca no fonte)', async () => {
    const seen = await runAsActor({ institutionId: 3, userId: 9 }, async () => {
      await new Promise(r => setTimeout(r, 1))
      return currentActor()
    })
    expect([seen, currentActor()]).toEqual([{ institutionId: 3, userId: 9 }, null])
    const mw = fs.readFileSync(path.join(__dirname, '..', 'gateway', 'auth.middleware.ts'), 'utf8')
    expect(mw).toMatch(/runAsActor\(\{ institutionId: payload\.institutionId, userId: payload\.userId \}, next\)/)
  })
})

describe('D-F153 — a LÁPIDE do aborto', () => {
  const version = f2aPassivoVersion()!
  /** Banco falso: [names] = o que o _migrations tem (f2a_fiscal_passivo / lápide); [triggers] = os visíveis. */
  const fake = (names: string[], triggers: string[] = f2aFreezeTriggerSpecs().map(t => t.name)) => {
    const sqls: string[] = []
    let rows = [...names]
    let trg = [...triggers]
    const c = { query: jest.fn(async (sql: string, p: any[] = []) => {
      sqls.push(sql)
      if (/FROM `setes_central`\.tb_institution WHERE schema_name/.test(sql)) return [[{ id: 1 }]]
      if (/FROM `setes_\w+`\.tb_establishment_issuer/.test(sql)) return [[{ deleted: 'N' }]]
      if (/cutover_at IS NOT NULL/.test(sql)) return [[{ n: 0 }]]
      if (/information_schema\.TRIGGERS/.test(sql)) return [trg.map(name => ({ name }))]
      if (/^SELECT name FROM `setes_\w+`\._migrations/.test(sql)) return [rows.filter(n => (p as string[]).includes(n)).map(name => ({ name }))]
      if (/^DROP TRIGGER/.test(sql)) { trg = trg.filter(n => !sql.includes(n)); return [{}] }
      if (/^UPDATE `setes_\w+`\._migrations SET version = \?, name = \?/.test(sql)) { rows = rows.map(n => (n === p[2] ? p[1] : n)); return [{ affectedRows: 1 }] }
      if (/^INSERT INTO `setes_\w+`\._migrations/.test(sql)) { rows.push(p[1]); return [{ affectedRows: 1 }] }
      if (/^DELETE FROM `setes_\w+`\._migrations/.test(sql)) { rows = rows.filter(n => n !== p[0]); return [{ affectedRows: 1 }] }
      throw new Error(`SQL inesperado: ${sql.slice(0, 90)}`)
    }) }
    return { c, sqls, rows: () => rows, trg: () => trg }
  }

  it('o --vai DERRUBA os gatilhos e TROCA a linha pela lápide com a versão SENTINELA (D-F162 — o número fica livre) — nunca a apaga; a pós-condição confere', async () => {
    const f = fake(['f2a_fiscal_passivo'])
    const r = await abort.abortF2aPassivo(f.c, 'setes_setes', 1, { vai: true, fiscalDb: 'fiscal_api' })
    expect([r.triggers.length, r.migrationRow, r.tombstone, f.trg(), f.rows()]).toEqual([9, true, true, [], [F2A_TOMBSTONE_NAME]])
    expect(f.sqls.some(s => /^DELETE FROM/.test(s))).toBe(false)
    const upd = (f.c.query as jest.Mock).mock.calls.find(([s]: [string]) => /^UPDATE/.test(s))
    expect([F2A_TOMBSTONE_VERSION, upd[1]]).toEqual(['F2A-ABORT', ['F2A-ABORT', F2A_TOMBSTONE_NAME, 'f2a_fiscal_passivo']])
  })

  it('D-F162: a linha da migration E a lápide juntas (alguém reaplicou sem tirar a lápide) → RECUSA; nada muda', async () => {
    const f = fake(['f2a_fiscal_passivo', F2A_TOMBSTONE_NAME])
    await expect(abort.abortF2aPassivo(f.c, 'setes_setes', 1, { vai: true, fiscalDb: 'fiscal_api' })).rejects.toThrow(/E a lápide/)
    expect([f.trg().length, f.sqls.some(s => /^(UPDATE|DROP|INSERT)/.test(s))]).toEqual([9, false])
  })

  it('R5-SOC-05: a LÁPIDE é gravada ANTES do 1º DROP; a conexão cai no meio dos DROPs → rodar de novo TERMINA (lápide + os que sobraram)', async () => {
    const f = fake(['f2a_fiscal_passivo'])
    const real = f.c.query.getMockImplementation()!
    let drops = 0
    f.c.query.mockImplementation(async (sql: string, p?: any[]) => {
      if (/^DROP TRIGGER/.test(sql) && ++drops === 5) throw Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true })
      return real(sql, p)
    })
    await expect(abort.abortF2aPassivo(f.c, 'setes_setes', 1, { vai: true, fiscalDb: 'fiscal_api' })).rejects.toThrow(/Connection lost/)
    expect(f.sqls.findIndex(s => /^UPDATE/.test(s))).toBeLessThan(f.sqls.findIndex(s => /^DROP TRIGGER/.test(s)))
    expect([f.rows(), f.trg().length]).toEqual([[F2A_TOMBSTONE_NAME], 5])
    f.c.query.mockImplementation(real)
    const again = await abort.abortF2aPassivo(f.c, 'setes_setes', 1, { vai: true, fiscalDb: 'fiscal_api' })
    expect([again.triggers.length, again.tombstone, f.trg(), f.rows()]).toEqual([5, true, [], [F2A_TOMBSTONE_NAME]])
  })

  it('R5-SOC-05: a linha registrada e só 8 dos 9 gatilhos VISÍVEIS → RECUSA (privilégio ou gatilho apagado — reaplicar antes); nada muda', async () => {
    const f = fake(['f2a_fiscal_passivo'], f2aFreezeTriggerSpecs().map(t => t.name).slice(1))
    await expect(abort.abortF2aPassivo(f.c, 'setes_setes', 1, { vai: true, fiscalDb: 'fiscal_api' }))
      .rejects.toThrow(/só 8 dos 9 gatilhos[\s\S]*f2a-reapply-freeze/)
    expect([f.rows(), f.trg().length, f.sqls.some(s => /^(UPDATE|DROP|INSERT)/.test(s))]).toEqual([['f2a_fiscal_passivo'], 8, false])
  })

  it('gatilhos sem a linha registrada → a lápide NASCE com a versão SENTINELA (D-F162); 2ª execução = nada a fazer (idempotente)', async () => {
    const f = fake([])
    await abort.abortF2aPassivo(f.c, 'setes_setes', 1, { vai: true, fiscalDb: 'fiscal_api' })
    const ins = (f.c.query as jest.Mock).mock.calls.find(([s]: [string]) => /^INSERT INTO/.test(s))
    expect(ins[1]).toEqual([F2A_TOMBSTONE_VERSION, F2A_TOMBSTONE_NAME])
    const again = await abort.abortF2aPassivo(f.c, 'setes_setes', 1, { vai: true, fiscalDb: 'fiscal_api' })
    expect([again.triggers, again.migrationRow, again.tombstone]).toEqual([[], false, true])
  })

  it('o runner do código NOVO recusa subir sobre a lápide com a mensagem própria (como voltar); o código ANTIGO (sem o arquivo) não a vê', () => {
    const files = [{ version, name: 'f2a_fiscal_passivo', file: `${version}_f2a_fiscal_passivo.sql` }]
    for (const tombVersion of [F2A_TOMBSTONE_VERSION, version]) {                                   // a sentinela (D-F162) e a forma numérica anterior
      expect(() => assertAppliedMatchFiles(files, [{ version: tombVersion, name: F2A_TOMBSTONE_NAME }], 'setes_setes'))
        .toThrow(/F2a foi ABORTADA[\s\S]*D-F153[\s\S]*--retirar-lapide --vai/)
      expect(() => assertAppliedMatchFiles([], [{ version: tombVersion, name: F2A_TOMBSTONE_NAME }], 'setes_setes')).not.toThrow()
    }
  })

  it('D-F162: com a lápide SENTINELA o número da migration fica LIVRE — a próxima migration do main com ele roda (o código antigo não cai)', () => {
    const next = [{ version, name: 'ibscbs_ib2', file: `${version}_ibscbs_ib2.sql` }]
    expect(() => assertAppliedMatchFiles(next, [{ version: F2A_TOMBSTONE_VERSION, name: F2A_TOMBSTONE_NAME }], 'setes_setes')).not.toThrow()
  })

  it('R5-SOC-03: a lápide vale pelo NOME — a F2a RENUMERADA num rebase também recusa; outra migration no número da lápide = "RESERVADA"', () => {
    const renumbered = [{ version: '071', name: 'f2a_fiscal_passivo', file: '071_f2a_fiscal_passivo.sql' }]
    expect(() => assertAppliedMatchFiles(renumbered, [{ version, name: F2A_TOMBSTONE_NAME }], 'setes_setes'))
      .toThrow(/ABORTADA[\s\S]*arquivo da F2a: 071_f2a_fiscal_passivo\.sql[\s\S]*--retirar-lapide/)
    const other = [{ version, name: 'outra_coisa', file: `${version}_outra_coisa.sql` }]
    expect(() => assertAppliedMatchFiles(other, [{ version, name: F2A_TOMBSTONE_NAME }], 'setes_setes'))
      .toThrow(/RESERVADA pela lápide[\s\S]*Renumere/)
  })

  it('--retirar-lapide: ensaio relata; --vai tira SÓ a lápide; sem lápide (ou com gatilho/linha) RECUSA', async () => {
    const f = fake([F2A_TOMBSTONE_NAME], [])
    const dry = await abort.removeF2aTombstone(f.c, 'setes_setes', 1, { vai: false, fiscalDb: 'fiscal_api' })
    expect([dry.dryRun, dry.tombstone, f.rows()]).toEqual([true, true, [F2A_TOMBSTONE_NAME]])
    await abort.removeF2aTombstone(f.c, 'setes_setes', 1, { vai: true, fiscalDb: 'fiscal_api' })
    expect(f.rows()).toEqual([])
    await expect(abort.removeF2aTombstone(fake([]).c, 'setes_setes', 1, { vai: true, fiscalDb: 'fiscal_api' })).rejects.toThrow(/não há a lápide/)
    await expect(abort.removeF2aTombstone(fake([F2A_TOMBSTONE_NAME]).c, 'setes_setes', 1, { vai: true, fiscalDb: 'fiscal_api' }))
      .rejects.toThrow(/lápide COM gatilho/)
  })

  it('linha de comando: --retirar-lapide [--vai] sem a confirmação de processo parado; misturar com ela = "uso:"', () => {
    expect(abort.parseAbortArgs(['setes_setes', '1', '--retirar-lapide', '--vai'])).toEqual({ schema: 'setes_setes', institutionId: 1, vai: true, resume: true })
    expect(() => abort.parseAbortArgs(['setes_setes', '1', '--retirar-lapide', '--confirmo-setes-api-parado'])).toThrow(/uso:/)
    expect(() => abort.parseAbortArgs(['setes_setes', '1', '--retirar-lapide', '--retirar-lapide'])).toThrow(/uso:/)
  })
})

describe('D-F152 — reaplicar a trava do schema X', () => {
  const statements = f2aFreezeStatements()
  const fake = (names: string[], visible: string[]) => {
    const executed: string[] = []
    let trg = [...visible]
    const specs = f2aFreezeTriggerSpecs()
    const c = { query: jest.fn(async (sql: string, p: any[] = []) => {
      if (/^SELECT name FROM `setes_\w+`\._migrations/.test(sql)) return [names.filter(n => (p as string[]).includes(n)).map(name => ({ name }))]
      if (/information_schema\.TRIGGERS/.test(sql)) {
        return [specs.filter(t => trg.includes(t.name)).map(t => ({ name: t.name, tbl: t.table, ev: t.event, timing: 'BEFORE', body: t.body }))]
      }
      if (/^USE `setes_\w+`$/.test(sql)) { executed.push(sql); return [{}] }
      if (/^(DROP TRIGGER IF EXISTS|CREATE TRIGGER)/.test(sql)) {
        executed.push(sql)
        const m = /^CREATE TRIGGER `(tg_f2a_freeze_\w+)`/.exec(sql)
        if (m) trg = [...new Set([...trg, m[1]])]
        return [{}]
      }
      throw new Error(`SQL inesperado: ${sql.slice(0, 90)}`)
    }) }
    return { c, executed }
  }

  it('as instruções são SÓ as de gatilho da migration (9 DROP IF EXISTS + 9 CREATE), na ordem do arquivo', () => {
    expect(statements).toHaveLength(18)
    expect(statements.filter(s => s.startsWith('CREATE TRIGGER')).map(s => /`(tg_\w+)`/.exec(s)![1])).toEqual(f2aFreezeTriggerSpecs().map(t => t.name))
  })

  it('ensaio relata o que falta; --vai reaplica no SCHEMA pedido (USE + SÓ o DROP+CREATE do que falta — R5-ADV-04) e confere pela conferência do boot', async () => {
    const one = f2aFreezeTriggerSpecs()[7].name
    const visible = f2aFreezeTriggerSpecs().map(t => t.name).filter(n => n !== one)
    const dry = fake(['f2a_fiscal_passivo'], visible)
    expect(await reapply.reapplyF2aFreeze(dry.c, 'setes_setes', { vai: false })).toEqual({ schema: 'setes_setes', dryRun: true, missing: [`${one} ausente`], executed: 0 })
    expect(dry.executed).toEqual([])
    const run = fake(['f2a_fiscal_passivo'], visible)
    const r = await reapply.reapplyF2aFreeze(run.c, 'setes_setes', { vai: true })
    expect([r.executed, run.executed[0], run.executed.slice(1)]).toEqual([2, 'USE `setes_setes`', statements.filter(s => s.includes(`\`${one}\``))])
  })

  it('RECUSA: schema com a LÁPIDE (F2a abortada — D-F153) e schema sem a migration registrada (o boot a aplica inteira)', async () => {
    await expect(reapply.reapplyF2aFreeze(fake([F2A_TOMBSTONE_NAME], []).c, 'setes_setes', { vai: true })).rejects.toThrow(/ABORTADA/)
    await expect(reapply.reapplyF2aFreeze(fake([], []).c, 'setes_setes', { vai: true })).rejects.toThrow(/não está registrada/)
    expect(() => reapply.parseReapplyArgs(['setes_setes', '--vai', '--vai'])).toThrow(/uso:/)
    expect(() => reapply.parseReapplyArgs(['fiscal_api'])).toThrow(/uso:/)
  })

  it('R5-SOC-07: reaplicar RECUSA um pool (o USE vale só numa conexão — os CREATE iriam para outro banco); nada roda', async () => {
    const f = fake(['f2a_fiscal_passivo'], [])
    const pool = Object.assign(f.c, { getConnection: jest.fn() })
    await expect(reapply.reapplyF2aFreeze(pool, 'setes_setes', { vai: true })).rejects.toThrow(/UMA conexão[\s\S]*pool/)
    expect([f.executed, (f.c.query as jest.Mock).mock.calls.length]).toEqual([[], 0])
  })

  it('o boot que acusa gatilho faltando aponta para a ferramenta (D-F152)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'f2a-freeze-triggers.ts'), 'utf8')
    expect(src).toMatch(/scripts\/f2a-reapply-freeze\.ts <schema> --vai/)
  })
})
