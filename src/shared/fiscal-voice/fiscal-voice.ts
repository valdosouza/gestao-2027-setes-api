import {
  readFamilyTransmissions, readFamilyTransmissionsMany, assertFamilyViewsReadable, SERVICE_VOICE_READING, VOICE_READINGS,
  invoiceRef, WEB_TERMINAL,
} from 'fiscal-api/reading'
import type { ServiceTransmissionView, InvoiceLifeRef, ReadQueryable } from 'fiscal-api/reading'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { newCrashRef, recordCrash } from '@shared/errors/crash.repository'
import { contentionToHttpError } from '@shared/db/contention'
import logger from '@shared/logger/logger'

/**
 * PORTA DE LEITURA da voz do fisco — F2a, etapa A3 (`prompt_apis_fiscais_isoladas.md` §22.2: parecer do guardião — "a ÚNICA peça
 * nova do ERP"). O setes-api é PASSIVO (D-F4/D-F11): nunca fala com o fisco nem com as APIs fiscais; LÊ a voz ONDE ela é escrita —
 * as views publicadas no banco `fiscal_api` (D-F15) — para decidir os fatos do ERP sobre a nota (efeito do cancelamento, plano,
 * dispensa, selo). Esta pasta é o ÚNICO lugar do setes-api que lê o `fiscal_api`, e só pela superfície `fiscal-api/reading`
 * (D-NE77 — cercas no núcleo e na suíte do setes-api): leitor que JÁ MAPEIA (D-NE66 (b)), escopado pela VIDA (D-F119), sem SQL
 * próprio e sem linha crua.
 *
 * Regras de quem consome (não da porta): quem DECIDE lê DEPOIS do `FOR UPDATE` da nota (o 1º comando da transação — D-F121,
 * PADROES §11 regra 12); a vida vem do `lockInvoice` (que exige 1 linha da view de vida — D-F126) ou da `vw_invoice_life` em lote.
 * Leitura sem trava (a porta não trava o `fiscal_api`: a serialização entre serviços é a trava da NOTA no ERP — D-F27).
 * Conhecimento negativo (D-F111): ANTES da virada o `fiscal_api` tem só a RÉPLICA do ERP — esta porta só entra na árvore viva na
 * JANELA, junto do congelamento da escrita do ERP (`f2a_fiscal_passivo`, D-F110).
 */

const DB_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/

/** Banco da voz (`FISCAL_DB_NAME`, padrão `fiscal_api` — D-F7). Nunca `setes_*` (PADROES §11 regra 1). */
export function fiscalDbName(env: NodeJS.ProcessEnv = process.env): string {
  const db = String(env.FISCAL_DB_NAME ?? 'fiscal_api').trim()
  if (!DB_NAME_RE.test(db) || db.startsWith('setes_')) throw new Error(`FISCAL_DB_NAME inválido: "${db}" (banco de serviço, nunca setes_* — D-F7)`)
  return db
}

/**
 * D-F130 (= Q-F138 (b), Valdo 2026-10-13 — gates da A3, F2A3-SOC-02/ADV-03): a voz ILEGÍVEL em EXECUÇÃO (GRANT revogado, view recriada sem
 * coluna, linha que o mapa da família recusa — D-F119/D-F136 —, banco fora) é UM fato tipado: 503 `FISCAL_VOICE_UNAVAILABLE` com o `ref`
 * do ALARME (tb_crashlytics — a causa vai para o log, nunca para o usuário). Quem DECIDE (cancelar, manter a nota, plano, efeito) falha
 * FECHADO com esse código; a LISTA de OS degrada (selo `unavailable`) — o selo é informativo. Contenção (1205/1213) NÃO é voz ilegível:
 * segue crua para o retry/409 de sempre. O boot continua não subindo sem as views (D-F113).
 */
export class FiscalVoiceUnavailableError extends HttpError {
  constructor(public readonly causeMessage: string, ref: string) {
    super(503, `A situação da NFS-e no fisco está indisponível agora — nada foi alterado; tente de novo em instantes (se persistir, informe o código ${ref} ao suporte)`,
      undefined, ErrorCodes.FISCAL_VOICE_UNAVAILABLE)
    this.name = 'FiscalVoiceUnavailableError'
    this.ref = ref
  }
}

async function guarded<T>(what: string, institutionId: number, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (err) {
    if (err instanceof FiscalVoiceUnavailableError || contentionToHttpError(err)) throw err
    const ref = newCrashRef()
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`Voz do fisco ilegível (${what}) [ref ${ref}]`, { err })
    void recordCrash({
      ref, code: ErrorCodes.FISCAL_VOICE_UNAVAILABLE, statusCode: 503, origen: `API fiscal-voice ${what}`,
      institutionId, userId: 0, message, stack: err instanceof Error ? err.stack : undefined,
    })
    throw new FiscalVoiceUnavailableError(message, ref)
  }
}

/** As tentativas da NFS-e na VIDA [lifeEvent] de UMA nota (terminal da web), mapeadas pela família — em ordem de tentativa. */
export function readServiceVoiceOfLife(
  q: ReadQueryable, institutionId: number, invoiceId: number, lifeEvent: number,
): Promise<ServiceTransmissionView[]> {
  return guarded('voz da vida', institutionId, () =>
    readFamilyTransmissions(q, SERVICE_VOICE_READING, fiscalDbName(), invoiceRef(institutionId, invoiceId, WEB_TERMINAL), lifeEvent))
}

/** Lote (selo da lista de OS): as tentativas da NFS-e de VÁRIAS notas, cada uma na vida PEDIDA (pares nota × vida — D-F119). */
export function readServiceVoicesOfLives(
  q: ReadQueryable, institutionId: number, lives: readonly InvoiceLifeRef[],
): Promise<ServiceTransmissionView[]> {
  return guarded('voz em lote', institutionId, () =>
    readFamilyTransmissionsMany(q, SERVICE_VOICE_READING, fiscalDbName(), { institutionId, terminal: WEB_TERMINAL }, lives))
}

/**
 * D-F113/D-F127: conferência do BOOT — a view de tentativas de CADA família do catálogo (`VOICE_READINGS` desta versão da biblioteca)
 * responde ao SELECT publicado (com `authority_recorded` — nota (9)). Sem a view, a coluna ou o GRANT, o setes-api NÃO sobe (nunca 500
 * na 1ª leitura da lista de OS). Ordem de deploy: o serviço da família (nfse-api) ANTES do setes-api.
 */
export async function assertFiscalVoiceReadable(q: ReadQueryable): Promise<string> {
  const db = fiscalDbName()
  await assertFamilyViewsReadable(q, db)
  return `${db} — família(s) ${Object.keys(VOICE_READINGS).join(', ')}`
}
