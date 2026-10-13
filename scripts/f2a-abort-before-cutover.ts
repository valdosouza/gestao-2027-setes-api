/**
 * ABORTO da F2a ANTES do ato da virada — D-F134 (= Q-F142 (a), Valdo 2026-10-13; `prompt_apis_fiscais_isoladas.md` §22.13/§22.16).
 *
 * Vale SÓ entre o passo 4 (merge do `f2a` → o boot aplicou a `NNN_f2a_fiscal_passivo`) e o passo 5 (`migrate:setes --cutover … --vai`) da
 * JANELA. Depois do `--vai` o rollback continua PROIBIDO (D-F50 — o ERP antigo voltaria a cunhar nDPS e a reviver a SE aposentada): este
 * script RECUSA quando a virada já aconteceu — habilitação SE do ERP aposentada (`deleted='S'`, o ATO da D-F44) ou `cutover_at` no
 * `fiscal_api` — e quando não consegue LER esses fatos (falha fechada).
 *
 * O ESCOPO é o SCHEMA (gate do delta da Rodada 4 — F2AR4-SOC-02/ADV-01): os gatilhos são do schema inteiro, então a virada é conferida em
 * TODAS as institutions donas dele (`setes_central.tb_institution.schema_name`) — qualquer uma virada = recusa. O id digitado é uma
 * CONFIRMAÇÃO do operador: tem de ser dono do schema e ter a sua linha SE no ERP (ausente = recusa — sem o fato não se prova "não virou").
 *
 * O que faz (com `--vai`; sem ele, só RELATA): derruba os gatilhos de TRAVA (a lista é a própria migration — `f2aFreezeTriggerSpecs`) e
 * tira a linha `f2a_fiscal_passivo` do `_migrations` do schema; depois CONFERE a pós-condição (nenhum gatilho, nenhuma linha). Os COMMENTs
 * de aposentadoria ficam (inofensivos). Estado INCOERENTE (linha no `_migrations` sem nenhum gatilho visível — usuário sem o privilégio
 * TRIGGER, ou gatilhos derrubados à mão) = recusa: não se "conclui" o que não se vê (F2AR4-ADV-06).
 *
 * ORDEM do aborto na janela (F2AR4-SOC-03 — o script e a migration SÓ existem na árvore `f2a`):
 *   1. PARAR o processo do setes-api (senão o boot do código NOVO reaplica a migration no próximo restart — o `tsx watch` reinicia a cada
 *      arquivo salvo); o `--vai` exige `--confirmo-setes-api-parado` (molde do ATO da nfse-api);
 *   2. este script com `--vai --confirmo-setes-api-parado`, rodado a partir da WORKTREE `f2a` (DDL faz commit implícito — cada passo é
 *      definitivo);
 *   3. reverter o código da árvore viva para a ponta ANTERIOR ao merge (registrada no passo 4);
 *   4. subir o setes-api (código antigo) e CONFERIR de novo (este script SEM `--vai`, da worktree `f2a`: `triggers: []`,
 *      `migrationRow: false` — a pós-condição depois do boot); `npm run migrate:setes` na nfse-api (re-sincronia);
 *   5. o app volta ao build anterior (a F2b não sai).
 *
 *   npx tsx --require tsconfig-paths/register scripts/f2a-abort-before-cutover.ts <schema setes_*> <institutionId> [--vai --confirmo-setes-api-parado]
 */
import 'dotenv/config'
import mysql from 'mysql2/promise'
import { f2aFreezeTriggerSpecs } from '../src/migrations/f2a-freeze-triggers'

const IDENT = /^[a-z][a-z0-9_]{0,63}$/
export const F2A_MIGRATION_NAME = 'f2a_fiscal_passivo'
export const CONFIRM_STOPPED = '--confirmo-setes-api-parado'
const FLAGS = new Set(['--vai', CONFIRM_STOPPED])
const USAGE = 'uso: npx tsx --require tsconfig-paths/register scripts/f2a-abort-before-cutover.ts <schema setes_*> <institutionId> '
  + `[--vai ${CONFIRM_STOPPED}]`

export interface AbortReport {
  schema: string
  institutionId: number
  /** As institutions donas do schema — todas conferidas (nenhuma virou). */
  owners: number[]
  dryRun: boolean
  triggers: string[]
  migrationRow: boolean
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> }

