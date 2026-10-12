import {
  currentOf, isLiveTransmission, isAuthorized, isFiscalRecord, localCancelPending, isSubstitutionCancel, reconfirmationVerdict,
  fiscalStateOf, VOICE_READINGS,
} from 'fiscal-api/reading'
import type { ServiceTransmissionView, ReadQueryable, ReconfirmReason, FiscalState } from 'fiscal-api/reading'
import { PoolConnection } from 'mysql2/promise'
import { readServiceVoiceOfLife, readServiceVoicesOfLives } from '@shared/fiscal-voice'
import { readInvoiceLives } from './invoice'

/**
 * A NOTA diante da voz do fisco — F2a, etapa A3 (`prompt_apis_fiscais_isoladas.md` §22.2/§22.6). Composição do ERP sobre os
 * PREDICADOS do núcleo (`fiscal-api/reading`) e os fatos do ERP (nota, vida, dispensa): nada decide por coluna crua da voz
 * (`accessKey`, `environment === 'H'|'P'`, `last_queried_at` — nota (8) e §22.5 item 8; cerca na suíte).
 *
 * Família: hoje só a NFS-e (`service`) está no catálogo `VOICE_READINGS`; a NF-e entra com a NE-2 e esta peça é revista com ela
 * (cerca: o catálogo com outra família quebra o teste desta peça até alguém decidir o que o plano faz com ela — nota (9)).
 */

export interface InvoiceFiscalReading {
  /** As tentativas da NFS-e na vida vigente (vazia = nunca transmitida nesta vida, ou nota sem vida — sincronizada da origem). */
  service: ServiceTransmissionView[]
  /** A vigente da vida (D-N26 — `currentOf` do núcleo: a registrada pelo fisco, senão a última). */
  current: ServiceTransmissionView | null
}

/** Famílias que esta composição conhece — qualquer outra no catálogo é revisão OBRIGATÓRIA (nota (9) da F2a). */
export const KNOWN_FAMILIES = Object.freeze(['service'] as const)

/** Lê a voz da VIDA vigente. Quem DECIDE chama depois da trava da nota (D-F121) com a vida do `lockInvoice` (D-F126). */
export async function readInvoiceFiscal(
  q: ReadQueryable, institutionId: number, invoiceId: number, lifeEvent: number | null,
): Promise<InvoiceFiscalReading> {
  if (lifeEvent == null) return { service: [], current: null }
  const service = await readServiceVoiceOfLife(q, institutionId, invoiceId, lifeEvent)
  return { service, current: currentOf(service) }
}

/** Registro FISCAL da nota (Q-CA5/D3/D4): o fisco registrou o documento EM PRODUÇÃO — fato da view (D-NE56), nunca a chave. */
export function invoiceFiscalRecord(r: InvoiceFiscalReading): boolean {
  return isFiscalRecord(r.current)
}

/**
 * A IDENTIDADE do documento registrado em produção (a chave) — lida só DEPOIS do fato do registro (F2A3-SOC-08, gate socrático da
 * A3; nota (8)): a chave é identidade, nunca a pergunta "foi registrado?" (na NF-e a chave é nossa desde a reserva). Sem registro
 * fiscal → null; registro fiscal SEM chave é linha incoerente da view e falha ALTO (nunca "não registrado" calado).
 */
export function fiscalRecordKey(cur: ServiceTransmissionView | null): string | null {
  if (!cur || !isFiscalRecord(cur)) return null
  if (!cur.accessKey) {
    throw new Error(`registro fiscal sem chave (nota ${cur.invoiceId}, tentativa ${cur.attempt}) — linha da view incoerente`)
  }
  return cur.accessKey
}

export type FiscalCancelBarrier =
  | { kind: 'none' }
  | { kind: 'authorized' | 'cancel-in-flight' | 'in-flight'; attempt: number; nfseNumber: string | null }
  | { kind: 'reconfirm'; reason: Exclude<ReconfirmReason, 'provada' | 'nao-exigida' | 'irma-viva'>; attempt: number | null }

/**
 * O que o FISCO diz sobre cancelar a nota LOCALMENTE (o bloco `fiscal` do plano — D-F29/D-F109):
 *  1. barreira pela VIGENTE (fatos do núcleo — §22.2): VIVA (em voo, S, K) bloqueia sempre; AUTORIZADA bloqueia só com REGISTRO
 *     FISCAL (produção — a de homologação não prende a nota, Q-CA5b). Nunca `isLive || isFiscalRecord` (barraria a voz C de produção,
 *     que é o caminho do efeito);
 *  2. a PROVA da reconferência (D-F29/D-F90): o VEREDITO do núcleo (D-F109) — irmã viva = em andamento; `provada`/`nao-exigida`
 *     liberam; o resto pede reconferir na nfse-api (o setes-api nunca pergunta ao fisco — D-F4).
 */
