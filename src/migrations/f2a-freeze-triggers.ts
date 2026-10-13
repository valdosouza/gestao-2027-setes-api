import fs from 'fs'
import path from 'path'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { splitStatements } from './runner'

/**
 * D-F135 (= Q-F143 (a), Valdo 2026-10-13 — gate adversarial da A3 da F2a, F2A3-ADV-04): o BOOT do setes-api confere os gatilhos de TRAVA
 * da `NNN_f2a_fiscal_passivo` (D-F110) pelo NOME em cada schema ativo, DEPOIS do runner — o `_migrations.name` prova que a migration
 * RODOU, não que os gatilhos continuam lá (`DROP TRIGGER` por quem tem ALL, dump `--skip-triggers`, restauração). Faltando ou diferente
 * (outra tabela, AFTER, outro evento, CORPO diferente do da migration) = o setes-api NÃO sobe (molde das sondas de CHECK — D-F45/
 * D-IB26). O CORPO é comparado com o da própria migration, normalizado (comentários fora e espaços colapsados — `normalizeTriggerBody`):
 * gate do delta da Rodada 4 (F2AR4-ADV-02) — SIGNAL sob um IF que nunca vale, SIGNAL em comentário ou a trava da SE de uma versão
 * ANTERIOR passavam com a regra antiga ("o corpo tem um SIGNAL"). A consulta filtra por `EVENT_OBJECT_SCHEMA` (F2AR4-SOC-04: no MariaDB
 * 10.4 o `TRIGGER_SCHEMA = ?` varre TODOS os bancos; o gatilho mora no schema da tabela — mesma semântica). A LISTA é a própria migration (os `CREATE TRIGGER` dela, pelo divisor do runner) — uma fonte só; o ATO da virada da nfse-api
 * confere a MESMA (`nfse-api/scripts/cutover-erp.ts` — cerca da lista × migration lá).
 * ⚠️ Conhecimento negativo (D-F132 — F3): o `information_schema.TRIGGERS` só mostra gatilho de tabela em que o usuário tem o privilégio
 * TRIGGER; hoje o setes-api conecta como dono. Com o usuário PRÓPRIO da F3 (sem TRIGGER — senão ele mesmo apagaria a trava) a lista vem
 * VAZIA e o boot recusa: a F3 move esta conferência para um usuário de diagnóstico (molde do `EXPLAIN_DB_USER` da nfse-api).
 */

const SQL_DIR = path.resolve(__dirname, 'sql')
const PASSIVO_FILE = /^(\d{3})_f2a_fiscal_passivo\.sql$/

export { F2A_PASSIVO_NAME, F2A_TOMBSTONE_NAME, F2A_TOMBSTONE_VERSION } from './f2a-names'

/** A versão (o número) da migration da F2a nesta árvore (null = antes da F2a). */
export function f2aPassivoVersion(dir = SQL_DIR): string | null {
  for (const f of fs.readdirSync(dir)) {
    const m = PASSIVO_FILE.exec(f)
    if (m) return m[1]
  }
  return null
}

/**
 * D-F152 (= Q-F157 (b)): as instruções de GATILHO da migration (o `DROP TRIGGER IF EXISTS` + o `CREATE TRIGGER` de cada um, na ordem do
 * arquivo, pelo divisor do runner) — o que a ferramenta "reaplicar a trava do schema X" executa (os COMMENTs de aposentadoria não).
 */
export function f2aFreezeStatements(dir = SQL_DIR): string[] {
  const file = fs.readdirSync(dir).find(f => PASSIVO_FILE.test(f))
  if (!file) return []
  return splitStatements(fs.readFileSync(path.join(dir, file), 'utf8'))
    .filter(s => /^(DROP TRIGGER IF EXISTS|CREATE TRIGGER) `tg_f2a_freeze_\w+`/.test(s))
}

export type FreezeTriggerSpec = Readonly<{ name: string; table: string; event: 'INSERT' | 'UPDATE' | 'DELETE'; body: string }>

