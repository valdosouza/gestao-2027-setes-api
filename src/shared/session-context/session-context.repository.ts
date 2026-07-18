import pool from '@shared/db/connection'
import { assertSchemaName } from '@shared/field-config'

/**
 * Consultas dos fatos derivados de sessão (decisão 17). tb_salesman vive no
 * schema do cliente (sql/03) com PK (id, tb_institution_id).
 */

/** "É vendedor" (decisão 15): registro em tb_salesman, sem depender do
 *  cadastro de salesman (onda 2). Refino por `active` fica para o futuro. */
export async function existsSalesman(
  schemaName: string, institutionId: number, userId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM \`${schemaName}\`.tb_salesman
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [userId, institutionId]
  )
  return rows.length > 0
}
