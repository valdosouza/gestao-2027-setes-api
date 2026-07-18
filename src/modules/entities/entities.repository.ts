import pool from '@shared/db/connection'

/**
 * Papéis EXISTENTES de uma entity (Fase 3 Entidade Única, decisão 3):
 * informativos no retorno do by-document — nunca bloqueiam (a mesma entity
 * pode ter vários papéis em vários schemas; o 409 de papel duplicado é
 * responsabilidade do módulo do papel, decisão 2).
 *
 * institution é global (setes_central); customer/salesman/carrier são
 * verificados NO schema e NA institution do usuário logado.
 */
export async function listEntityRoles(
  entityId: number, schemaName: string, institutionId: number
): Promise<string[]> {
  const roles: string[] = []

  const [inst] = await pool.query<any[]>(
    "SELECT 1 FROM setes_central.tb_institution WHERE id = ? AND deleted = 'N'",
    [entityId]
  )
  if (inst.length > 0) roles.push('institution')

  const localRoles: Array<[string, string]> = [
    ['tb_customer', 'customer'],
    ['tb_salesman', 'salesman'],
    ['tb_carrier',  'carrier'],
  ]
  for (const [table, role] of localRoles) {
    const [rows] = await pool.query<any[]>(
      `SELECT 1 FROM ?? WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [`${schemaName}.${table}`, entityId, institutionId]
    )
    if (rows.length > 0) roles.push(role)
  }

  return roles
}
