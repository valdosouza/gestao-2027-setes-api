import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { SETES_INSTITUTION_ID, SETES_SCHEMA } from '@shared/auth/roles'
import { saveEntityFiscalChain, getEntityFiscalFull } from '@shared/entity'
import { assertSchema } from '@shared/db/schema'
import {
  InstitutionInput, InstitutionListRow, InstitutionFull, SyncApiKeyRow,
} from './institutions.interface'

/**
 * Repositório do CONCRETO Institution — CONSUMIDOR da cadeia de entidade
 * fiscal compartilhada (@shared/entity/entity.repository — skill
 * cadastro-entidade-fiscal.md). Responsabilidades daqui:
 * abrir/fechar a TRANSAÇÃO da cascade, chamar os helpers da cadeia e
 * cuidar da tabela própria (tb_institution) + feature flags do onboarding.
 */

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE
 * (D2). Desempate por i.id (D8) mantém o OFFSET estável.
 */
export async function listInstitutions(query: ListQuery): Promise<PagedRows<InstitutionListRow>> {
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM setes_central.tb_institution i
     INNER JOIN setes_central.tb_entity e ON e.id = i.id
     WHERE i.deleted = 'N'
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ? OR i.schema_name LIKE ?)`
  const params = [like, like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT i.id,
            e.nick_trade   AS nickTrade,
            e.name_company AS nameCompany,
            i.schema_name  AS schemaName,
            i.active
     ${where}
     ORDER BY e.nick_trade, i.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

/** Objeto COMPLETO: cadeia compartilhada (shared/entity) + tb_institution. */
export async function getInstitution(id: number): Promise<InstitutionFull | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT schema_name AS schemaName, active
     FROM setes_central.tb_institution
     WHERE id = ? AND deleted = 'N'`,
    [id]
  )
  if (!rows[0]) return null

  const chain = await getEntityFiscalFull(id)
  if (!chain) return null

  return { ...chain, schemaName: rows[0].schemaName, active: rows[0].active }
}

/** schema_name é UNIQUE e nunca reaproveitado — verifica INCLUINDO deleted='S'. */
export async function schemaNameExists(schemaName: string): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    'SELECT schema_name FROM setes_central.tb_institution WHERE schema_name = ?',
    [schemaName]
  )
  return rows.length > 0
}

export async function institutionExists(id: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    "SELECT id FROM setes_central.tb_institution WHERE id = ? AND deleted = 'N'",
    [id]
  )
  return rows.length > 0
}

// ---------------------------------------------------------------------
// Cascade (transação única) — a cadeia é do shared; a tb_institution é daqui
// ---------------------------------------------------------------------

/**
 * POST: cadeia inteira em transação única (helpers do shared) + INSERT da
 * tb_institution. A institution nasce active='N' — quem ativa é a migração
 * do schema, DEPOIS do commit (DDL não tem rollback).
 */
