import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { assertSchemaName } from '@shared/field-config'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import {
  ServiceTaxRuleRow, ServiceTaxRuleInput, ServiceTaxRuleLookupRow,
} from './service-tax-rules.interface'

/**
 * Repositório de tb_service_tax_rule (schema do cliente). id MAX+1 por
 * institution em transação; cidade validada na central (FK física) e item
 * validado em setes_central.tb_service_list (sem FK — padrão CST/025);
 * unicidade do FATO (institution × cidade × item) por 409 na transação.
 */

const FIELDS = `r.id, r.tb_city_id AS cityId, c.name AS cityName,
            st.abbreviation AS stateAbbreviation,
            r.tb_service_list_id AS serviceListId,
            sl.description AS serviceListDescription,
            sl.local_incidence AS localIncidence,
            r.aliq, r.municipal_code AS municipalCode,
            COALESCE(r.active, 'S') AS active`

const JOINS = (schemaName: string) =>
  `FROM \`${schemaName}\`.tb_service_tax_rule r
   LEFT JOIN setes_central.tb_city c ON c.id = r.tb_city_id
   LEFT JOIN setes_central.tb_state st ON st.id = c.tb_state_id
   LEFT JOIN setes_central.tb_service_list sl ON sl.id = r.tb_service_list_id`

/** Lista PAGINADA: página + COUNT com a MESMA where (filtro em cidade, item
 *  e descrição do item). */
export async function listServiceTaxRules(
  query: ListQuery, schemaName: string, institutionId: number
): Promise<PagedRows<ServiceTaxRuleRow>> {
  assertSchemaName(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `${JOINS(schemaName)}
     WHERE r.tb_institution_id = ? AND r.deleted = 'N'
       AND (? IS NULL OR c.name LIKE ? OR r.tb_service_list_id LIKE ? OR sl.description LIKE ?)`
  const params = [institutionId, like, like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT ${FIELDS} ${where}
     ORDER BY c.name, CAST(SUBSTRING_INDEX(r.tb_service_list_id, '.', 1) AS UNSIGNED),
              r.tb_service_list_id, r.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

export async function getServiceTaxRule(
  id: number, schemaName: string, institutionId: number
): Promise<ServiceTaxRuleRow | null> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT ${FIELDS} ${JOINS(schemaName)}
     WHERE r.id = ? AND r.tb_institution_id = ? AND r.deleted = 'N'`,
    [id, institutionId]
  )
  return rows[0] ?? null
}

/** Cidade viva na central + item vivo/ativo no catálogo + fato único. */
async function assertRule(
  conn: PoolConnection, input: ServiceTaxRuleInput,
  schemaName: string, institutionId: number, excludeId: number | null
): Promise<void> {
  const [city] = await conn.query<any[]>(
    `SELECT 1 FROM setes_central.tb_city WHERE id = ? AND deleted = 'N'`,
    [input.cityId])
  if (city.length === 0) {
    throw new HttpError(400, 'Cidade inexistente',
      [{ field: 'cityId', message: 'Cidade não encontrada' }])
  }
  const [item] = await conn.query<any[]>(
    `SELECT 1 FROM setes_central.tb_service_list
      WHERE id = ? AND deleted = 'N' AND active = 'S'`,
    [input.serviceListId])
  if (item.length === 0) {
    throw new HttpError(400, 'Item da Lista de Serviços inexistente ou inativo',
      [{ field: 'serviceListId', message: 'Item não encontrado no catálogo' }])
  }
  const [dup] = await conn.query<any[]>(
    `SELECT id FROM \`${schemaName}\`.tb_service_tax_rule
      WHERE tb_institution_id = ? AND tb_city_id = ? AND tb_service_list_id = ?
        AND deleted = 'N' ${excludeId !== null ? 'AND id <> ?' : ''}`,
    excludeId !== null
      ? [institutionId, input.cityId, input.serviceListId, excludeId]
      : [institutionId, input.cityId, input.serviceListId])
  if (dup.length > 0) {
    throw new HttpError(409, 'Já existe regra para esta cidade e item',
      [{ field: 'serviceListId', message: `Regra ${dup[0].id} já cobre este item nesta cidade` }],
      'SERVICE_TAX_RULE_DUPLICATE')
  }
}

const INPUT = (input: ServiceTaxRuleInput) => [
  input.cityId, input.serviceListId, input.aliq,
  input.municipalCode ?? null, input.active ?? 'S',
]

export async function insertServiceTaxRule(
  input: ServiceTaxRuleInput, schemaName: string, institutionId: number
): Promise<number> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await assertRule(conn, input, schemaName, institutionId, null)
    const [mx] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId
         FROM \`${schemaName}\`.tb_service_tax_rule
        WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId])
    const id = Number(mx[0].nextId)
    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_service_tax_rule
         (id, tb_institution_id, tb_city_id, tb_service_list_id, aliq,
          municipal_code, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [id, institutionId, ...INPUT(input)])
    await conn.commit()
    return id
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function updateServiceTaxRule(
  id: number, input: ServiceTaxRuleInput, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(
      `SELECT 1 FROM \`${schemaName}\`.tb_service_tax_rule
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' FOR UPDATE`,
      [id, institutionId])
    if (rows.length === 0) {
      await conn.rollback()
      return false
    }
    await assertRule(conn, input, schemaName, institutionId, id)
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_service_tax_rule
          SET tb_city_id = ?, tb_service_list_id = ?, aliq = ?,
              municipal_code = ?, active = ?, updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ?`,
      [...INPUT(input), id, institutionId])
    await conn.commit()
    return true
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Soft delete — 409 se algum serviço vivo aponta a regra (FK literal D1:
 *  serviço sem regra bloqueia o faturamento, D6 — apagar por baixo
 *  quebraria o cadastro silenciosamente). */
export async function softDeleteServiceTaxRule(
  id: number, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const [inUse] = await pool.query<any[]>(
    `SELECT s.id FROM \`${schemaName}\`.tb_service s
       JOIN \`${schemaName}\`.tb_product p
         ON p.id = s.id AND p.tb_institution_id = s.tb_institution_id AND p.deleted = 'N'
      WHERE s.tb_institution_id = ? AND s.tb_service_tax_rule_id = ? AND s.deleted = 'N'
      LIMIT 1`,
    [institutionId, id])
  if (inUse.length > 0) {
    throw new HttpError(409, 'Regra em uso por serviço cadastrado',
      [{ field: 'id', message: `Serviço ${inUse[0].id} aponta esta regra` }],
      'SERVICE_TAX_RULE_IN_USE')
  }
  const [result] = await pool.query<any>(
    `UPDATE \`${schemaName}\`.tb_service_tax_rule
        SET deleted = 'S', updated_at = NOW()
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [id, institutionId])
  return result.affectedRows > 0
}

/** Lookup dos itens ATIVOS da Lista de Serviços (form da regra). */
export async function listServiceListLookup(filter: string): Promise<ServiceTaxRuleLookupRow[]> {
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT id, description
       FROM setes_central.tb_service_list
      WHERE deleted = 'N' AND active = 'S'
        AND (? IS NULL OR id LIKE ? OR description LIKE ?)
      ORDER BY CAST(SUBSTRING_INDEX(id, '.', 1) AS UNSIGNED), id
      LIMIT 100`,
    [like, like, like])
  return rows
}
