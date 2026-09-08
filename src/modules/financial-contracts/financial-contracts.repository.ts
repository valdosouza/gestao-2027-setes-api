import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { assertSchemaName } from '@shared/field-config'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import {
  FinancialContractListRow, FinancialContractFull, FinancialContractInput,
  FinancialContractCreateInput, PaymentTypeLookupRow, BankAccountLookupRow,
} from './financial-contracts.interface'

/**
 * Repositório de Contratos Financeiros (tb_financial_contract no schema do
 * cliente — PK (institution, forma) = especialização do vínculo
 * tb_institution_has_payment_types, D2). Sem id próprio: o recurso é
 * endereçado pelo tb_payment_types_id. Conta 0 = caixa (sentinela, sem FK —
 * D1); conta > 0 validada em tb_bank_account na transação (regra 2).
 */

const LIST_FIELDS = `c.tb_payment_types_id AS id,
            c.tb_payment_types_id AS paymentTypeId,
            pt.description        AS paymentTypeDescription,
            pt.kind               AS paymentTypeKind,
            c.tb_bank_account_id  AS bankAccountId,
            CASE WHEN c.tb_bank_account_id > 0 AND a.id IS NOT NULL
                 THEN CONCAT(COALESCE(b.description, ''), ' — ',
                             COALESCE(a.agency, ''), '/', COALESCE(a.number, ''))
                 ELSE NULL END   AS bankAccountLabel,
            c.fee_rate            AS feeRate,
            c.payment_term        AS paymentTerm,
            DATE_FORMAT(c.expiration_date, '%Y-%m-%d') AS expirationDate`

const FROM = (schemaName: string) =>
  `FROM \`${schemaName}\`.tb_financial_contract c
   LEFT JOIN setes_central.tb_payment_types pt ON pt.id = c.tb_payment_types_id
   LEFT JOIN \`${schemaName}\`.tb_bank_account a
          ON a.id = c.tb_bank_account_id AND a.tb_institution_id = c.tb_institution_id
         AND a.deleted = 'N'
   LEFT JOIN setes_central.tb_bank b ON b.id = a.tb_bank_id`