/** O aborto em si (exportado para a prova em banco descartável). [schema]/[fiscalDb]/[centralDb] só pela forma; o resto pelos fatos. */
export async function abortF2aPassivo(
  c: Q, schema: string, institutionId: number, opts: { vai: boolean; fiscalDb: string; centralDb?: string },
): Promise<AbortReport> {
  const centralDb = opts.centralDb ?? 'setes_central'
  if (!IDENT.test(schema) || !IDENT.test(opts.fiscalDb) || !IDENT.test(centralDb)) {
    throw new Error(`schema/banco inválido: ${schema} / ${opts.fiscalDb} / ${centralDb}`)
  }
  if (!Number.isSafeInteger(institutionId) || institutionId <= 0) throw new Error(`institutionId inválido: ${institutionId}`)
  // 0. o escopo é o SCHEMA: as donas dele (ativas ou não — quem virou e foi desativada continua virada)
  const [own] = await c.query(`SELECT id FROM \`${centralDb}\`.tb_institution WHERE schema_name = ?`, [schema])
  const owners = (own as any[]).map(r => Number(r.id)).sort((a, b) => a - b)
  if (!owners.includes(institutionId)) {
    throw new Error(`${schema}: a institution ${institutionId} não é dona deste schema (donas: ${owners.join(', ') || 'nenhuma'}) — confira o id`)
  }
  // 1. a virada NÃO pode ter acontecido em NENHUMA dona — os dois lados do ato (D-F44: ERP aposenta a SE; D-F39: fiscal_api ganha cutover_at)
  for (const id of owners) {
    const [se] = await c.query(`SELECT deleted FROM \`${schema}\`.tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [id])
    const rows = se as any[]
    if (id === institutionId && rows.length !== 1) {
      throw new Error(`${schema}: a institution ${institutionId} não tem a habilitação SE no ERP — sem o fato não se prova que a virada não aconteceu`)
    }
    if (rows.some(r => String(r.deleted) !== 'N')) {
      throw new Error(`${schema}: a habilitação SE da institution ${id} já foi APOSENTADA pelo ato da virada — o aborto acabou (D-F50: rollback proibido depois do --vai)`)
    }
    const [cut] = await c.query(`SELECT COUNT(*) AS n FROM \`${opts.fiscalDb}\`.tb_establishment_issuer WHERE tb_institution_id = ? AND cutover_at IS NOT NULL`, [id])
    if (Number((cut as any[])[0]?.n ?? 0) > 0) {
      throw new Error(`${opts.fiscalDb}: a institution ${id} já VIROU (cutover_at) — o aborto acabou (D-F50: rollback proibido depois do --vai)`)
    }
  }
  // 2. o que existe para desfazer
  const specs = f2aFreezeTriggerSpecs()
  if (!specs.length) throw new Error('a migration f2a_fiscal_passivo não está nesta árvore — rode o aborto a partir da worktree f2a (a que a aplicou)')
  const state = async () => {
    const [trg] = await c.query(`SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND TRIGGER_NAME IN (?)`,
      [schema, specs.map(t => t.name)])
    const [mig] = await c.query(`SELECT COUNT(*) AS n FROM \`${schema}\`._migrations WHERE name = ?`, [F2A_MIGRATION_NAME])
    return { present: (trg as any[]).map(r => String(r.name)).sort(), migrationRow: Number((mig as any[])[0]?.n ?? 0) > 0 }
  }
  const before = await state()
  if (before.migrationRow && before.present.length === 0) {
    throw new Error(`${schema}: a linha ${F2A_MIGRATION_NAME} está no _migrations mas NENHUM gatilho de trava é visível — confira o privilégio `
      + 'TRIGGER do usuário (o information_schema só mostra gatilho de tabela em que ele tem TRIGGER) antes de abortar; nada foi feito')
  }
  if (opts.vai) {
    for (const name of before.present) await c.query(`DROP TRIGGER IF EXISTS \`${schema}\`.\`${name}\``)
    if (before.migrationRow) await c.query(`DELETE FROM \`${schema}\`._migrations WHERE name = ?`, [F2A_MIGRATION_NAME])
    const after = await state()
    if (after.present.length || after.migrationRow) {
      throw new Error(`${schema}: pós-condição do aborto FALHOU — restou ${JSON.stringify(after)} (o processo do setes-api está parado?)`)
    }
  }
  return { schema, institutionId, owners, dryRun: !opts.vai, triggers: before.present, migrationRow: before.migrationRow }
}

/** A linha de comando: só os 2 posicionais e as flags conhecidas, cada uma UMA vez; `--vai` exige a confirmação de processo parado. */
export function parseAbortArgs(argv: string[]): { schema: string; institutionId: number; vai: boolean } {
  const [schema, idArg, ...rest] = argv
  const repeated = rest.some((a, i) => rest.indexOf(a) !== i)
  if (!schema || !/^setes_[a-z0-9_]+$/.test(schema) || !/^\d+$/.test(idArg ?? '') || rest.some(a => !FLAGS.has(a)) || repeated) {
    throw new Error(USAGE)
  }
  const vai = rest.includes('--vai')
  if (vai && !rest.includes(CONFIRM_STOPPED)) {
    throw new Error(`${USAGE} — o --vai exige ${CONFIRM_STOPPED}: PARE o setes-api antes (o boot do código novo reaplicaria a trava)`)
  }
  return { schema, institutionId: Number(idArg), vai }
}

async function main(): Promise<void> {
  const { schema, institutionId, vai } = parseAbortArgs(process.argv.slice(2))
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  })
  try {
    const r = await abortF2aPassivo(c, schema, institutionId, { vai, fiscalDb: String(process.env.FISCAL_DB_NAME ?? 'fiscal_api') })
    console.log(JSON.stringify({ ...r, proximo: vai
      ? 'reverter o código da árvore viva, subir o setes-api (código ANTERIOR), rodar este script de novo SEM --vai (triggers [] e '
        + 'migrationRow false) e `npm run migrate:setes` na nfse-api'
      : `ENSAIO — nada mudou; com --vai ${CONFIRM_STOPPED}: derruba os gatilhos e tira a linha do _migrations (PARE o processo antes)` }, null, 2))
  } finally {
    await c.end()
  }
}

if (require.main === module) {
  main().catch(err => { console.error(`[f2a-abort] ${err?.message ?? err}`); process.exit(1) })
}
