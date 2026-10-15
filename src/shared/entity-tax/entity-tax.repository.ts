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
       (id, tb_institution_id, consumer, tax_regime, simples_regime, simples_assessment, simples_total_tax_aliquot, special_tax_regime, cnae,
        by_pass_st, ind_ie_dest,
        iss_exigibilidade, iss_process_nr, iss_retido, iss_ind_inc_fiscal,
        auto_send_invoice, auto_send_invoice_just_xml, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       consumer = VALUES(consumer), tax_regime = VALUES(tax_regime),
       simples_regime = VALUES(simples_regime), simples_assessment = VALUES(simples_assessment),
       simples_total_tax_aliquot = VALUES(simples_total_tax_aliquot),
       special_tax_regime = VALUES(special_tax_regime), cnae = VALUES(cnae),
       by_pass_st = VALUES(by_pass_st), ind_ie_dest = VALUES(ind_ie_dest),
       iss_exigibilidade = VALUES(iss_exigibilidade),
       iss_process_nr = VALUES(iss_process_nr), iss_retido = VALUES(iss_retido),
       iss_ind_inc_fiscal = VALUES(iss_ind_inc_fiscal),
       auto_send_invoice = VALUES(auto_send_invoice),
       auto_send_invoice_just_xml = VALUES(auto_send_invoice_just_xml),
       deleted = 'N', updated_at = NOW()`,
    [`${schemaName}.tb_entity_tax`, entityId, institutionId,
     input.consumer ?? 'N', input.taxRegime ?? null,
     input.simplesRegime ?? null, input.simplesAssessment ?? null, input.simplesTotalTaxAliquot ?? null, input.specialTaxRegime ?? null, input.cnae ?? null,
     input.byPassSt ?? 'N',
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
            simples_regime             AS simplesRegime,
            simples_assessment         AS simplesAssessment,
            simples_total_tax_aliquot  AS simplesTotalTaxAliquot,
            special_tax_regime         AS specialTaxRegime,
            cnae,
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

/** opSimpNac do emitente na data (1 não optante · 2 MEI · 3 ME/EPP · 4 pendente — NT 009). */
export interface EmitterSimplesRegime {
  simplesRegime: '1' | '2' | '3' | '4' | null
}

/**
 * ENQUADRAMENTO DO EMITENTE NA DATA (fase IBS/CBS, D-IB66 — prompt_fase_ibs_cbs.md §12.6). Assinatura já DATADA, mas
 * sob a convenção NOMEADA "sem história, o enquadramento conhecido vale para toda data": lê a linha ATUAL da relação
 * emitente × institution (`tb_entity_tax`, id = institution). A tabela datada `tb_establishment_tax_regime` (D-IB7), a
 * D-IB24 (CRT derivado) e o leitor por competência nascem com o 1º FATO datado (gatilhos: Q-IB1 em 30/10, XSD da NT 009
 * ou 1º não optante) — quem chama já passa a data e não muda. Dentro da transação: leitura TRAVANTE compartilhada
 * (PADROES §9 regra 2 — decide o 422 da obrigação). Valor fora do domínio = desconhecido (null).
 */
export async function emitterRegimeAt(
  q: Executor | { query: (sql: string, params?: unknown[]) => Promise<any> },
  schemaName: string, institutionId: number, _date: string, opts: { lock: boolean },
): Promise<EmitterSimplesRegime> {
  const [rows] = await (q as Executor).query<any[]>(
    `SELECT simples_regime AS simplesRegime FROM ??
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'${opts.lock ? ' LOCK IN SHARE MODE' : ''}`,
    [`${schemaName}.tb_entity_tax`, institutionId, institutionId])
  const raw = rows[0]?.simplesRegime == null ? null : String(rows[0].simplesRegime).trim()
  return { simplesRegime: raw === '1' || raw === '2' || raw === '3' || raw === '4' ? raw : null }
}
