import { Pool, PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { EntityTaxInput, EntityTaxRow } from './entity-tax.types'

type Executor = Pool | PoolConnection

/**
 * Persistência da TRIBUTAÇÃO (tb_entity_tax no SCHEMA DO CLIENTE — PK
 * id + tb_institution_id). Peça independente (SRP): só conhece a própria
 * tabela; recebe schema/institution/entity por parâmetro. Escrita aceita a
 * conn de uma transação aberta (aba Tributação salva JUNTO com o papel —
 * decisão 17) ou o pool (PUT avulso /api/entities/:id/tax).
 */

/** Upsert da tributação da relação entity × institution (revive deleted). */
export async function upsertEntityTax(
  db: Executor, schemaName: string, institutionId: number, entityId: number,
  input: EntityTaxInput
): Promise<void> {
  await db.query(
    `INSERT INTO ??
       (id, tb_institution_id, consumer, tax_regime, by_pass_st, ind_ie_dest,
        iss_exigibilidade, iss_process_nr, iss_retido, iss_ind_inc_fiscal,
        auto_send_invoice, auto_send_invoice_just_xml, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       consumer = VALUES(consumer), tax_regime = VALUES(tax_regime),
       by_pass_st = VALUES(by_pass_st), ind_ie_dest = VALUES(ind_ie_dest),
       iss_exigibilidade = VALUES(iss_exigibilidade),
       iss_process_nr = VALUES(iss_process_nr), iss_retido = VALUES(iss_retido),
       iss_ind_inc_fiscal = VALUES(iss_ind_inc_fiscal),
       auto_send_invoice = VALUES(auto_send_invoice),
       auto_send_invoice_just_xml = VALUES(auto_send_invoice_just_xml),
       deleted = 'N', updated_at = NOW()`,
    [`${schemaName}.tb_entity_tax`, entityId, institutionId,
     input.consumer ?? 'N', input.taxRegime ?? null, input.byPassSt ?? 'N',
     input.indIeDest ?? null, input.issExigibilidade ?? null,
     input.issProcessNr ?? null, input.issRetido ?? 'N',
     input.issIndIncFiscal ?? 'N', input.autoSendInvoice ?? 'N',
     input.autoSendInvoiceJustXml ?? 'N']
  )
}

/** Tributação viva da relação (null se nunca configurada). */
export async function getEntityTax(
  schemaName: string, institutionId: number, entityId: number
): Promise<EntityTaxRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT consumer,
            tax_regime                 AS taxRegime,
            by_pass_st                 AS byPassSt,
            ind_ie_dest                AS indIeDest,
            iss_exigibilidade          AS issExigibilidade,
            iss_process_nr             AS issProcessNr,
            iss_retido                 AS issRetido,
            iss_ind_inc_fiscal         AS issIndIncFiscal,
            auto_send_invoice          AS autoSendInvoice,
            auto_send_invoice_just_xml AS autoSendInvoiceJustXml
     FROM ?? WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [`${schemaName}.tb_entity_tax`, entityId, institutionId]
  )
  return (rows[0] as EntityTaxRow | undefined) ?? null
}
