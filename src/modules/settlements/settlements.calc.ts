/**
 * Funções PURAS da apuração da baixa (Fase 6.1 do 05-ORDEM-SERVICO) —
 * P5: juros/multa/desconto são VALORES INFORMADOS manualmente; cálculo
 * automático fica futuro. Aqui só a aritmética do líquido.
 */

/** Líquido do título: tag + juros + multa − desconto% sobre o tag. */
export function liquidValue(
  tagValue: number, interestValue: number, lateValue: number,
  discountAliquot: number
): number {
  const discount = round2(tagValue * discountAliquot / 100)
  return round2(tagValue + interestValue + lateValue - discount)
}

/** Saldo em aberto do título (nunca negativo). */
export function openBalance(tagValue: number, paidSum: number): number {
  return Math.max(0, round2(tagValue - paidSum))
}

/** Soma dias corridos a uma data 'YYYY-MM-DD' (DP12: venc. PA = baixa+12). */
export function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

/** Quinhão do parceiro: % sobre o valor efetivamente pago (4.3). */
export function partnerShare(paidValue: number, rate: number): number {
  return round2(paidValue * rate / 100)
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100
}
