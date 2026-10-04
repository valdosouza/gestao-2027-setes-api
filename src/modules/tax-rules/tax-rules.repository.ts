import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, SearchCriterion, escapeLike } from '@shared/list'
import { TAX_RULE_ORIGINS, TAX_RULE_PURPOSES } from './tax-rules.dto'
import { assertSchema } from '@shared/db/schema'
import { savePieces, loadPieces, TaxRulePieces, TaxRuleSelector } from '@shared/tax-rule'
import { TaxRuleListRow, TaxRuleDetail, TaxRuleCatalogs, LookupRow } from './tax-rules.interface'
import { TaxRuleBodyDto } from './tax-rules.dto'

/**
 * Repositório do cadastro tax-rules (schema do cliente). Escopo = schema do
 * JWT + institution no seletor (estabelecimento). Escrita SEMPRE em cascata
 * transacional seletor+peças (presença = incidência — savePieces da peça
 * @shared/tax-rule; o match NUNCA é reimplementado aqui).
 */

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

/**
 * PESQUISA AVANÇADA (prompt_pesquisa_avancada.md — Onda 2 §12, Bloco 2): lista branca desta
 * lista. Vive AQUI (D-BA12) porque as expressões dependem dos aliases da query base; o escopo
 * (schema/institution) fica na query, o critério referencia ALIAS (parecer do guardião).
 */
export const TAX_RULE_SEARCH_CRITERIA: readonly SearchCriterion[] = [
  { key: 'ncm', kind: 'text', labelKey: 'search.tax-rules.ncm', expr: 'r.ncm' },
  { key: 'productName', kind: 'text', labelKey: 'search.tax-rules.productName', expr: 'p.description' },
  { key: 'product', kind: 'lookup', labelKey: 'search.tax-rules.product',
    expr: 'r.tb_product_id', lookup: '/api/tax-rules/products' },
  { key: 'stateName', kind: 'text', labelKey: 'search.tax-rules.stateName', expr: 'st.name' },
  { key: 'state', kind: 'lookup', labelKey: 'search.tax-rules.state',
    expr: 'r.tb_state_id', lookup: '/api/tax-rules/states' },
  // CFOP tem id VARCHAR ('5.102') — não é lookup inteiro: texto "contém" sobre o código
  { key: 'cfop', kind: 'text', labelKey: 'search.tax-rules.cfop', expr: 'r.tb_cfop_id' },
  { key: 'origin', kind: 'options', labelKey: 'search.tax-rules.origin', expr: 'r.origin', options: TAX_RULE_ORIGINS },
  { key: 'purpose', kind: 'options', labelKey: 'search.tax-rules.purpose', expr: 'r.purpose', options: TAX_RULE_PURPOSES },
  { key: 'direction', kind: 'options', labelKey: 'search.tax-rules.direction', expr: 'r.direction', options: ['E', 'S'] },
  { key: 'st', kind: 'bool', labelKey: 'search.tax-rules.st', expr: 'r.st', boolValues: ['S', 'N'] },
  { key: 'finalConsumer', kind: 'bool', labelKey: 'search.tax-rules.finalConsumer', expr: 'r.final_consumer', boolValues: ['S', 'N'] },
  { key: 'simples', kind: 'bool', labelKey: 'search.tax-rules.simples', expr: 'r.simples', boolValues: ['S', 'N'] },
  // D-BA22: derivados = presença do filho (LEFT JOIN 1:1 na query base — a coluna da linha é a MESMA expressão)
  { key: 'hasIcms', kind: 'bool', labelKey: 'search.tax-rules.hasIcms', expr: 'icms.id IS NOT NULL' },
  { key: 'hasIcmsSt', kind: 'bool', labelKey: 'search.tax-rules.hasIcmsSt', expr: 'icmsst.id IS NOT NULL' },
  { key: 'hasIpi', kind: 'bool', labelKey: 'search.tax-rules.hasIpi', expr: 'ipi.id IS NOT NULL' },
  { key: 'hasPisCofins', kind: 'bool', labelKey: 'search.tax-rules.hasPisCofins', expr: 'pc.id IS NOT NULL' },
  { key: 'hasIi', kind: 'bool', labelKey: 'search.tax-rules.hasIi', expr: 'ii.id IS NOT NULL' },
]

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
     LEFT JOIN \`${s}\`.tb_tax_rule_icms icms ON icms.id = r.id AND icms.deleted = 'N'
     LEFT JOIN \`${s}\`.tb_tax_rule_icms_st icmsst ON icmsst.id = r.id AND icmsst.deleted = 'N'
     LEFT JOIN \`${s}\`.tb_tax_rule_ipi ipi ON ipi.id = r.id AND ipi.deleted = 'N'
     LEFT JOIN (SELECT pc0.id FROM \`${s}\`.tb_tax_rule_pis_cofins pc0 WHERE pc0.deleted = 'N' GROUP BY pc0.id) pc
       ON pc.id = r.id
     LEFT JOIN \`${s}\`.tb_tax_rule_ii ii ON ii.id = r.id AND ii.deleted = 'N'
     WHERE r.deleted = 'N' AND r.tb_institution_id = ?
       AND (? IS NULL OR r.ncm LIKE ? OR p.description LIKE ?)${query.criteria.sql}`
  const params = [institutionId, like, like, like, ...query.criteria.params]

  const [rows] = await pool.query<any[]>(
    `SELECT r.id, r.ncm, r.origin, r.purpose, r.st,
            r.final_consumer AS finalConsumer, r.simples,
            r.tb_product_id AS productId, p.description AS productName,
            r.tb_entity_id AS entityId,
            r.tb_state_id AS stateId, st.name AS stateName,
            r.tb_cfop_id AS cfopId,
            (icms.id IS NOT NULL)   AS hasIcms,
            (icmsst.id IS NOT NULL) AS hasIcmsSt,
            (ipi.id IS NOT NULL)    AS hasIpi,
            (pc.id IS NOT NULL)     AS hasPisCofins,
            (ii.id IS NOT NULL)     AS hasIi
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

/** Produtos da institution para o critério "produto" (lookup do PRÓPRIO módulo, { id, name }). */
export async function listProductsLookup(
  filter: string, schemaName: string, institutionId: number
): Promise<LookupRow[]> {
  const s = assertSchema(schemaName)
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT id, description AS name
       FROM \`${s}\`.tb_product
      WHERE tb_institution_id = ? AND deleted = 'N'
        AND (? IS NULL OR description LIKE ? OR identifier LIKE ?)
      ORDER BY description, id
      LIMIT 50`,
    [institutionId, like, like, like]
  )
  return rows as LookupRow[]
}

/** Estados para o critério "UF" ({ id, name } = nome + sigla). */
export async function listStatesLookup(filter: string): Promise<LookupRow[]> {
  const like = filter ? `%${escapeLike(filter)}%` : null
  const [rows] = await pool.query<any[]>(
    `SELECT id, CONCAT(name, ' (', abbreviation, ')') AS name
       FROM setes_central.tb_state
      WHERE deleted = 'N' AND (? IS NULL OR name LIKE ? OR abbreviation LIKE ?)
      ORDER BY name, id
      LIMIT 50`,
    [like, like, like]
  )
  return rows as LookupRow[]
}
