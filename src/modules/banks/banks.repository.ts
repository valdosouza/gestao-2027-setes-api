import pool from '@shared/db/connection'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { assertSchemaName } from '@shared/field-config'
import { BankRow } from './banks.interface'

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE
 * (D2). Desempate por id (D8) mantém o OFFSET estável.
 */
export async function listBanks(query: ListQuery): Promise<PagedRows<BankRow>> {
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM setes_central.tb_bank
     WHERE deleted = 'N'
       AND (? IS NULL OR number LIKE ? OR description LIKE ?)`
  const params = [like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT id, number, description
     ${where}
     ORDER BY number, id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

export async function getBank(id: number): Promise<BankRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT id, number, description
     FROM setes_central.tb_bank
     WHERE id = ? AND deleted = 'N'`,
    [id]
  )
  return rows[0] ?? null
}

/**
 * Verifica se o número FEBRABAN já está em uso — INCLUINDO deleted='S'
 * (o UNIQUE `number` do DDL não enxerga soft delete; sem esta checagem o
 * INSERT/UPDATE estouraria ER_DUP_ENTRY contra um banco excluído).
 * excludeId: ignora o próprio registro na edição.
 */
export async function bankNumberExists(number: string, excludeId?: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT id FROM setes_central.tb_bank WHERE number = ? AND (? IS NULL OR id <> ?)`,
    [number, excludeId ?? null, excludeId ?? null]
  )
  return rows.length > 0
}

/** Linha do número em QUALQUER estado (vivo ou excluído) — base do revive. */
export async function getBankByNumber(
  number: string
): Promise<{ id: number, deleted: string } | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT id, deleted FROM setes_central.tb_bank WHERE number = ?`,
    [number]
  )
  return rows[0] ?? null
}

/**
 * REVIVE um banco soft-deletado com a descrição nova, preservando o id
 * (decisão do Valdo 2026-08-04: soft delete → restaurável; as FKs de
 * tb_bank_account dos clientes seguem válidas).
 */
export async function reviveBank(id: number, description: string): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_bank
     SET description = ?, deleted = 'N', updated_at = NOW()
     WHERE id = ?`,
    [description, id]
  )
}

/**
 * Insere banco com id gerado MAX(id)+1 em TRANSAÇÃO com FOR UPDATE (mesmo
 * desenho do bank-accounts — achado do gate
 * adversarial 2026-08-04: sem o lock, dois POSTs simultâneos colidem na PK
 * e o ER_DUP_ENTRY vira um 409 de "número duplicado" FALSO). tb_bank NÃO
 * tem auto_increment; o código externo é o `number` FEBRABAN (seed 17).
 */
export async function insertBank(number: string, description: string): Promise<number> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.tb_bank FOR UPDATE`
    ) as any[]
    const id: number = rows[0].nextId
    await conn.query(
      `INSERT INTO setes_central.tb_bank (id, number, description, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())`,
      [id, number, description]
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

/**
 * Schemas de cliente com conta corrente VIVA apontando para o banco
 * (gate adversarial 2026-08-04): a FK de tb_bank_account não barra o soft
 * delete, e um banco excluído em uso quebra a edição de conta de TODOS os
 * clientes. Os schemas saem do information_schema (só os que TÊM a tabela).
 */
export async function listBankUsage(id: number): Promise<string[]> {
  const [schemas] = await pool.query<any[]>(
    `SELECT table_schema AS schemaName FROM information_schema.tables
     WHERE table_name = 'tb_bank_account' AND table_schema LIKE 'setes\\_%'`
  )
  const used: string[] = []
  for (const s of schemas) {
    assertSchemaName(s.schemaName)
    const [rows] = await pool.query<any[]>(
      `SELECT 1 FROM \`${s.schemaName}\`.tb_bank_account
       WHERE tb_bank_id = ? AND deleted = 'N' LIMIT 1`,
      [id]
    )
    if (rows.length > 0) used.push(s.schemaName)
  }
  return used
}

export async function updateBank(id: number, number: string, description: string): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_bank
     SET number = ?, description = ?, updated_at = NOW()
     WHERE id = ?`,
    [number, description, id]
  )
}

export async function deleteBank(id: number): Promise<void> {
  await pool.query(
    `UPDATE setes_central.tb_bank SET deleted = 'S', updated_at = NOW() WHERE id = ?`,
    [id]
  )
}