export async function insertInstitutionCascade(
  input: InstitutionInput, schemaName: string, updatedBy: number | null = null
): Promise<number> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    // Fase 3 (decisões 1 e 9): a cadeia resolve reuso pelo documento.
    const { id } = await saveEntityFiscalChain(conn, null, input, updatedBy)

    // Papel duplicado (decisão 2): 409 com o id no payload — o app oferece
    // abrir em edição. Vale mesmo deleted='S' (schema nunca é reaproveitado).
    const [existing] = await conn.query<any[]>(
      'SELECT 1 FROM setes_central.tb_institution WHERE id = ? FOR UPDATE',
      [id]
    )
    if (existing.length > 0) {
      throw new HttpError(409,
        `Esta entidade já está cadastrada como estabelecimento (id ${id})`,
        [{ field: 'id', message: String(id) }])
    }

    await conn.query(
      `INSERT INTO setes_central.tb_institution (id, schema_name, active, created_at, updated_at)
       VALUES (?, ?, 'N', NOW(), NOW())`,
      [id, schemaName]
    )

    // Decisão 13 da Fase 3 (Valdo, 2026-07-16): todo institution nasce também
    // CLIENTE DA SETES (tb_customer em setes_setes, institution 1) para a
    // administração do contrato — "clientes de verdade são os que não são a
    // própria Setes". Idempotente: se a entity já era cliente da Setes,
    // revive/mantém (não é papel duplicado — é o vínculo comercial esperado).
    await conn.query(
      `INSERT INTO ??
         (id, tb_institution_id, active, created_at, updated_at)
       VALUES (?, ?, 'S', NOW(), NOW())
       ON DUPLICATE KEY UPDATE deleted = 'N', active = 'S', updated_at = NOW()`,
      [`${SETES_SCHEMA}.tb_customer`, id, SETES_INSTITUTION_ID]
    )

    await conn.commit()
    return id
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** PUT: mesma cascade em transação única. schema_name é IMUTÁVEL. */
export async function updateInstitutionCascade(
  id: number, input: InstitutionInput, updatedBy: number | null = null
): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    await saveEntityFiscalChain(conn, id, input, updatedBy)

    if (input.active !== undefined) {
      await conn.query(
        `UPDATE setes_central.tb_institution SET active = ?, updated_at = NOW() WHERE id = ?`,
        [input.active, id]
      )
    }

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function setInstitutionActive(id: number, active: 'S' | 'N'): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_institution SET active = ?, updated_at = NOW() WHERE id = ?`,
    [active, id]
  )
}

/** Soft delete da institution — a cadeia entity permanece. */
export async function deleteInstitution(id: number): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_institution SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}

/**
 * Feature flags padrão do onboarding (gate técnico — decisão 17). Veio do
 * antigo admin.repository quando o cadastro absorveu o onboarding
 * (decisão do Valdo, 2026-07-11).
 */
export async function insertDefaultFlags(institutionId: number): Promise<void> {
  // 'customers' liberado por padrão desde a Fase 3; 'collaborators' desde a
  // onda 2; 'salesmen'/'carriers' desde a Onda 2 salesman/carrier (gate
  // técnico — o comercial por tela continua em tb_institution_has_interface,
  // decisão 17).
  // 'modules' (menus do cliente) liberado por padrão desde 2026-08-04
  // (prompt_modulo_menus.md — a tela é do admin via adminGuard).
  // 'users' desde 2026-08-15 (A2): sem ele o admin do cliente toma 403 ao
  // gerenciar os próprios usuários — administração, não produto vendável.
  const defaultModules = [
    'core', 'users', 'customers', 'collaborators', 'salesmen', 'carriers',
    'providers', 'categories', 'financial-plans', 'tax-rules',
    'payment-types', 'contracts', 'bank-accounts',
    'service-orders', 'settlements', 'modules',
  ]
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query<any[]>(
      'SELECT COALESCE(MAX(id), 0) AS maxId FROM setes_central.tb_feature_flag FOR UPDATE'
    )
    let nextId = Number(rows[0].maxId)

    const now    = new Date()
    const values = defaultModules.map(mod => [++nextId, institutionId, mod, true, now, now])

    await conn.query(
      `INSERT INTO setes_central.tb_feature_flag
         (id, tb_institution_id, module_key, enabled, created_at, updated_at)
       VALUES ?`,
      [values]
    )

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/**
 * Telas ESTRUTURAIS do cliente (decisão do Valdo, 2026-08-15 — A2): não são
 * produto vendável, são o mínimo para o admin se virar sozinho. Todo o resto
 * do catálogo continua venda explícita do Super (tela de Interfaces do
 * Estabelecimento). Sem isto o menu de um cliente novo nasce VAZIO — o
 * getMenus faz INNER JOIN com o contrato.
 *
 * Ids resolvidos por i18n_key, nunca literais (lição do seed 25).
 * Roda DEPOIS das migrations: a tabela vive no schema do cliente.
 */
export const STRUCTURAL_INTERFACE_KEYS = ['users', 'modules', 'interface-configs']

export async function grantStructuralInterfaces(
  schemaName: string, institutionId: number
): Promise<number> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT id FROM setes_central.tb_interface
      WHERE i18n_key IN (?) AND deleted = 'N'`,
    [STRUCTURAL_INTERFACE_KEYS]
  )
  if (rows.length === 0) return 0

  const now    = new Date()
  const values = rows.map((r: any) => [institutionId, r.id, 'S', now, now])
  await pool.query(
    `INSERT INTO \`${s}\`.tb_institution_has_interface
       (tb_institution_id, tb_interface_id, active, created_at, updated_at)
     VALUES ?
     ON DUPLICATE KEY UPDATE active = 'S', deleted = 'N', updated_at = NOW()`,
    [values]
  )
  return rows.length
}

// ---------------------------------------------------------------------
// Chave de sincronização (tb_sync_api_key — D12 da revisão do sincronizador)
// ---------------------------------------------------------------------

export async function getSyncApiKey(institutionId: number): Promise<SyncApiKeyRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT api_key AS apiKey, establishment_code AS establishmentCode, active
     FROM setes_central.tb_sync_api_key
     WHERE tb_institution_id = ? AND deleted = 'N'
     ORDER BY id
     LIMIT 1`,
    [institutionId]
  )
  return rows[0] ?? null
}

/** Uma chave por estabelecimento; id sem auto_increment → MAX+1 na transação. */
export async function insertSyncApiKey(
  institutionId: number, apiKey: string, establishmentCode: string
): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(
      'SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.tb_sync_api_key FOR UPDATE'
    )
    await conn.query(
      `INSERT INTO setes_central.tb_sync_api_key
         (id, api_key, tb_institution_id, establishment_code, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'S', NOW(), NOW())`,
      [Number(rows[0].nextId), apiKey, institutionId, establishmentCode]
    )
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}
