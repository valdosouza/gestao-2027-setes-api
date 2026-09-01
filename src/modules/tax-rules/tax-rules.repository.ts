import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, escapeLike } from '@shared/list'
import { assertSchema } from '@shared/db/schema'
import { savePieces, loadPieces, TaxRulePieces, TaxRuleSelector } from '@shared/tax-rule'
import { TaxRuleListRow, TaxRuleDetail, TaxRuleCatalogs } from './tax-rules.interface'
import { TaxRuleBodyDto } from './tax-rules.dto'

/**
 * Repositório do cadastro tax-rules (schema do cliente). Escopo = schema do
 * JWT + institution no seletor (estabelecimento). Escrita SEMPRE em cascata
 * transacional seletor+peças (presença = incidência — savePieces da peça
 * @shared/tax-rule; o match NUNCA é reimplementado aqui).
 */

const HAS = (table: string, s: string) =>
  `EXISTS (SELECT 1 FROM \`${s}\`.${table} x
            WHERE x.id = r.id AND x.deleted = 'N')`

function toListRow(row: any): TaxRuleListRow {
  return {
    id: row.id, ncm: row.ncm || null, origin: row.origin,
    purpose: row.purpose, st: row.st, finalConsumer: row.finalConsumer,
    simples: row.simples, productId: row.productId,
    productName: row.productName ?? null, entityId: row.entityId,
    stateId: row.stateId, stateName: row.stateName ?? null,
    cfopId: row.cfopId,
    hasIcms: !!Number(row.hasIcms), hasIcmsSt: !!Number(row.hasIcmsSt),
    hasIpi: !!Number(row.hasIpi), hasPisCofins: !!Number(row.hasPisCofins),
    hasIi: !!Number(row.hasIi),
  }
}

export async function listTaxRules(
  schemaName: string, institutionId: number, query: ListQuery
): Promise<PagedRows<TaxRuleListRow>> {
  const s = assertSchema(schemaName)
  const like = query.filter ? `%${escapeLike(query.filter)}%` : null
  const where =
    `FROM \`${s}\`.tb_tax_rule r
     LEFT JOIN \`${s}\`.tb_product p
       ON (p.id = r.tb_product_id AND p.tb_institution_id = r.tb_institution_id)
     LEFT JOIN setes_central.tb_state st ON (st.id = r.tb_state_id)
     WHERE r.deleted = 'N' AND r.tb_institution_id = ?
       AND (? IS NULL OR r.ncm LIKE ? OR p.description LIKE ?)`
  const params = [institutionId, like, like, like]

  const [rows] = await pool.query<any[]>(
    `SELECT r.id, r.ncm, r.origin, r.purpose, r.st,
            r.final_consumer AS finalConsumer, r.simples,
            r.tb_product_id AS productId, p.description AS productName,
            r.tb_entity_id AS entityId,
            r.tb_state_id AS stateId, st.name AS stateName,
            r.tb_cfop_id AS cfopId,
            ${HAS('tb_tax_rule_icms', s)} AS hasIcms,
            ${HAS('tb_tax_rule_icms_st', s)} AS hasIcmsSt,
            ${HAS('tb_tax_rule_ipi', s)} AS hasIpi,
            ${HAS('tb_tax_rule_pis_cofins', s)} AS hasPisCofins,
            ${HAS('tb_tax_rule_ii', s)} AS hasIi
     ${where}
     ORDER BY r.ncm DESC, r.id
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, query.offset]
  )
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total ${where}`, params
  )
  return { rows: rows.map(toListRow), total: Number(count[0].total) }
}

export async function getTaxRule(
  schemaName: string, institutionId: number, id: number
): Promise<TaxRuleDetail | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT r.* FROM \`${s}\`.tb_tax_rule r
      WHERE r.id = ? AND r.tb_institution_id = ? AND r.deleted = 'N'`,
    [id, institutionId]
  )
  if (!rows[0]) return null
  const r = rows[0]
  const selector: TaxRuleSelector = {
    id: r.id, institutionId: r.tb_institution_id,
    productId: r.tb_product_id, entityId: r.tb_entity_id,
    ncm: r.ncm || null, origin: r.origin,
    finalConsumer: r.final_consumer, simples: r.simples, st: r.st,
    purpose: r.purpose, direction: r.direction, cfopId: r.tb_cfop_id,
    stateId: r.tb_state_id, observationId: r.tb_observation_id,
    taxesId: r.tb_taxes_id,
  }
  return { selector, pieces: await loadPieces(s, id) }
}

function toPieces(input: TaxRuleBodyDto): TaxRulePieces {
  return {
    icms:      input.icms ?? undefined,
    icmsSt:    input.icmsSt ?? undefined,
    ipi:       input.ipi ?? undefined,
    pisCofins: input.pisCofins ?? undefined,
    ii:        input.ii ?? undefined,
  } as TaxRulePieces
}

