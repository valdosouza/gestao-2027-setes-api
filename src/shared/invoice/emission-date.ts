import { todayFor } from '@shared/time-zone'

/**
 * A DATA DE EMISSÃO da nota — que é também a COMPETÊNCIA FISCAL da declaração IBS/CBS (`dCompet` — D-IB64: a data do faturamento,
 * nunca a competência do contrato) e a base dos vencimentos. DONO ÚNICO (gate socrático da IB-3, M2 → D-IB88, 2026-10-15): os dois
 * produtores do ramo de serviço (billing da venda e faturamento da OS) e a PRÉVIA (validate da venda, detalhe da OS aberta) perguntam aqui —
 * se a D-IB64 mudar (pendente com o contador), muda num lugar só e a prévia segue sendo "o que o faturamento faria". Cerca:
 * `__tests__/emission-date-fence.test.ts` (nenhum `todayFor` decide `dtEmission`/`baseDate`/`competenceDate` fora daqui).
 * Dentro de transação, a conexão dela (C1 — nunca 2ª conexão do pool); o relógio é o da operação (Q-TZ8/Q-TZ9).
 */
export function invoiceEmissionDateFor(
  schemaName: string, institutionId: number, conn?: Parameters<typeof todayFor>[2],
): Promise<string> {
  return todayFor(schemaName, institutionId, conn)
}
