/**
 * Funções puras de resolução de contexto do faturamento (sem SQL).
 * As queries vivem no repository; aqui só transformação.
 */

// parseCrt PROMOVIDO para @shared/entity-tax (D39 — o cadastro do
// estabelecimento e o form de regras também precisam dele); re-export
// mantém os consumidores/testes deste módulo.
export { parseCrt } from '@shared/entity-tax/entity-tax.types'

// Prazo e datas MIGRARAM para as peças da negociação (prompt_negociacao_pedido.md
// §6, 2026-09-06): a gramática da coluna deadline vive em @shared/order-billing
// e a materialização em @shared/order-installment. Re-export mantido para os
// consumidores/testes antigos (precedente parseCrt, D39).
export { parseDeadline, MAX_DEADLINE_DAYS } from '@shared/order-billing'
export { addDays } from '@shared/order-installment'

/**
 * MVA ajustada pela carga tributária real (P2.7/P3.2):
 * `MVA_aj = ((1 + MVA/100) × (100 − inter) / (100 − intra) − 1) × 100`.
 * Se intra ≤ inter (carga do destino não maior), o ajuste não amplia — usa
 * a original (prática fiscal: MVA ajustada só quando a interna é maior).
 */
export function adjustMva(mvaOriginalPct: number, interAliq: number, intraAliq: number): number {
  if (intraAliq <= interAliq || intraAliq >= 100) return mvaOriginalPct
  const adjusted = ((1 + mvaOriginalPct / 100) * (100 - interAliq) / (100 - intraAliq) - 1) * 100
  return Math.round(adjusted * 10000) / 10000
}

/**
 * Produto sujeito a ST no formato novo: derivado da PRESENÇA de CEST
 * (Código Especificador da Substituição Tributária — só existe para
 * produtos ST). O PRO_SUB_TRIB do legado não tem coluna própria no
 * formato novo (gap registrado na rodada do prompt de fase).
 */
export function deriveProductSt(cest: string | null | undefined): 'S' | 'N' {
  return (cest ?? '').trim() !== '' ? 'S' : 'N'
}

export interface FinancialPolarity {
  kind: 'RA' | 'PA'
  operation: 'C' | 'D'
}

/**
 * Natureza financeira por ramo (R5-Q1 — evidência em UN_Fatura_Vda/Cpa/
 * Srv/Ajt.pas): venda e serviço geram RA+C; compra gera PA+D. O AJUSTE
 * inverte pela DIREÇÃO escolhida na tela de faturamento (mesmo campo que
 * já resolve a regra fiscal — não é um campo novo): Saída (devolução ao
 * fornecedor) → PA+C (crédito nosso); Entrada (cliente devolvendo pra nós)
 * → RA+D (débito nosso). É o oposto do par direção→tipo usado em
 * venda/compra, por isso não dá pra reaproveitar branch.direction aqui.
 */
export function resolveFinancialPolarity(
  branch: 'sale' | 'purchase' | 'adjust' | 'service',
  adjustDirection: 'E' | 'S' | null | undefined
): FinancialPolarity {
  if (branch === 'purchase') return { kind: 'PA', operation: 'D' }
  if (branch === 'adjust') {
    return adjustDirection === 'E'
      ? { kind: 'RA', operation: 'D' }
      : { kind: 'PA', operation: 'C' }
  }
  return { kind: 'RA', operation: 'C' } // sale | service
}
