/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA da Rodada 7 da F2a/F2b (2026-10-13 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §7 D-F153/D-F162/D-F165, §22.22). O delta do setes-api é só teste (`99da896..f5d2be2`); aqui ficam os
// CONTRASTES do lado setes-api ("dois leitores, uma resposta") que fundamentam achados registrados no núcleo e na nfse-api:
//   - R7-ADV-01 (núcleo): o MESMO token anônimo `{"typ":"JWT"}` + corpo não-JSON que dá 500 na nfse-api dá 401 aqui;
//   - R7-ADV-03 (nfse-api): linha + lápide no `_migrations` — o setes-api RECUSA o estado (o runner da F2a não sobe; o aborto também
//     recusa); o ato da virada da nfse-api vira;
//   - R7-ADV-04 (nfse-api): aborto INTERROMPIDO (lápide + gatilhos) — o `--retirar-lapide` que a frase do ato manda usar RECUSA o estado;
//     o aborto rodado de novo é que o termina;
//   - regressão dos gates anteriores: o F2AR4-ADV-05 (Rodada 4) provado pela PORTA (o `it.failing` dele passa vazio hoje).
// Convenção: `it('[FATO …]')` = comportamento atual registrado (nenhum achado é DESTE repositório). Banco MOCKADO na fronteira; nada vivo.
jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFADVR7'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))

import path from 'path'
import { readServiceVoiceOfLife, FiscalVoiceUnavailableError } from '../shared/fiscal-voice'
import { rawServiceRow } from '../test-setup/fiscal-voice-rows'
import { authMiddleware } from '../gateway/auth.middleware'
import { verifyFinalToken } from '../shared/auth/product-token'
import { HttpError } from '../shared/errors/http-error'
import { selectInstitution } from '../modules/auth/auth.service'
import * as f2aRunner from '../migrations/runner'
import { f2aFreezeTriggerSpecs, F2A_TOMBSTONE_NAME, F2A_TOMBSTONE_VERSION, F2A_PASSIVO_NAME } from '../migrations/f2a-freeze-triggers'

const REPO = path.join(__dirname, '..', '..')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const abortTool = require(path.join(REPO, 'scripts', 'f2a-abort-before-cutover')) as {
  abortF2aPassivo: (c: any, s: string, i: number, o: { vai: boolean; fiscalDb: string; centralDb?: string }) => Promise<any>
  removeF2aTombstone: (c: any, s: string, i: number, o: { vai: boolean; fiscalDb: string; centralDb?: string }) => Promise<any>
}

