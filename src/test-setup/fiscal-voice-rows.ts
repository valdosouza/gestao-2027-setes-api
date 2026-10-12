/**
 * Linhas da VIEW de tentativas da NFS-e (`fiscal_api.vw_invoice_service_transmission`) como o banco as devolve — colunas com os
 * aliases do SELECT publicado, `authority_recorded` 'S'/'N', instantes 'YYYY-MM-DD HH:MM:SS' UTC — e a MESMA linha passada pelo mapa
 * REAL da família (`mapTransmissionView` do núcleo). F2a, etapa A3 — nota (5): a suíte precisa de linha real, porque a falha FECHADA
 * dos predicados esconde erro de projeção (um campo faltando vira "não provado" calado).
 */
import { mapTransmissionView } from 'fiscal-api/reading'
import type { ServiceTransmissionView } from 'fiscal-api/reading'

export const TEST_KEY = '41069022123456780001990000000000123202610100000123'

export interface RawServiceRow {
  institutionId: number; invoiceId: number; terminal: number; attempt: number; lifeEvent: number
  environment: 'H' | 'P'; accessKey: string | null; authorityRecorded: 'S' | 'N'
  lastQueriedAt: string | null; createdAt: string | null; lastEvent: number | null; lastKind: string | null
  lastCode: string | null; lastMessage: string | null; lastSource: 'P' | 'Q' | null; lastDh: string | null; lastEventAt: string | null
  serie: string | null; dpsNumber: number | null; dpsId: string | null; nfseNumber: string | null; dhProc: string | null
  nfseNotGeneratedAt: string | null
}

/** Linha CRUA (como o driver devolve). Padrão: NFS-e AUTORIZADA em produção, tentativa 1 da vida 1 da nota 7400. */
export function rawServiceRow(over: Partial<RawServiceRow> = {}): RawServiceRow {
  return {
    institutionId: 1, invoiceId: 7400, terminal: 0, attempt: 1, lifeEvent: 1,
    environment: 'P', accessKey: TEST_KEY, authorityRecorded: 'S',
    lastQueriedAt: null, createdAt: '2026-10-10 12:00:00', lastEvent: 1, lastKind: 'A',
    lastCode: null, lastMessage: null, lastSource: 'P', lastDh: '2026-10-10 12:00:05', lastEventAt: '2026-10-10 12:00:05',
    serie: '1', dpsNumber: 10, dpsId: 'DPS410690221234567800019900001000000000000010', nfseNumber: '710', dhProc: '2026-10-10 12:00:05',
    nfseNotGeneratedAt: null,
    ...over,
  }
}

/** A mesma linha MAPEADA pela família (o que a porta `@shared/fiscal-voice` entrega). */
export function serviceView(over: Partial<RawServiceRow> = {}): ServiceTransmissionView {
  return mapTransmissionView(rawServiceRow(over))
}

/** Tentativa SEM registro (sem chave — em voo, R ou F). */
export function unrecorded(over: Partial<RawServiceRow> = {}): ServiceTransmissionView {
  return serviceView({ accessKey: null, authorityRecorded: 'N', nfseNumber: null, dhProc: null, ...over })
}
