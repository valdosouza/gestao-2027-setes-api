import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { saveEntityFiscalChain, getEntityFiscalFull } from '@shared/entity'
import { upsertEntityTax, getEntityTax } from '@shared/entity-tax/entity-tax.repository'
import { ProviderInput, ProviderListRow, ProviderFull } from './providers.interface'

/**
 * Repositório do CONCRETO Provider — CONSUMIDOR da cadeia de entidade fiscal
 * compartilhada (skill cadastro-entidade-fiscal.md). A cadeia vive em
 * setes_central; a tb_provider vive no SCHEMA DO CLIENTE (sql/03 + migration
 * 022 — D2) com PK composta (id, tb_institution_id) — todas as queries
 * filtram pela institution do JWT. Aba Tributação (D1): peça
 * @shared/entity-tax salva na MESMA transação do papel.
 */

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE.
 * Desempate por p.id mantém o OFFSET estável.
 */
export async function listProviders(
  query: ListQuery, schemaName: string, institutionId: number
): Promise<PagedRows<ProviderListRow>> {
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM ?? p
     INNER JOIN setes_central.tb_entity e ON e.id = p.id
     WHERE p.tb_institution_id = ? AND p.deleted = 'N'
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ?)`
  const params = [`${schemaName}.tb_provider`, institutionId, like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT p.id,
            e.nick_trade   AS nickTrade,
            e.name_company AS nameCompany,
            p.active
     ${where}
     ORDER BY e.nick_trade, p.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

/** Objeto COMPLETO: cadeia compartilhada + tb_provider + tributação. */
export async function getProvider(
  id: number, schemaName: string, institutionId: number
): Promise<ProviderFull | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT p.active
     FROM ?? p
     WHERE p.id = ? AND p.tb_institution_id = ? AND p.deleted = 'N'`,
    [`${schemaName}.tb_provider`, id, institutionId]
  )
  if (!rows[0]) return null

  const chain = await getEntityFiscalFull(id)
  if (!chain) return null

  const tax = await getEntityTax(schemaName, institutionId, id)
  return { ...chain, ...rows[0], tax }
}

export async function providerExists(
  id: number, schemaName: string, institutionId: number
): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM ?? WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [`${schemaName}.tb_provider`, id, institutionId]
  )
  return rows.length > 0
}

// ---------------------------------------------------------------------
// Cascade (transação única) — a cadeia é do shared; a tb_provider é daqui
// ---------------------------------------------------------------------

/**
 * POST: cadeia em transação única (reuso por documento — decisões 1 e 9 da
 * Fase 3) + tb_provider + tributação. Papel duplicado NESTA institution:
 * linha viva → 409 com o id no payload (o app oferece abrir em edição);
 * linha deleted='S' (inclusive nascida do sync) → REVIVE com os dados novos.
 * active default 'S' no cadastro manual (D3).
 */
export async function insertProviderCascade(
  input: ProviderInput, schemaName: string, institutionId: number,
  updatedBy: number | null = null
): Promise<{ id: number; reused: boolean }> {
  const table = `${schemaName}.tb_provider`
  const conn  = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const { id, reused } = await saveEntityFiscalChain(conn, null, input, updatedBy)

    const [existing] = await conn.query<any[]>(
      `SELECT deleted FROM ?? WHERE id = ? AND tb_institution_id = ? FOR UPDATE`,
      [table, id, institutionId]
    )
    if (existing.length > 0 && existing[0].deleted === 'N') {
      throw new HttpError(409,
        `Esta entidade já está cadastrada como fornecedor deste estabelecimento (id ${id})`,
        [{ field: 'id', message: String(id) }], 'DUP_ROLE')
    }

    if (existing.length > 0) {
      await conn.query(
        `UPDATE ?? SET active = ?, deleted = 'N', updated_at = NOW()
         WHERE id = ? AND tb_institution_id = ?`,
        [table, input.active ?? 'S', id, institutionId]
      )
    } else {
      await conn.query(
        `INSERT INTO ?? (id, tb_institution_id, active, created_at, updated_at)
         VALUES (?, ?, ?, NOW(), NOW())`,
        [table, id, institutionId, input.active ?? 'S']
      )
    }

    // Aba Tributação (D1): salva JUNTO, na mesma transação;
    // undefined/null = não tocar (mesma proteção das listas da cadeia)
    if (input.tax != null) {
      await upsertEntityTax(conn, schemaName, institutionId, id, input.tax)
    }

    await conn.commit()
    return { id, reused }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** PUT: mesma cascade em transação única. */
export async function updateProviderCascade(
  id: number, input: ProviderInput, schemaName: string, institutionId: number,
  updatedBy: number | null = null
): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    await saveEntityFiscalChain(conn, id, input, updatedBy)

    await conn.query(
      `UPDATE ?? SET active = ?, updated_at = NOW()
       WHERE id = ? AND tb_institution_id = ?`,
      [`${schemaName}.tb_provider`, input.active ?? 'S', id, institutionId]
    )

    if (input.tax != null) {
      await upsertEntityTax(conn, schemaName, institutionId, id, input.tax)
    }

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Soft delete do PAPEL — a cadeia entity permanece (outros papéis/schemas). */
export async function deleteProvider(
  id: number, schemaName: string, institutionId: number
): Promise<void> {
  await pool.query(
    `UPDATE ?? SET deleted = 'S', updated_at = NOW() WHERE id = ? AND tb_institution_id = ?`,
    [`${schemaName}.tb_provider`, id, institutionId]
  )
}
