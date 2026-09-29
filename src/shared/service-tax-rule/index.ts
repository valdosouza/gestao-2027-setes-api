import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'

/**
 * Peça @shared/service-tax-rule — resolução da Regra de Tributação de
 * SERVIÇO (ISS) para o faturamento (prompt_regra_tributacao_servico.md,
 * Onda 3 — D1/D5/D6/D12/D13). Caminho INDIVIDUAL do serviço: NADA aqui
 * reusa o motor de match de mercadoria (@shared/tax-rule). O cálculo
 * (calcIssqn) continua na peça de cálculo puro — esta peça só resolve
 * QUAL regra vale e SE ela pode ser usada:
 *   - D1: o serviço aponta a regra (tb_service.tb_service_tax_rule_id);
 *   - D6: serviço sem regra é PENDÊNCIA (bloqueia);
 *   - D12: a regra carrega a cidade de INCIDÊNCIA e o faturamento CONFERE
 *     contra a cidade do TOMADOR (divergência bloqueia);
 *   - D13: a alíquota é a da regra, sem interferência por regime.
 */

export interface ServiceTaxRuleResolved {
  id:            number
  cityId:        number
  cityName:      string | null
  serviceListId: string
  aliq:          number
  municipalCode: string | null
  /** cTribNac (6 dígitos) — o da regra, ou DERIVADO quando o subitem tem um único
   *  desdobro nacional (D-N11a). null = subitem com vários desdobros e a regra não
   *  escolheu (pendência: NATIONAL_CODE). */
  nationalCode:  string | null
  active:        'S' | 'N'
}

export type ServiceRuleProblem = 'NO_RULE' | 'INACTIVE' | 'CITY_MISMATCH' | 'NATIONAL_CODE'

/** cTribNac derivado: único código ATIVO do subitem (Anexo B) — só quando é um só. */
export const DERIVED_NATIONAL_CODE_SQL = `(SELECT MIN(n.code) FROM setes_central.tb_service_national_code n
                  WHERE n.tb_service_list_id = r.tb_service_list_id AND n.deleted = 'N' AND n.active = 'S'
                  GROUP BY n.tb_service_list_id HAVING COUNT(*) = 1)`

const FIELDS = `r.id, r.tb_city_id AS cityId, c.name AS cityName,
                r.tb_service_list_id AS serviceListId, r.aliq,
                r.municipal_code AS municipalCode,
                COALESCE(r.national_code, ${DERIVED_NATIONAL_CODE_SQL}) AS nationalCode,
                COALESCE(r.active, 'S') AS active`

function toResolved(row: any): ServiceTaxRuleResolved {
  return {
    id: Number(row.id), cityId: Number(row.cityId), cityName: row.cityName ?? null,
    serviceListId: String(row.serviceListId), aliq: Number(row.aliq ?? 0),
    municipalCode: row.municipalCode ?? null, nationalCode: row.nationalCode ?? null,
    active: row.active === 'N' ? 'N' : 'S',
  }
}

/** Regra viva por id (RegraDireta 'M' ou vínculo 'A' gravado). */
export async function getServiceTaxRuleById(
  schemaName: string, institutionId: number, ruleId: number
): Promise<ServiceTaxRuleResolved | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT ${FIELDS}
       FROM \`${s}\`.tb_service_tax_rule r
       LEFT JOIN setes_central.tb_city c ON c.id = r.tb_city_id
      WHERE r.id = ? AND r.tb_institution_id = ? AND r.deleted = 'N'`,
    [ruleId, institutionId])
  return rows[0] ? toResolved(rows[0]) : null
}

/** Regra apontada pelo SERVIÇO (FK literal — D1); null = serviço sem regra. */
export async function resolveServiceTaxRule(
  schemaName: string, institutionId: number, productId: number
): Promise<ServiceTaxRuleResolved | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT ${FIELDS}
       FROM \`${s}\`.tb_service sv
       JOIN \`${s}\`.tb_service_tax_rule r
         ON r.id = sv.tb_service_tax_rule_id AND r.tb_institution_id = sv.tb_institution_id
        AND r.deleted = 'N'
       LEFT JOIN setes_central.tb_city c ON c.id = r.tb_city_id
      WHERE sv.id = ? AND sv.tb_institution_id = ? AND sv.deleted = 'N'`,
    [productId, institutionId])
  return rows[0] ? toResolved(rows[0]) : null
}

/**
 * A regra pode ser usada nesta operação? null = ok. Cidade do tomador
 * desconhecida (sem endereço) não dispara CITY_MISMATCH — o contexto já
 * acusa a falta de endereço como pendência própria.
 */
export function checkServiceRule(
  rule: ServiceTaxRuleResolved | null, recipientCityId: number | null
): ServiceRuleProblem | null {
  if (!rule) return 'NO_RULE'
  if (rule.active !== 'S') return 'INACTIVE'
  if (recipientCityId !== null && rule.cityId !== recipientCityId) return 'CITY_MISMATCH'
  // D-N11a: o DPS exige cTribNac; regra de subitem com vários desdobros sem escolha = pendência
  // (depois da cidade: a regra errada é o problema maior)
  if (rule.nationalCode == null) return 'NATIONAL_CODE'
  return null
}

/** Texto da pendência (scope item, field serviceTaxRule). */
export function serviceRuleProblemMessage(
  itemId: number, problem: ServiceRuleProblem, rule: ServiceTaxRuleResolved | null
): string {
  switch (problem) {
    case 'NO_RULE':
      return `Item ${itemId}: serviço sem regra de tributação de serviço — vincule a regra no cadastro do serviço`
    case 'INACTIVE':
      return `Item ${itemId}: regra de tributação de serviço ${rule!.id} está inativa`
    case 'CITY_MISMATCH':
      return `Item ${itemId}: regra ${rule!.id} incide em ${rule!.cityName ?? rule!.cityId}, mas o tomador está em outra cidade — cadastre/vincule a regra do município do tomador`
    case 'NATIONAL_CODE':
      return `Item ${itemId}: regra ${rule!.id} sem código de tributação nacional — o subitem ${rule!.serviceListId} tem mais de um desdobro no Anexo B; escolha na regra`
  }
}