/**
 * O corpo de um gatilho na forma COMPARÁVEL: comentários (`/* *\/`, `-- `, `#`) fora de literais saem, espaços em branco fora de literais
 * viram UM espaço, pontas aparadas, `;` final fora. Literais ('…', "…", `…`) ficam intactos. A MESMA regra vive na nfse-api
 * (`scripts/cutover-erp.ts`, que guarda o sha-256 do corpo normalizado — a cerca de lá confere contra esta migration).
 */
export function normalizeTriggerBody(sql: string): string {
  let out = ''
  let quote: string | null = null
  let space = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      out += ch
      if (ch === quote) {
        if (sql[i + 1] === quote) out += sql[++i]                     // aspas dobradas = a própria aspa
        else quote = null
      } else if (ch === '\\' && quote !== '`' && i + 1 < sql.length) {
        out += sql[++i]
      }
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? sql.length : end + 1
      space = true
      continue
    }
    if ((ch === '-' && sql[i + 1] === '-' && (i + 2 >= sql.length || /\s/.test(sql[i + 2]))) || ch === '#') {
      const end = sql.indexOf('\n', i)
      i = end < 0 ? sql.length : end
      space = true
      continue
    }
    if (/\s/.test(ch)) { space = true; continue }
    if (space && out.length) out += ' '
    space = false
    out += ch
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
  }
  return out.replace(/;$/, '').trim()
}

/** Os gatilhos que a migration `f2a_fiscal_passivo` CRIA (vazio = a migration não está nesta árvore — antes da F2a). */
export function f2aFreezeTriggerSpecs(dir = SQL_DIR): FreezeTriggerSpec[] {
  const file = fs.readdirSync(dir).find(f => PASSIVO_FILE.test(f))
  if (!file) return []
  return splitStatements(fs.readFileSync(path.join(dir, file), 'utf8'))
    .map(s => /^CREATE TRIGGER `(tg_\w+)` BEFORE (INSERT|UPDATE|DELETE) ON `(\w+)`\s+FOR EACH ROW\s+([\s\S]+)$/.exec(s))
    .filter((m): m is RegExpExecArray => !!m)
    .map(m => Object.freeze({ name: m[1], table: m[3], event: m[2] as FreezeTriggerSpec['event'], body: normalizeTriggerBody(m[4]) }))
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> }

/** O que FALTA (ou está diferente) no schema — pelo nome no `information_schema.TRIGGERS`. */
export async function f2aFreezeTriggersMissing(q: Q, schemaName: string, specs = f2aFreezeTriggerSpecs()): Promise<string[]> {
  return f2aFreezeTriggersMissingIn(q, assertSchema(schemaName), specs)
}

/** A mesma conferência num identificador JÁ validado por quem chama (a ferramenta de reaplicar e as provas em banco descartável `f2a_*`). */
export async function f2aFreezeTriggersMissingIn(q: Q, s: string, specs = f2aFreezeTriggerSpecs()): Promise<string[]> {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(s)) throw new Error(`schema inválido: ${s}`)
  if (!specs.length) return []
  const [rows] = await q.query(
    `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, EVENT_MANIPULATION AS ev, ACTION_TIMING AS timing, ACTION_STATEMENT AS body
       FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND TRIGGER_NAME IN (?)`, [s, specs.map(t => t.name)])
  const found = new Map<string, any>((rows as any[]).map(r => [String(r.name), r]))
  const missing: string[] = []
  for (const t of specs) {
    const r = found.get(t.name)
    if (!r) { missing.push(`${t.name} ausente`); continue }
    if (String(r.tbl) !== t.table || String(r.ev).toUpperCase() !== t.event || String(r.timing).toUpperCase() !== 'BEFORE') {
      missing.push(`${t.name} diferente (${r.timing} ${r.ev} em ${r.tbl})`)
    } else if (normalizeTriggerBody(String(r.body ?? '')) !== t.body) {
      missing.push(`${t.name} diferente (o corpo não é o da migration)`)
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
      + 'reaplique a trava do schema (D-F152): `npx tsx --require tsconfig-paths/register scripts/f2a-reapply-freeze.ts <schema> --vai` '
      + '— ou confira o privilégio TRIGGER do usuário do setes-api')
  }
  return `${specs.length} gatilho(s) em ${(institutions as any[]).length} schema(s)`
}