/** Cria seletor (id MAX+1 FOR UPDATE) + peças na MESMA transação. */
export async function insertTaxRuleCascade(
  schemaName: string, institutionId: number, input: TaxRuleBodyDto
): Promise<number> {
  const s = assertSchema(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId
         FROM \`${s}\`.tb_tax_rule FOR UPDATE`
    ) as any[]
    const id: number = rows[0].nextId
    const sel = input.selector
    await conn.query(
      `INSERT INTO \`${s}\`.tb_tax_rule
         (id, tb_institution_id, tb_product_id, tb_entity_id, ncm, origin,
          final_consumer, simples, st, purpose, direction, tb_cfop_id,
          tb_state_id, tb_observation_id, tb_taxes_id,
          created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
      [id, institutionId, sel.productId ?? null, sel.entityId ?? null,
       sel.ncm ?? null, sel.origin, sel.finalConsumer, sel.simples, sel.st,
       sel.purpose, sel.direction, sel.cfopId ?? null,
       sel.stateId ?? null, sel.observationId ?? null, sel.taxesId ?? null]
    )
    await savePieces(conn, s, id, toPieces(input))
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
 * Atualiza seletor + ressincroniza peças na MESMA transação. Existência
 * verificada pelo próprio UPDATE (affectedRows — padrão do gate 2026-08-04:
 * PUT cruzando com DELETE não ressuscita peças de regra morta).
 */
export async function updateTaxRuleCascade(
  schemaName: string, institutionId: number, id: number, input: TaxRuleBodyDto
): Promise<void> {
  const s = assertSchema(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const sel = input.selector
    const [result] = await conn.query(
      `UPDATE \`${s}\`.tb_tax_rule
          SET tb_product_id = ?, tb_entity_id = ?, ncm = ?, origin = ?,
              final_consumer = ?, simples = ?, st = ?, purpose = ?,
              direction = ?, tb_cfop_id = ?, tb_state_id = ?,
              tb_observation_id = ?, tb_taxes_id = ?, updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [sel.productId ?? null, sel.entityId ?? null, sel.ncm ?? null,
       sel.origin, sel.finalConsumer, sel.simples, sel.st, sel.purpose,
       sel.direction, sel.cfopId ?? null, sel.stateId ?? null,
       sel.observationId ?? null, sel.taxesId ?? null, id, institutionId]
    ) as any[]
    if (Number(result?.affectedRows ?? 0) === 0) {
      throw new HttpError(404, `Regra de tributação ${id} não encontrada`)
    }
    await savePieces(conn, s, id, toPieces(input))
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Soft-delete do seletor + peças na MESMA transação (ordem de locks fixa). */
export async function deleteTaxRuleCascade(
  schemaName: string, institutionId: number, id: number
): Promise<void> {
  const s = assertSchema(schemaName)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [result] = await conn.query(
      `UPDATE \`${s}\`.tb_tax_rule SET deleted = 'S', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [id, institutionId]
    ) as any[]
    if (Number(result?.affectedRows ?? 0) === 0) {
      throw new HttpError(404, `Regra de tributação ${id} não encontrada`)
    }
    for (const t of ['tb_tax_rule_icms', 'tb_tax_rule_icms_st',
                     'tb_tax_rule_ipi', 'tb_tax_rule_pis_cofins',
                     'tb_tax_rule_ii']) {
      await conn.query(
        `UPDATE \`${s}\`.${t} SET deleted = 'S', updated_at = NOW()
          WHERE id = ?`, [id])
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Catálogos centrais para os combos do form (lookup — exceção D6, sem paginação). */
export async function listCatalogs(): Promise<TaxRuleCatalogs> {
  const fetch = async (table: string) => {
    const [rows] = await pool.query<any[]>(
      `SELECT id, description FROM setes_central.\`${table}\`
        WHERE deleted = 'N' ORDER BY id`)
    return rows
  }
  const [icmsNr, icmsSn, modBc, modBcSt, discharge, ipi, pis, cofins] =
    await Promise.all([
      fetch('tb_tax_icms_nr'),
      fetch('tb_tax_icms_sn'),
      fetch('tb_deter_base_tax_icms'),
      fetch('tb_deter_base_tax_icms_st'),
      fetch('tb_discharge_icms'),
      fetch('tb_tax_ipi'),
      fetch('tb_tax_pis'),
      fetch('tb_tax_cofins'),
    ])
  return { icmsNr, icmsSn, modBc, modBcSt, discharge, ipi, pis, cofins }
}

// ---------------------------------------------------------------------
// Lista de CFOPs por ALÇADA (rodada 2026-09-01): o form monta o combo a
// partir do sentido + UF do destinatário; o 1º dígito resolve a alçada.
// ---------------------------------------------------------------------

/** UF (stateId) do endereço principal do PRÓPRIO estabelecimento —
 *  convenção R4: tb_institution.id = tb_entity.id (mesma leitura da
 *  getEntityLocation do billing, aqui só a UF). */
export async function getEmitterStateId(institutionId: number): Promise<number | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT a.tb_state_id AS stateId
       FROM setes_central.tb_address a
      WHERE a.id = ? AND a.deleted = 'N'
      ORDER BY (a.main = 'S') DESC
      LIMIT 1`,
    [institutionId])
  return rows[0]?.stateId ?? null
}

/** Sigla da UF (null se o id não existe) — detecta 'EX' (Exterior). */
export async function getStateAbbreviation(stateId: number): Promise<string | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT abbreviation FROM setes_central.tb_state WHERE id = ?`,
    [stateId])
  return rows[0]?.abbreviation ?? null
}

/** CFOPs vivos/ativos cujo 1º dígito ∈ digits — lookup (sem paginação,
 *  exceção D6; teto de sanidade). */
export async function listCfopOptions(
  digits: string[], filter: string | null
): Promise<Array<{ id: string; description: string | null }>> {
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT id, description
       FROM setes_central.tb_cfop
      WHERE deleted = 'N' AND active = 'S'
        AND LEFT(id, 1) IN (${digits.map(() => '?').join(', ')})
        AND (? IS NULL OR id LIKE ? OR description LIKE ?)
      ORDER BY id
      LIMIT 200`,
    [...digits, like, like, like])
  return rows as Array<{ id: string; description: string | null }>
}
