import { PoolConnection } from 'mysql2/promise'
import { round2 } from '@shared/money'

/**
 * SALDO EM ABERTO do título — peça ÚNICA (Q-G21/Q-A13 do cancelamento de
 * nota, Valdo 2026-09-09: "rec."). Antes havia três fórmulas (lista de
 * títulos, cheque em pagamento, teto da baixa) e nenhuma subtraía o
 * DESCONTO — o título "quitado com desconto" seguia em Abertos e aceitava
 * 2ª baixa.
 *
 * Princípio: cada baixa viva COBRE um principal =
 *   paid_value − juros − multa + discount_value
 * e o saldo em aberto = tag_value − Σ principal coberto; baixa com desconto
 * QUITA quando cobre o que resta.
 *
 * D-G28 (= Q-A21, Valdo 2026-09-10 — regra BX-10 do legado, "baixa parcial
 * gera título residual" cuja FACE é o que resta): o desconto de CADA baixa
 * incide sobre o SALDO EM ABERTO no ato, nunca sobre o tag inteiro (o %
 * sobre o tag empilhava: 9 baixas de 0,01 a 10 % quitavam 100 com 10,00).
 * O VALOR concedido é fato do ato e fica gravado na baixa (migration 050,
 * `discount_value`) — a soma em SQL não precisa reconstruir o histórico.
 *
 * Uma fórmula, consumida por: lista/carteira (`OPEN_BALANCE_SQL`), cheque em
 * pagamento (`OPEN_BALANCE_SQL` sob FOR UPDATE), lookup a pagar do cheque
 * (Q-A26) e teto da baixa (`getPrincipalPaidTx`, leitura travante).
 */

/**
 * D-A28 (Valdo 2026-09-13, opção 1 — MANTER): o desconto de cada baixa incide sobre o
 * SALDO do ato (D-G28/BX-10), e isso é INTENCIONAL mesmo levado ao extremo — N baixas
 * pequenas com % concedem N descontos e o total recebido pode ficar bem abaixo do valor
 * do título (o gate adversarial provou 30 baixas de 0,01 a 10 % quitando 100 com 4,43).
 * NÃO É BUG e não deve ser "corrigido": cada baixa é um ATO do operador, o valor concedido
 * fica gravado (`discount_value`) para auditoria, e quem contém o risco é a AUTORIDADE —
 * teto por config `max_discount_aliquot` + privilégio DESCONTO (D-G32/D-G36).
 * Teste que fixa a semântica: `settlement-batch.test` ("D-A28").
 */

/** Σ principal coberto pelas baixas VIVAS do título `fAlias` (subquery correlacionada). */
export const PRINCIPAL_PAID_SQL = (schema: string, fAlias = 'f') => `
    (SELECT COALESCE(SUM(p.paid_value - COALESCE(p.interest_value, 0) - COALESCE(p.late_value, 0)
                         + COALESCE(p.discount_value, 0)), 0)
       FROM \`${schema}\`.tb_financial_payment p
      WHERE p.tb_institution_id = ${fAlias}.tb_institution_id
        AND p.tb_order_id = ${fAlias}.tb_order_id AND p.terminal = ${fAlias}.terminal
        AND p.parcel = ${fAlias}.parcel AND p.status = 'N' AND p.deleted = 'N')`

/** Saldo em aberto do título `fAlias` (nunca negativo), 2 casas. */
export const OPEN_BALANCE_SQL = (schema: string, fAlias = 'f') =>
  `GREATEST(ROUND(${fAlias}.tag_value - ${PRINCIPAL_PAID_SQL(schema, fAlias)}, 2), 0)`

/**
 * Principal já coberto pelas baixas VIVAS (leitura TRAVANTE — ordem título →
 * payment; o chamador já travou o título).
 */
export async function getPrincipalPaidTx(
  conn: PoolConnection, schema: string, institutionId: number,
  orderId: number, parcel: number
): Promise<number> {
  const [rows] = await conn.query<any[]>(
    `SELECT COALESCE(SUM(paid_value - COALESCE(interest_value, 0) - COALESCE(late_value, 0)
                        + COALESCE(discount_value, 0)), 0) AS principalPaid
       FROM \`${schema}\`.tb_financial_payment
      WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = 0 AND parcel = ?
        AND status = 'N' AND deleted = 'N' FOR UPDATE`,
    [institutionId, orderId, parcel]
  )
  return round2(rows[0]?.principalPaid ?? 0)
}

/**
 * Teto de uma baixa: saldo em aberto − desconto DESTA baixa + juros/multa
 * INFORMADOS. `discount` = valor concedido (D-G28: % sobre o SALDO em aberto).
 */
export function settlementCeiling(
  tagValue: number, principalPaid: number,
  input: {
    interestValue?: number | null; lateValue?: number | null; discountAliquot?: number | null
    /** D-G30: desconto já em VALOR (boleto: congelado na emissão) — prevalece sobre o %. */
    discountValue?: number | null
  }
): { openBalance: number; discount: number; discountWanted: number; maxDiscount: number; ceiling: number } {
  const openBalance = round2(Math.max(tagValue - principalPaid, 0))
  // D-G30 (Q-G30, Valdo 2026-09-13): quem já tem o desconto em VALOR passa
  // `discountValue`; senão % sobre o saldo (D-G28). Nunca acima do saldo —
  // desconto não cobre mais do que resta.
  const wanted = input.discountValue != null
    ? round2(Number(input.discountValue))
    : round2(openBalance * Number(input.discountAliquot ?? 0) / 100)
  // D-G35 (Valdo 2026-09-13): desconto por ALÍQUOTA nunca cobre o saldo inteiro —
  // 99,99 % de 10,00 dá 9,999 → 10,00 no DECIMAL e "quitaria" sem receber;
  // "desativar a cobrança" é outro ato. Teto = saldo − 0,01 (sobra 1 centavo).
  // Desconto em VALOR (boleto, D-G30) é ato ANTERIOR, acordado na emissão: vale
  // até o saldo inteiro — a autoridade dessa porta é questão aberta (Q-G36).
  const maxDiscount = input.discountValue != null
    ? openBalance
    : (openBalance >= 0.01 ? round2(openBalance - 0.01) : 0)
  const discount = Math.min(Math.max(wanted, 0), maxDiscount)
  const ceiling = round2(openBalance - discount + Number(input.interestValue ?? 0) + Number(input.lateValue ?? 0))
  // M-3/L-1 (adversarial da Rodada 6): `discountWanted` e `maxDiscount` saem da
  // peça para o chamador RECUSAR o desconto que não cabe, em vez de reduzir em
  // silêncio e gravar uma alíquota que não foi concedida (o recibo mentia) —
  // e para o erro apontar `discountAliquot`, não `paidValue`.
  return { openBalance, discount, discountWanted: Math.max(wanted, 0), maxDiscount, ceiling }
}
