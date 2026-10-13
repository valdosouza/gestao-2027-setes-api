/**
 * REAPLICAR A TRAVA da F2a num schema — D-F152 (= Q-F157 (b), Valdo 2026-10-13 — gate socrático do delta da Rodada 4).
 *
 * O boot do setes-api confere os 9 gatilhos de TRAVA da `f2a_fiscal_passivo` em TODO schema ativo (D-F135) e NÃO sobe se um faltar ou
 * estiver diferente (global — D-F152 mantém); a mensagem do boot aponta para cá. Esta ferramenta executa SÓ as instruções de gatilho da
 * própria migration (`DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` — `f2aFreezeStatements`; os COMMENTs de aposentadoria não) — e SÓ as
 * dos gatilhos que FALTAM ou DIFEREM (gate adversarial da Rodada 5, R5-ADV-04: recriar os 9 abria, em cada um, uma janela sem trava — DDL é
 * commit implícito, entre o DROP e o CREATE a escrita congelada passa; provado ao vivo) — no schema pedido e confere a pós-condição pela
 * MESMA conferência do boot (`f2aFreezeTriggersMissing` — corpo normalizado).
 *
 * Só onde a migration está REGISTRADA (`_migrations.name = 'f2a_fiscal_passivo'`): sem a linha, o boot do código da F2a aplica a
 * migration inteira (nada a reaplicar); com a LÁPIDE do aborto (D-F153), a F2a foi abortada ali — RECUSA (voltar à F2a é o
 * `--retirar-lapide` do aborto). Sem `--vai` é ENSAIO: relata o que falta. A quarentena POR INSTITUTION (o schema torto não derrubar o
 * boot dos outros) fica registrada para a F3 (§22.16 do prompt).
 *
 *   npx tsx --require tsconfig-paths/register scripts/f2a-reapply-freeze.ts <schema setes_*> [--vai]
 */
import 'dotenv/config'
import mysql from 'mysql2/promise'
import {
  f2aFreezeStatements, f2aFreezeTriggersMissingIn, F2A_PASSIVO_NAME, F2A_TOMBSTONE_NAME,
} from '../src/migrations/f2a-freeze-triggers'

const USAGE = 'uso: npx tsx --require tsconfig-paths/register scripts/f2a-reapply-freeze.ts <schema setes_*> [--vai]'
const IDENT = /^[a-z][a-z0-9_]{0,63}$/

export interface ReapplyReport {
  schema: string
  dryRun: boolean
  /** O que faltava (ou estava diferente) ANTES. */
  missing: string[]
  /** Quantas instruções de gatilho rodaram (0 no ensaio; 2 por gatilho que faltava/diferia — R5-ADV-04). */
  executed: number
}

/** UMA conexão — nunca um pool (o `USE` vale só na conexão em que roda; R5-SOC-07). `getConnection?: never` barra o Pool no tipo. */
type Q = { query: (sql: string, params?: unknown[]) => Promise<any>; getConnection?: never }

/** A reaplicação em si (exportada para a prova em banco descartável). [schema] só pela forma; o resto pelos fatos. */
export async function reapplyF2aFreeze(c: Q, schema: string, opts: { vai: boolean }): Promise<ReapplyReport> {
  if (!IDENT.test(schema)) throw new Error(`schema inválido: ${schema}`)
  if (typeof (c as { getConnection?: unknown }).getConnection === 'function') {
    throw new Error('reaplicar a trava precisa de UMA conexão (o USE vale só nela) — recebeu um pool; nada foi feito')
  }
  const statements = f2aFreezeStatements()
  if (!statements.length) throw new Error('a migration f2a_fiscal_passivo não está nesta árvore — rode a partir da árvore da F2a')
  const [mig] = await c.query(`SELECT name FROM \`${schema}\`._migrations WHERE name IN (?, ?)`, [F2A_PASSIVO_NAME, F2A_TOMBSTONE_NAME])
  const names = new Set((mig as any[]).map(r => String(r.name)))
  if (names.has(F2A_TOMBSTONE_NAME)) {
    throw new Error(`${schema}: a F2a foi ABORTADA aqui (lápide da D-F153) — não se reaplica a trava; voltar à F2a é o --retirar-lapide do aborto`)
  }
  if (!names.has(F2A_PASSIVO_NAME)) {
    throw new Error(`${schema}: a migration ${F2A_PASSIVO_NAME} não está registrada — o boot do código da F2a a aplica inteira; nada a reaplicar`)
  }
  const missing = await f2aFreezeTriggersMissingIn(c, schema)
  if (!opts.vai || !missing.length) return { schema, dryRun: !opts.vai, missing, executed: 0 }
  // como o runner: o schema como banco da CONEXÃO e as instruções da migration como estão (o `ON tabela` do gatilho se resolve nele —
  // qualificar só o nome do gatilho deixaria a tabela sem banco numa conexão sem banco padrão)
  // R5-ADV-04: só os que faltam/diferem (o nome abre cada item de `missing`) — os certos ficam de pé, sem janela
  const bad = new Set(missing.map(m => m.split(' ')[0]))
  const todo = statements.filter(s => bad.has(/^(?:DROP TRIGGER IF EXISTS|CREATE TRIGGER) `(\w+)`/.exec(s)?.[1] ?? ''))
  if (todo.length !== bad.size * 2) {
    throw new Error(`${schema}: a conferência acusou ${[...bad].join(', ')}, mas a migration não tem DROP+CREATE de cada um — nada foi feito`)
  }
  await c.query(`USE \`${schema}\``)
  for (const s of todo) await c.query(s)
  const after = await f2aFreezeTriggersMissingIn(c, schema)
  if (after.length) throw new Error(`${schema}: depois de reaplicar ainda falta/difere: ${after.join('; ')} — confira o privilégio TRIGGER do usuário`)
  return { schema, dryRun: false, missing, executed: todo.length }
}

export function parseReapplyArgs(argv: string[]): { schema: string; vai: boolean } {
  const [schema, ...rest] = argv
  const repeated = rest.some((a, i) => rest.indexOf(a) !== i)
  if (!schema || !/^setes_[a-z0-9_]+$/.test(schema) || rest.some(a => a !== '--vai') || repeated) throw new Error(USAGE)
  return { schema, vai: rest.includes('--vai') }
}

async function main(): Promise<void> {
  const { schema, vai } = parseReapplyArgs(process.argv.slice(2))
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  })
  try {
    const r = await reapplyF2aFreeze(c, schema, { vai })
    console.log(JSON.stringify({ ...r, proximo: vai ? 'trava reaplicada e conferida — reinicie o setes-api' : 'ENSAIO — nada mudou; com --vai reaplica' }, null, 2))
  } finally {
    await c.end()
  }
}

if (require.main === module) {
  main().catch(err => { console.error(`[f2a-reapply] ${err?.message ?? err}`); process.exit(1) })
}
