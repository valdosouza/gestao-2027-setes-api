import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { saveEntityFiscalChain, getEntityFiscalFull } from '@shared/entity'
import { upsertEntityTax, getEntityTax } from '@shared/entity-tax/entity-tax.repository'
import {
  CustomerInput, CustomerListRow, CustomerFull, RoleLookupRow,
} from './customers.interface'

/**
 * Repositório do CONCRETO Customer — CONSUMIDOR da cadeia de entidade fiscal
 * compartilhada (skill cadastro-entidade-fiscal.md). A cadeia vive em
 * setes_central; a tb_customer vive no SCHEMA DO CLIENTE (FK cross-schema,
 * migration 005) com PK composta (id, tb_institution_id) — todas as queries
 * filtram pela institution do JWT. Identificadores de schema entram via ??
 * (escape de identifier do mysql2).
 */

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

export async function listCustomers(
  filter: string, schemaName: string, institutionId: number,
  salesmanId: number | null = null
): Promise<CustomerListRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT c.id,
            e.nick_trade   AS nickTrade,
            e.name_company AS nameCompany,
            c.active
     FROM ?? c
     INNER JOIN setes_central.tb_entity e ON e.id = c.id
     WHERE c.tb_institution_id = ? AND c.deleted = 'N'
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ?)
       AND (? IS NULL OR c.tb_salesman_id = ?)
     ORDER BY e.nick_trade
     LIMIT 200`,
    [`${schemaName}.tb_customer`, institutionId, like, like, like, salesmanId, salesmanId]
  )
  return rows
}

/** Objeto COMPLETO: cadeia compartilhada + tb_customer + nomes dos FKs +
 *  tributação (peça @shared/entity-tax). wallet DERIVADO do payment type. */
export async function getCustomer(
  id: number, schemaName: string, institutionId: number
): Promise<CustomerFull | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT c.tb_salesman_id      AS tbSalesmanId,
            es.nick_trade         AS salesmanName,
            c.tb_carrier_id       AS tbCarrierId,
            ec.nick_trade         AS carrierName,
            c.credit_status       AS creditStatus,
            c.credit_value        AS creditValue,
            c.tb_payment_types_id AS tbPaymentTypesId,
            c.multiplier,
            c.active
     FROM ?? c
     LEFT JOIN setes_central.tb_entity es ON es.id = c.tb_salesman_id
     LEFT JOIN setes_central.tb_entity ec ON ec.id = c.tb_carrier_id
     WHERE c.id = ? AND c.tb_institution_id = ? AND c.deleted = 'N'`,
    [`${schemaName}.tb_customer`, id, institutionId]
  )
  if (!rows[0]) return null

  const chain = await getEntityFiscalFull(id)
  if (!chain) return null

  const tax = await getEntityTax(schemaName, institutionId, id)
  return {
    ...chain, ...rows[0],
    wallet: Number(rows[0].tbPaymentTypesId) > 0 ? 'S' : 'N',
    tax,
  }
}

export async function customerExists(
  id: number, schemaName: string, institutionId: number
): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM ?? WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [`${schemaName}.tb_customer`, id, institutionId]
  )
  return rows.length > 0
}

// ---------------------------------------------------------------------
// Cascade (transação única) — a cadeia é do shared; a tb_customer é daqui
// ---------------------------------------------------------------------

const CUSTOMER_FIELDS = (input: CustomerInput, paymentTypesId: number) => [
  input.tbSalesmanId ?? null, input.tbCarrierId ?? null,
  input.creditStatus ?? null, input.creditValue ?? null,
  paymentTypesId, input.multiplier ?? 1,
  input.active ?? 'S',
]

/**
 * Porta do Fc_PegaFormaPgto do Delphi (decisão 18): garante a forma de
 * pagamento "Carteira" (fiado/pendurado — id_nfce 05 = Crédito Loja) no
 * schema do cliente, criando-a on-demand com id MAX+1 (FOR UPDATE, dentro
 * da transação do salvar). Devolve o id para gravar em tb_payment_types_id.
 */
async function ensureWalletPaymentType(
  conn: PoolConnection, schemaName: string
): Promise<number> {
  const table = `${schemaName}.tb_payment_types`
  const [rows] = await conn.query<any[]>(
    `SELECT id FROM ?? WHERE description = ? AND deleted = 'N' LIMIT 1 FOR UPDATE`,
    [table, 'Carteira']
  )
  if (rows.length > 0) return Number(rows[0].id)

  const [mx] = await conn.query<any[]>(
    'SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM ?? FOR UPDATE', [table]
  )
  const id = Number(mx[0].nextId)
  await conn.query(
    `INSERT INTO ?? (id, description, id_nfce, created_at, updated_at)
     VALUES (?, ?, '05', NOW(), NOW())`,
    [table, id, 'Carteira']
  )
  return id
}

