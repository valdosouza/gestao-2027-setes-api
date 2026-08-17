import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { TaxRuleMatchCriteria, TaxRuleSelector } from './types'

/**
 * O MOTOR de busca da Regra de Tributação — porte fiel do legado
 * (tributacao.md §2: CriaSqlTributacao :542-567 + binding :890-926 +
 * desempate Fc_DefineTributacao :941-951 com o B9 CORRIGIDO).
 *
 * As 6 sutilezas vivem AQUI e em nenhum outro lugar (constraint do parecer
 * setes-conceito — endpoint nenhum reimplementa o match):
 *  1. Coringas: tb_product_id/tb_entity_id/ncm NULL casam qualquer valor
 *  2. Precedência por NCM: regra COM ncm vence (ORDER BY ncm DESC — NULL por último)
 *  3. Estado: mesma UF → exige tb_state_id exato; interestadual → aceita coringa
 *  4. Ajuste (natureza informada): filtra por CFOP e força finalidade '0'
 *  5. Operação presencial: não contribuinte de outra UF → busca pela UF do EMITENTE
 *  6. RegraDireta: escolha por item pula a combinação inteira
 * + o override do cliente (Q18): IgnorarCalculoST sobrescreve o ST do produto
 *   ANTES da busca — SÓ na via combinada (nunca na direta).
 */

function toSelector(row: any): TaxRuleSelector {
  return {
    id:            row.id,
    institutionId: row.tb_institution_id,
    productId:     row.tb_product_id,
    entityId:      row.tb_entity_id,
    ncm:           row.ncm || null,
    origin:        row.origin,
    finalConsumer: row.final_consumer,
    simples:       row.simples,
    st:            row.st,
    purpose:       row.purpose,
    direction:     row.direction,
    cfopId:        row.tb_cfop_id,
    stateId:       row.tb_state_id,
    observationId: row.tb_observation_id,
    taxesId:       row.tb_taxes_id,
  }
}

/** Sutileza 5 — resolve a UF usada no match (tributacao.pas :911-921). */
export function resolveMatchStateId(c: TaxRuleMatchCriteria): number {
  const nonContributor =
    c.contributorIndicator === '1' || c.contributorIndicator === '9'
  if (c.presential && nonContributor &&
      c.destinationStateId !== c.emitterStateId) {
    return c.emitterStateId
  }
  return c.destinationStateId
}

/** Override do cliente (Q18) — tributacao.pas :883-887. */
export function resolveEffectiveSt(c: TaxRuleMatchCriteria): 'S' | 'N' {
  if (c.productSt === 'S' && c.customerIgnoreSt === 'S') return 'N'
  return c.productSt
}

/**
 * Desempate quando a combinação devolve mais de uma regra — porte do
 * Fc_DefineTributacao (:941-951) com o B9 corrigido (o último fallback do
 * legado passava o código do ESTADO no campo produto; aqui usa o PRODUTO):
 * cliente → estado+produto → estado → produto → 1ª da ordem (NCM DESC).
 */
export function pickRule(
  rules: TaxRuleSelector[], c: TaxRuleMatchCriteria, stateId: number
): TaxRuleSelector {
  if (rules.length === 1) return rules[0]
  const byEntity = rules.find(r => r.entityId !== null && r.entityId === c.entityId)
  if (byEntity) return byEntity
  const byStateProduct = rules.find(r =>
    r.stateId === stateId && r.productId === c.productId)
  if (byStateProduct) return byStateProduct
  const byState = rules.find(r => r.stateId === stateId)
  if (byState) return byState
  const byProduct = rules.find(r => r.productId === c.productId)  // B9 corrigido
  if (byProduct) return byProduct
  return rules[0]  // ordem NCM DESC — a mais específica por NCM
}

/**
 * Busca a regra para UM item. Devolve o seletor casado ou null (chamador
 * monta o alerta "Regra de Tributação não encontrada" — processo-§3).
 */
export async function findTaxRule(
  schemaName: string, c: TaxRuleMatchCriteria
): Promise<TaxRuleSelector | null> {
  const s = assertSchema(schemaName)

  // Sutileza 6 — modo RegraDireta (escolha por item): pula a combinação e o
  // override de ST do cliente (fiel ao legado :863-877). Escopo por
  // institution mesmo aqui: regra de outro estabelecimento do schema não
  // tributa esta nota (gate adversarial da Onda 1).
  if (c.directRuleId) {
    const [rows] = await pool.query<any[]>(
      `SELECT * FROM \`${s}\`.tb_tax_rule
        WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
      [c.directRuleId, c.institutionId]
    )
    return rows[0] ? toSelector(rows[0]) : null
  }

  const effectiveSt = resolveEffectiveSt(c)
  const matchState  = resolveMatchStateId(c)
  // Sutileza 4 — ajuste dirigido por natureza: CFOP entra no filtro e a
  // finalidade é FORÇADA a '0' (Outras) — tributacao.pas :901-904.
  const purpose = c.cfopId ? '0' : c.purpose
  // Sutileza 3 — regime do estado decidido pela UF REAL do destinatário
  // (não a resolvida — fiel a :563-565).
  const sameState = c.destinationStateId === c.emitterStateId
  const stateWhere = sameState
    ? 'AND (r.tb_state_id = ?)'
    : 'AND (r.tb_state_id = ? OR r.tb_state_id IS NULL)'

  const [rows] = await pool.query<any[]>(
    `SELECT r.*
       FROM \`${s}\`.tb_tax_rule r
      WHERE r.deleted = 'N'
        AND r.tb_institution_id = ?
        AND (r.tb_product_id IS NULL OR r.tb_product_id = ?)
        AND (r.tb_entity_id IS NULL OR r.tb_entity_id = ?)
        AND (r.ncm IS NULL OR r.ncm = '' OR r.ncm = ?)
        AND r.origin = ?
        AND r.st = ?
        AND r.final_consumer = ?
        AND r.simples = ?
        AND r.purpose = ?
        ${c.cfopId ? 'AND r.tb_cfop_id = ?' : ''}
        ${stateWhere}
      ORDER BY r.ncm DESC, r.id`,
    [
      c.institutionId, c.productId, c.entityId ?? -1, c.productNcm ?? '',
      c.productOrigin, effectiveSt, c.finalConsumer, c.simples, purpose,
      ...(c.cfopId ? [c.cfopId] : []),
      matchState,
    ]
  )
  if (rows.length === 0) return null
  return pickRule(rows.map(toSelector), c, matchState)
}
