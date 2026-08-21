import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { assertSchema } from '@shared/db/schema'
import {
  StateMvaNcmRow, StateMvaNcmInput, StateFcpNcmRow, StateFcpNcmInput,
} from './state-tax-rates.interface'

/**
 * Repositório do catálogo MVA/FCP por UF×NCM (schema do cliente). Duas
 * tabelas independentes (`tb_state_mva_ncm`/`tb_state_fcp_ncm`), mesmo
 * padrão de CRUD (id global MAX+1 FOR UPDATE, molde tax-rules.repository).
 * `resolveMvaAliq`/`resolveFcpAliq` são as funções que a orquestração do
 * faturamento (próxima onda) vai consumir — MVA por igualdade exata, FCP
 * por prefixo (P7.1 do tributacao.md).
 */

function toMvaRow(row: any): StateMvaNcmRow {
  return {
    id: row.id, stateId: row.stateId, stateName: row.stateName ?? null,
    ncm: row.ncm, internalAliq: Number(row.internalAliq),
    mvaOriginal: Number(row.mvaOriginal),
    mvaAdjusted: row.mvaAdjusted === null ? null : Number(row.mvaAdjusted),
  }
}

function toFcpRow(row: any): StateFcpNcmRow {
  return {
    id: row.id, stateId: row.stateId, stateName: row.stateName ?? null,
    ncm: row.ncm, aliq: Number(row.aliq),
  }
}

// ── MVA ──────────────────────────────────────────────────────────────────

export async function listMva(
  schemaName: string, institutionId: number, query: ListQuery
): Promise<PagedRows<StateMvaNcmRow>> {
  const s = assertSchema(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM \`${s}\`.tb_state_mva_ncm m
     LEFT JOIN setes_central.tb_state st ON (st.id = m.tb_state_id)
     WHERE m.deleted = 'N' AND m.tb_institution_id = ?
       AND (? IS NULL OR m.ncm LIKE ?)`
  const params = [institutionId, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT m.id, m.tb_state_id AS stateId, st.name AS stateName, m.ncm,
            m.internal_aliq AS internalAliq, m.mva_original AS mvaOriginal,
            m.mva_adjusted AS mvaAdjusted
     ${where}
     ORDER BY st.name, m.ncm
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(`SELECT COUNT(*) AS total ${where}`, params)
  return { rows: rows.map(toMvaRow), total: Number(count[0].total) }
}

export async function getMva(
  schemaName: string, institutionId: number, id: number
): Promise<StateMvaNcmRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT m.id, m.tb_state_id AS stateId, st.name AS stateName, m.ncm,
            m.internal_aliq AS internalAliq, m.mva_original AS mvaOriginal,
            m.mva_adjusted AS mvaAdjusted
       FROM \`${s}\`.tb_state_mva_ncm m
       LEFT JOIN setes_central.tb_state st ON (st.id = m.tb_state_id)
      WHERE m.id = ? AND m.tb_institution_id = ? AND m.deleted = 'N'`,
    [id, institutionId]
  )
  return rows[0] ? toMvaRow(rows[0]) : null
}

export async function insertMva(
  schemaName: string, institutionId: number, input: StateMvaNcmInput
): Promise<number> {
  const s = assertSchema(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${s}\`.tb_state_mva_ncm FOR UPDATE`
    ) as any[]
    const id: number = rows[0].nextId
    await conn.query(
      `INSERT INTO \`${s}\`.tb_state_mva_ncm
         (id, tb_institution_id, tb_state_id, ncm, internal_aliq, mva_original,
          mva_adjusted, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
      [id, institutionId, input.stateId, input.ncm, input.internalAliq,
       input.mvaOriginal, input.mvaAdjusted ?? null]
    )
    await conn.commit()
    return id
  } catch (err) {
    await conn.rollback()
    if ((err as any)?.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'Já existe alíquota MVA cadastrada para este Estado × NCM',
        [{ field: 'ncm', message: 'Combinação Estado + NCM já cadastrada' }])
    }
    throw err
  } finally {
    conn.release()
  }
}

export async function updateMva(
  schemaName: string, institutionId: number, id: number, input: StateMvaNcmInput
): Promise<void> {
  const s = assertSchema(schemaName)
  try {
    const [result] = await pool.query(
      `UPDATE \`${s}\`.tb_state_mva_ncm
          SET tb_state_id = ?, ncm = ?, internal_aliq = ?, mva_original = ?,
              mva_adjusted = ?, updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [input.stateId, input.ncm, input.internalAliq, input.mvaOriginal,
       input.mvaAdjusted ?? null, id, institutionId]
    ) as any[]
    if (Number(result?.affectedRows ?? 0) === 0) {
      throw new HttpError(404, `Alíquota MVA ${id} não encontrada`)
    }
  } catch (err) {
    if ((err as any)?.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'Já existe alíquota MVA cadastrada para este Estado × NCM',
        [{ field: 'ncm', message: 'Combinação Estado + NCM já cadastrada' }])
    }
    throw err
  }
}

export async function deleteMva(
  schemaName: string, institutionId: number, id: number
): Promise<void> {
  const s = assertSchema(schemaName)
  const [result] = await pool.query(
    `UPDATE \`${s}\`.tb_state_mva_ncm SET deleted = 'S', updated_at = NOW()
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [id, institutionId]
  ) as any[]
  if (Number(result?.affectedRows ?? 0) === 0) {
    throw new HttpError(404, `Alíquota MVA ${id} não encontrada`)
  }
}

/**
 * Resolve alíquota interna + MVA por IGUALDADE EXATA de NCM (decisão 36 —
 * mesma fidelidade do motor da regra, sem prefixo aqui). `stateId` é o
 * caller quem escolhe (UF do destinatário p/ ST, UF do emitente p/ NR —
 * P2.7/P3.1); a tabela não sabe qual papel está sendo resolvido.
 */
export async function resolveMvaAliq(
  schemaName: string, institutionId: number, stateId: number, ncm: string
): Promise<StateMvaNcmRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT m.id, m.tb_state_id AS stateId, NULL AS stateName, m.ncm,
            m.internal_aliq AS internalAliq, m.mva_original AS mvaOriginal,
            m.mva_adjusted AS mvaAdjusted
       FROM \`${s}\`.tb_state_mva_ncm m
      WHERE m.tb_institution_id = ? AND m.tb_state_id = ? AND m.ncm = ?
        AND m.deleted = 'N'
      LIMIT 1`,
    [institutionId, stateId, ncm]
  )
  return rows[0] ? toMvaRow(rows[0]) : null
}

