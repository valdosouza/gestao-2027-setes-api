import { PoolConnection } from 'mysql2/promise'
import { randomBytes } from 'crypto'
import pool from '@shared/db/connection'
import { assertSchemaName } from '@shared/db/schema'
import { HttpError } from '@shared/errors/http-error'
import { BankChannelInput, BankChannelRow } from './types'

/**
 * Acesso a `tb_bank_account_channel` (migration 055). Especialização por PK da
 * conta: 1 canal por conta. Tudo que é DERIVADO da conta (número do banco,
 * conta corrente) vem por JOIN — nunca duplicado aqui (D-I2/D-I14).
 */

type Q = PoolConnection | typeof pool

const SELECT = (s: string) => `
  SELECT c.tb_bank_account_id AS bankAccountId, c.tb_institution_id AS institutionId,
         c.environment, c.client_id AS clientId, c.inbound_token AS inboundToken, c.active,
         b.number AS bankNumber, a.number AS accountNumber, a.number_dv AS accountNumberDv
    FROM \`${s}\`.tb_bank_account_channel c
   INNER JOIN \`${s}\`.tb_bank_account a
      ON a.id = c.tb_bank_account_id AND a.tb_institution_id = c.tb_institution_id AND a.deleted = 'N'
   INNER JOIN setes_central.tb_bank b ON b.id = a.tb_bank_id`

function map(r: any): BankChannelRow {
  return {
    bankAccountId: Number(r.bankAccountId), institutionId: Number(r.institutionId),
    environment: r.environment === 'P' ? 'P' : 'S', clientId: r.clientId ?? null,
    inboundToken: String(r.inboundToken), active: r.active === 'S' ? 'S' : 'N',
    bankNumber: String(r.bankNumber ?? ''), accountNumber: r.accountNumber ?? null,
    accountNumberDv: r.accountNumberDv ?? null,
  }
}

export async function getBankChannel(
  q: Q, schemaName: string, institutionId: number, bankAccountId: number, forUpdate = false
): Promise<BankChannelRow | null> {
  assertSchemaName(schemaName)
  const [rows] = await q.query<any[]>(
    `${SELECT(schemaName)}
      WHERE c.tb_bank_account_id = ? AND c.tb_institution_id = ? AND c.deleted = 'N'${forUpdate ? ' FOR UPDATE' : ''}`,
    [bankAccountId, institutionId]
  )
  return rows[0] ? map(rows[0]) : null
}

/** Webhook (D-I15): o token no path identifica o canal — e só ele. */
export async function findBankChannelByInboundToken(
  schemaName: string, inboundToken: string
): Promise<BankChannelRow | null> {
  assertSchemaName(schemaName)
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(inboundToken)) return null
  const [rows] = await pool.query<any[]>(
    `${SELECT(schemaName)} WHERE c.inbound_token = ? AND c.deleted = 'N'`, [inboundToken]
  )
  return rows[0] ? map(rows[0]) : null
}

/** Token de entrada: 32 bytes url-safe (48 chars). Nunca reaproveitado entre contas. */
export function newInboundToken(): string {
  return randomBytes(36).toString('base64url').slice(0, 48)
}

/**
 * Cria ou altera o canal da conta. O `inbound_token` nasce UMA vez (a URL do
 * webhook cadastrada no banco depende dele — trocá-lo é ato explícito,
 * `rotateInboundToken`). Conta precisa existir viva.
 */
export async function upsertBankChannel(
  conn: PoolConnection, schemaName: string, institutionId: number, bankAccountId: number,
  input: BankChannelInput
): Promise<BankChannelRow> {
  assertSchemaName(schemaName)
  const [acc] = await conn.query<any[]>(
    `SELECT 1 FROM \`${schemaName}\`.tb_bank_account WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' FOR UPDATE`,
    [bankAccountId, institutionId]
  )
  if (acc.length === 0) throw new HttpError(404, `Conta bancária ${bankAccountId} não encontrada`, undefined, 'BANK_ACCOUNT_NOT_FOUND')
  await conn.query(
    `INSERT INTO \`${schemaName}\`.tb_bank_account_channel
       (tb_bank_account_id, tb_institution_id, environment, client_id, inbound_token, active, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE environment = VALUES(environment), client_id = VALUES(client_id),
       active = VALUES(active), deleted = 'N', updated_at = NOW()`,
    [bankAccountId, institutionId, input.environment, input.clientId, newInboundToken(), input.active]
  )
  const row = await getBankChannel(conn, schemaName, institutionId, bankAccountId)
  if (!row) throw new HttpError(500, 'Canal não persistido')
  return row
}

export async function rotateInboundToken(
  conn: PoolConnection, schemaName: string, institutionId: number, bankAccountId: number
): Promise<string> {
  assertSchemaName(schemaName)
  const token = newInboundToken()
  const [r] = await conn.query<any>(
    `UPDATE \`${schemaName}\`.tb_bank_account_channel SET inbound_token = ?, updated_at = NOW()
      WHERE tb_bank_account_id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [token, bankAccountId, institutionId]
  )
  if (r.affectedRows === 0) throw new HttpError(404, 'Canal não encontrado', undefined, 'BANK_CHANNEL_MISSING')
  return token
}

export async function softDeleteBankChannel(
  conn: PoolConnection, schemaName: string, institutionId: number, bankAccountId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const [r] = await conn.query<any>(
    `UPDATE \`${schemaName}\`.tb_bank_account_channel SET deleted = 'S', updated_at = NOW()
      WHERE tb_bank_account_id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [bankAccountId, institutionId]
  )
  return r.affectedRows > 0
}
