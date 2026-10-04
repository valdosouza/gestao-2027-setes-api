import { assertServiceProduct } from '@shared/service-product'
import { round2 } from '@shared/money'
import pool from '@shared/db/connection'
import { PoolConnection } from 'mysql2/promise'
import { HttpError } from '@shared/errors/http-error'
import { assertPaymentTypesEnabled } from '@shared/payment-types'
import { assertSchemaName } from '@shared/field-config'
import { ListQuery, PagedRows, SearchCriterion, escapeLike } from '@shared/list'
import { listEnabledPaymentTypes } from '@shared/payment-types'
import {
  ContractListRow, ContractFull, ContractInput, ProductLookupRow,
  LookupRow,
} from './contracts.interface'

/**
 * Repositório de Contratos (tb_contract + tb_contract_item no schema do
 * cliente). id MAX+1 POR INSTITUTION em transação; cliente validado no
 * papel local (tb_customer) DENTRO da transação; itens sincronizados por
 * productId (soft delete dos ausentes + upsert dos enviados).
 */

/**
 * PESQUISA AVANÇADA (prompt_pesquisa_avancada.md — Onda 2 §12, D-BA21/D-BA27): lista
 * branca da lista de contratos. O valor mensal vem do alias `mv` (derived table 1:1 na
 * query base — a coluna da linha e o critério são a MESMA expressão, parecer do guardião);
 * cliente e forma por lookup do PRÓPRIO módulo.
 */
export const CONTRACT_SEARCH_CRITERIA: readonly SearchCriterion[] = [
  { key: 'customerName', kind: 'text', labelKey: 'search.contracts.customerName',
    expr: ['e.nick_trade', 'e.name_company'] },
  { key: 'customer', kind: 'lookup', labelKey: 'search.contracts.customer',
    expr: 'c.tb_customer_id', lookup: '/api/contracts/customer-lookup' },
  { key: 'paymentType', kind: 'lookup', labelKey: 'search.contracts.paymentType',
    expr: 'c.tb_payment_types_id', lookup: '/api/contracts/payment-types' },
  { key: 'paymentDay', kind: 'number', labelKey: 'search.contracts.paymentDay', expr: 'c.payment_day' },
  { key: 'dtStart', kind: 'date', labelKey: 'search.contracts.dtStart', expr: 'c.dt_start' },
  { key: 'dtEnd', kind: 'date', labelKey: 'search.contracts.dtEnd', expr: 'c.dt_end' },
  { key: 'monthlyValue', kind: 'money', labelKey: 'search.contracts.monthlyValue', expr: 'COALESCE(mv.total, 0)' },
  { key: 'active', kind: 'bool', labelKey: 'search.contracts.active', expr: 'c.active', boolValues: ['S', 'N'] },
]

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE
 * (D2). Ordenação por customerName já tinha desempate por c.id (D8).
 */
