/**
 * ABORTO da F2a ANTES do ato da virada — D-F134 (= Q-F142 (a), Valdo 2026-10-13; `prompt_apis_fiscais_isoladas.md` §22.13/§22.16).
 *
 * Vale SÓ entre o passo 4 (merge do `f2a` → o boot aplicou a `NNN_f2a_fiscal_passivo`) e o passo 5 (`migrate:setes --cutover … --vai`) da
 * JANELA. Depois do `--vai` o rollback continua PROIBIDO (D-F50 — o ERP antigo voltaria a cunhar nDPS e a reviver a SE aposentada): este
 * script RECUSA quando a virada já aconteceu — habilitação SE do ERP aposentada (`deleted='S'`, o ATO da D-F44) ou `cutover_at` em
 * qualquer linha da institution no `fiscal_api` — e quando não consegue LER esses fatos (falha fechada).
 *
 * O que faz (com `--vai`; sem ele, só RELATA): derruba os gatilhos de TRAVA (a lista é a própria migration — `f2aFreezeTriggerSpecs`) e
 * tira a linha `f2a_fiscal_passivo` do `_migrations` do schema. Os COMMENTs de aposentadoria ficam (inofensivos). ORDEM do aborto na janela:
 *   1. PARAR o processo do setes-api (senão o boot do código NOVO reaplica a migration no próximo restart);
 *   2. reverter o código da árvore viva para a ponta ANTERIOR ao merge (registrada no passo 4);
 *   3. este script com `--vai` (DDL faz commit implícito — cada passo é definitivo);
 *   4. subir o setes-api (código antigo) e `npm run migrate:setes` na nfse-api (re-sincronia: a réplica volta a seguir a origem viva);
 *   5. o app volta ao build anterior (a F2b não sai).
 *
 *   npx tsx --require tsconfig-paths/register scripts/f2a-abort-before-cutover.ts <schema setes_*> <institutionId> [--vai]
 */
import 'dotenv/config'
import mysql from 'mysql2/promise'
import { f2aFreezeTriggerSpecs } from '../src/migrations/f2a-freeze-triggers'

const IDENT = /^[a-z][a-z0-9_]{0,63}$/
export const F2A_MIGRATION_NAME = 'f2a_fiscal_passivo'

export interface AbortReport {
  schema: string
  institutionId: number
  dryRun: boolean
  triggers: string[]
  migrationRow: boolean
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> }

/** O aborto em si (exportado para a prova em banco descartável). [schema]/[fiscalDb] já conferidos por quem chama; aqui só a forma. */
export async function abortF2aPassivo(c: Q, schema: string, institutionId: number, opts: { vai: boolean; fiscalDb: string }): Promise<AbortReport> {
  if (!IDENT.test(schema) || !IDENT.test(opts.fiscalDb)) throw new Error(`schema/banco inválido: ${schema} / ${opts.fiscalDb}`)
  if (!Number.isSafeInteger(institutionId) || institutionId <= 0) throw new Error(`institutionId inválido: ${institutionId}`)
  // 1. a virada NÃO pode ter acontecido — os dois lados do ato (D-F44: ERP aposenta a SE; D-F39: fiscal_api ganha cutover_at)
  const [se] = await c.query(`SELECT deleted FROM \`${schema}\`.tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [institutionId])
  if ((se as any[]).some(r => String(r.deleted) !== 'N')) {
    throw new Error(`${schema}: a habilitação SE do ERP já foi APOSENTADA pelo ato da virada — o aborto acabou (D-F50: rollback proibido depois do --vai)`)
  }
  const [cut] = await c.query(`SELECT COUNT(*) AS n FROM \`${opts.fiscalDb}\`.tb_establishment_issuer WHERE tb_institution_id = ? AND cutover_at IS NOT NULL`, [institutionId])
  if (Number((cut as any[])[0]?.n ?? 0) > 0) {
    throw new Error(`${opts.fiscalDb}: a institution ${institutionId} já VIROU (cutover_at) — o aborto acabou (D-F50: rollback proibido depois do --vai)`)
  }
  // 2. o que existe para desfazer
  const specs = f2aFreezeTriggerSpecs()
  if (!specs.length) throw new Error('a migration f2a_fiscal_passivo não está nesta árvore — rode o aborto a partir da árvore que a aplicou')
  const [trg] = await c.query(`SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND TRIGGER_NAME IN (?)`,
    [schema, specs.map(t => t.name)])
  const present = (trg as any[]).map(r => String(r.name)).sort()
  const [mig] = await c.query(`SELECT COUNT(*) AS n FROM \`${schema}\`._migrations WHERE name = ?`, [F2A_MIGRATION_NAME])
  const migrationRow = Number((mig as any[])[0]?.n ?? 0) > 0
  if (opts.vai) {
    for (const name of present) await c.query(`DROP TRIGGER IF EXISTS \`${schema}\`.\`${name}\``)
    if (migrationRow) await c.query(`DELETE FROM \`${schema}\`._migrations WHERE name = ?`, [F2A_MIGRATION_NAME])
  }
  return { schema, institutionId, dryRun: !opts.vai, triggers: present, migrationRow }
}

async function main(): Promise<void> {
  const [schema, idArg, ...rest] = process.argv.slice(2)
  const unknown = rest.filter(a => a !== '--vai')
  if (!schema || !/^setes_[a-z0-9_]+$/.test(schema) || !/^\d+$/.test(idArg ?? '') || unknown.length) {
    throw new Error('uso: npx tsx --require tsconfig-paths/register scripts/f2a-abort-before-cutover.ts <schema setes_*> <institutionId> [--vai]')
  }
  const vai = rest.includes('--vai')
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  })
  try {
    const r = await abortF2aPassivo(c, schema, Number(idArg), { vai, fiscalDb: String(process.env.FISCAL_DB_NAME ?? 'fiscal_api') })
    console.log(JSON.stringify({ ...r, proximo: vai
      ? 'subir o setes-api com o código ANTERIOR (já revertido) e rodar `npm run migrate:setes` na nfse-api'
      : 'ENSAIO — nada mudou; com --vai: derruba os gatilhos e tira a linha do _migrations (pare o processo e reverta o código ANTES)' }, null, 2))
  } finally {
    await c.end()
  }
}

if (require.main === module) {
  main().catch(err => { console.error(`[f2a-abort] ${err?.message ?? err}`); process.exit(1) })
}
