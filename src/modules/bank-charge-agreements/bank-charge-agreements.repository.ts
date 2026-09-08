import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { assertSchemaName } from '@shared/field-config'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import {
  ChargeAgreementListRow, ChargeAgreementFull, ChargeAgreementInput, BankAccountLookupRow,
} from './bank-charge-agreements.interface'

/**
 * Repositório de Carteiras de Cobrança (tb_bank_charge_agreement no schema
 * do cliente). id MAX+1 POR INSTITUTION em transação; conta corrente
 * validada no cadastro do cliente. `tb_bank_charge_kind_id`/
 * `tb_bank_charge_ticket_id` nascem 0 (sem catálogo hoje — ver interface.ts).
 */

const ACCOUNT_LABEL = `CASE WHEN a.id IS NULL THEN NULL
       ELSE CONCAT(COALESCE(b.description, ''), ' — ', COALESCE(a.agency, ''), '/', COALESCE(a.number, '')) END`

const LIST_FIELDS = `ag.id, ag.agreement,
            ag.tb_bank_account_id AS bankAccountId,
            ${ACCOUNT_LABEL} AS bankAccountLabel,
            ag.active, ag.our_number_next AS ourNumberNext`

const FROM = (schemaName: string) =>
  `FROM \`${schemaName}\`.tb_bank_charge_agreement ag
   LEFT JOIN \`${schemaName}\`.tb_bank_account a
          ON a.id = ag.tb_bank_account_id AND a.tb_institution_id = ag.tb_institution_id
         AND a.deleted = 'N'
   LEFT JOIN setes_central.tb_bank b ON b.id = a.tb_bank_id`

