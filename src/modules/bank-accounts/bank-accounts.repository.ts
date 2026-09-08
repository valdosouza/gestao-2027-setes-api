import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { assertSchemaName } from '@shared/field-config'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import {
  BankAccountListRow, BankAccountFull, BankAccountInput, BankLookupRow,
} from './bank-accounts.interface'

/**
 * Repositório de Contas Bancárias (tb_bank_account no schema do cliente ×
 * catálogo central setes_central.tb_bank). id MAX+1 POR INSTITUTION em
 * transação; banco validado no catálogo central.
 */

const LIST_FIELDS = `a.id,
            a.tb_bank_id  AS bankId,
            b.number      AS bankNumber,
            b.description AS bankDescription,
            a.agency, a.agency_dv AS agencyDv,
            a.number, a.number_dv AS numberDv,
            a.manager, a.limit_value AS limitValue`

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE
 * (D2). Desempate por a.id (D8) mantém o OFFSET estável.
 */
export async function listBankAccounts(
  query: ListQuery, schemaName: string, institutionId: number
): Promise<PagedRows<BankAccountListRow>> {
  assertSchemaName(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM \`${schemaName}\`.tb_bank_account a
     LEFT JOIN setes_central.tb_bank b ON b.id = a.tb_bank_id
     WHERE a.tb_institution_id = ? AND a.deleted = 'N'
       AND (? IS NULL OR b.description LIKE ? OR b.number LIKE ? OR a.number LIKE ?)`
  const params = [institutionId, like, like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT ${LIST_FIELDS}
     ${where}
     ORDER BY b.description, a.agency, a.number, a.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

export async function getBankAccount(
  id: number, schemaName: string, institutionId: number
): Promise<BankAccountFull | null> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT ${LIST_FIELDS},
            DATE_FORMAT(a.dt_opening,  '%Y-%m-%d') AS dtOpening,
            a.phone,
            DATE_FORMAT(a.dt_contract, '%Y-%m-%d') AS dtContract
     FROM \`${schemaName}\`.tb_bank_account a
     LEFT JOIN setes_central.tb_bank b ON b.id = a.tb_bank_id
     WHERE a.id = ? AND a.tb_institution_id = ? AND a.deleted = 'N'`,
    [id, institutionId]
  )
  return rows[0] ?? null
}

/** Banco precisa existir vivo no catálogo central. */
async function assertBank(conn: any, bankId: number): Promise<void> {
  const [rows] = await conn.query(
    `SELECT 1 FROM setes_central.tb_bank WHERE id = ? AND deleted = 'N'`,
    [bankId]
  )
  if (rows.length === 0) {
    throw new HttpError(400, 'Banco inexistente no catálogo',
      [{ field: 'bankId', message: 'Banco não encontrado' }],
      'BANK_NOT_FOUND')
  }
}

const INPUT_FIELDS = (input: BankAccountInput) => [
  input.bankId, input.dtOpening ?? null, input.agency,
  input.agencyDv ?? null, input.number, input.numberDv ?? null,
  input.phone ?? null, input.manager ?? null, input.limitValue ?? null,
  input.dtContract ?? null,
]

export async function insertBankAccount(
  input: BankAccountInput, schemaName: string, institutionId: number
): Promise<number> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await assertBank(conn, input.bankId)

    const [mx] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${schemaName}\`.tb_bank_account
        WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId]
    )
    const id = Number(mx[0].nextId)

    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_bank_account
         (id, tb_institution_id, tb_bank_id, dt_opening, agency, agency_dv,
          number, number_dv, phone, manager, limit_value, dt_contract,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [id, institutionId, ...INPUT_FIELDS(input)]
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

export async function updateBankAccount(
  id: number, input: BankAccountInput, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query<any[]>(
      `SELECT 1 FROM \`${schemaName}\`.tb_bank_account
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' FOR UPDATE`,
      [id, institutionId]
    )
    if (rows.length === 0) {
      await conn.rollback()
      return false
    }
    await assertBank(conn, input.bankId)

    await conn.query(
      `UPDATE \`${schemaName}\`.tb_bank_account
          SET tb_bank_id = ?, dt_opening = ?, agency = ?, agency_dv = ?,
              number = ?, number_dv = ?, phone = ?, manager = ?,
              limit_value = ?, dt_contract = ?, updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ?`,
      [...INPUT_FIELDS(input), id, institutionId]
    )

    await conn.commit()
    return true
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function softDeleteBankAccount(
  id: number, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [result] = await conn.query<any>(
      `UPDATE \`${schemaName}\`.tb_bank_account
          SET deleted = 'S', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [id, institutionId]
    )
    if (result.affectedRows > 0) {
      // D-G2 (contrato financeiro, Rodada 4): contrato que apontava para a
      // conta excluída é soft-deletado junto — a forma volta a "sem baixa
      // automática" de forma visível (nunca órfão apontando para conta morta).
      await conn.query(
        `UPDATE \`${schemaName}\`.tb_financial_contract
            SET deleted = 'S', updated_at = NOW()
          WHERE tb_institution_id = ? AND tb_bank_account_id = ? AND deleted = 'N'`,
        [institutionId, id]
      )
    }
    await conn.commit()
    return result.affectedRows > 0
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Lookup do catálogo CENTRAL de bancos (form). */
export async function listBanksLookup(filter: string): Promise<BankLookupRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT id, number, description
     FROM setes_central.tb_bank
     WHERE deleted = 'N'
       AND (? IS NULL OR description LIKE ? OR number LIKE ?)
     ORDER BY description
     LIMIT 100`,
    [like, like, like]
  )
  return rows
}
