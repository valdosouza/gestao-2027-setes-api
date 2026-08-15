import pool from '@shared/db/connection'

// A criação de institution (onboarding) foi ABSORVIDA pelo módulo
// institutions (POST /api/institutions — decisão do Valdo 2026-07-11):
// insertInstitution/insertDefaultFlags/institutionSchemaExists migraram
// para src/modules/institutions/institutions.repository.ts.

// ---------------------------------------------------------------------
// setes-app Fase 1 — licenciamento de interfaces (decisões 17, 18, 23).
// O Super opera no schema do cliente ALVO, resolvido via tb_institution
// (nunca o schemaName do próprio JWT).
// ---------------------------------------------------------------------

// Peça centralizada em @shared/db/schema (2026-08-04).
import { assertSchema } from '@shared/db/schema'

export async function getInstitutionSchemaName(institutionId: number): Promise<string | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT schema_name AS schemaName
     FROM setes_central.tb_institution
     WHERE id = ? AND deleted = 'N'`,
    [institutionId]
  )
  return rows[0]?.schemaName ?? null
}

export interface InterfaceGrantRow {
  id:           number
  description:  string | null
  groupDefault: string | null
  kind:         string | null
  granted:      boolean
}

// Catálogo completo (central) + situação do contrato no schema do cliente alvo
export async function listInterfacesWithGrant(schemaName: string): Promise<InterfaceGrantRow[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT i.id,
            i.description,
            i.group_default AS groupDefault,
            i.kind,
            CASE WHEN ihi.tb_interface_id IS NOT NULL THEN TRUE ELSE FALSE END AS granted
     FROM setes_central.tb_interface i
     LEFT JOIN \`${s}\`.tb_institution_has_interface ihi
       ON (ihi.tb_interface_id = i.id AND ihi.active = 'S' AND ihi.deleted = 'N')
     WHERE i.deleted = 'N'
     ORDER BY i.group_default, i.description`
  )
  return rows.map(r => ({ ...r, granted: Boolean(r.granted) }))
}

// Sincroniza o contrato: concede as interfaces da lista, revoga (soft) as demais
export async function setInstitutionInterfaces(
  schemaName: string, institutionId: number, interfaceIds: number[]
): Promise<void> {
  const s    = assertSchema(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    if (interfaceIds.length > 0) {
      const values = interfaceIds.map(id => [institutionId, id, 'S', new Date(), new Date()])
      await conn.query(
        `INSERT INTO \`${s}\`.tb_institution_has_interface
           (tb_institution_id, tb_interface_id, active, created_at, updated_at)
         VALUES ?
         ON DUPLICATE KEY UPDATE active = 'S', deleted = 'N', updated_at = NOW()`,
        [values]
      )
      await conn.query(
        `UPDATE \`${s}\`.tb_institution_has_interface
         SET active = 'N', updated_at = NOW()
         WHERE tb_institution_id = ? AND tb_interface_id NOT IN (?)`,
        [institutionId, interfaceIds]
      )
    } else {
      await conn.query(
        `UPDATE \`${s}\`.tb_institution_has_interface
         SET active = 'N', updated_at = NOW()
         WHERE tb_institution_id = ?`,
        [institutionId]
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

// Gate técnico de módulos da API (decisão 17): a tela do Super mantém
// tb_feature_flag coerente com o contrato de interfaces.
export async function upsertFeatureFlag(
  institutionId: number, moduleKey: string, enabled: boolean
): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [existing] = await conn.query<any[]>(
      `SELECT id FROM setes_central.tb_feature_flag
       WHERE tb_institution_id = ? AND module_key = ? FOR UPDATE`,
      [institutionId, moduleKey]
    )

    if (existing.length > 0) {
      await conn.query(
        `UPDATE setes_central.tb_feature_flag
         SET enabled = ?, deleted = 'N', updated_at = NOW()
         WHERE id = ?`,
        [enabled, existing[0].id]
      )
    } else {
      const [rows] = await conn.query<any[]>(
        'SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.tb_feature_flag FOR UPDATE'
      )
      await conn.query(
        `INSERT INTO setes_central.tb_feature_flag
           (id, tb_institution_id, module_key, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, NOW(), NOW())`,
        [Number(rows[0].nextId), institutionId, moduleKey, enabled]
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