const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const typJwtNotJson = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: 'k1' }))}.${b64u('nao-e-json-' + 'A'.repeat(40))}.${b64u('lixo')}`

describe('contraste do R7-ADV-01 — o setes-api responde 401 ao token que derruba o núcleo em 500', () => {
  it('[FATO] `{"typ":"JWT"}` + corpo não-JSON: o `verified()` daqui também LANÇA SyntaxError no `jwt.decode` (não-HTTP), mas o `authMiddleware` converte qualquer não-HTTP em 401 e o `selectInstitution` idem — 401, sem log de erro interno', async () => {
    let thrown: unknown
    try { verifyFinalToken(typJwtNotJson) } catch (e) { thrown = e }
    expect([thrown instanceof HttpError, (thrown as Error)?.name]).toEqual([false, 'SyntaxError'])
    const json = jest.fn()
    const res: any = { status: jest.fn(() => res), json }
    const next = jest.fn()
    authMiddleware({ headers: { authorization: `Bearer ${typJwtNotJson}` }, path: '/api/x' } as any, res, next)
    expect([res.status.mock.calls[0][0], json.mock.calls[0][0].code, next.mock.calls.length]).toEqual([401, 'UNAUTHORIZED', 0])
    await expect(selectInstitution(typJwtNotJson, 1)).rejects.toMatchObject({ statusCode: 401 })
  })
})

/** Um schema simulado: os gatilhos visíveis [triggers] e as linhas do `_migrations` [names]; dona = institution 1. */
function schemaQ(triggers: string[], names: string[]) {
  const calls: string[] = []
  return {
    calls,
    query: jest.fn(async (sql: string, p: unknown[] = []) => {
      calls.push(sql.replace(/\s+/g, ' ').trim())
      if (/FROM `setes_central`\.tb_institution WHERE schema_name = \?/.test(sql)) return [[{ id: 1 }]]
      if (/information_schema\.TRIGGERS/.test(sql)) return [triggers.map(name => ({ name }))]
      if (/_migrations WHERE name IN/.test(sql)) return [names.filter(n => (p as string[]).includes(n)).map(name => ({ name }))]
      if (/tb_establishment_issuer WHERE tb_institution_id = \? AND model = 'SE'/.test(sql)) return [[{ deleted: 'N' }]]
      if (/cutover_at IS NOT NULL/.test(sql)) return [[{ n: 0 }]]
      return [[]]
    }),
  }
}
const opts = { fiscalDb: 'fiscal_api' }

describe('contraste do R7-ADV-03/R7-ADV-04 — os estados da lápide pelo lado do setes-api', () => {
  it('[FATO — base do R7-ADV-03] linha + lápide: o runner da F2a RECUSA subir ("a F2a foi ABORTADA neste schema") e o aborto recusa ("estado que o aborto não deixa") — o setes-api trata o estado como ERRO; a nfse-api (ato da virada) o trata como "F2a aplicada"', async () => {
    const files = [{ version: '069', name: F2A_PASSIVO_NAME, file: '069_f2a_fiscal_passivo.sql' }]
    expect(() => f2aRunner.assertAppliedMatchFiles(files as any,
      [{ version: '069', name: F2A_PASSIVO_NAME }, { version: F2A_TOMBSTONE_VERSION, name: F2A_TOMBSTONE_NAME }], 'setes_x'))
      .toThrow(/ABORTADA/)
    const all = f2aFreezeTriggerSpecs().map(t => t.name)
    await expect(abortTool.abortF2aPassivo(schemaQ(all, [F2A_PASSIVO_NAME, F2A_TOMBSTONE_NAME]), 'setes_x', 1, { vai: false, ...opts }))
      .rejects.toThrow(/estado que o aborto não deixa/)
  })

  it('[FATO — base do R7-ADV-04] aborto INTERROMPIDO (lápide + 4 gatilhos, sem a linha): o `--retirar-lapide` (o que a frase do ato da nfse-api manda usar) RECUSA com "estado que o aborto não deixa"; o ABORTO rodado de novo é o que aceita o estado (ensaio: lápide presente, gatilhos a derrubar)', async () => {
    const half = f2aFreezeTriggerSpecs().map(t => t.name).slice(0, 4)
    await expect(abortTool.removeF2aTombstone(schemaQ(half, [F2A_TOMBSTONE_NAME]), 'setes_x', 1, { vai: false, ...opts }))
      .rejects.toThrow(/lápide COM gatilho[\s\S]*estado que o aborto não deixa/)
    const dry = await abortTool.abortF2aPassivo(schemaQ(half, [F2A_TOMBSTONE_NAME]), 'setes_x', 1, { vai: false, ...opts })
    expect([dry.dryRun, dry.migrationRow, dry.tombstone, dry.triggers.length]).toEqual([true, false, true, 4])
  })
})

describe('regressão dos gates anteriores — higiene do F2AR4-ADV-05 (gate da Rodada 4)', () => {
  it('[RESISTIU — a promessa que o `failing` antigo não prova mais] linha da voz "REGISTRADA sem chave" (S + chave NULL, voz C 105102 — o caso do F2AR4-ADV-05) pela PORTA `readServiceVoiceOfLife`: 503 `FISCAL_VOICE_UNAVAILABLE` tipado (causa "contrato"), nunca Error solto. O `it.failing` do F2AR4-ADV-05 no gate da Rodada 4 hoje passa VAZIO — quebra na pré-condição `serviceView(…).not.toThrow()` que a própria correção no núcleo inverteu — e não detectaria uma regressão das rotas: convém trocá-lo por `it("[CORRIGIDO]")` sem a pré-condição', async () => {
    const incoherent = rawServiceRow({ accessKey: null, authorityRecorded: 'S', lastKind: 'C', lastCode: '105102', lastSource: 'Q' })
    const q = { query: jest.fn(async () => [[incoherent], []]) }
    let err: any
    try { await readServiceVoiceOfLife(q as any, 1, 7400, 1) } catch (e) { err = e }
    expect([err instanceof FiscalVoiceUnavailableError, err?.statusCode, err?.code, err?.failureCause]).toEqual([true, 503, 'FISCAL_VOICE_UNAVAILABLE', 'contract'])
    expect(String(err?.causeMessage)).toMatch(/REGISTRADA sem chave/)
  })
})
