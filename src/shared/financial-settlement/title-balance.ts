import { PoolConnection } from 'mysql2/promise'

/**
 * SALDO EM ABERTO do título — peça ÚNICA (Q-G21/Q-A13 do cancelamento de
 * nota, Valdo 2026-09-09: "rec."). Antes havia três fórmulas (lista de
 * títulos, cheque em pagamento, teto da baixa) e nenhuma subtraía o
 * DESCONTO — o título "quitado com desconto" seguia em Abertos e aceitava
 * 2ª baixa.
 *
 * Princípio: cada baixa viva COBRE um principal =
 *   paid_value − juros − multa + desconto,   desconto = tag_value × aliq/100
 * (o app calcula paid = tag + juros + multa − tag×desc% — settlements.calc
 * `liquidValue`). Saldo em aberto = tag_value − Σ principal coberto; baixa
 * com desconto QUITA. Uma fórmula, consumida por: lista/carteira
 * (`OPEN_BALANCE_SQL`), cheque em pagamento (`OPEN_BALANCE_SQL` sob FOR
 * UPDATE), teto da baixa (`getPrincipalPaidTx`, leitura travante).
 */

/** Σ principal coberto pelas baixas VIVAS do título `fAlias` (subquery correlacionada). */
export const PRINCIPAL_PAID_SQL = (schema: string, fAlias = 'f') => `
    (SELECT COALESCE(SUM(p.paid_value - COALESCE(p.interest_value, 0) - COALESCE(p.late_value, 0)
                         + ${fAlias}.tag_value * COALESCE(p.discount_aliquot, 0) / 100), 0)
       FROM \`${schema}\`.tb_financial_payment p
      WHERE p.tb_institution_id = ${fAlias}.tb_institution_id
        AND p.tb_order_id = ${fAlias}.tb_order_id AND p.terminal = ${fAlias}.terminal
        AND p.parcel = ${fAlias}.parcel AND p.status = 'N' AND p.deleted = 'N')`

/** Saldo em aberto do título `fAlias` (nunca negativo), 2 casas. */
export const OPEN_BALANCE_SQL = (schema: string, fAlias = 'f') =>
  `GREATEST(ROUND(${fAlias}.tag_value - ${PRINCIPAL_PAID_SQL(schema, fAlias)}, 2), 0)`

/**
 * Principal já coberto pelas baixas VIVAS (leitura TRAVANTE — ordem título →
 * payment; o chamador já travou o título). `tagValue` do título entra no
 * cálculo do desconto de cada baixa.
 */
export async function getPrincipalPaidTx(
  conn: PoolConnection, schema: string, institutionId: number,
  orderId: number, parcel: number, tagValue: number
): Promise<number> {
  const [rows] = await conn.query<any[]>(
    `SELECT COALESCE(SUM(paid_value - COALESCE(interest_value, 0) - COALESCE(late_value, 0)
                        + ? * COALESCE(discount_aliquot, 0) / 100), 0) AS principalPaid
       FROM \`${schema}\`.tb_financial_payment
      WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0 AND parcel = ?
        AND status = 'N' AND deleted = 'N' FOR UPDATE`,
    [tagValue, institutionId, orderId, parcel]
  )
  return Math.round(Number(rows[0]?.principalPaid ?? 0) * 100) / 100
}

/** Teto de uma baixa: saldo em aberto − desconto DESTA baixa + juros/multa INFORMADOS. */
export function settlementCeiling(
  tagValue: number, principalPaid: number,
  input: { interestValue?: number | null; lateValue?: number | null; discountAliquot?: number | null }
): { openBalance: number; ceiling: number } {
  const r2 = (n: number) => Math.round(n * 100) / 100
  const openBalance = r2(Math.max(tagValue - principalPaid, 0))
  const discount = r2(tagValue * Number(input.discountAliquot ?? 0) / 100)
  const ceiling = r2(openBalance - discount + Number(input.interestValue ?? 0) + Number(input.lateValue ?? 0))
  return { openBalance, ceiling }
}
