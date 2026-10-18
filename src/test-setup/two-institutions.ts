/**
 * Fixture "DUAS institutions no MESMO schema" para leitores testados com o pool MOCKADO — frente do grupo de
 * estabelecimentos (D-GE4, `Infra-IA/prompts/prompt_frente_grupo_estabelecimentos.md`; regra no
 * `PADROES_BANCO.md` §12).
 *
 * O mock não adivinha a intenção da query: a tabela falsa guarda as linhas das DUAS institutions e só os
 * predicados de institution que o PRÓPRIO SQL expressa são aplicados. Sem o predicado, o leitor recebe o
 * schema inteiro — o que o MySQL faria. É a reprodução do vazamento com pool falso; a prova contra o banco
 * real fica para a fixture da onda 0 da frente.
 */

export const GROUP_SCHEMA = 'setes_acme'
/** Duas institutions vivas no MESMO schema (a matriz é a de menor id — a que um `rows[0]` sem ORDER BY pega). */
export const MATRIZ = 7
export const FILIAL = 8

/** SQL com espaços colapsados e sem crases — base de toda conferência textual abaixo. */
export function normalizeSql(sql: string): string {
  return sql.replace(/`/g, '').replace(/\s+/g, ' ').trim()
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Valor do parâmetro que o mysql2 coloca no `?` logo depois de `<column> =` (conta os `?` anteriores no SQL).
 * `undefined` = o SQL não tem esse predicado.
 */
export function paramOf(sql: string, params: readonly unknown[] | undefined, column: string): unknown {
  const text = normalizeSql(sql)
  const match = new RegExp(`(^|[^\\w.])${escapeRe(column)}\\s*=\\s*\\?`).exec(text)
  if (!match) return undefined
  const before = text.slice(0, match.index + match[0].length - 1)
  const index = (before.match(/\?/g) ?? []).length
  return (params ?? [])[index]
}

/**
 * Linhas da tabela `alias` que sobram depois dos predicados `<alias>.tb_institution_id = ?` do SQL. Sem o
 * predicado, volta TUDO — as duas institutions.
 */
export function scopedByInstitution<T extends { tb_institution_id: number }>(
  sql: string, params: readonly unknown[] | undefined, alias: string, rows: readonly T[]
): T[] {
  const value = paramOf(sql, params, `${alias}.tb_institution_id`)
  return value === undefined ? [...rows] : rows.filter(r => r.tb_institution_id === Number(value))
}

/** O SQL junta `<a>.tb_institution_id = <b>.tb_institution_id` (em qualquer ordem)? */
export function joinsByInstitution(sql: string, a: string, b: string): boolean {
  const text = normalizeSql(sql)
  const ab = new RegExp(`\\b${escapeRe(a)}\\.tb_institution_id\\s*=\\s*${escapeRe(b)}\\.tb_institution_id\\b`)
  const ba = new RegExp(`\\b${escapeRe(b)}\\.tb_institution_id\\s*=\\s*${escapeRe(a)}\\.tb_institution_id\\b`)
  return ab.test(text) || ba.test(text)
}