// ── FCP ──────────────────────────────────────────────────────────────────

export async function listFcp(
  schemaName: string, institutionId: number, query: ListQuery
): Promise<PagedRows<StateFcpNcmRow>> {
  const s = assertSchema(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM \`${s}\`.tb_state_fcp_ncm f
     LEFT JOIN setes_central.tb_state st ON (st.id = f.tb_state_id)
     WHERE f.deleted = 'N' AND f.tb_institution_id = ?
       AND (? IS NULL OR f.ncm LIKE ?)`
  const params = [institutionId, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT f.id, f.tb_state_id AS stateId, st.name AS stateName, f.ncm, f.aliq
     ${where}
     ORDER BY st.name, f.ncm
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(`SELECT COUNT(*) AS total ${where}`, params)
  return { rows: rows.map(toFcpRow), total: Number(count[0].total) }
}

export async function getFcp(
  schemaName: string, institutionId: number, id: number
): Promise<StateFcpNcmRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT f.id, f.tb_state_id AS stateId, st.name AS stateName, f.ncm, f.aliq
       FROM \`${s}\`.tb_state_fcp_ncm f
       LEFT JOIN setes_central.tb_state st ON (st.id = f.tb_state_id)
      WHERE f.id = ? AND f.tb_institution_id = ? AND f.deleted = 'N'`,
    [id, institutionId]
  )
  return rows[0] ? toFcpRow(rows[0]) : null
}

export async function insertFcp(
  schemaName: string, institutionId: number, input: StateFcpNcmInput
): Promise<number> {
  const s = assertSchema(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${s}\`.tb_state_fcp_ncm FOR UPDATE`
    ) as any[]
    const id: number = rows[0].nextId
    await conn.query(
      `INSERT INTO \`${s}\`.tb_state_fcp_ncm
         (id, tb_institution_id, tb_state_id, ncm, aliq, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
      [id, institutionId, input.stateId, input.ncm, input.aliq]
    )
    await conn.commit()
    return id
  } catch (err) {
    await conn.rollback()
    if ((err as any)?.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'Já existe alíquota FCP cadastrada para este Estado × NCM',
        [{ field: 'ncm', message: 'Combinação Estado + NCM já cadastrada' }])
    }
    throw err
  } finally {
    conn.release()
  }
}

export async function updateFcp(
  schemaName: string, institutionId: number, id: number, input: StateFcpNcmInput
): Promise<void> {
  const s = assertSchema(schemaName)
  try {
    const [result] = await pool.query(
      `UPDATE \`${s}\`.tb_state_fcp_ncm
          SET tb_state_id = ?, ncm = ?, aliq = ?, updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [input.stateId, input.ncm, input.aliq, id, institutionId]
    ) as any[]
    if (Number(result?.affectedRows ?? 0) === 0) {
      throw new HttpError(404, `Alíquota FCP ${id} não encontrada`)
    }
  } catch (err) {
    if ((err as any)?.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'Já existe alíquota FCP cadastrada para este Estado × NCM',
        [{ field: 'ncm', message: 'Combinação Estado + NCM já cadastrada' }])
    }
    throw err
  }
}

export async function deleteFcp(
  schemaName: string, institutionId: number, id: number
): Promise<void> {
  const s = assertSchema(schemaName)
  const [result] = await pool.query(
    `UPDATE \`${s}\`.tb_state_fcp_ncm SET deleted = 'S', updated_at = NOW()
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [id, institutionId]
  ) as any[]
  if (Number(result?.affectedRows ?? 0) === 0) {
    throw new HttpError(404, `Alíquota FCP ${id} não encontrada`)
  }
}

/**
 * Resolve alíquota do FCP por PREFIXO (P7.1 — "o NCM da tabela pode ser
 * parcial; a primeira linha que casar vence"). Entre vários prefixos que
 * casam, o mais ESPECÍFICO (maior tamanho) vence — permite regra por
 * capítulo inteiro E exceção por NCM completo convivendo na mesma tabela.
 */
export async function resolveFcpAliq(
  schemaName: string, institutionId: number, stateId: number, ncm: string
): Promise<StateFcpNcmRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT f.id, f.tb_state_id AS stateId, NULL AS stateName, f.ncm, f.aliq
       FROM \`${s}\`.tb_state_fcp_ncm f
      WHERE f.tb_institution_id = ? AND f.tb_state_id = ? AND f.deleted = 'N'
        AND ? LIKE CONCAT(f.ncm, '%')
      ORDER BY LENGTH(f.ncm) DESC
      LIMIT 1`,
    [institutionId, stateId, ncm]
  )
  return rows[0] ? toFcpRow(rows[0]) : null
}
