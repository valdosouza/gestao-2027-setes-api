import { round2 } from '@shared/money'

/**
 * Funções PURAS da apuração da baixa (Fase 6.1 do 05-ORDEM-SERVICO) —
 * P5: juros/multa/desconto são VALORES INFORMADOS manualmente; cálculo
 * automático fica futuro. Aqui só a aritmética do líquido.
 */

// L4 (socrático da Rodada 6): `liquidValue` e `openBalance` viviam aqui como 2ª
// implementação da regra do desconto, sem consumidor (só testes) e sem o teto da
// D-G35 — a verdade é a peça `@shared/financial-settlement/title-balance`
// (`OPEN_BALANCE_SQL`, `settlementCeiling`). Removidas: regra que virou LEI não
// pode ter cópia parada esperando alguém importar por engano.

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

