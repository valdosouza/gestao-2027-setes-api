/**
 * Vocabulário dos eventos da TRANSMISSÃO (voz do fisco) — fonte ÚNICA (L5 do gate
 * socrático: a mesma lista vivia em dois repositórios; kind novo entrava num e não
 * no outro em silêncio). Sem imports: peça e composição consomem daqui.
 *
 * S enviado · A autorizada · R rejeitada · C cancelada · K cancelamento em voo ·
 * F falha explícita · N pedido de cancelamento NÃO consta no fisco (D-N17).
 *
 * CONHECIMENTO NEGATIVO (D-F102/D-F103, Valdo 2026-10-11 — texto completo em `fiscal-api/src/voice/kinds.ts`): S não tem produtor nem
 * saída (quem criar produtor de S abre os DOIS portões da D-F51 na mesma entrega); `kind` não tem CHECK de domínio (nunca gravar voz
 * por fora do código). Esta composição morre na F2a.
 */
export type TransmissionEventKind = 'S' | 'A' | 'R' | 'C' | 'K' | 'F' | 'N'

/** Transmissão ENCERRADA para a consulta ativa comum: o fisco não vai dizer mais nada útil sobre ela sozinho. */
export const FINAL_TRANSMISSION_KINDS: ReadonlySet<string> = new Set<TransmissionEventKind>(['A', 'R', 'C', 'F', 'N'])
/** Kinds que deixam a NFS-e AUTORIZADA e vigente (A, ou N depois de um K — D-N17). */
export const AUTHORIZED_KINDS: ReadonlySet<string> = new Set<TransmissionEventKind>(['A', 'N'])

/**
 * D-F71 (= Q-F78, Valdo 2026-10-10): o TIPO do evento de cancelamento do fisco é FATO na voz C (`authority_code`) —
 * texto livre não é contrato. Domínio = CHECK da migration 067 (tiposEventos_v1.01.xsd: e101101 pelo contribuinte ·
 * e105102 por SUBSTITUIÇÃO · e105104 deferido em análise fiscal · e305101 de ofício).
 */
export const CANCEL_EVENT_CODES: ReadonlySet<string> = new Set(['101101', '105102', '105104', '305101'])
/** O único cancelamento que o produto PEDE (resposta direta do POST /eventos — source P). */
export const ISSUER_CANCEL_CODE = '101101'
/** D-F64/D-F74: cancelamento por SUBSTITUIÇÃO — existe uma NFS-e substituta que o ERP não conhece; efeito só por ato humano. */
export const SUBSTITUTION_CANCEL_CODE = '105102'
/** D-F82 (= Q-F89, Valdo 2026-10-10): cancelamento DE OFÍCIO pelo fisco — sem substituta; o efeito local é do HUMANO. */
export const EX_OFFICIO_CANCEL_CODE = '305101'
/**
 * D-F82: cancelamentos cujo efeito no ERP só nasce de ato HUMANO (substituição: cancelar ou manter a nota — D-F67; de
 * ofício: cancelar a nota). Saem do rodízio (consultar de novo não muda nada). 101101 e 105104 seguem automáticos.
 */
export const HUMAN_EFFECT_CANCEL_CODES: ReadonlySet<string> = new Set([SUBSTITUTION_CANCEL_CODE, EX_OFFICIO_CANCEL_CODE])
