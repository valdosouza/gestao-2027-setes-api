import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { FiscalInput, PersonRow, CompanyRow } from './fiscal.types'

/**
 * Persistência FISCAL (tb_person × tb_company, setes_central).
 * Peça independente (SRP): só conhece as duas tabelas do toggle; o vínculo
 * com a entity é o [entityId] recebido por parâmetro. Escrita é
 * TRANSACTION-AWARE (conn da transação aberta pelo chamador).
 */

/** Toggle fiscal: upsert da especialização escolhida, soft delete da outra. */
export async function upsertFiscal(
  conn: PoolConnection, entityId: number, input: FiscalInput
): Promise<void> {
  if (input.personType === 'F') {
    await conn.query(
      `INSERT INTO setes_central.tb_person (id, cpf, rg, birthday, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         cpf = VALUES(cpf), rg = VALUES(rg), birthday = VALUES(birthday),
         deleted = 'N', updated_at = NOW()`,
      [entityId, input.person!.cpf, input.person!.rg ?? null, input.person!.birthday ?? null]
    )
    await conn.query(
      `UPDATE setes_central.tb_company SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
      [entityId]
    )
  } else {
    await conn.query(
      `INSERT INTO setes_central.tb_company (id, cnpj, ie, im, dt_foundation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         cnpj = VALUES(cnpj), ie = VALUES(ie), im = VALUES(im),
         dt_foundation = VALUES(dt_foundation), deleted = 'N', updated_at = NOW()`,
      [entityId, input.company!.cnpj, input.company!.ie ?? null, input.company!.im ?? null,
       input.company!.dtFoundation ?? null]
    )
    await conn.query(
      `UPDATE setes_central.tb_person SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
      [entityId]
    )
  }
}

/** PF viva da entity (null se não é PF). Datas com DATE_FORMAT. */
export async function getPerson(entityId: number): Promise<PersonRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT cpf, rg, DATE_FORMAT(birthday, '%Y-%m-%d') AS birthday
     FROM setes_central.tb_person WHERE id = ? AND deleted = 'N'`,
    [entityId]
  )
  return (rows[0] as PersonRow | undefined) ?? null
}

/** PJ viva da entity (null se não é PJ). Datas com DATE_FORMAT. */
export async function getCompany(entityId: number): Promise<CompanyRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT cnpj, ie, im, DATE_FORMAT(dt_foundation, '%Y-%m-%d') AS dtFoundation
     FROM setes_central.tb_company WHERE id = ? AND deleted = 'N'`,
    [entityId]
  )
  return (rows[0] as CompanyRow | undefined) ?? null
}
