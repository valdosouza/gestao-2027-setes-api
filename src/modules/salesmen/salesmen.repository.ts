import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows } from '@shared/list'
import {
  SalesmanInput, SalesmanListRow, SalesmanFull, CollaboratorLookupRow,
} from './salesmen.interface'

/**
 * Repositório do CONCRETO Salesman — Onda 2 da Entidade Única (D1): vendedor
 * é PROMOÇÃO de colaborador, então este repositório NÃO toca a cadeia fiscal
 * (setes_central) — só o papel tb_salesman no SCHEMA DO CLIENTE (PK composta
 * id + tb_institution_id; herança por PK: id = tb_collaborator.id =
 * tb_entity.id). Identificadores de schema entram via ?? (escape do mysql2).
 */

// ---------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------

/**
 * Lista PAGINADA (shared/list): página + COUNT com a MESMA cláusula WHERE.
 * Desempate por s.id mantém o OFFSET estável.
 */
export async function listSalesmen(
  query: ListQuery, schemaName: string, institutionId: number
): Promise<PagedRows<SalesmanListRow>> {
  const like = query.filter ? `%${query.filter}%` : null
  const where =
    `FROM ?? s
     INNER JOIN setes_central.tb_entity e ON e.id = s.id
     WHERE s.tb_institution_id = ? AND s.deleted = 'N'
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ?)`
  const params = [`${schemaName}.tb_salesman`, institutionId, like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT s.id,
            e.nick_trade   AS nickTrade,
            e.name_company AS nameCompany,
            s.active
     ${where}
     ORDER BY e.nick_trade, s.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

/** Identificação do colaborador (readonly no form) + campos do papel. */
export async function getSalesman(
  id: number, schemaName: string, institutionId: number
): Promise<SalesmanFull | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT s.id,
            e.nick_trade            AS nickTrade,
            e.name_company          AS nameCompany,
            COALESCE(p.cpf, c.cnpj) AS document,
            s.active,
            s.aliq_kickback         AS aliqKickback,
            s.kickback_product      AS kickbackProduct,
            s.flex_value            AS flexValue
     FROM ?? s
     INNER JOIN setes_central.tb_entity  e ON e.id = s.id
     LEFT  JOIN setes_central.tb_person  p ON p.id = s.id AND p.deleted = 'N'
     LEFT  JOIN setes_central.tb_company c ON c.id = s.id AND c.deleted = 'N'
     WHERE s.id = ? AND s.tb_institution_id = ? AND s.deleted = 'N'`,
    [`${schemaName}.tb_salesman`, id, institutionId]
  )
  return rows[0] ?? null
}

export async function salesmanExists(
  id: number, schemaName: string, institutionId: number
): Promise<boolean> {
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM ?? WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [`${schemaName}.tb_salesman`, id, institutionId]
  )
  return rows.length > 0
}

/**
 * Lookup de COLABORADORES da institution (origem da promoção — D1): a
 * precedência Collaborator→Salesman morre por construção porque o "novo
 * vendedor" só nasce daqui. Lista todos os colaboradores vivos — quem já é
 * vendedor cai no 409 DUP_ROLE do POST e o app abre a edição.
 */
export async function listCollaboratorLookup(
  filter: string, schemaName: string, institutionId: number
): Promise<CollaboratorLookupRow[]> {
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT c.id, COALESCE(e.nick_trade, e.name_company) AS name
     FROM ?? c
     INNER JOIN setes_central.tb_entity e ON e.id = c.id
     WHERE c.tb_institution_id = ? AND c.deleted = 'N'
       AND (? IS NULL OR e.nick_trade LIKE ? OR e.name_company LIKE ?)
     ORDER BY name
     LIMIT 50`,
    [`${schemaName}.tb_collaborator`, institutionId, like, like, like]
  )
  return rows
}

// ---------------------------------------------------------------------
// Escrita — sem cascade: o papel referencia a cadeia, nunca a altera
// ---------------------------------------------------------------------

const SALESMAN_FIELDS = (input: SalesmanInput) => [
  input.active ?? 'S',
  input.aliqKickback ?? null,
  input.kickbackProduct ?? null,
  input.flexValue ?? 0,
]

/**
 * POST (promoção — D1): [id] é um colaborador VIVO desta institution
 * (validado aqui — 404 se não for; por construção o app só oferece o
 * lookup). Papel vivo → 409 DUP_ROLE com o id no payload (o app abre a
 * edição); linha deleted='S' → REVIVE com os dados novos (padrão da casa).
 * active default 'S' no cadastro manual (o default 'N' do DDL protege as
 * linhas nascidas da sincronização, que chegam sem decisão do usuário).
 */
export async function insertSalesman(
  id: number, input: SalesmanInput, schemaName: string, institutionId: number
): Promise<{ id: number }> {
  const table = `${schemaName}.tb_salesman`
  const conn  = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [collab] = await conn.query<any[]>(
      `SELECT 1 FROM ?? WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [`${schemaName}.tb_collaborator`, id, institutionId]
    )
    if (collab.length === 0) {
      throw new HttpError(404,
        `Colaborador ${id} não encontrado neste estabelecimento — vendedor nasce de um colaborador (D1)`)
    }

    const [existing] = await conn.query<any[]>(
      `SELECT deleted FROM ?? WHERE id = ? AND tb_institution_id = ? FOR UPDATE`,
      [table, id, institutionId]
    )
    if (existing.length > 0 && existing[0].deleted === 'N') {
      throw new HttpError(409,
        `Este colaborador já está cadastrado como vendedor deste estabelecimento (id ${id})`,
        [{ field: 'id', message: String(id) }], 'DUP_ROLE')
    }

    if (existing.length > 0) {
      await conn.query(
        `UPDATE ?? SET active = ?, aliq_kickback = ?, kickback_product = ?,
           flex_value = ?, deleted = 'N', updated_at = NOW()
         WHERE id = ? AND tb_institution_id = ?`,
        [table, ...SALESMAN_FIELDS(input), id, institutionId]
      )
    } else {
      await conn.query(
        `INSERT INTO ?? (id, tb_institution_id, active, aliq_kickback,
           kickback_product, flex_value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [table, id, institutionId, ...SALESMAN_FIELDS(input)]
      )
    }

    await conn.commit()
    return { id }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** PUT: só os campos do papel. */
export async function updateSalesman(
  id: number, input: SalesmanInput, schemaName: string, institutionId: number
): Promise<void> {
  await pool.query(
    `UPDATE ?? SET active = ?, aliq_kickback = ?, kickback_product = ?,
       flex_value = ?, updated_at = NOW()
     WHERE id = ? AND tb_institution_id = ?`,
    [`${schemaName}.tb_salesman`, ...SALESMAN_FIELDS(input), id, institutionId]
  )
}

/** Soft delete LIVRE (D4) — carteira (tb_customer.tb_salesman_id) permanece
 *  como histórico; o lookup deixa de oferecê-lo. Nunca DELETE físico. */
export async function deleteSalesman(
  id: number, schemaName: string, institutionId: number
): Promise<void> {
  await pool.query(
    `UPDATE ?? SET deleted = 'S', updated_at = NOW() WHERE id = ? AND tb_institution_id = ?`,
    [`${schemaName}.tb_salesman`, id, institutionId]
  )
}
