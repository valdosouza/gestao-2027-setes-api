/**
 * Vocabulário dos eventos da TRANSMISSÃO (voz do fisco) — fonte ÚNICA (L5 do gate
 * socrático: a mesma lista vivia em dois repositórios; kind novo entrava num e não
 * no outro em silêncio). Sem imports: peça e composição consomem daqui.
 *
 * S enviado · A autorizada · R rejeitada · C cancelada · K cancelamento em voo ·
 * F falha explícita · N pedido de cancelamento NÃO consta no fisco (D-N17).
 */
export type TransmissionEventKind = 'S' | 'A' | 'R' | 'C' | 'K' | 'F' | 'N'

/** Transmissão ENCERRADA para a consulta ativa comum: o fisco não vai dizer mais nada útil sobre ela sozinho. */
export const FINAL_TRANSMISSION_KINDS: ReadonlySet<string> = new Set<TransmissionEventKind>(['A', 'R', 'C', 'F', 'N'])
/** Kinds que deixam a NFS-e AUTORIZADA e vigente (A, ou N depois de um K — D-N17). */
export const AUTHORIZED_KINDS: ReadonlySet<string> = new Set<TransmissionEventKind>(['A', 'N'])
