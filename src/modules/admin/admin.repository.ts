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


// O vínculo estabelecimento × interfaces (leitura e escrita) virou peça ÚNICA em 2026-10-18 (D-PV11 — duas telas, a aba do Super e
// a "Interfaces dos clientes" delegável): `@shared/institution-interfaces`, já na forma escopada pela institution (D-GE4).
export {
  getInstitutionSchemaName, listInterfacesWithGrant, setInstitutionInterfaces,
} from '@shared/institution-interfaces'
export type { InterfaceGrantRow } from '@shared/institution-interfaces'

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

