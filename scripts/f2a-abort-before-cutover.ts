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
 * troca a linha `f2a_fiscal_passivo` do `_migrations` pela LÁPIDE (D-F153 = Q-F158 (c): a mesma versão com o nome
 * `f2a_fiscal_passivo_abortada` — o código ANTIGO sobe normalmente; o código NOVO RECUSA subir sobre ela, então um restart acidental
 * nunca re-congela calado); depois CONFERE a pós-condição (nenhum gatilho, só a lápide). Os COMMENTs de aposentadoria ficam
 * (inofensivos). Estado INCOERENTE (linha no `_migrations` sem nenhum gatilho visível — usuário sem o privilégio TRIGGER, ou gatilhos
 * derrubados à mão) = recusa: não se "conclui" o que não se vê (F2AR4-ADV-06).
 *
 * VOLTAR à F2a depois de um aborto = ato DELIBERADO: `--retirar-lapide --vai` tira a lápide (só ela — confere que não há gatilho nem a
 * linha da migration); o próximo boot do código da F2a aplica a migration de novo.
 *
 * ORDEM do aborto na janela (F2AR4-SOC-03 — o script e a migration SÓ existem na árvore `f2a`):
 *   1. PARAR o processo do setes-api; o `--vai` exige `--confirmo-setes-api-parado` (molde do ATO da nfse-api);
 *   2. este script com `--vai --confirmo-setes-api-parado`, rodado a partir da WORKTREE `f2a` (DDL faz commit implícito — cada passo é
 *      definitivo);
 *   3. reverter o código da árvore viva para a ponta ANTERIOR ao merge (registrada no passo 4);
 *   4. subir o setes-api (código antigo) e CONFERIR de novo (este script SEM `--vai`, da worktree `f2a`: `triggers: []`,
 *      `migrationRow: false`, `tombstone: true`); `npm run migrate:setes` na nfse-api (re-sincronia);
 *   5. o app volta ao build anterior (a F2b não sai).
 *
 *   npx tsx --require tsconfig-paths/register scripts/f2a-abort-before-cutover.ts <schema setes_*> <institutionId> [--vai --confirmo-setes-api-parado]
 *   npx tsx --require tsconfig-paths/register scripts/f2a-abort-before-cutover.ts <schema setes_*> <institutionId> --retirar-lapide [--vai]
 */
import 'dotenv/config'
import mysql from 'mysql2/promise'
import { f2aFreezeTriggerSpecs, f2aPassivoVersion, F2A_PASSIVO_NAME, F2A_TOMBSTONE_NAME } from '../src/migrations/f2a-freeze-triggers'

const IDENT = /^[a-z][a-z0-9_]{0,63}$/
export const F2A_MIGRATION_NAME = F2A_PASSIVO_NAME
export const CONFIRM_STOPPED = '--confirmo-setes-api-parado'
export const RESUME_FLAG = '--retirar-lapide'
const FLAGS = new Set(['--vai', CONFIRM_STOPPED, RESUME_FLAG])
const USAGE = 'uso: npx tsx --require tsconfig-paths/register scripts/f2a-abort-before-cutover.ts <schema setes_*> <institutionId> '
  + `[--vai ${CONFIRM_STOPPED}] | ${RESUME_FLAG} [--vai]`

export interface AbortReport {
  schema: string
  institutionId: number
  /** As institutions donas do schema — todas conferidas (nenhuma virou). */
  owners: number[]
  dryRun: boolean
  /** Gatilhos de trava presentes ANTES do ato. */
  triggers: string[]
  /** A linha `f2a_fiscal_passivo` estava no `_migrations` ANTES do ato. */
  migrationRow: boolean
  /** A LÁPIDE (D-F153) está no `_migrations` — depois do ato (`--vai`) ou agora (ensaio). */
  tombstone: boolean
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> }
type Opts = { vai: boolean; fiscalDb: string; centralDb?: string }

function assertForm(schema: string, institutionId: number, opts: Opts): string {
  const centralDb = opts.centralDb ?? 'setes_central'
  if (!IDENT.test(schema) || !IDENT.test(opts.fiscalDb) || !IDENT.test(centralDb)) {
    throw new Error(`schema/banco inválido: ${schema} / ${opts.fiscalDb} / ${centralDb}`)
  }
  if (!Number.isSafeInteger(institutionId) || institutionId <= 0) throw new Error(`institutionId inválido: ${institutionId}`)
  return centralDb
}

