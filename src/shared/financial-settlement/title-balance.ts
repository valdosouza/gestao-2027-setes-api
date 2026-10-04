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

/*
 * As TRÊS formas da fórmula (correlacionada, de LISTA e travante) montam o SQL a partir
 * destas três partes internas — a fórmula existe uma vez só (parecer do guardião, D-BA37):
 * - PAYMENT_PRINCIPAL: principal coberto por UMA baixa;
 * - LIVE_PAYMENT: o que é "baixa viva". ⚠️ NÃO "harmonizar" com a D-CH2 (saldo do caixa soma
 *   TODAS as linhas porque lá o espelho 'R' compensa o original 'E'): aqui o espelho 'R' do
 *   estorno é POSITIVO — somar tudo dobraria o valor. `status = 'N'` FAZ PARTE da fórmula;
 * - balanceOver: saldo = valor do título − principal coberto, 2 casas, nunca negativo.
 */
const PAYMENT_PRINCIPAL = (p = 'p') =>
  `${p}.paid_value - COALESCE(${p}.interest_value, 0) - COALESCE(${p}.late_value, 0)
                         + COALESCE(${p}.discount_value, 0)`
const LIVE_PAYMENT = (p = 'p') => `${p}.status = 'N' AND ${p}.deleted = 'N'`
const balanceOver = (fAlias: string, principalExpr: string) =>
  `GREATEST(ROUND(${fAlias}.tag_value - ${principalExpr}, 2), 0)`

/** Σ principal coberto pelas baixas VIVAS do título `fAlias` (subquery correlacionada — 1 título). */
export const PRINCIPAL_PAID_SQL = (schema: string, fAlias = 'f') => `
    (SELECT COALESCE(SUM(${PAYMENT_PRINCIPAL('p')}), 0)
       FROM \`${schema}\`.tb_financial_payment p
      WHERE p.tb_institution_id = ${fAlias}.tb_institution_id
        AND p.tb_order_id = ${fAlias}.tb_order_id AND p.terminal = ${fAlias}.terminal
        AND p.parcel = ${fAlias}.parcel AND ${LIVE_PAYMENT('p')})`

/** Saldo em aberto do título `fAlias` (nunca negativo), 2 casas — forma correlacionada. */
export const OPEN_BALANCE_SQL = (schema: string, fAlias = 'f') =>
  balanceOver(fAlias, PRINCIPAL_PAID_SQL(schema, fAlias))

/**
 * Forma de LISTA (D-BA37, Onda 3 da pesquisa avançada): o principal coberto de TODOS os
 * títulos da institution numa derived table AGREGADA 1:1 por título, juntada à query base
 * por LEFT JOIN — a lista deixa de fazer duas subconsultas por linha e o COUNT deixa de
 * recalcular tudo. A peça emite o JOIN INTEIRO (derived table + ON): a chave do título
 * (institution, order, terminal, parcel) vive num lugar só — o GROUP BY e o ON usam as
 * MESMAS quatro colunas, e quem consome não escreve ON (sem fan-out por esquecimento).
 *
 * ⚠️ Carrega UM `?` = institution (escopo da derived table, parte da query base — como o
 * `mv` dos contratos); ele vem ANTES do `?` do WHERE do consumidor no texto do SQL.
 * Só para LEITURA de lista: derived table dentro de FOR UPDATE não trava (PADROES_BANCO §9,
 * regra 2) — decisão travante segue em `getPrincipalPaidTx`.
 */
export const PRINCIPAL_PAID_JOIN_SQL = (schema: string, fAlias = 'f', ppAlias = 'pp') => `
     LEFT JOIN (SELECT p.tb_institution_id, p.tb_order_id, p.terminal, p.parcel,
                       SUM(${PAYMENT_PRINCIPAL('p')}) AS principal_paid
                  FROM \`${schema}\`.tb_financial_payment p
                 WHERE p.tb_institution_id = ? AND ${LIVE_PAYMENT('p')}
                 GROUP BY p.tb_institution_id, p.tb_order_id, p.terminal, p.parcel) ${ppAlias}
       ON ${ppAlias}.tb_institution_id = ${fAlias}.tb_institution_id
      AND ${ppAlias}.tb_order_id = ${fAlias}.tb_order_id
      AND ${ppAlias}.terminal = ${fAlias}.terminal
      AND ${ppAlias}.parcel = ${fAlias}.parcel`

/** Principal coberto sobre o alias juntado (sem schema, sem `?` — cabe em lista branca `const`). */
export const PRINCIPAL_PAID_OF = (ppAlias = 'pp') => `COALESCE(${ppAlias}.principal_paid, 0)`

/** Saldo em aberto sobre o alias juntado — mesma conta do `OPEN_BALANCE_SQL` (balanceOver). */
export const OPEN_BALANCE_OF = (fAlias = 'f', ppAlias = 'pp') =>
  balanceOver(fAlias, PRINCIPAL_PAID_OF(ppAlias))

/**
 * Principal já coberto pelas baixas VIVAS (leitura TRAVANTE — ordem título →
 * payment; o chamador já travou o título). `terminal = 0` é chave por desenho
 * (baixa só existe no terminal 0), não diferença de fórmula.
 */
export async function getPrincipalPaidTx(
  conn: PoolConnection, schema: string, institutionId: number,
  orderId: number, parcel: number
): Promise<number> {
  const [rows] = await conn.query<any[]>(
    `SELECT COALESCE(SUM(${PAYMENT_PRINCIPAL('p')}), 0) AS principalPaid
       FROM \`${schema}\`.tb_financial_payment p
      WHERE p.tb_institution_id = ? AND p.tb_order_id = ? AND p.terminal = 0 AND p.parcel = ?
        AND ${LIVE_PAYMENT('p')} FOR UPDATE`,
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
