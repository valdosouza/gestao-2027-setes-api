import fs from 'fs'
import path from 'path'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { splitStatements } from './runner'

/**
 * D-F135 (= Q-F143 (a), Valdo 2026-10-13 — gate adversarial da A3 da F2a, F2A3-ADV-04): o BOOT do setes-api confere os gatilhos de TRAVA
 * da `NNN_f2a_fiscal_passivo` (D-F110) pelo NOME em cada schema ativo, DEPOIS do runner — o `_migrations.name` prova que a migration
 * RODOU, não que os gatilhos continuam lá (`DROP TRIGGER` por quem tem ALL, dump `--skip-triggers`, restauração). Faltando ou diferente
 * (outra tabela, AFTER, outro evento, corpo sem `SIGNAL SQLSTATE '45000'`) = o setes-api NÃO sobe (molde das sondas de CHECK — D-F45/
 * D-IB26). A LISTA é a própria migration (os `CREATE TRIGGER` dela, pelo divisor do runner) — uma fonte só; o ATO da virada da nfse-api
 * confere a MESMA (`nfse-api/scripts/cutover-erp.ts` — cerca da lista × migration lá).
 * ⚠️ Conhecimento negativo (D-F132 — F3): o `information_schema.TRIGGERS` só mostra gatilho de tabela em que o usuário tem o privilégio
 * TRIGGER; hoje o setes-api conecta como dono. Com o usuário PRÓPRIO da F3 (sem TRIGGER — senão ele mesmo apagaria a trava) a lista vem
 * VAZIA e o boot recusa: a F3 move esta conferência para um usuário de diagnóstico (molde do `EXPLAIN_DB_USER` da nfse-api).
 */

const SQL_DIR = path.resolve(__dirname, 'sql')
const PASSIVO_FILE = /^\d{3}_f2a_fiscal_passivo\.sql$/

export type FreezeTriggerSpec = Readonly<{ name: string; table: string; event: 'INSERT' | 'UPDATE' | 'DELETE' }>

/** Os gatilhos que a migration `f2a_fiscal_passivo` CRIA (vazio = a migration não está nesta árvore — antes da F2a). */
export function f2aFreezeTriggerSpecs(dir = SQL_DIR): FreezeTriggerSpec[] {
  const file = fs.readdirSync(dir).find(f => PASSIVO_FILE.test(f))
  if (!file) return []
  return splitStatements(fs.readFileSync(path.join(dir, file), 'utf8'))
    .map(s => /^CREATE TRIGGER `(tg_\w+)` BEFORE (INSERT|UPDATE|DELETE) ON `(\w+)`/.exec(s))
    .filter((m): m is RegExpExecArray => !!m)
    .map(m => Object.freeze({ name: m[1], table: m[3], event: m[2] as FreezeTriggerSpec['event'] }))
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> }

/** O que FALTA (ou está diferente) no schema — pelo nome no `information_schema.TRIGGERS`. */
export async function f2aFreezeTriggersMissing(q: Q, schemaName: string, specs = f2aFreezeTriggerSpecs()): Promise<string[]> {
  const s = assertSchema(schemaName)
  if (!specs.length) return []
  const [rows] = await q.query(
    `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, EVENT_MANIPULATION AS ev, ACTION_TIMING AS timing, ACTION_STATEMENT AS body
       FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND TRIGGER_NAME IN (?)`, [s, specs.map(t => t.name)])
  const found = new Map<string, any>((rows as any[]).map(r => [String(r.name), r]))
  const missing: string[] = []
  for (const t of specs) {
    const r = found.get(t.name)
    if (!r) { missing.push(`${t.name} ausente`); continue }
    if (String(r.tbl) !== t.table || String(r.ev).toUpperCase() !== t.event || String(r.timing).toUpperCase() !== 'BEFORE'
      || !/SIGNAL\s+SQLSTATE\s+'45000'/i.test(String(r.body))) {
      missing.push(`${t.name} diferente (${r.timing} ${r.ev} em ${r.tbl})`)
    }
  }
  return missing
}

/** Conferência do BOOT (D-F135): todo schema ATIVO (os mesmos do runner) com os gatilhos da migration; senão o boot falha alto. */
export async function assertF2aFreezeTriggers(q: Q = pool): Promise<string> {
  const specs = f2aFreezeTriggerSpecs()
  if (!specs.length) return 'sem a migration f2a_fiscal_passivo nesta árvore (antes da F2a)'
  const [institutions] = await q.query("SELECT schema_name FROM setes_central.tb_institution WHERE active = 'S' AND deleted = 'N'")
  const bad: string[] = []
  for (const i of institutions as any[]) {
    const missing = await f2aFreezeTriggersMissing(q, String(i.schema_name), specs)
    if (missing.length) bad.push(`${i.schema_name}: ${missing.join('; ')}`)
  }
  if (bad.length) {
    throw new Error(`D-F135: gatilhos de TRAVA da F2a faltando ou diferentes — ${bad.join(' | ')} — o ERP não está congelado (D-F110); `
      + 'reaplique a migration f2a_fiscal_passivo (re-executável) ou confira o privilégio TRIGGER do usuário do setes-api')
  }
  return `${specs.length} gatilho(s) em ${(institutions as any[]).length} schema(s)`
}