/** As donas do schema; o id digitado tem de ser uma delas. */
async function ownersOf(c: Q, centralDb: string, schema: string, institutionId: number): Promise<number[]> {
  const [own] = await c.query(`SELECT id FROM \`${centralDb}\`.tb_institution WHERE schema_name = ?`, [schema])
  const owners = (own as any[]).map(r => Number(r.id)).sort((a, b) => a - b)
  if (!owners.includes(institutionId)) {
    throw new Error(`${schema}: a institution ${institutionId} não é dona deste schema (donas: ${owners.join(', ') || 'nenhuma'}) — confira o id`)
  }
  return owners
}

/** O que existe no schema: os gatilhos de trava, a linha da migration e a lápide. */
async function stateOf(c: Q, schema: string): Promise<{ present: string[]; migrationRow: boolean; tombstone: boolean }> {
  const specs = f2aFreezeTriggerSpecs()
  const [trg] = await c.query(`SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND TRIGGER_NAME IN (?)`,
    [schema, specs.map(t => t.name)])
  const [mig] = await c.query(`SELECT name FROM \`${schema}\`._migrations WHERE name IN (?, ?)`, [F2A_PASSIVO_NAME, F2A_TOMBSTONE_NAME])
  const names = new Set((mig as any[]).map(r => String(r.name)))
  return {
    present: (trg as any[]).map(r => String(r.name)).sort(),
    migrationRow: names.has(F2A_PASSIVO_NAME),
    tombstone: names.has(F2A_TOMBSTONE_NAME),
  }
}

/** O aborto em si (exportado para a prova em banco descartável). [schema]/[fiscalDb]/[centralDb] só pela forma; o resto pelos fatos. */
export async function abortF2aPassivo(c: Q, schema: string, institutionId: number, opts: Opts): Promise<AbortReport> {
  const centralDb = assertForm(schema, institutionId, opts)
  // 0. o escopo é o SCHEMA: as donas dele (ativas ou não — quem virou e foi desativada continua virada)
  const owners = await ownersOf(c, centralDb, schema, institutionId)
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
  const version = f2aPassivoVersion()
  if (!f2aFreezeTriggerSpecs().length || !version) {
    throw new Error('a migration f2a_fiscal_passivo não está nesta árvore — rode o aborto a partir da worktree f2a (a que a aplicou)')
  }
  const before = await stateOf(c, schema)
  if (before.migrationRow && before.present.length === 0) {
    throw new Error(`${schema}: a linha ${F2A_PASSIVO_NAME} está no _migrations mas NENHUM gatilho de trava é visível — confira o privilégio `
      + 'TRIGGER do usuário (o information_schema só mostra gatilho de tabela em que ele tem TRIGGER) antes de abortar; nada foi feito')
  }
  if (!opts.vai) {
    return { schema, institutionId, owners, dryRun: true, triggers: before.present, migrationRow: before.migrationRow, tombstone: before.tombstone }
  }
  for (const name of before.present) await c.query(`DROP TRIGGER IF EXISTS \`${schema}\`.\`${name}\``)
  // D-F153: a linha vira a LÁPIDE (mesma versão, outro nome); sem a linha (gatilhos sem migration registrada), a lápide nasce
  if (before.migrationRow) {
    await c.query(`UPDATE \`${schema}\`._migrations SET name = ? WHERE name = ?`, [F2A_TOMBSTONE_NAME, F2A_PASSIVO_NAME])
  } else if (!before.tombstone) {
    await c.query(`INSERT INTO \`${schema}\`._migrations (version, name) VALUES (?, ?)`, [version, F2A_TOMBSTONE_NAME])
  }
  const after = await stateOf(c, schema)
  if (after.present.length || after.migrationRow || !after.tombstone) {
    throw new Error(`${schema}: pós-condição do aborto FALHOU — restou ${JSON.stringify(after)} (o processo do setes-api está parado?)`)
  }
  return { schema, institutionId, owners, dryRun: false, triggers: before.present, migrationRow: before.migrationRow, tombstone: true }
}