/** Lista PAGINADA (shared/list): página + COUNT com a MESMA where (D2 da paginação). */
export async function listFinancialContracts(
  query: ListQuery, schemaName: string, institutionId: number
): Promise<PagedRows<FinancialContractListRow>> {
  assertSchemaName(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `${FROM(schemaName)}
     WHERE c.tb_institution_id = ? AND c.deleted = 'N'
       AND (? IS NULL OR pt.description LIKE ? OR b.description LIKE ?)`
  const params = [institutionId, like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT ${LIST_FIELDS}
     ${where}
     ORDER BY pt.description, c.tb_payment_types_id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

export async function getFinancialContract(
  paymentTypeId: number, schemaName: string, institutionId: number
): Promise<FinancialContractFull | null> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT ${LIST_FIELDS}, c.note
     ${FROM(schemaName)}
     WHERE c.tb_payment_types_id = ? AND c.tb_institution_id = ? AND c.deleted = 'N'`,
    [paymentTypeId, institutionId]
  )
  return rows[0] ?? null
}

/** Forma precisa estar VINCULADA (viva) à institution — o contrato especializa o vínculo. */
async function assertLink(
  conn: any, schemaName: string, institutionId: number, paymentTypeId: number
): Promise<void> {
  const [rows] = await conn.query(
    `SELECT 1 FROM \`${schemaName}\`.tb_institution_has_payment_types h
      INNER JOIN setes_central.tb_payment_types pt
              ON pt.id = h.tb_payment_types_id AND pt.deleted = 'N'
      WHERE h.tb_institution_id = ? AND h.tb_payment_types_id = ? AND h.deleted = 'N'`,
    [institutionId, paymentTypeId]
  )
  if (rows.length === 0) {
    throw new HttpError(400, 'Forma de pagamento não vinculada a esta empresa',
      [{ field: 'paymentTypeId', message: 'Forma de pagamento não encontrada' }],
      'PAYMENT_TYPE_NOT_LINKED')
  }
}

/** Conta > 0 precisa existir viva (regra 2 — a existência é gate do cadastro). */
async function assertBankAccount(
  conn: any, schemaName: string, institutionId: number, bankAccountId: number
): Promise<void> {
  if (bankAccountId === 0) return
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

const INPUT_FIELDS = (input: FinancialContractInput) => [
  input.bankAccountId, input.feeRate, input.paymentTerm,
  input.expirationDate ?? null, input.note ?? null,
]

/**
 * Cria o contrato da forma. 1 por forma (PK): existente vivo → 409
 * FINANCIAL_CONTRACT_EXISTS; soft-deletado → REVIVE com os dados novos
 * (mesmo espírito do banks/decisão 8).
 */
export async function insertFinancialContract(
  input: FinancialContractCreateInput, schemaName: string, institutionId: number
): Promise<number> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await assertLink(conn, schemaName, institutionId, input.paymentTypeId)
    await assertBankAccount(conn, schemaName, institutionId, input.bankAccountId)

    const [cur] = await conn.query<any[]>(
      `SELECT deleted FROM \`${schemaName}\`.tb_financial_contract
        WHERE tb_institution_id = ? AND tb_payment_types_id = ? FOR UPDATE`,
      [institutionId, input.paymentTypeId]
    )
    if (cur[0] && cur[0].deleted === 'N') {
      throw new HttpError(409, 'Esta forma de pagamento já tem contrato financeiro',
        [{ field: 'paymentTypeId', message: 'Contrato já existe' }],
        'FINANCIAL_CONTRACT_EXISTS')
    }
    if (cur[0]) {
      await conn.query(
        `UPDATE \`${schemaName}\`.tb_financial_contract
            SET tb_bank_account_id = ?, fee_rate = ?, payment_term = ?,
                expiration_date = ?, note = ?, deleted = 'N', updated_at = NOW()
          WHERE tb_institution_id = ? AND tb_payment_types_id = ?`,
        [...INPUT_FIELDS(input), institutionId, input.paymentTypeId]
      )
    } else {
      await conn.query(
        `INSERT INTO \`${schemaName}\`.tb_financial_contract
           (tb_institution_id, tb_payment_types_id, tb_bank_account_id, fee_rate,
            payment_term, expiration_date, note, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
        [institutionId, input.paymentTypeId, ...INPUT_FIELDS(input)]
      )
    }
    await conn.commit()
    return input.paymentTypeId
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function updateFinancialContract(
  paymentTypeId: number, input: FinancialContractInput,
  schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(
      `SELECT 1 FROM \`${schemaName}\`.tb_financial_contract
        WHERE tb_institution_id = ? AND tb_payment_types_id = ? AND deleted = 'N' FOR UPDATE`,
      [institutionId, paymentTypeId]
    )
    if (rows.length === 0) {
      await conn.rollback()
      return false
    }
    await assertBankAccount(conn, schemaName, institutionId, input.bankAccountId)
    await conn.query(
      `UPDATE \`${schemaName}\`.tb_financial_contract
          SET tb_bank_account_id = ?, fee_rate = ?, payment_term = ?,
              expiration_date = ?, note = ?, updated_at = NOW()
        WHERE tb_institution_id = ? AND tb_payment_types_id = ?`,
      [...INPUT_FIELDS(input), institutionId, paymentTypeId]
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

/** Soft delete = a forma volta a "sem contrato" (título nasce aberto — regra 4). */
export async function softDeleteFinancialContract(
  paymentTypeId: number, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const [result] = await pool.query<any>(
    `UPDATE \`${schemaName}\`.tb_financial_contract
        SET deleted = 'S', updated_at = NOW()
      WHERE tb_institution_id = ? AND tb_payment_types_id = ? AND deleted = 'N'`,
    [institutionId, paymentTypeId]
  )
  return result.affectedRows > 0
}

/** Lookup: formas vinculadas e habilitadas, marcando quem já tem contrato. */
export async function listPaymentTypesLookup(
  filter: string, schemaName: string, institutionId: number
): Promise<PaymentTypeLookupRow[]> {
  assertSchemaName(schemaName)
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT pt.id, pt.description, pt.kind,
            CASE WHEN c.tb_payment_types_id IS NULL THEN 'N' ELSE 'S' END AS hasContract
       FROM \`${schemaName}\`.tb_institution_has_payment_types h
       INNER JOIN setes_central.tb_payment_types pt
               ON pt.id = h.tb_payment_types_id AND pt.deleted = 'N'
       LEFT JOIN \`${schemaName}\`.tb_financial_contract c
              ON c.tb_institution_id = h.tb_institution_id
             AND c.tb_payment_types_id = h.tb_payment_types_id AND c.deleted = 'N'
      WHERE h.tb_institution_id = ? AND h.deleted = 'N' AND h.\`enable\` = 'S'
        AND (? IS NULL OR pt.description LIKE ?)
      ORDER BY pt.description
      LIMIT 100`,
    [institutionId, like, like]
  )
  return rows
}

/** Lookup: contas correntes vivas da institution. */
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