export function fiscalCancelBarrier(r: InvoiceFiscalReading): FiscalCancelBarrier {
  const cur = r.current
  if (cur && isLiveTransmission(cur)) {
    // o estado é o do núcleo (F2A3-SOC-08: nada pela letra crua — `fiscalStateOf` é o switch exaustivo do vocabulário)
    const kind = fiscalStateOf(cur) === 'cancel_in_flight' ? 'cancel-in-flight' : 'in-flight'
    return { kind, attempt: cur.attempt, nfseNumber: cur.nfseNumber }
  }
  if (cur && isAuthorized(cur) && isFiscalRecord(cur)) return { kind: 'authorized', attempt: cur.attempt, nfseNumber: cur.nfseNumber }
  const verdict = reconfirmationVerdict(r.service)
  switch (verdict.reason) {
    case 'provada':
    case 'nao-exigida':
      return { kind: 'none' }
    case 'irma-viva': {
      const live = r.service.find(t => isLiveTransmission(t))!          // o veredito só diz irmã viva se ela existe
      return { kind: 'in-flight', attempt: live.attempt, nfseNumber: live.nfseNumber }
    }
    default:
      return { kind: 'reconfirm', reason: verdict.reason, attempt: verdict.candidate?.attempt ?? null }
  }
}

/**
 * D-F114 (= Q-F120 (a)): a pendência do EFEITO no ERP é UMA classificação derivada da vigente da vida vigente × nota × dispensa:
 *  - `none`   — sem voz C vigente, nota já cancelada, ou substituição já DISPENSADA ("manter a nota" — D-F67/D-F81);
 *  - `apply`  — o app aplica o C local sozinho (= `localCancelPending` do núcleo: C comum — 101101/105104/sem código);
 *  - `decide` — SUBSTITUIÇÃO (105102) em produção sem dispensa: o humano decide manter ou cancelar (D-F64/D-F67);
 *  - `cancel` — o humano cancela a nota: DE OFÍCIO (305101 — D-F82) ou substituição em HOMOLOGAÇÃO (sem "manter" — D-F80/D-F83).
 * "Pendência" nunca sozinha (glossário): esta é a do EFEITO; a contagem por `invoice_event IS NULL` era maquete (D-F28) e saiu.
 */
export type FiscalEffect = 'none' | 'apply' | 'decide' | 'cancel'

export function fiscalEffectOf(
  current: ServiceTransmissionView | null, invoiceLastKind: string | null, waived: boolean,
): FiscalEffect {
  // voz C vigente = estado `cancelled` do núcleo (F2A3-SOC-08); `invoiceLastKind` é o evento da NOTA (fato do ERP, não voz do fisco)
  if (!current || fiscalStateOf(current) !== 'cancelled' || invoiceLastKind === 'C') return 'none'
  if (localCancelPending(current, invoiceLastKind)) return 'apply'
  if (isSubstitutionCancel(current) && isFiscalRecord(current)) return waived ? 'none' : 'decide'
  return 'cancel'
}

/** Cerca da nota (9): o catálogo de famílias desta versão da biblioteca é o que esta composição conhece. */
export function unknownFamilies(): string[] {
  return Object.keys(VOICE_READINGS).filter(f => !(KNOWN_FAMILIES as readonly string[]).includes(f))
}

/** Selo fiscal de uma linha de lista (OS): situação da NFS-e pela VIGENTE da vida vigente — o mesmo leitor do plano. */
export interface FiscalSeal {
  state:       FiscalState
  environment: 'H' | 'P' | null
  nfseNumber:  string | null
}

/**
 * Selos de VÁRIAS notas (lista paginada de OS): vidas pela `vw_invoice_life` (sem trava — leitura consultiva) e a voz em UM lote
 * pelos pares nota × vida (D-F119 — nota (9): nunca um WHERE próprio). Nota sem vida (sincronizada) ou sem tentativa → 'none'.
 */
export async function readFiscalSeals(
  q: Pick<PoolConnection, 'query'> & ReadQueryable, s: string, institutionId: number, invoiceIds: readonly number[],
): Promise<Map<number, FiscalSeal>> {
  const out = new Map<number, FiscalSeal>()
  if (!invoiceIds.length) return out
  const lives = await readInvoiceLives(q, s, institutionId, invoiceIds)
  const pairs = [...lives.values()].filter(l => l.lifeEvent != null).map(l => ({ invoiceId: l.invoiceId, lifeEvent: l.lifeEvent as number }))
  const rows = await readServiceVoicesOfLives(q, institutionId, pairs)
  const byInvoice = new Map<number, ServiceTransmissionView[]>()
  for (const r of rows) byInvoice.set(r.invoiceId, [...(byInvoice.get(r.invoiceId) ?? []), r])
  for (const id of invoiceIds) {
    const cur = currentOf(byInvoice.get(id) ?? [])
    out.set(id, { state: fiscalStateOf(cur), environment: cur?.environment ?? null, nfseNumber: cur?.nfseNumber ?? null })
  }
  return out
}
