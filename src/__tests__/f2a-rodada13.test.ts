/// <reference types="jest" />
// F2a — Rodada 13 (questões dos gates do delta da Rodada 11 + Rodada 12), Valdo 2026-10-13: "Q-F195 - siga recomendações" (§7 D-F187…D-F191
// do `prompt_apis_fiscais_isoladas.md`). Aqui, o lado do setes-api:
//   D-F190 — o aborto da F2a só existe ANTES da 1ª janela: QUALQUER institution da INSTALAÇÃO virada = recusa (depois do merge, a lápide num
//            schema faria o boot recusar para TODOS); o `--retirar-lapide` não tem a guarda (retirar só desbloqueia).
import path from 'path'

jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() } }))

import { f2aFreezeTriggerSpecs, F2A_TOMBSTONE_NAME } from '../migrations/f2a-freeze-triggers'

const REPO = path.join(__dirname, '..', '..')
// scripts/ fica fora do rootDir do tsc (src) — require com o tipo usado
// eslint-disable-next-line @typescript-eslint/no-var-requires
const abort = require(path.join(REPO, 'scripts', 'f2a-abort-before-cutover')) as {
  abortF2aPassivo: (c: any, schema: string, id: number, o: { vai: boolean; fiscalDb: string; centralDb?: string }) => Promise<any>
  removeF2aTombstone: (c: any, schema: string, id: number, o: { vai: boolean; fiscalDb: string; centralDb?: string }) => Promise<any>
}

describe('D-F190 — o aborto só ANTES da 1ª janela', () => {
  /** Banco falso: [installationCut] = quantas institutions da INSTALAÇÃO já viraram (a do schema nunca). */
  const fake = (names: string[], installationCut: number, triggers: string[] = f2aFreezeTriggerSpecs().map(t => t.name)) => {
    const sqls: string[] = []
    let rows = [...names]
    let trg = [...triggers]
    const c = { query: jest.fn(async (sql: string, p: any[] = []) => {
      sqls.push(sql)
      if (/FROM `setes_central`\.tb_institution WHERE schema_name/.test(sql)) return [[{ id: 1 }]]
      if (/FROM `setes_\w+`\.tb_establishment_issuer/.test(sql)) return [[{ deleted: 'N' }]]
      if (/WHERE tb_institution_id = \? AND cutover_at IS NOT NULL/.test(sql)) return [[{ n: 0 }]]
      if (/tb_establishment_issuer WHERE cutover_at IS NOT NULL/.test(sql)) return [[{ n: installationCut }]]
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

  it('uma institution QUALQUER da instalação virada (não a deste schema) → RECUSA o aborto — no ensaio e no --vai; nada é escrito', async () => {
    for (const vai of [false, true]) {
      const f = fake(['f2a_fiscal_passivo'], 1)
      await expect(abort.abortF2aPassivo(f.c, 'setes_cliente2', 1, { vai, fiscalDb: 'fiscal_api' }))
        .rejects.toThrow(/a instalação já tem institution VIRADA[\s\S]*faria o boot do setes-api recusar para TODAS[\s\S]*D-F190/)
      expect([vai, f.sqls.some(s => /^(UPDATE|DROP|INSERT|DELETE)/.test(s)), f.trg().length, f.rows()]).toEqual([vai, false, 9, ['f2a_fiscal_passivo']])
    }
  })

  it('nenhuma institution virada → o aborto segue como sempre (a lápide SENTINELA, os gatilhos derrubados)', async () => {
    const f = fake(['f2a_fiscal_passivo'], 0)
    const r = await abort.abortF2aPassivo(f.c, 'setes_setes', 1, { vai: true, fiscalDb: 'fiscal_api' })
    expect([r.tombstone, f.trg(), f.rows()]).toEqual([true, [], [F2A_TOMBSTONE_NAME]])
  })

  it('o --retirar-lapide NÃO tem a guarda: com a instalação virada ele ainda retira a lápide (só desbloqueia o boot)', async () => {
    const f = fake([F2A_TOMBSTONE_NAME], 1, [])
    const r = await abort.removeF2aTombstone(f.c, 'setes_cliente2', 1, { vai: true, fiscalDb: 'fiscal_api' })
    expect([r.tombstone, f.rows()]).toEqual([false, []])
    expect(f.sqls.some(s => /tb_establishment_issuer WHERE cutover_at IS NOT NULL/.test(s))).toBe(false)
  })
})