export async function listContracts(
  query: ListQuery, schemaName: string, institutionId: number
): Promise<PagedRows<ContractListRow>> {
  assertSchemaName(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM \`${schemaName}\`.tb_contract c
     INNER JOIN setes_central.tb_entity e ON e.id = c.tb_customer_id
     LEFT JOIN (SELECT i.tb_contract_id, i.tb_institution_id, SUM(i.value) AS total
                  FROM \`${schemaName}\`.tb_contract_item i
                 WHERE i.deleted = 'N'
                 GROUP BY i.tb_contract_id, i.tb_institution_id) mv
       ON mv.tb_contract_id = c.id AND mv.tb_institution_id = c.tb_institution_id
     WHERE c.tb_institution_id = ? AND c.deleted = 'N'
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ?)${query.criteria.sql}`
  const params = [institutionId, like, like, like, ...query.criteria.params]

  const [rows] = await pool.query<any[]>(
    `SELECT c.id,
            c.tb_customer_id AS customerId,
            COALESCE(e.nick_trade, e.name_company) AS customerName,
            DATE_FORMAT(c.dt_start, '%Y-%m-%d') AS dtStart,
            DATE_FORMAT(c.dt_end,   '%Y-%m-%d') AS dtEnd,
            COALESCE(mv.total, 0) AS monthlyValue,
            c.active
     ${where}
     ORDER BY customerName, c.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
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
            c.tb_payment_types_id AS paymentTypeId,
            pt.description AS paymentTypeDescription,
            c.active
     FROM \`${schemaName}\`.tb_contract c
     INNER JOIN setes_central.tb_entity e ON e.id = c.tb_customer_id
     LEFT JOIN setes_central.tb_payment_types pt
            ON pt.id = c.tb_payment_types_id AND pt.deleted = 'N'
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
      [{ field: 'customerId', message: 'Cliente inexistente' }],
      'ROLE_MISSING')
  }
}

/** Sincroniza os itens: soft delete dos ausentes + upsert dos enviados. */
async function syncItems(
  conn: any, schemaName: string, institutionId: number,
  contractId: number, items: ContractInput['items']
): Promise<void> {
  // Q-G27 (Valdo 2026-09-10, "ambos"): item do contrato = SERVIÇO existente e ativo —
  // a MESMA guarda única da OS (peça @shared/service-product); sem FK, a validação é
  // aqui. A rotina mensal ainda pula e reporta o que ficou inválido depois.
  // D-G34 (Valdo 2026-09-13): só item NOVO ou com valor ALTERADO revalida o produto —
  // encerrar/inativar o contrato com item herdado que ficou inválido passa (padrão
  // da Q5 dos Menus: "422 só para ids novos, vínculo herdado sobrevive").
  const table = `${schemaName}.tb_contract_item`
  const [current] = await conn.query(
    `SELECT tb_product_id AS productId, value FROM ??
      WHERE tb_contract_id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [table, contractId, institutionId]
  )
  const known = new Map<number, number>((current as any[]).map(r => [Number(r.productId), round2(Number(r.value))]))
  for (const item of items) {
    const before = known.get(Number(item.productId))
    if (before === undefined || before !== round2(Number(item.value))) {
      await assertServiceProduct(conn, schemaName, institutionId, item.productId)
    }
  }
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

/**
 * A forma COMBINADA (D14) é validada NA PORTA onde o humano digita (HIGH-1 do
 * gate socrático + MEDIUM do adversarial): antes, o contrato aceitava qualquer
 * inteiro — inclusive forma inexistente ou desabilitada — e o erro só aparecia
 * meses depois, no dia da cobrança, dentro do lote, depois de N ordens já
 * faturadas. Regra da casa: o que valida é o que grava (02-VALIDACAO.md).
 *
 * A migration 053 deixou a coluna sem FK de propósito (a forma é central e o
 * habilitado é o vínculo institution×forma) — então a guarda é esta.
 */
async function assertContractPaymentType(
  conn: PoolConnection, schemaName: string, institutionId: number, input: ContractInput
): Promise<void> {
  if (input.paymentTypeId == null) return   // "informar no faturamento" — a presença decide
  await assertPaymentTypesEnabled(
    conn, schemaName, institutionId, [input.paymentTypeId], 'paymentTypeId')
}

export async function insertContract(
  input: ContractInput, schemaName: string, institutionId: number
): Promise<number> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await assertCustomerRole(conn, schemaName, institutionId, input.customerId)
    await assertContractPaymentType(conn, schemaName, institutionId, input)

    const [mx] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${schemaName}\`.tb_contract
        WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId]
    )
    const id = Number(mx[0].nextId)

    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_contract
         (id, tb_institution_id, tb_customer_id, dt_start, dt_end,
          payment_day, tb_payment_types_id, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [id, institutionId, input.customerId, input.dtStart,
       input.dtEnd ?? null, input.paymentDay, input.paymentTypeId ?? null, input.active]
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
    await assertContractPaymentType(conn, schemaName, institutionId, input)

    await conn.query(
      `UPDATE \`${schemaName}\`.tb_contract
          SET tb_customer_id = ?, dt_start = ?, dt_end = ?,
              payment_day = ?, tb_payment_types_id = ?, active = ?, updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ?`,
      [input.customerId, input.dtStart, input.dtEnd ?? null,
       input.paymentDay, input.paymentTypeId ?? null, input.active, id, institutionId]
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

/** Clientes da institution para o critério "cliente" (D-BA27: carteira travada vale aqui). */
export async function listCustomerLookup(
  filter: string, schemaName: string, institutionId: number,
  salesmanId: number | null = null
): Promise<LookupRow[]> {
  assertSchemaName(schemaName)
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT cu.id, COALESCE(NULLIF(e.nick_trade, ''), e.name_company) AS name
       FROM \`${schemaName}\`.tb_customer cu
       INNER JOIN setes_central.tb_entity e ON e.id = cu.id
      WHERE cu.tb_institution_id = ? AND cu.deleted = 'N'
        AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ?)
        AND (? IS NULL OR cu.tb_salesman_id = ?)
      ORDER BY name, cu.id
      LIMIT 50`,
    [institutionId, like, like, like, salesmanId, salesmanId]
  )
  return rows as LookupRow[]
}

/** Formas de pagamento HABILITADAS para o critério "forma" (peça @shared/payment-types). */
export async function listPaymentTypesLookup(
  filter: string, schemaName: string, institutionId: number
): Promise<LookupRow[]> {
  const rows = await listEnabledPaymentTypes(pool, schemaName, institutionId, filter)
  return rows.map(r => ({ id: r.id, name: r.description }))
}

/** Lookup de SERVIÇOS ativos da institution (form de itens do contrato). */
export async function listProductsLookup(
  filter: string, schemaName: string, institutionId: number
): Promise<ProductLookupRow[]> {
  assertSchemaName(schemaName)
  const like = filter ? `%${filter}%` : null
  // Contrato (Software House) vende SERVIÇOS: tb_product.kind='S' (D2 do
  // prompt_notas_mercadoria_servico.md).
  const [rows] = await pool.query<any[]>(
    `SELECT p.id, p.description
     FROM \`${schemaName}\`.tb_product p
     WHERE p.tb_institution_id = ? AND p.deleted = 'N' AND p.active = 'S' AND p.kind = 'S'
       AND (? IS NULL OR p.description LIKE ?)
     ORDER BY p.description
     LIMIT 100`,
    [institutionId, like, like]
  )
  return rows
}
