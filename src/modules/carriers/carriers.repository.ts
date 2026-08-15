import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { saveEntityFiscalChain, getEntityFiscalFull } from '@shared/entity'
import { upsertEntityTax, getEntityTax } from '@shared/entity-tax/entity-tax.repository'
import { CarrierInput, CarrierListRow, CarrierFull } from './carriers.interface'

/**
 * Repositório do CONCRETO Carrier — CONSUMIDOR da cadeia de entidade fiscal
 * compartilhada (skill cadastro-entidade-fiscal.md). A cadeia vive em
 * setes_central; a tb_carrier vive no SCHEMA DO CLIENTE (sql/03) com PK
 * composta (id, tb_institution_id) — todas as queries filtram pela
 * institution do JWT. Aba Tributação (D2): peça @shared/entity-tax salva na
 * MESMA transação do papel.
 */

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE
 * (D2 da paginação). Desempate por c.id (D8) mantém o OFFSET estável.
 */
export async function listCarriers(
  query: ListQuery, schemaName: string, institutionId: number
): Promise<PagedRows<CarrierListRow>> {
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM ?? c
     INNER JOIN setes_central.tb_entity e ON e.id = c.id
     WHERE c.tb_institution_id = ? AND c.deleted = 'N'
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ?)`
  const params = [`${schemaName}.tb_carrier`, institutionId, like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT c.id,
            e.nick_trade   AS nickTrade,
            e.name_company AS nameCompany,
            c.active
     ${where}
     ORDER BY e.nick_trade, c.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

/** Objeto COMPLETO: cadeia compartilhada + tb_carrier + tributação. */
export async function getCarrier(
  id: number, schemaName: string, institutionId: number
): Promise<CarrierFull | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT c.active
     FROM ?? c
     WHERE c.id = ? AND c.tb_institution_id = ? AND c.deleted = 'N'`,
    [`${schemaName}.tb_carrier`, id, institutionId]
  )
  if (!rows[0]) return null

  const chain = await getEntityFiscalFull(id)
  if (!chain) return null

  const tax = await getEntityTax(schemaName, institutionId, id)
  return { ...chain, ...rows[0], tax }
}

export async function carrierExists(
  id: number, schemaName: string, institutionId: number
): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM ?? WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [`${schemaName}.tb_carrier`, id, institutionId]
  )
  return rows.length > 0
}

// ---------------------------------------------------------------------
// Cascade (transação única) — a cadeia é do shared; a tb_carrier é daqui
// ---------------------------------------------------------------------

/**
 * POST: cadeia em transação única (reuso por documento — decisões 1 e 9 da
 * Fase 3) + tb_carrier + tributação. Papel duplicado NESTA institution:
 * linha viva → 409 com o id no payload (o app oferece abrir em edição);
 * linha deleted='S' → REVIVE com os dados novos (modelo customers).
 */
export async function insertCarrierCascade(
  input: CarrierInput, schemaName: string, institutionId: number,
  updatedBy: number | null = null
): Promise<{ id: number; reused: boolean }> {
  const table = `${schemaName}.tb_carrier`
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
        `Esta entidade já está cadastrada como transportadora deste estabelecimento (id ${id})`,
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

    // Aba Tributação (D2): salva JUNTO, na mesma transação;
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
export async function updateCarrierCascade(
  id: number, input: CarrierInput, schemaName: string, institutionId: number,
  updatedBy: number | null = null
): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    await saveEntityFiscalChain(conn, id, input, updatedBy)

    await conn.query(
      `UPDATE ?? SET active = ?, updated_at = NOW()
       WHERE id = ? AND tb_institution_id = ?`,
      [`${schemaName}.tb_carrier`, input.active ?? 'S', id, institutionId]
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
export async function deleteCarrier(
  id: number, schemaName: string, institutionId: number
): Promise<void> {
  await pool.query(
    `UPDATE ?? SET deleted = 'S', updated_at = NOW() WHERE id = ? AND tb_institution_id = ?`,
    [`${schemaName}.tb_carrier`, id, institutionId]
  )
}
