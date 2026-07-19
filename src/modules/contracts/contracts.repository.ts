import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { assertSchemaName } from '@shared/field-config'
import {
  ContractListRow, ContractFull, ContractInput, ProductLookupRow,
} from './contracts.interface'

/**
 * Repositório de Contratos (tb_contract + tb_contract_item no schema do
 * cliente). id MAX+1 POR INSTITUTION em transação; cliente validado no
 * papel local (tb_customer) DENTRO da transação; itens sincronizados por
 * productId (soft delete dos ausentes + upsert dos enviados).
 */

export async function listContracts(
  filter: string, schemaName: string, institutionId: number
): Promise<ContractListRow[]> {
  assertSchemaName(schemaName)
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT c.id,
            c.tb_customer_id AS customerId,
            COALESCE(e.nick_trade, e.name_company) AS customerName,
            DATE_FORMAT(c.dt_start, '%Y-%m-%d') AS dtStart,
            DATE_FORMAT(c.dt_end,   '%Y-%m-%d') AS dtEnd,
            COALESCE((SELECT SUM(i.value) FROM \`${schemaName}\`.tb_contract_item i
                       WHERE i.tb_contract_id = c.id
                         AND i.tb_institution_id = c.tb_institution_id
                         AND i.deleted = 'N'), 0) AS monthlyValue,
            c.active
     FROM \`${schemaName}\`.tb_contract c
     INNER JOIN setes_central.tb_entity e ON e.id = c.tb_customer_id
     WHERE c.tb_institution_id = ? AND c.deleted = 'N'
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ?)
     ORDER BY customerName, c.id
     LIMIT 200`,
    [institutionId, like, like, like]
  )
  return rows
}

export async function getContract(
  id: number, schemaName: string, institutionId: number
): Promise<ContractFull | null> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT c.id,
            c.tb_customer_id AS customerId,
            COALESCE(e.nick_trade, e.name_company) AS customerName,
            DATE_FORMAT(c.dt_start, '%Y-%m-%d') AS dtStart,
            DATE_FORMAT(c.dt_end,   '%Y-%m-%d') AS dtEnd,
            c.payment_day AS paymentDay,
            c.active
     FROM \`${schemaName}\`.tb_contract c
     INNER JOIN setes_central.tb_entity e ON e.id = c.tb_customer_id
     WHERE c.id = ? AND c.tb_institution_id = ? AND c.deleted = 'N'`,
    [id, institutionId]
  )
  if (!rows[0]) return null

  const [items] = await pool.query<any[]>(
    `SELECT i.tb_product_id AS productId,
            p.description   AS productDescription,
            i.value
     FROM \`${schemaName}\`.tb_contract_item i
     LEFT JOIN \`${schemaName}\`.tb_product p
       ON p.id = i.tb_product_id AND p.tb_institution_id = i.tb_institution_id
     WHERE i.tb_contract_id = ? AND i.tb_institution_id = ? AND i.deleted = 'N'
     ORDER BY p.description`,
    [id, institutionId]
  )
  return { ...rows[0], items }
}

/** Cliente precisa ter o PAPEL local (tb_customer) nesta institution. */
async function assertCustomerRole(
  conn: any, schemaName: string, institutionId: number, customerId: number
): Promise<void> {
  const [rows] = await conn.query(
    `SELECT 1 FROM \`${schemaName}\`.tb_customer
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [customerId, institutionId]
  )
  if (rows.length === 0) {
    throw new HttpError(400, 'Cliente não encontrado nesta institution',
      [{ field: 'customerId', message: 'Cliente inexistente' }])
  }
}

/** Sincroniza os itens: soft delete dos ausentes + upsert dos enviados. */
async function syncItems(
  conn: any, schemaName: string, institutionId: number,
  contractId: number, items: ContractInput['items']
): Promise<void> {
  const table = `${schemaName}.tb_contract_item`
  const ids = items.map(i => i.productId)
  await conn.query(
    `UPDATE ?? SET deleted = 'S', updated_at = NOW()
      WHERE tb_contract_id = ? AND tb_institution_id = ?
        AND tb_product_id NOT IN (?)`,
    [table, contractId, institutionId, ids]
  )
  for (const item of items) {
    await conn.query(
      `INSERT INTO ?? (tb_contract_id, tb_institution_id, tb_product_id,
         value, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         value = VALUES(value), deleted = 'N', updated_at = NOW()`,
      [table, contractId, institutionId, item.productId, item.value]
    )
  }
}

export async function insertContract(
  input: ContractInput, schemaName: string, institutionId: number
): Promise<number> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await assertCustomerRole(conn, schemaName, institutionId, input.customerId)

    const [mx] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${schemaName}\`.tb_contract
        WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId]
    )
    const id = Number(mx[0].nextId)

    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_contract
         (id, tb_institution_id, tb_customer_id, dt_start, dt_end,
          payment_day, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [id, institutionId, input.customerId, input.dtStart,
       input.dtEnd ?? null, input.paymentDay, input.active]
    )
    await syncItems(conn, schemaName, institutionId, id, input.items)

    await conn.commit()
    return id
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function updateContract(
  id: number, input: ContractInput, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query<any[]>(
      `SELECT 1 FROM \`${schemaName}\`.tb_contract
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' FOR UPDATE`,
      [id, institutionId]
    )
    if (rows.length === 0) {
      await conn.rollback()
      return false
    }
    await assertCustomerRole(conn, schemaName, institutionId, input.customerId)

    await conn.query(
      `UPDATE \`${schemaName}\`.tb_contract
          SET tb_customer_id = ?, dt_start = ?, dt_end = ?,
              payment_day = ?, active = ?, updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ?`,
      [input.customerId, input.dtStart, input.dtEnd ?? null,
       input.paymentDay, input.active, id, institutionId]
    )
    await syncItems(conn, schemaName, institutionId, id, input.items)

    await conn.commit()
    return true
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function softDeleteContract(
  id: number, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const [result] = await pool.query<any>(
    `UPDATE \`${schemaName}\`.tb_contract
        SET deleted = 'S', updated_at = NOW()
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [id, institutionId]
  )
  return result.affectedRows > 0
}

/** Lookup de produtos/serviços ATIVOS da institution (form de itens). */
export async function listProductsLookup(
  filter: string, schemaName: string, institutionId: number
): Promise<ProductLookupRow[]> {
  assertSchemaName(schemaName)
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT p.id, p.description
     FROM \`${schemaName}\`.tb_product p
     WHERE p.tb_institution_id = ? AND p.deleted = 'N' AND p.active = 'S'
       AND (? IS NULL OR p.description LIKE ?)
     ORDER BY p.description
     LIMIT 100`,
    [institutionId, like, like]
  )
  return rows
}