/**
 * D-F153: VOLTAR à F2a depois do aborto (ato deliberado) — tira a LÁPIDE do `_migrations`; o próximo boot do código da F2a aplica a
 * migration de novo (o código antigo não a conhece — não é afetado). Recusa sem lápide, ou com gatilho/linha da migration (estado que o
 * aborto não deixa).
 */
export async function removeF2aTombstone(c: Q, schema: string, institutionId: number, opts: Opts): Promise<AbortReport> {
  const centralDb = assertForm(schema, institutionId, opts)
  const owners = await ownersOf(c, centralDb, schema, institutionId)
  const before = await stateOf(c, schema)
  if (!before.tombstone) throw new Error(`${schema}: não há a lápide ${F2A_TOMBSTONE_NAME} — a F2a não foi abortada aqui; nada a retirar`)
  if (before.present.length || before.migrationRow) {
    throw new Error(`${schema}: lápide COM gatilho ou com a linha da migration (${JSON.stringify(before)}) — estado que o aborto não deixa; confira antes`)
  }
  if (opts.vai) {
    await c.query(`DELETE FROM \`${schema}\`._migrations WHERE name = ?`, [F2A_TOMBSTONE_NAME])
    const after = await stateOf(c, schema)
    if (after.tombstone) throw new Error(`${schema}: a lápide continua lá — nada mudou`)
  }
  return { schema, institutionId, owners, dryRun: !opts.vai, triggers: before.present, migrationRow: before.migrationRow, tombstone: !opts.vai }
}

/** A linha de comando: só os 2 posicionais e as flags conhecidas, cada uma UMA vez; `--vai` do aborto exige a confirmação de processo parado. */
export function parseAbortArgs(argv: string[]): { schema: string; institutionId: number; vai: boolean; resume: boolean } {
  const [schema, idArg, ...rest] = argv
  const repeated = rest.some((a, i) => rest.indexOf(a) !== i)
  if (!schema || !/^setes_[a-z0-9_]+$/.test(schema) || !/^\d+$/.test(idArg ?? '') || rest.some(a => !FLAGS.has(a)) || repeated) {
    throw new Error(USAGE)
  }
  const vai = rest.includes('--vai')
  const resume = rest.includes(RESUME_FLAG)
  if (resume && rest.includes(CONFIRM_STOPPED)) throw new Error(`${USAGE} — ${RESUME_FLAG} não leva ${CONFIRM_STOPPED} (não é o aborto)`)
  if (!resume && vai && !rest.includes(CONFIRM_STOPPED)) {
    throw new Error(`${USAGE} — o --vai exige ${CONFIRM_STOPPED}: PARE o setes-api antes (o boot do código novo reaplicaria a trava)`)
  }
  return { schema, institutionId: Number(idArg), vai, resume }
}

async function main(): Promise<void> {
  const { schema, institutionId, vai, resume } = parseAbortArgs(process.argv.slice(2))
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  })
  try {
    const opts = { vai, fiscalDb: String(process.env.FISCAL_DB_NAME ?? 'fiscal_api') }
    if (resume) {
      const r = await removeF2aTombstone(c, schema, institutionId, opts)
      console.log(JSON.stringify({ ...r, proximo: vai
        ? 'lápide retirada — o próximo boot do código da F2a aplica a migration f2a_fiscal_passivo de novo'
        : `ENSAIO — nada mudou; com ${RESUME_FLAG} --vai: tira a lápide (voltar à F2a)` }, null, 2))
      return
    }
    const r = await abortF2aPassivo(c, schema, institutionId, opts)
    console.log(JSON.stringify({ ...r, proximo: vai
      ? 'reverter o código da árvore viva, subir o setes-api (código ANTERIOR), rodar este script de novo SEM --vai (triggers [], '
        + 'migrationRow false, tombstone true) e `npm run migrate:setes` na nfse-api'
      : `ENSAIO — nada mudou; com --vai ${CONFIRM_STOPPED}: derruba os gatilhos e deixa a lápide no _migrations (PARE o processo antes)` }, null, 2))
  } finally {
    await c.end()
  }
}

if (require.main === module) {
  main().catch(err => { console.error(`[f2a-abort] ${err?.message ?? err}`); process.exit(1) })
}
