import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { assertSchemaName } from '@shared/field-config'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import {
  ServiceListRow, ServiceFull, ServiceInput, ServicePriceRow,
  ServiceLookupRow,
} from './services.interface'

/**
 * Repositório do cadastro de Serviços — tb_product com kind='S' FIXO (D5:
 * caminho individual do serviço; o kind entra no INSERT e em TODO WHERE de
 * leitura/escrita — este módulo nunca enxerga nem toca mercadoria).
 * Grade de preços (D4/D7): tb_price sincronizada na MESMA transação
 * (presença = sincroniza; priceTag null remove).
 */

/** Lista PAGINADA (shared/list): página + COUNT com a MESMA where. */
export async function listServices(
  query: ListQuery, schemaName: string, institutionId: number
): Promise<PagedRows<ServiceListRow>> {
  assertSchemaName(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM \`${schemaName}\`.tb_product p
     LEFT JOIN \`${schemaName}\`.tb_category c
       ON c.id = p.tb_category_id AND c.tb_institution_id = p.tb_institution_id
     WHERE p.tb_institution_id = ? AND p.deleted = 'N' AND p.kind = 'S'
       AND (? IS NULL OR p.description LIKE ? OR p.identifier LIKE ?)`
  const params = [institutionId, like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT p.id, p.identifier, p.description,
            p.tb_category_id AS categoryId,
            c.description    AS categoryDescription,
            COALESCE(p.active, 'S') AS active
     ${where}
     ORDER BY p.description, p.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

/** Grade de preços: TODAS as tabelas vivas + o preço atual do serviço. */
async function listServicePrices(
  serviceId: number, schemaName: string, institutionId: number
): Promise<ServicePriceRow[]> {
  const [rows] = await pool.query<any[]>(
    `SELECT l.id          AS priceListId,
            l.description AS priceListDescription,
            pr.price_tag  AS priceTag
       FROM \`${schemaName}\`.tb_price_list l
       LEFT JOIN \`${schemaName}\`.tb_price pr
         ON pr.tb_price_list_id = l.id
        AND pr.tb_institution_id = l.tb_institution_id
        AND pr.tb_product_id = ?
        AND pr.deleted = 'N'
      WHERE l.tb_institution_id = ? AND l.deleted = 'N'
      ORDER BY l.description, l.id`,
    [serviceId, institutionId]
  )
  return rows
}

export async function getService(
  id: number, schemaName: string, institutionId: number
): Promise<ServiceFull | null> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT p.id, p.identifier, p.description,
            p.tb_category_id        AS categoryId,
            c.description           AS categoryDescription,
            p.tb_financial_plans_id AS financialPlansId,
            f.description           AS financialPlansDescription,
            COALESCE(p.promotion, 'N')  AS promotion,
            COALESCE(p.highlights, 'N') AS highlights,
            COALESCE(p.published, 'N')  AS published,
            COALESCE(p.active, 'S')     AS active,
            CAST(p.note AS CHAR)        AS note
     FROM \`${schemaName}\`.tb_product p
     LEFT JOIN \`${schemaName}\`.tb_category c
       ON c.id = p.tb_category_id AND c.tb_institution_id = p.tb_institution_id
     LEFT JOIN \`${schemaName}\`.tb_financial_plans f
       ON f.id = p.tb_financial_plans_id AND f.tb_institution_id = p.tb_institution_id
     WHERE p.id = ? AND p.tb_institution_id = ? AND p.deleted = 'N'
       AND p.kind = 'S'`,
    [id, institutionId]
  )
  if (!rows[0]) return null
  const prices = await listServicePrices(id, schemaName, institutionId)
  return { ...rows[0], prices }
}

/** FKs do form validadas DENTRO da transação — 400 com fields[]. */
async function assertRefs(
  conn: PoolConnection, input: ServiceInput,
  schemaName: string, institutionId: number
): Promise<void> {
  const check = async (
    table: string, id: number, field: string, label: string
  ) => {
    const [rows] = await conn.query<any[]>(
      `SELECT 1 FROM \`${schemaName}\`.${table}
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [id, institutionId]
    )
    if (rows.length === 0) {
      throw new HttpError(400, `${label} inexistente`,
        [{ field, message: `${label} não encontrada` }])
    }
  }
  await check('tb_category', input.categoryId, 'categoryId', 'Categoria')
  if (input.financialPlansId != null) {
    await check('tb_financial_plans', input.financialPlansId,
      'financialPlansId', 'Plano financeiro')
  }
  for (const price of input.prices ?? []) {
    await check('tb_price_list', price.priceListId,
      'prices', 'Tabela de preço')
  }
}

/** Grade tb_price na MESMA transação: presença = sincroniza (upsert das
 *  presentes com valor; priceTag null OU ausência da tabela = soft delete). */
async function syncPrices(
  conn: PoolConnection, serviceId: number, input: ServiceInput,
  schemaName: string, institutionId: number
): Promise<void> {
  const withValue = (input.prices ?? []).filter(p => p.priceTag !== null)
  const keptIds = withValue.map(p => p.priceListId)

  await conn.query(
    `UPDATE \`${schemaName}\`.tb_price
        SET deleted = 'S', updated_at = NOW()
      WHERE tb_institution_id = ? AND tb_product_id = ?
        ${keptIds.length ? 'AND tb_price_list_id NOT IN (?)' : ''}`,
    keptIds.length
      ? [institutionId, serviceId, keptIds]
      : [institutionId, serviceId]
  )
  for (const price of withValue) {
    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_price
         (tb_institution_id, tb_price_list_id, tb_product_id, price_tag,
          created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         price_tag = VALUES(price_tag), deleted = 'N', updated_at = NOW()`,
      [institutionId, price.priceListId, serviceId, price.priceTag]
    )
  }
}

const PRODUCT_FIELDS = (input: ServiceInput) => [
  input.description, input.categoryId, input.financialPlansId ?? null,
  input.promotion ?? 'N', input.highlights ?? 'N', input.published ?? 'N',
  input.active ?? 'S', input.note ?? null,
]

export async function insertService(
  input: ServiceInput, schemaName: string, institutionId: number
): Promise<number> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await assertRefs(conn, input, schemaName, institutionId)

    const [mx] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId
         FROM \`${schemaName}\`.tb_product
        WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId]
    )
    const id = Number(mx[0].nextId)
    // D1: identifier em branco recebe o próprio id.
    const identifier = (input.identifier ?? '').trim() || String(id)

    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_product
         (id, identifier, tb_institution_id, description, kind,
          tb_category_id, tb_financial_plans_id, promotion, highlights,
          published, active, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'S', ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [id, identifier, institutionId,
       input.description, input.categoryId, input.financialPlansId ?? null,
       input.promotion ?? 'N', input.highlights ?? 'N',
       input.published ?? 'N', input.active ?? 'S', input.note ?? null]
    )
    await syncPrices(conn, id, input, schemaName, institutionId)

    await conn.commit()
    return id
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function updateService(
  id: number, input: ServiceInput, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    // kind='S' no WHERE: este módulo NUNCA edita mercadoria (D5).
    const [rows] = await conn.query<any[]>(
      `SELECT identifier FROM \`${schemaName}\`.tb_product
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'
          AND kind = 'S' FOR UPDATE`,
      [id, institutionId]
    )
    if (rows.length === 0) {
      await conn.rollback()
      return false
    }
    await assertRefs(conn, input, schemaName, institutionId)
    const identifier = (input.identifier ?? '').trim() || String(id)

    await conn.query(
      `UPDATE \`${schemaName}\`.tb_product
          SET identifier = ?, description = ?, tb_category_id = ?,
              tb_financial_plans_id = ?, promotion = ?, highlights = ?,
              published = ?, active = ?, note = ?, updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND kind = 'S'`,
      [identifier, ...PRODUCT_FIELDS(input), id, institutionId]
    )
    await syncPrices(conn, id, input, schemaName, institutionId)

    await conn.commit()
    return true
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Soft delete (kind='S' no WHERE); usos históricos ficam pelos JOINs. */
export async function softDeleteService(
  id: number, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const [result] = await pool.query<any>(
    `UPDATE \`${schemaName}\`.tb_product
        SET deleted = 'S', updated_at = NOW()
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'
        AND kind = 'S'`,
    [id, institutionId]
  )
  return result.affectedRows > 0
}

// ---------------------------------------------------------------------
// Lookups de apoio do form (LIMIT 100, escapeLike)
// ---------------------------------------------------------------------

async function lookup(
  table: string, filter: string, schemaName: string, institutionId: number
): Promise<ServiceLookupRow[]> {
  assertSchemaName(schemaName)
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT id, description
       FROM \`${schemaName}\`.${table}
      WHERE tb_institution_id = ? AND deleted = 'N'
        AND (? IS NULL OR description LIKE ?)
      ORDER BY description
      LIMIT 100`,
    [institutionId, like, like]
  )
  return rows
}

export const listCategoriesLookup = (
  filter: string, schemaName: string, institutionId: number
) => lookup('tb_category', filter, schemaName, institutionId)

export const listFinancialPlansLookup = (
  filter: string, schemaName: string, institutionId: number
) => lookup('tb_financial_plans', filter, schemaName, institutionId)

/** Tabelas de preço vivas — grade do serviço NOVO (o app fala só com
 *  /api/services; nunca com o endpoint do módulo vizinho). */
export async function listPriceListsLookup(
  schemaName: string, institutionId: number
): Promise<ServiceLookupRow[]> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT id, description
       FROM \`${schemaName}\`.tb_price_list
      WHERE tb_institution_id = ? AND deleted = 'N'
      ORDER BY description, id
      LIMIT 100`,
    [institutionId]
  )
  return rows
}
