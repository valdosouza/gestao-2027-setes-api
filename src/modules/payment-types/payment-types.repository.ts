import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { assertSchemaName } from '@shared/field-config'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { ensureCatalogPaymentType, upsertLink } from '@shared/payment-types'
import {
  LinkedPaymentTypeRow, PaymentTypeCatalogRow, PaymentTypeLinkInput,
  PaymentTypeLinkUpdate,
} from './payment-types.interface'

/**
 * Repositório de Formas de Pagamento: catálogo em setes_central.
 * tb_payment_types (compartilhado — o cliente INICIA o cadastro, reuso por
 * DESCRIÇÃO na transação) × vínculo em setes_<schema>.
 * tb_institution_has_payment_types (atributos operacionais — migration 012).
 */

/** Formas VINCULADAS à institution (lista da tela) — atributos do vínculo
 *  + descrições dos Planos de Conta (LEFT JOIN, 0 = não definido).
 *  PAGINADA (shared/list, D7): filtro por descrição + página + COUNT com a
 *  MESMA cláusula WHERE (D2); desempate por pt.id (D8). */
export async function listLinked(
  query: ListQuery, schemaName: string, institutionId: number
): Promise<PagedRows<LinkedPaymentTypeRow>> {
  assertSchemaName(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM \`${schemaName}\`.tb_institution_has_payment_types h
     INNER JOIN setes_central.tb_payment_types pt
        ON pt.id = h.tb_payment_types_id AND pt.deleted = 'N'
     LEFT JOIN \`${schemaName}\`.tb_financial_plans fpc
        ON fpc.id = h.tb_financial_plans_id_cre
       AND fpc.tb_institution_id = h.tb_institution_id AND fpc.deleted = 'N'
     LEFT JOIN \`${schemaName}\`.tb_financial_plans fpd
        ON fpd.id = h.tb_financial_plans_id_deb
       AND fpd.tb_institution_id = h.tb_institution_id AND fpd.deleted = 'N'
     WHERE h.tb_institution_id = ? AND h.deleted = 'N'
       AND (? IS NULL OR pt.description LIKE ?)`
  const params = [institutionId, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT pt.id,
            pt.description,
            pt.id_nfce        AS idNfce,
            h.\`enable\`,
            h.app_mobile      AS appMobile,
            h.block_for_customer_blocked  AS blockForCustomerBlocked,
            h.block_for_customer_no_limit AS blockForCustomerNoLimit,
            h.max_parcels     AS maxParcels,
            h.tef,
            h.tb_financial_plans_id_cre   AS financialPlansIdCre,
            h.tb_financial_plans_id_deb   AS financialPlansIdDeb,
            fpc.description   AS financialPlanCreDescription,
            fpd.description   AS financialPlanDebDescription
     ${where}
     ORDER BY pt.description, pt.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows, total: Number(count[0].total) }
}

/** Catálogo central com marcação das já vinculadas (lookup do form). */
export async function listCatalog(
  filter: string, schemaName: string, institutionId: number
): Promise<PaymentTypeCatalogRow[]> {
  assertSchemaName(schemaName)
  const like = filter ? `%${filter}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT pt.id,
            pt.description,
            pt.id_nfce AS idNfce,
            CASE WHEN h.tb_payment_types_id IS NULL THEN 'N' ELSE 'S' END AS linked
     FROM setes_central.tb_payment_types pt
     LEFT JOIN \`${schemaName}\`.tb_institution_has_payment_types h
        ON h.tb_payment_types_id = pt.id
       AND h.tb_institution_id = ? AND h.deleted = 'N'
     WHERE pt.deleted = 'N'
       AND (? IS NULL OR pt.description LIKE ?)
     ORDER BY pt.description
     LIMIT 100`,
    [institutionId, like, like]
  )
  return rows
}

/** O vínculo vivo existe? */
export async function linkExists(
  id: number, schemaName: string, institutionId: number
): Promise<boolean> {
  assertSchemaName(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT 1 FROM \`${schemaName}\`.tb_institution_has_payment_types
      WHERE tb_institution_id = ? AND tb_payment_types_id = ? AND deleted = 'N'`,
    [institutionId, id]
  )
  return rows.length > 0
}

/**
 * POST (workflow do Valdo): vincula forma EXISTENTE (paymentTypeId) ou
 * cria/reusa pela description — tudo numa transação. Os helpers do
 * catálogo/vínculo vêm de @shared/payment-types (compartilhados com o
 * wallet/"Carteira" do customers).
 */
export async function linkOrCreatePaymentType(
  input: PaymentTypeLinkInput, schemaName: string, institutionId: number
): Promise<{ id: number; reused: boolean }> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    let id: number
    let reused = false

    if (input.paymentTypeId != null) {
      const [rows] = await conn.query<any[]>(
        `SELECT id FROM setes_central.tb_payment_types
          WHERE id = ? AND deleted = 'N' FOR UPDATE`,
        [input.paymentTypeId]
      )
      if (!rows[0]) {
        throw new HttpError(400, 'Forma de pagamento inexistente no catálogo',
          [{ field: 'paymentTypeId', message: 'Forma não encontrada' }])
      }
      id = Number(rows[0].id)
      reused = true
    } else {
      const ensured = await ensureCatalogPaymentType(
        conn, String(input.description).trim(), input.idNfce ?? null)
      id = ensured.id
      reused = ensured.reused
    }

    await upsertLink(conn, schemaName, institutionId, id, input)

    await conn.commit()
    return { id, reused }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** PUT: atributos do VÍNCULO e, se veio idNfce, o código NF-e na linha
 *  CENTRAL (compartilhada — vale para todos os clientes vinculados);
 *  transação cobre as duas bases. */
export async function updateLink(
  id: number, input: PaymentTypeLinkUpdate,
  schemaName: string, institutionId: number
): Promise<void> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(
      `UPDATE ?? SET \`enable\` = ?, app_mobile = ?,
          block_for_customer_blocked = ?, block_for_customer_no_limit = ?,
          max_parcels = ?, tef = ?,
          tb_financial_plans_id_cre = ?, tb_financial_plans_id_deb = ?,
          updated_at = NOW()
        WHERE tb_institution_id = ? AND tb_payment_types_id = ?`,
      [`${schemaName}.tb_institution_has_payment_types`,
       input.enable, input.appMobile,
       input.blockForCustomerBlocked, input.blockForCustomerNoLimit,
       input.maxParcels, input.tef,
       input.financialPlansIdCre, input.financialPlansIdDeb,
       institutionId, id]
    )
    if (input.idNfce !== undefined) {
      await conn.query(
        `UPDATE setes_central.tb_payment_types
            SET id_nfce = ?, updated_at = NOW()
          WHERE id = ? AND deleted = 'N'`,
        [input.idNfce, id]
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

/** DELETE: soft delete do VÍNCULO — a forma permanece no catálogo. */
export async function unlinkPaymentType(
  id: number, schemaName: string, institutionId: number
): Promise<void> {
  assertSchemaName(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(
      `UPDATE ?? SET deleted = 'S', updated_at = NOW()
        WHERE tb_institution_id = ? AND tb_payment_types_id = ?`,
      [`${schemaName}.tb_institution_has_payment_types`, institutionId, id]
    )
    // D-G2 (contrato financeiro, Rodada 4): o contrato é especialização do
    // vínculo — desvincular a forma soft-deleta o contrato junto (nunca fica
    // órfão; revincular NÃO revive o contrato — recriar pelo cadastro).
    await conn.query(
      `UPDATE ?? SET deleted = 'S', updated_at = NOW()
        WHERE tb_institution_id = ? AND tb_payment_types_id = ? AND deleted = 'N'`,
      [`${schemaName}.tb_financial_contract`, institutionId, id]
    )
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}