/** wallet da UI (Sim/Não) → id da forma de pagamento (0 = sem carteira). */
async function resolveWalletPaymentType(
  conn: PoolConnection, schemaName: string, input: CustomerInput
): Promise<number> {
  return input.wallet === 'S' ? ensureWalletPaymentType(conn, schemaName) : 0
}

/**
 * POST: cadeia em transação única (reuso por documento — decisões 1 e 9) +
 * tb_customer. Papel duplicado NESTA institution (decisão 2): linha viva →
 * 409 com o id no payload (o app oferece abrir em edição); linha deleted='S'
 * → REVIVE com os dados novos.
 */
export async function insertCustomerCascade(
  input: CustomerInput, schemaName: string, institutionId: number,
  updatedBy: number | null = null
): Promise<{ id: number; reused: boolean }> {
  const table = `${schemaName}.tb_customer`
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
        `Esta entidade já está cadastrada como cliente deste estabelecimento (id ${id})`,
        [{ field: 'id', message: String(id) }])
    }

    const paymentTypesId = await resolveWalletPaymentType(conn, schemaName, input)

    if (existing.length > 0) {
      await conn.query(
        `UPDATE ?? SET tb_salesman_id = ?, tb_carrier_id = ?, credit_status = ?,
           credit_value = ?, tb_payment_types_id = ?, multiplier = ?,
           active = ?, deleted = 'N', updated_at = NOW()
         WHERE id = ? AND tb_institution_id = ?`,
        [table, ...CUSTOMER_FIELDS(input, paymentTypesId), id, institutionId]
      )
    } else {
      await conn.query(
        `INSERT INTO ?? (id, tb_institution_id, tb_salesman_id, tb_carrier_id,
           credit_status, credit_value, tb_payment_types_id, multiplier,
           active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [table, id, institutionId, ...CUSTOMER_FIELDS(input, paymentTypesId)]
      )
    }

    // Aba Tributação (decisão 17): salva JUNTO, na mesma transação;
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
export async function updateCustomerCascade(
  id: number, input: CustomerInput, schemaName: string, institutionId: number,
  updatedBy: number | null = null
): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    await saveEntityFiscalChain(conn, id, input, updatedBy)

    const paymentTypesId = await resolveWalletPaymentType(conn, schemaName, input)

    await conn.query(
      `UPDATE ?? SET tb_salesman_id = ?, tb_carrier_id = ?, credit_status = ?,
         credit_value = ?, tb_payment_types_id = ?, multiplier = ?,
         active = ?, updated_at = NOW()
       WHERE id = ? AND tb_institution_id = ?`,
      [`${schemaName}.tb_customer`, ...CUSTOMER_FIELDS(input, paymentTypesId), id, institutionId]
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
export async function deleteCustomer(
  id: number, schemaName: string, institutionId: number
): Promise<void> {
  await pool.query(
    `UPDATE ?? SET deleted = 'S', updated_at = NOW() WHERE id = ? AND tb_institution_id = ?`,
    [`${schemaName}.tb_customer`, id, institutionId]
  )
}

// ---------------------------------------------------------------------
// Lookups de salesman/carrier (decisão 11 — padrão countries/states;
// os CADASTROS deles ficam para a onda 2)
// ---------------------------------------------------------------------

async function roleLookup(
  table: string, filter: string, schemaName: string, institutionId: number
): Promise<RoleLookupRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT r.id, COALESCE(e.nick_trade, e.name_company) AS name
     FROM ?? r
     INNER JOIN setes_central.tb_entity e ON e.id = r.id
     WHERE r.tb_institution_id = ? AND r.deleted = 'N'
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ?)
     ORDER BY name
     LIMIT 50`,
    [`${schemaName}.${table}`, institutionId, like, like, like]
  )
  return rows
}

export const listSalesmanLookup = (filter: string, schemaName: string, institutionId: number) =>
  roleLookup('tb_salesman', filter, schemaName, institutionId)

export const listCarrierLookup = (filter: string, schemaName: string, institutionId: number) =>
  roleLookup('tb_carrier', filter, schemaName, institutionId)
