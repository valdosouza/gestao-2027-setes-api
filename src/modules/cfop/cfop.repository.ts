import pool from '@shared/db/connection'
import { ListQuery, PagedRows, SearchCriterion, escapeLike } from '@shared/list'
import { CfopRow, CfopInput } from './cfop.interface'

/**
 * Repositório de setes_central.tb_cfop (catálogo central — Super).
 * note é BLOB no banco: CAST no SELECT para chegar como texto.
 */

const CFOP_FIELDS = (input: CfopInput) => [
  input.description,
  input.concise ?? null,
  input.register ?? null,
  input.way,
  input.jurisdiction ?? null,
  input.note ?? null,
  input.active ?? 'S',
]

/**
 * PESQUISA AVANÇADA (prompt_pesquisa_avancada.md — Onda 2 §12, Bloco 2): lista branca desta
 * lista. Vive AQUI (D-BA12) porque as expressões dependem dos aliases da query base; o escopo
 * (schema/institution) fica na query, o critério referencia ALIAS (parecer do guardião).
 */
export const CFOP_SEARCH_CRITERIA: readonly SearchCriterion[] = [
  { key: 'description', kind: 'text', labelKey: 'search.cfop.description', expr: 'c.description' },
  { key: 'concise', kind: 'text', labelKey: 'search.cfop.concise', expr: 'c.concise' },
  { key: 'code', kind: 'text', labelKey: 'search.cfop.code', expr: 'c.id' },
  { key: 'way', kind: 'options', labelKey: 'search.cfop.way', expr: 'c.way', options: ['E', 'S'] },
  { key: 'jurisdiction', kind: 'options', labelKey: 'search.cfop.jurisdiction', expr: 'c.jurisdiction', options: ['E', 'N', 'X'] },
  // coluna NULLABLE e com '' residual no catálogo: ativo = 'S' (a semântica do motor), o resto é inativo
  { key: 'active', kind: 'bool', labelKey: 'search.cfop.active', expr: "COALESCE(c.active, 'N') = 'S'" },
]

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE
 * (D2). Ordenação já é pelo id (código fiscal) — sem desempate extra (D8).
 */
export async function listCfop(query: ListQuery): Promise<PagedRows<CfopRow>> {
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM setes_central.tb_cfop c
     WHERE c.deleted = 'N'
       AND (? IS NULL OR c.id LIKE ? OR c.description LIKE ? OR c.concise LIKE ?)${query.criteria.sql}`
  const params = [like, like, like, like, ...query.criteria.params]

  const [rows] = await pool.query<any[]>(
    `SELECT c.id, c.description, c.concise, c.register, c.way,
            c.jurisdiction, CAST(c.note AS CHAR) AS note, c.active
     ${where}
     ORDER BY c.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

export async function getCfop(id: string): Promise<CfopRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT c.id, c.description, c.concise, c.register, c.way,
            c.jurisdiction, CAST(c.note AS CHAR) AS note, c.active
     FROM setes_central.tb_cfop c
     WHERE c.id = ? AND c.deleted = 'N'`,
    [id]
  )
  return rows[0] ?? null
}

/** Código já usado? INCLUI deleted='S' — código externo nunca é
 *  reaproveitado (padrão countries/BACEN). */
export async function cfopCodeExists(id: string): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    'SELECT id FROM setes_central.tb_cfop WHERE id = ?',
    [id]
  )
  return rows.length > 0
}

export async function insertCfop(id: string, input: CfopInput): Promise<void> {
  await pool.query(
    `INSERT INTO setes_central.tb_cfop
       (id, description, concise, register, way, jurisdiction, note,
        active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [id, ...CFOP_FIELDS(input)]
  )
}

/** Atualiza o CFOP — o código (id) nunca muda. */
export async function updateCfop(id: string, input: CfopInput): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_cfop
        SET description = ?, concise = ?, register = ?, way = ?,
            jurisdiction = ?, note = ?, active = ?, updated_at = NOW()
      WHERE id = ?`,
    [...CFOP_FIELDS(input), id]
  )
}

export async function deleteCfop(id: string): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_cfop SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}