/** Lista PAGINADA: página + COUNT com a MESMA where (D2 da paginação). */
export async function listChargeAgreements(
  query: ListQuery, schemaName: string, institutionId: number
): Promise<PagedRows<ChargeAgreementListRow>> {
  assertSchemaName(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `${FROM(schemaName)}
     WHERE ag.tb_institution_id = ? AND ag.deleted = 'N'
       AND (? IS NULL OR ag.agreement LIKE ? OR b.description LIKE ?)`
  const params = [institutionId, like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT ${LIST_FIELDS}
     ${where}
     ORDER BY ag.agreement, ag.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

export async function getChargeAgreement(
  id: number, schemaName: string, institutionId: number
): Promise<ChargeAgreementFull | null> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT ${LIST_FIELDS}, ag.accept, ag.aliq_discount AS aliqDiscount,
            ag.aliq_interest AS aliqInterest, ag.aliq_late AS aliqLate,
            ag.value_late_min AS valueLateMin, ag.aliq_fine AS aliqFine,
            ag.value_fine AS valueFine, ag.value_rate AS valueRate,
            CONVERT(ag.instruction USING utf8mb4) AS instruction,
            ag.protest, ag.day_protest AS dayProtest
     ${FROM(schemaName)}
     WHERE ag.id = ? AND ag.tb_institution_id = ? AND ag.deleted = 'N'`,
    [id, institutionId]
  )
  if (!rows[0]) return null
  const r = rows[0]
  return {
    ...r,
    aliqDiscount: r.aliqDiscount == null ? null : Number(r.aliqDiscount),
    aliqInterest: r.aliqInterest == null ? null : Number(r.aliqInterest),
    aliqLate: r.aliqLate == null ? null : Number(r.aliqLate),
    valueLateMin: r.valueLateMin == null ? null : Number(r.valueLateMin),
    aliqFine: r.aliqFine == null ? null : Number(r.aliqFine),
    valueFine: r.valueFine == null ? null : Number(r.valueFine),
    valueRate: r.valueRate == null ? null : Number(r.valueRate),
    instruction: r.instruction == null ? null : String(r.instruction),
  }
}

/** Conta precisa existir viva no cadastro do cliente. */
async function assertBankAccount(
  conn: any, schemaName: string, institutionId: number, bankAccountId: number
): Promise<void> {
  const [rows] = await conn.query(
    `SELECT 1 FROM \`${schemaName}\`.tb_bank_account
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [bankAccountId, institutionId]
  )
  if (rows.length === 0) {
    throw new HttpError(400, 'Conta bancária inexistente',
      [{ field: 'bankAccountId', message: 'Conta não encontrada' }],
      'BANK_NOT_FOUND')
  }
}

const INPUT_FIELDS = (input: ChargeAgreementInput) => [
  input.agreement, input.bankAccountId, input.active, input.accept,
  input.aliqDiscount ?? null, input.aliqInterest ?? null, input.aliqLate ?? null,
  input.valueLateMin ?? null, input.aliqFine ?? null, input.valueFine ?? null,
  input.valueRate ?? null, input.instruction ?? null,
  input.protest, input.protest === 'S' ? (input.dayProtest ?? null) : null,
  input.ourNumberNext ?? null,
]

export async function insertChargeAgreement(
  input: ChargeAgreementInput, schemaName: string, institutionId: number
): Promise<number> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await assertBankAccount(conn, schemaName, institutionId, input.bankAccountId)

    const [mx] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${schemaName}\`.tb_bank_charge_agreement
        WHERE tb_institution_id = ? FOR UPDATE`,
      [institutionId]
    )
    const id = Number(mx[0].nextId)

    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_bank_charge_agreement
         (id, tb_institution_id, tb_bank_account_id, tb_bank_charge_ticket_id,
          tb_bank_charge_kind_id, agreement, accept, aliq_discount, aliq_interest,
          aliq_late, value_late_min, aliq_fine, value_fine, value_rate, instruction,
          protest, day_protest, active, our_number_next, created_at, updated_at, deleted)
       VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
      [id, institutionId, input.bankAccountId, input.agreement, input.accept,
       input.aliqDiscount ?? null, input.aliqInterest ?? null, input.aliqLate ?? null,
       input.valueLateMin ?? null, input.aliqFine ?? null, input.valueFine ?? null,
       input.valueRate ?? null, input.instruction ?? null,
       input.protest, input.protest === 'S' ? (input.dayProtest ?? null) : null,
       input.active, input.ourNumberNext ?? null]
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

export async function updateChargeAgreement(
  id: number, input: ChargeAgreementInput, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(
      `SELECT 1 FROM \`${schemaName}\`.tb_bank_charge_agreement
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' FOR UPDATE`,
      [id, institutionId]
    )
    if (rows.length === 0) {
      await conn.rollback()
      return false
    }
    await assertBankAccount(conn, schemaName, institutionId, input.bankAccountId)

    await conn.query(
      `UPDATE \`${schemaName}\`.tb_bank_charge_agreement
          SET agreement = ?, tb_bank_account_id = ?, accept = ?, aliq_discount = ?,
              aliq_interest = ?, aliq_late = ?, value_late_min = ?, aliq_fine = ?,
              value_fine = ?, value_rate = ?, instruction = ?, protest = ?,
              day_protest = ?, active = ?, our_number_next = ?, updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ?`,
      [input.agreement, input.bankAccountId, input.accept,
       input.aliqDiscount ?? null, input.aliqInterest ?? null, input.aliqLate ?? null,
       input.valueLateMin ?? null, input.aliqFine ?? null, input.valueFine ?? null,
       input.valueRate ?? null, input.instruction ?? null,
       input.protest, input.protest === 'S' ? (input.dayProtest ?? null) : null,
       input.active, input.ourNumberNext ?? null, id, institutionId]
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

/** Soft delete = a carteira some do cadastro E do gate 0/1/n do faturamento (D8). */
export async function softDeleteChargeAgreement(
  id: number, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const [result] = await pool.query<any>(
    `UPDATE \`${schemaName}\`.tb_bank_charge_agreement
        SET deleted = 'S', updated_at = NOW()
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [id, institutionId]
  )
  return result.affectedRows > 0
}

/** Lookup: contas correntes vivas da institution (form). */
export async function listBankAccountsLookup(
  filter: string, schemaName: string, institutionId: number
): Promise<BankAccountLookupRow[]> {
  assertSchemaName(schemaName)
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT a.id,
            CONCAT(COALESCE(b.description, ''), ' — ',
                   COALESCE(a.agency, ''), '/', COALESCE(a.number, '')) AS label
       FROM \`${schemaName}\`.tb_bank_account a
       LEFT JOIN setes_central.tb_bank b ON b.id = a.tb_bank_id
      WHERE a.tb_institution_id = ? AND a.deleted = 'N'
        AND (? IS NULL OR b.description LIKE ? OR a.number LIKE ?)
      ORDER BY b.description, a.agency, a.number
      LIMIT 100`,
    [institutionId, like, like, like]
  )
  return rows
}
