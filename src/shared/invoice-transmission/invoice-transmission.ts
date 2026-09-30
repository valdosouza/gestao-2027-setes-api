import fs from 'fs'
import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import logger from '@shared/logger/logger'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { runIsolated } from '@shared/db/savepoint'
import { isDeadlock, isLockWaitTimeout } from '@shared/db/contention'
import { lockInstitutionCounters } from '@shared/db/counters'
import { lockInvoice, buildCancelPlan, cancelInvoice } from '@shared/invoice'
import { AuthorityHttpError, NfseQuery, parseNfseXml } from '@shared/tax-authority'
import {
  TransmissionRow, TransmissionEventRow, TransmissionEventKind, TransmissionSource, TransmissionEnvironment,
  latestTransmission, currentTransmissionsOf, getTransmission, findTransmissionByDpsId, insertTransmission, setDpsId, fillAuthorityData,
  insertTransmissionEvent, setTransmissionEventEffect, hasTransmissionEvent, findTransmissionEventByKind,
  touchQueriedAt, listServiceTransmissions, listLiveTransmissionsToRefresh, nextDpsNumber, setDpsNumber,
  isLiveTransmission, isAuthorized, countPendingEffects, currentOf,
} from './transmission.repository'
import {
  readServiceInvoice, lockDpsNumber, buildDpsBase, buildSignedDps, buildSignedCancel, buildEmitter,
  openServiceIssuer, authorityContextFor, serviceAdapter, classifyAuthorityError, OUTCOME_KIND,
  firstAuthorityCode, authorityMessage, municipalTermsCached, saveFiscalXml, findFiscalXml,
  dpsFileName, nfseFileName, cancelEventFileName, nowIsoLocal, ServiceInvoiceHeader, EMITTER_FAILURE_CODES, emitterCnpj,
} from './branches/service'

/**
 * COMPOSIÇÃO @shared/invoice-transmission — Onda 3 NFS-e (prompt_onda3_nfse_adn.md
 * §3 "Composições", D-N3/D-N7/D-N15/D-N17…D-N21; §3.9/§3.11 da NF-e: D-E6 UMA
 * composição com estratégia por RAMO). Aqui vive só a POLÍTICA de "como tratamos
 * a voz de um fisco" — o documento (DPS hoje, NF-e amanhã) é da estratégia em
 * `branches/`. Molde: `@shared/bank-slip-registration` (Onda 2).
 *
 *  A. transmitServiceInvoice        — reserva `attempt` sob lock (institution →
 *                                     nota → emissor FOR UPDATE → ramo) → fisco
 *                                     FORA da transação → A (source P) / R / F;
 *                                     AMBÍGUO nunca fecha estado (D-I21 espelhada)
 *  B. refreshServiceTransmission    — consulta o fisco (por chave, ou por dps_id
 *                                     quando ainda não há chave — inclusive em R/F,
 *                                     MEDIUM-1), grava a VOZ idempotente (A/N por
 *                                     (kind, dh); C por KIND — HIGH-3a), K sem
 *                                     cancelamento no fisco → N (D-N17)
 *  C. applyCancelEffect             — a ÚNICA porta de efeitos (C do fisco → C
 *                                     local por `cancelInvoice`, em SAVEPOINT:
 *                                     recusa de REGRA = fato + pendência — D-I10;
 *                                     transitório desfaz); nota já C = link
 *  D. cancelServiceInvoiceAtAuthority — D-N7: plano local → estado fiscal →
 *                                     pedido ao fisco → voz C → C local na MESMA
 *                                     transação; ambíguo = K em voo
 *  E. refreshOpenServiceTransmissions — consulta ativa throttled (vivas a cada N
 *                                     min, autorizadas a cada 24 h, C pendente a
 *                                     cada 15 min — D-N21; uma passada por institution)
 *
 * Regras de transação: nenhuma chamada ao fisco com lock segurado; quem cunha
 * o nDPS trava a institution PRIMEIRO (regra 7 do PADROES_BANCO §9) e o contador
 * é do emissor (D-N18); tudo que grava roda sob `lockInvoice` com `withDeadlockRetry`.
 */

/** Consulta ativa: não reconsulta transmissão viva vista há menos de N minutos. */
export const REFRESH_MIN_MINUTES = 5
export const REFRESH_MAX_PER_RUN = 8
/** Orçamento TOTAL de uma passada — é a requisição de quem abriu a tela. */
export const REFRESH_BUDGET_MS = 20_000
/** Reserva sem voz há mais de N minutos = envio interrompido (crash/timeout): pergunta ao fisco antes de nova tentativa. */
export const IN_FLIGHT_MINUTES = 10

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 255)

/** Data/hora do fisco (ISO com fuso) → 'YYYY-MM-DD HH:MM:SS' como veio (sem converter fuso — é a voz dele). */
export function toDbDateTime(v: string | null | undefined): string | null {
  if (!v) return null
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(v))
  if (!m) return null
  return `${m[1]} ${m[2] ?? '00'}:${m[3] ?? '00'}:${m[4] ?? '00'}`
}

async function withInvoiceTx<T>(
  label: string, institutionId: number, invoiceId: number, fn: (conn: PoolConnection) => Promise<T>
): Promise<T> {
  return withDeadlockRetry(label, { institutionId, invoiceId }, 3, async () => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const out = await fn(conn)
      await conn.commit()
      return out
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
  })
}

/** Recusa de REGRA nossa (HttpError 4xx) × falha transitória/de programa (tudo o mais). */
function isRuleRefusal(err: unknown): boolean {
  if (isLockWaitTimeout(err) || isDeadlock(err)) return false
  if (!(err instanceof HttpError)) return false
  if (err.code === ErrorCodes.RESOURCE_BUSY) return false
  return err.statusCode >= 400 && err.statusCode < 500
}

function assertTransmittable(header: ServiceInvoiceHeader): void {
  if (header.lastInvoiceKind == null) {
    throw new HttpError(409, `Nota ${header.invoiceId} sem evento de emissão na web (sincronizada da origem) — transmite-se na origem`,
      undefined, ErrorCodes.INVOICE_NOT_TRANSMITTABLE)
  }
  if (header.lastInvoiceKind === 'C') {
    throw new HttpError(409, `Nota ${header.number ?? header.invoiceId} cancelada — nada a transmitir`, undefined, ErrorCodes.INVOICE_NOT_TRANSMITTABLE)
  }
}

/** MEDIUM-2: idade da reserva vem do banco (`TIMESTAMPDIFF` no TX_SELECT); sem valor = não se sabe → trata como recente. */
function inFlightAgeMinutes(tx: TransmissionRow): number {
  return tx.ageMinutes ?? 0
}

/** Reservada e sem voz há mais de IN_FLIGHT_MINUTES: o envio foi interrompido (crash/timeout do POST). */
export function isInterruptedInFlight(tx: TransmissionRow | null): boolean {
  return !!tx && isLiveTransmission(tx) && tx.lastKind === null && inFlightAgeMinutes(tx) >= IN_FLIGHT_MINUTES
}

function liveTransmissionError(tx: TransmissionRow): HttpError {
  if (isAuthorized(tx)) {
    return new HttpError(409, `NFS-e ${tx.nfseNumber ?? ''} já autorizada no fisco (tentativa ${tx.attempt}, chave ${tx.accessKey ?? '?'})`,
      undefined, ErrorCodes.FISCAL_ALREADY_AUTHORIZED)
  }
  if (tx.lastKind === 'K') {
    return new HttpError(409, `Pedido de cancelamento ao fisco sem resposta (tentativa ${tx.attempt}) — consulte a NFS-e para reconciliar`,
      undefined, ErrorCodes.FISCAL_CANCEL_IN_FLIGHT)
  }
  return new HttpError(409, `Transmissão desta nota ao fisco em andamento (tentativa ${tx.attempt}) — aguarde e consulte`,
    undefined, ErrorCodes.FISCAL_TRANSMISSION_IN_PROGRESS)
}

const changedDuringTransmit = () =>
  new HttpError(409, 'Nota mudou durante a transmissão (evento ou ramo alterados) — tente de novo', undefined, ErrorCodes.RESOURCE_BUSY)

// ---------------------------------------------------------------------------
// A. Transmitir
// ---------------------------------------------------------------------------

export interface TransmitResult {
  invoiceId:  number
  attempt:    number
  dpsId:      string
  accessKey:  string | null
  nfseNumber: string | null
  kind:       TransmissionEventKind
}

export async function transmitServiceInvoice(
  schemaName: string, institutionId: number, userId: number, invoiceId: number
): Promise<TransmitResult> {
  const s = assertSchema(schemaName)
  // (a) tudo que é NOSSO e pode faltar falha ANTES de reservar e antes do fisco
  const header = await readServiceInvoice(pool, s, institutionId, invoiceId)
  assertTransmittable(header)
  // (b) habilitação + par PEM válido (409 legíveis — nunca chamada às cegas)
  const opened0 = await openServiceIssuer(s, institutionId)
  // (c) DPS montado FORA da transação; a validação do leiaute roda já aqui com um
  // nDPS provisório — dado inválido (CNPJ, IBGE, alíquota) vira 422 e nunca reserva (LOW-1)
  const base = await buildDpsBase(s, institutionId, header, opened0.issuer.environment)
  buildSignedDps(base, opened0.issuer.serie, header.branch.dpsNumber ?? 1, opened0)

  // (0b) reserva INTERROMPIDA (sem voz há mais de 10 min — HIGH-3 da Onda 2):
  // pergunta ao fisco pelo Id do DPS ANTES de decidir. Achou = A retroativo (→ 409
  // abaixo); não achou = F "sem resposta" e a nota segue para nova tentativa.
  const latest0 = await latestTransmission(pool, s, institutionId, invoiceId)
  if (latest0 && isInterruptedInFlight(latest0)) {
    await reconcileInterrupted(s, institutionId, userId, latest0, opened0)
  }

  // (d) TRANSAÇÃO 1 — reserva: institution PRIMEIRO (cunha nDPS), depois a nota,
  // o EMISSOR (FOR UPDATE — ambiente/série congelados DESTA leitura, MEDIUM-3) e o ramo
  const reserved = await withInvoiceTx('reserva da transmissão', institutionId, invoiceId, async conn => {
    await lockInstitutionCounters(conn, institutionId)
    const locked = await lockInvoice(conn, s, institutionId, invoiceId)
    // MEDIUM-3: a nota lida fora é a mesma de agora? (evento novo = cancelou/refaturou no intervalo)
    if (locked.lastEvent !== header.lastInvoiceEvent) throw changedDuringTransmit()
    const latest = await latestTransmission(conn, s, institutionId, invoiceId, true)
    // viva (em voo/S/K) OU autorizada (A/N: final para a transmissão, vigente para a nota)
    if (latest && (isLiveTransmission(latest) || isAuthorized(latest))) throw liveTransmissionError(latest)
    // M2 do socrático (Q-N33): voz C do fisco com efeito LOCAL pendente — reenviar o MESMO Id de DPS não
    // tem desfecho bom (o fisco ecoa a NFS-e cancelada → chave repetida; timeout → órfã). Resolve-se a
    // pendência (aplicar o efeito / cancelar manualmente) antes de nova apresentação.
    if (latest?.lastKind === 'C' && (await countPendingEffects(conn, s, institutionId, invoiceId)) > 0) {
      throw new HttpError(409, `NFS-e cancelada no fisco (tentativa ${latest.attempt}) com o cancelamento local ainda pendente — resolva a pendência antes de transmitir de novo`,
        [{ field: 'fiscal', message: 'Efeito pendente' }], ErrorCodes.FISCAL_EFFECT_PENDING)
    }
    const opened = await openServiceIssuer(s, institutionId, { conn, forUpdate: true })
    const branch = await lockDpsNumber(conn, s, institutionId, invoiceId)
    if ((branch.updatedAt ?? null) !== (header.branchUpdatedAt ?? null)) throw changedDuringTransmit()
    let nDps = branch.dpsNumber
    if (nDps == null) {
      // D-N3: write-once — a 1ª transmissão desta VIDA cunha (D-N18: contador do emissor); as seguintes reusam
      nDps = await nextDpsNumber(conn, s, institutionId)
      await setDpsNumber(conn, s, institutionId, invoiceId, nDps)
    }
    const attempt = await insertTransmission(conn, s, institutionId, invoiceId, opened.issuer.environment, userId, header.lastInvoiceEvent)
    const { dpsId, xml } = buildSignedDps(base, opened.issuer.serie, nDps, opened, opened.issuer.environment)
    await setDpsId(conn, s, institutionId, invoiceId, attempt, dpsId)
    return { attempt, dpsId, xml, nDps, opened }
  })
  const opened = reserved.opened
  const environment = opened.issuer.environment
  const ctx = authorityContextFor(s, institutionId, opened, environment)
  const adapter = serviceAdapter()

  // (e) o DPS assinado em disco — snapshot do que foi dito ao fisco
  try {
    saveFiscalXml(base.emitter.cnpj, dpsFileName(reserved.dpsId), reserved.xml, new Date(), environment)
  } catch (err) {
    logger.warn('DPS assinado não gravado em disco', { institutionId, invoiceId, attempt: reserved.attempt, err: errMsg(err) })
  }

  // (f) o FISCO — fora de qualquer transação
  let outcome
  try {
    outcome = await adapter.transmit(ctx, reserved.xml)
  } catch (err) {
    const cls = classifyAuthorityError(err)
    // (g') AMBÍGUO (rede/timeout/5xx/2xx ilegível/erro cru): o fisco PODE ter gerado a
    // NFS-e — a reserva fica em voo; a consulta por dps_id reconcilia (nada gravado).
    // Q-N30b: par PEM recusado LOCALMENTE (antes do socket) fecha a tentativa NA HORA com F
    // "credencial local" — o fisco comprovadamente não foi chamado; nada fica em voo
    if (cls === 'ambiguous') throw err
    const aerr = err as AuthorityHttpError
    await withInvoiceTx('voz do fisco (recusa)', institutionId, invoiceId, async conn => {
      await lockInvoice(conn, s, institutionId, invoiceId)
      await insertTransmissionEvent(conn, s, institutionId, invoiceId, reserved.attempt, userId, {
        kind: OUTCOME_KIND[cls], source: 'P', authorityCode: firstAuthorityCode(aerr), message: authorityMessage(aerr),
      })
    })
    logger.info('Fisco recusou o DPS', { institutionId, invoiceId, attempt: reserved.attempt, kind: OUTCOME_KIND[cls], code: aerr.code })
    throw err
  }

  // (g) AUTORIZADA: write-once do fisco + voz A + XML da NFS-e em disco
  const dh = toDbDateTime(outcome.dhProc)
  await withInvoiceTx('voz do fisco (autorizada)', institutionId, invoiceId, async conn => {
    await lockInvoice(conn, s, institutionId, invoiceId)
    await fillAuthorityData(conn, s, institutionId, invoiceId, reserved.attempt, {
      accessKey: outcome.accessKey, nfseNumber: outcome.nfseNumber, dhProc: dh,
    })
    if (!(await hasTransmissionEvent(conn, s, institutionId, invoiceId, reserved.attempt, 'A', dh))) {
      await insertTransmissionEvent(conn, s, institutionId, invoiceId, reserved.attempt, userId, {
        kind: 'A', source: 'P', dh, message: `NFS-e ${outcome.nfseNumber ?? ''} chave ${outcome.accessKey}`.trim(),
      })
    }
  })
  try {
    saveFiscalXml(base.emitter.cnpj, nfseFileName(outcome.accessKey), outcome.nfseXml, new Date(), environment)
  } catch (err) {
    logger.error('XML da NFS-e autorizada NÃO gravado em disco — a consulta regrava', { institutionId, invoiceId, accessKey: outcome.accessKey, err: errMsg(err) })
  }
  logger.info('NFS-e autorizada', { institutionId, invoiceId, attempt: reserved.attempt, accessKey: outcome.accessKey, nfseNumber: outcome.nfseNumber })
  return { invoiceId, attempt: reserved.attempt, dpsId: reserved.dpsId, accessKey: outcome.accessKey, nfseNumber: outcome.nfseNumber, kind: 'A' }
}

/**
 * Envio interrompido (reserva sem voz > 10 min): GET /dps/{id}. Achou → chave +
 * A (source Q, pela mesma porta da consulta); não achou → F "sem resposta"
 * (assunção registrada: o POST /nfse é síncrono — 10 min depois, ou a NFS-e
 * existe para esse Id ou nunca chegou). Fisco fora → propaga (fail-closed).
 */
async function reconcileInterrupted(
  s: string, institutionId: number, userId: number | null, tx: TransmissionRow, opened: Awaited<ReturnType<typeof openServiceIssuer>>
): Promise<void> {
  if (!tx.dpsId) return
  const ctx = authorityContextFor(s, institutionId, opened, tx.environment)
  const key = await serviceAdapter().queryDpsAccessKey(ctx, tx.dpsId)
  if (key) {
    await refreshServiceTransmission(s, institutionId, userId, tx.invoiceId, 'Q', { attempt: tx.attempt })
    return
  }
  await withInvoiceTx('reconciliação do envio interrompido', institutionId, tx.invoiceId, async conn => {
    await lockInvoice(conn, s, institutionId, tx.invoiceId)
    const cur = await latestTransmission(conn, s, institutionId, tx.invoiceId, true)
    if (!cur || cur.attempt !== tx.attempt || cur.lastKind !== null) return
    await touchQueriedAt(conn, s, institutionId, tx.invoiceId, tx.attempt)
    await insertTransmissionEvent(conn, s, institutionId, tx.invoiceId, tx.attempt, userId, {
      kind: 'F', source: 'Q', message: 'Sem resposta do fisco e nenhuma NFS-e gerada para este DPS — envio interrompido',
    })
  })
}

/**
 * Q-ADV1b (Valdo 2026-09-30): antes de um cancelamento LOCAL, a nota cuja tentativa vigente fechou
 * com F de envio INTERROMPIDO (voz por consulta, sem chave) é conferida de novo no fisco
 * (`GET /dps/{id}`): o F nasceu de uma consulta; o cancelamento local é irreversível para o número.
 * Achou a NFS-e → reconcilia (A) e o plano de cancelamento passa a exigir "Cancelar NFS-e";
 * não achou → segue; fisco fora → o erro sobe (fail-closed: não cancela no escuro).
 * Nota sem transmissão, com chave, ou com F de resposta direta (401/403, credencial local) → nada.
 */
export async function reconfirmBeforeLocalCancel(
  schemaName: string, institutionId: number, userId: number | null, invoiceId: number
): Promise<void> {
  const s = assertSchema(schemaName)
  const tx = await latestTransmission(pool, s, institutionId, invoiceId)
  if (!tx || tx.accessKey || tx.lastKind !== 'F' || tx.lastSource !== 'Q' || !tx.dpsId) return
  // gate (MEDIUM): HOMOLOGAÇÃO não prende a nota (Q-CA5b) — nem pelo cancelamento no fisco nem por esta
  // reconferência (sandbox fora não pode bloquear o cancelamento local de nota sem valor jurídico)
  if (tx.environment === 'H') return
  const opened = await openServiceIssuer(s, institutionId)
  const ctx = authorityContextFor(s, institutionId, opened, tx.environment)
  const key = await serviceAdapter().queryDpsAccessKey(ctx, tx.dpsId)
  if (!key) return
  logger.warn('NFS-e achada no fisco para DPS dado como sem resposta — reconciliando antes do cancelamento local',
    { institutionId, invoiceId, attempt: tx.attempt, dpsId: tx.dpsId })
  await refreshServiceTransmission(s, institutionId, userId, invoiceId, 'Q', { attempt: tx.attempt })
}

// ---------------------------------------------------------------------------
// B/C. Consultar e aplicar a voz do fisco
// ---------------------------------------------------------------------------

export interface RefreshResult {
  invoiceId:     number
  attempt:       number
  changed:       boolean
  kind:          TransmissionEventKind | null
  accessKey:     string | null
  /** Evento C produzido em tb_invoice_event (null = sem efeito, ou efeito recusado). */
  invoiceEvent:  number | null
  effectRefused: string | null
}

/** Último evento da NOTA mesmo com o cabeçalho soft-deletado (HIGH-3b: o C local já aconteceu). */
async function lastInvoiceEventAny(
  conn: PoolConnection, s: string, institutionId: number, invoiceId: number
): Promise<{ event: number; kind: string } | null> {
  const [rows] = await conn.query<any[]>(
    `SELECT event, kind FROM \`${s}\`.tb_invoice_event
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND deleted = 'N'
      ORDER BY event DESC LIMIT 1 FOR UPDATE`,
    [institutionId, invoiceId]
  )
  return rows[0] ? { event: Number(rows[0].event), kind: String(rows[0].kind) } : null
}

/**
 * A ÚNICA porta de efeitos: a voz C do fisco vira C local por `cancelInvoice`
 * (motivo "Cancelada no fisco: …"). Nota já cancelada aqui — cabeçalho vivo com
 * último evento C, ou cabeçalho soft-deletado (D3) cujo último evento é C
 * (HIGH-3b) — → link para esse evento (efeito JÁ aplicado, sem pendência).
 * Lança quando a NOSSA regra recusa — quem chama roda em SAVEPOINT e grava a
 * pendência.
 */
export async function applyCancelEffect(
  conn: PoolConnection, s: string, institutionId: number, userId: number, invoiceId: number, motive: string | null
): Promise<number> {
  try {
    const invoice = await lockInvoice(conn, s, institutionId, invoiceId)
    if (invoice.lastKind === 'C') return invoice.lastEvent!
  } catch (err) {
    if (!(err instanceof HttpError && err.statusCode === 404)) throw err
    const last = await lastInvoiceEventAny(conn, s, institutionId, invoiceId)
    if (last?.kind === 'C') return last.event
    throw err
  }
  const r = await cancelInvoice(conn, s, institutionId, userId, {
    orderId: invoiceId, reason: `Cancelada no fisco${motive ? ': ' + motive : ''}`.slice(0, 255),
  })
  return r.event
}

/**
 * Efeito em SAVEPOINT (D-I10 / HIGH-1 da Onda 2): recusa de REGRA → fato fica
 * com `invoice_event` NULL + "Efeito recusado: …"; contenção/erro de programa
 * → propaga (a transação inteira desfaz; a próxima consulta tenta de novo).
 */
async function applyEffectIsolated(
  conn: PoolConnection, s: string, institutionId: number, userId: number, invoiceId: number, attempt: number,
  event: number, motive: string | null
): Promise<{ invoiceEvent: number | null; refused: string | null }> {
  let refused: string | null = null
  let transient: unknown = null
  const invoiceEvent = await runIsolated(conn, 'fiscal_cancel_effect', 'Efeito da voz C do fisco', async () => {
    try { return await applyCancelEffect(conn, s, institutionId, userId, invoiceId, motive) }
    catch (e) { if (isRuleRefusal(e)) refused = errMsg(e); else transient = e; throw e }
  }, { institutionId, invoiceId, attempt, event })
  if (transient) throw transient
  await setTransmissionEventEffect(conn, s, institutionId, invoiceId, attempt, event, invoiceEvent ?? null,
    refused ? `Efeito recusado: ${refused}` : null)
  return { invoiceEvent: invoiceEvent ?? null, refused }
}

/** Sem novidade: não lança 404 se a nota já foi soft-deletada pelo C local (a transmissão fica). */
async function lockInvoiceIfAlive(conn: PoolConnection, s: string, institutionId: number, invoiceId: number): Promise<void> {
  try { await lockInvoice(conn, s, institutionId, invoiceId) }
  catch (err) { if (!(err instanceof HttpError && err.statusCode === 404)) throw err }
}

/**
 * Voz C do fisco nesta tentativa (idempotente por KIND — HIGH-3a: um C por
 * transmissão, qualquer dh) + efeito; pendência (invoice_event NULL) é retentada.
 */
async function recordCancelVoice(
  conn: PoolConnection, s: string, institutionId: number, userId: number | null, invoiceId: number, attempt: number,
  source: TransmissionSource, dh: string | null, motive: string | null
): Promise<{ event: number; invoiceEvent: number | null; refused: string | null; inserted: boolean }> {
  const existing = await findTransmissionEventByKind(conn, s, institutionId, invoiceId, attempt, 'C', true)
  if (existing && existing.invoiceEvent != null) return { event: existing.event, invoiceEvent: existing.invoiceEvent, refused: null, inserted: false }
  const event = existing ? existing.event
    : await insertTransmissionEvent(conn, s, institutionId, invoiceId, attempt, userId, {
        kind: 'C', source, dh, message: (motive ? `Cancelada no fisco: ${motive}` : 'Cancelada no fisco').slice(0, 255),
      })
  const eff = await applyEffectIsolated(conn, s, institutionId, userId ?? 0, invoiceId, attempt, event, motive)
  return { event, invoiceEvent: eff.invoiceEvent, refused: eff.refused, inserted: !existing }
}

export async function refreshServiceTransmission(
  schemaName: string, institutionId: number, userId: number | null, invoiceId: number,
  source: Exclude<TransmissionSource, 'P'> = 'Q', opts: { query?: NfseQuery; attempt?: number } = {}
): Promise<RefreshResult> {
  const s = assertSchema(schemaName)
  // R3-1: quem sabe qual tentativa quer olhar (reserva interrompida, rodízio da consulta ativa) diz — senão a
  // vigente. Sem isso a tentativa em voo que não detém a chave nunca era olhada nem encerrada (órfã).
  const tx0 = (opts.attempt != null ? await getTransmission(pool, s, institutionId, invoiceId, opts.attempt) : null)
    ?? await latestTransmission(pool, s, institutionId, invoiceId)
  if (!tx0) throw new HttpError(409, `Nota ${invoiceId} nunca foi transmitida ao fisco`, undefined, ErrorCodes.FISCAL_NOT_TRANSMITTED)
  const unchanged = (tx: TransmissionRow): RefreshResult =>
    ({ invoiceId, attempt: tx.attempt, changed: false, kind: tx.lastKind, accessKey: tx.accessKey, invoiceEvent: null, effectRefused: null })
  if (!tx0.dpsId) return unchanged(tx0)                                  // reserva sem Id: envio ainda montando
  // C já é o fim da história — salvo efeito local pendente (retenta)
  if (tx0.lastKind === 'C' && (await countPendingEffects(pool, s, institutionId, invoiceId)) === 0) return unchanged(tx0)

  // o fisco — fora da transação, no ambiente CONGELADO da tentativa
  let query = opts.query ?? null
  let target = tx0
  let accessKey = tx0.accessKey
  if (!query) {
    const opened = await openServiceIssuer(s, institutionId)
    const ctx = authorityContextFor(s, institutionId, opened, tx0.environment)
    const adapter = serviceAdapter()
    if (!accessKey) {
      // a chave é da tentativa que CUNHOU o dps_id: se alguma irmã JÁ a detém (R3-1: esta é uma órfã do
      // mesmo Id), a NFS-e é consultada por ela — sem GET /dps; senão a mais antiga sem chave
      const holder = await findTransmissionByDpsId(pool, s, institutionId, invoiceId, tx0.dpsId)
      if (holder?.accessKey) {
        accessKey = holder.accessKey
        target = holder
      } else {
        // MEDIUM-1: sem chave (em voo, R ou F) a pergunta é pelo Id do DPS — a NFS-e pode
        // existir para um envio que demos por perdido/rejeitado
        accessKey = await adapter.queryDpsAccessKey(ctx, tx0.dpsId)
        if (!accessKey) {
          // ainda não gerada (ou nunca chegou): só "nós olhamos" — F só por recusa explícita (D-I21)
          await touchQueriedAt(pool, s, institutionId, invoiceId, tx0.attempt)
          return unchanged(tx0)
        }
        target = holder ?? tx0
      }
    }
    query = await adapter.queryNfse(ctx, accessKey)
  }
  const nfse = query
  const parsed = parseNfseXml(nfse.nfseXml)
  // R2-2 (c): a NFS-e devolvida embute o DPS — tem que ser o DESTA tentativa; resposta trocada
  // (proxy/cache) nunca grava chave alheia na nota (nada gravado, nem "nós olhamos")
  if (parsed.dpsId && target.dpsId && parsed.dpsId !== target.dpsId) {
    throw new HttpError(502, `Fisco devolveu a NFS-e de OUTRO DPS (${parsed.dpsId}) para a consulta de ${target.dpsId} — nada gravado`,
      undefined, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE)
  }
  const dhA = toDbDateTime(nfse.dhProc ?? parsed.dhProc)

  const result: RefreshResult = await withInvoiceTx('voz do fisco (consulta)', institutionId, invoiceId, async (conn): Promise<RefreshResult> => {
    await lockInvoiceIfAlive(conn, s, institutionId, invoiceId)
    const tx = await getTransmission(conn, s, institutionId, invoiceId, target.attempt, true)
    if (!tx) return unchanged(target)
    await touchQueriedAt(conn, s, institutionId, invoiceId, tx.attempt)
    // R3-1: a tentativa que perguntou está em voo e a NFS-e deste Id pertence a OUTRA — ela é ÓRFÃ: encerra
    // com F (voz da consulta) para sair do rodízio; a chave fica só na tentativa que a detém (UNIQUE)
    if (tx0.attempt !== tx.attempt && tx0.lastKind === null) {
      const orphan = await getTransmission(conn, s, institutionId, invoiceId, tx0.attempt, true)
      if (orphan && orphan.lastKind === null) {
        await touchQueriedAt(conn, s, institutionId, invoiceId, orphan.attempt)
        await insertTransmissionEvent(conn, s, institutionId, invoiceId, orphan.attempt, userId, {
          kind: 'F', source, message: `A NFS-e deste DPS pertence à tentativa ${tx.attempt} (chave ${accessKey}) — envio reconciliado`,
        })
      }
    }
    if (nfse.status === 'unknown') {
      throw new HttpError(502, 'Fisco respondeu sem situação legível para a NFS-e — nada gravado; verifique o adaptador',
        undefined, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE)
    }
    // write-once do fisco (mesmo sem evento novo)
    await fillAuthorityData(conn, s, institutionId, invoiceId, tx.attempt, { accessKey: nfse.accessKey, nfseNumber: parsed.nNFSe, dhProc: dhA })
    let changed = false
    let kind: TransmissionEventKind | null = tx.lastKind
    // A: quando a tentativa ainda não a tem — inclusive depois de R/F (MEDIUM-1: a NFS-e existe); nunca depois de C
    if (!isAuthorized(tx) && tx.lastKind !== 'C' && tx.lastKind !== 'K'
        && !(await hasTransmissionEvent(conn, s, institutionId, invoiceId, tx.attempt, 'A', dhA))) {
      await insertTransmissionEvent(conn, s, institutionId, invoiceId, tx.attempt, userId, {
        kind: 'A', source, dh: dhA, message: `NFS-e ${parsed.nNFSe ?? ''} chave ${nfse.accessKey}`.trim(),
      })
      changed = true; kind = 'A'
    }
    if (nfse.status !== 'cancelled') {
      // D-N17 (HIGH-1): K sem cancelamento no fisco → N "pedido não consta" (dh = agora; um N por K).
      // D-N28 (MEDIUM-2 da 2ª rodada): só depois da CARÊNCIA — 5 s após um timeout o fisco pode
      // ainda estar processando o pedido; "ambíguo não é N" (mesma lição do "ambíguo não é F")
      if (tx.lastKind === 'K' && (tx.lastEventAgeMinutes ?? 0) >= IN_FLIGHT_MINUTES) {
        await insertTransmissionEvent(conn, s, institutionId, invoiceId, tx.attempt, userId, {
          kind: 'N', source, dh: toDbDateTime(nowIsoLocal()), message: 'Pedido de cancelamento não consta no fisco — NFS-e segue autorizada',
        })
        changed = true; kind = 'N'
      }
      return { invoiceId, attempt: tx.attempt, changed, kind, accessKey: nfse.accessKey, invoiceEvent: null, effectRefused: null }
    }
    // C do fisco: voz (por KIND) + EFEITO (única porta); pendência retentada
    const v = await recordCancelVoice(conn, s, institutionId, userId, invoiceId, tx.attempt, source,
      toDbDateTime(nfse.cancelled?.dhEvento), nfse.cancelled?.motive ?? null)
    return { invoiceId, attempt: tx.attempt, changed: changed || v.inserted || v.invoiceEvent != null, kind: 'C', accessKey: nfse.accessKey, invoiceEvent: v.invoiceEvent, effectRefused: v.refused }
  })
  // XML autorizado em disco (regrava se faltar — o transmit pode ter falhado ao gravar)
  if (nfse.nfseXml && result.accessKey) {
    try {
      const cnpj = await emitterCnpj(institutionId)
      const when = target.dhProc ? new Date(target.dhProc.replace(' ', 'T')) : new Date()
      if (!findFiscalXml(cnpj, nfseFileName(result.accessKey), [target.dhProc, target.createdAt], target.environment)) {
        saveFiscalXml(cnpj, nfseFileName(result.accessKey), nfse.nfseXml, when, target.environment)
      }
      // Q-N38: evento de cancelamento do fisco — grava se faltar (recupera o de cancelamentos antigos)
      const eventXml = nfse.cancelled?.eventXml
      if (eventXml && !findFiscalXml(cnpj, cancelEventFileName(result.accessKey), [target.dhProc, target.createdAt], target.environment)) {
        saveFiscalXml(cnpj, cancelEventFileName(result.accessKey), eventXml, when, target.environment)
      }
    } catch (err) {
      logger.warn('XML da NFS-e não gravado na consulta', { institutionId, invoiceId, err: errMsg(err) })
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// D. Cancelar no fisco — D-N7: plano local → estado fiscal → fisco → voz → C
// ---------------------------------------------------------------------------

export interface CancelAtAuthorityResult {
  invoiceId:         number
  attempt:           number | null
  /** true = o fisco cancelou a NFS-e (e101101 aceito); false = cancelamento só local (nunca autorizada) ou já cancelada dos dois lados. */
  atAuthority:       boolean
  invoiceEvent:      number | null
  transmissionEvent: number | null
  warnings:          string[]
}

export async function cancelServiceInvoiceAtAuthority(
  schemaName: string, institutionId: number, userId: number, invoiceId: number, reason: string
): Promise<CancelAtAuthorityResult> {
  const s = assertSchema(schemaName)
  const motive = String(reason ?? '').trim()
  if (!motive) {
    throw new HttpError(400, 'Motivo do cancelamento é obrigatório', [{ field: 'reason', message: 'Obrigatório' }], ErrorCodes.INVOICE_REASON_REQUIRED)
  }
  type Local = { local: { event: number; attempt: number | null; txEvent: number | null } }
  type Decision = Local | { authorized: TransmissionRow }
  // (1)+(2) plano LOCAL primeiro (FOR UPDATE): baixa/boleto/cheque/devolução bloqueiam
  // ANTES de tocar o fisco; depois o estado fiscal decide o caminho. Nunca
  // transmitida / R / F → cancela só local, nesta mesma transação.
  const decision: Decision = await withInvoiceTx('plano do cancelamento fiscal', institutionId, invoiceId, async (conn): Promise<Decision> => {
    const tx = await latestTransmission(conn, s, institutionId, invoiceId, true)
    // HIGH-3c: já cancelada dos DOIS lados (voz C + nota C) → nada a fazer; liga a pendência se houver
    if (tx?.lastKind === 'C') {
      const last = await lastInvoiceEventAny(conn, s, institutionId, invoiceId)
      if (last?.kind === 'C') {
        const voice = await findTransmissionEventByKind(conn, s, institutionId, invoiceId, tx.attempt, 'C', true)
        if (voice && voice.invoiceEvent == null) {
          await setTransmissionEventEffect(conn, s, institutionId, invoiceId, tx.attempt, voice.event, last.event, `Efeito ligado ao cancelamento já feito (evento ${last.event})`)
        }
        return { local: { event: last.event, attempt: tx.attempt, txEvent: voice?.event ?? null } }
      }
    }
    const plan = await buildCancelPlan(conn, s, institutionId, invoiceId)
    const local = plan.blocks.filter(b => b.field !== 'fiscal')
    if (local.length > 0) throw new HttpError(409, 'Cancelamento bloqueado — resolva as pendências listadas antes', local, ErrorCodes.INVOICE_CANCEL_BLOCKED)
    if (!tx || tx.lastKind === 'R' || tx.lastKind === 'F' || tx.lastKind === 'C') {
      const r = await cancelInvoice(conn, s, institutionId, userId, { orderId: invoiceId, reason: motive })
      let txEvent: number | null = null
      if (tx?.lastKind === 'C') {
        // voz C já gravada com efeito pendente: este ato é o efeito dela
        const voice = await findTransmissionEventByKind(conn, s, institutionId, invoiceId, tx.attempt, 'C', true)
        if (voice) {
          txEvent = voice.event
          await setTransmissionEventEffect(conn, s, institutionId, invoiceId, tx.attempt, voice.event, r.event, `Efeito aplicado pelo cancelamento manual (evento ${r.event})`)
        }
      }
      return { local: { event: r.event, attempt: tx?.attempt ?? null, txEvent } }
    }
    if (tx.lastKind === null || tx.lastKind === 'S') throw liveTransmissionError(tx)   // em voo
    if (tx.lastKind === 'K') throw liveTransmissionError(tx)                            // cancelamento em voo
    if (!tx.accessKey) throw new HttpError(409, `Transmissão ${tx.attempt} autorizada sem chave de acesso — consulte antes`, undefined, ErrorCodes.FISCAL_TRANSMISSION_IN_PROGRESS)
    return { authorized: tx }                                                            // A, ou N depois de K (D-N17)
  })
  if ('local' in decision) {
    return { invoiceId, attempt: decision.local.attempt, atAuthority: false, invoiceEvent: decision.local.event, transmissionEvent: decision.local.txEvent, warnings: [] }
  }
  const tx = decision.authorized

  // (3) prazo do PAM: AVISO — a recusa definitiva é a do fisco (D-N15)
  const opened = await openServiceIssuer(s, institutionId)
  const ctx = authorityContextFor(s, institutionId, opened, tx.environment)
  const adapter = serviceAdapter()
  const { identity } = await buildEmitter(s, institutionId)
  const warnings: string[] = []
  const terms = await municipalTermsCached(adapter, ctx, identity.cMunEmi)
  if (terms?.cancelDays != null && tx.dhProc) {
    const limit = new Date(tx.dhProc.replace(' ', 'T')).getTime() + terms.cancelDays * 86_400_000
    if (limit < Date.now()) warnings.push(`Prazo de cancelamento do município (${terms.cancelDays} dias após ${tx.dhProc}) já passou — o fisco pode recusar`)
  }

  // (4) pedido ao fisco — FORA de transação
  const dhEvento = nowIsoLocal()
  const signed = buildSignedCancel(tx.accessKey!, motive, dhEvento, tx.environment, identity.cnpj, opened)
  let registered
  try {
    registered = await adapter.registerEvent(ctx, tx.accessKey!, signed.xml)
  } catch (err) {
    const cls = classifyAuthorityError(err)
    if (cls === 'rejected') {
      const aerr = err as AuthorityHttpError
      throw new HttpError(409, `Fisco recusou o cancelamento: ${authorityMessage(aerr)}`, aerr.fields, ErrorCodes.FISCAL_CANCEL_REFUSED)
    }
    if (cls === 'auth_failed' || cls === 'local') throw err          // R3-2: o fisco NÃO foi chamado — nada de K
    // AMBÍGUO (rede/timeout/5xx/2xx sem o evento — ACHADO 1 do gate): o fisco PODE ter
    // cancelado — K em voo bloqueia tudo até a consulta reconciliar (N ou C)
    await withInvoiceTx('pedido de cancelamento sem resposta', institutionId, invoiceId, async conn => {
      await lockInvoice(conn, s, institutionId, invoiceId)
      const cur = await latestTransmission(conn, s, institutionId, invoiceId, true)
      if (!cur || cur.attempt !== tx.attempt || !isAuthorized(cur)) return
      await insertTransmissionEvent(conn, s, institutionId, invoiceId, tx.attempt, userId, {
        kind: 'K', source: 'P', dh: toDbDateTime(dhEvento), message: `Pedido de cancelamento enviado sem resposta (${errMsg(err)})`,
      })
    })
    throw err          // o erro sobe COMO VEIO (503/502 do transporte ou erro cru → crashlytics); o fato novo é o K
  }

  // Q-N38: o evento GERADO pelo fisco vai para o arquivo fiscal ANTES da transação local (o fato já
  // existe no fisco; falhar ao gravar só avisa — a consulta regrava depois)
  if (registered.eventXml) {
    try {
      // mesma pasta da NFS-e (mês da AUTORIZAÇÃO) — a consulta procura lá e não duplica
      saveFiscalXml(await emitterCnpj(institutionId), cancelEventFileName(tx.accessKey!), registered.eventXml,
        tx.dhProc ? new Date(tx.dhProc.replace(' ', 'T')) : new Date(), tx.environment)
    } catch (err) {
      logger.warn('XML do evento de cancelamento não gravado em disco', { institutionId, invoiceId, err: errMsg(err) })
    }
  }

  // (5) o fisco cancelou (irreversível): voz C + C local na MESMA transação; a
  // recusa local que entrou no intervalo vira pendência visível (D-I10) — a voz fica
  const dhC = toDbDateTime(registered.dhEvento ?? dhEvento)
  const out = await withInvoiceTx('voz C do fisco + cancelamento local', institutionId, invoiceId, async conn => {
    await lockInvoiceIfAlive(conn, s, institutionId, invoiceId)
    const cur = (await getTransmission(conn, s, institutionId, invoiceId, tx.attempt, true))!
    return recordCancelVoice(conn, s, institutionId, userId, invoiceId, cur.attempt, 'P', dhC, signed.xMotivo)
  })
  logger.info('NFS-e cancelada no fisco', { institutionId, invoiceId, attempt: tx.attempt, accessKey: tx.accessKey, invoiceEvent: out.invoiceEvent, refused: out.refused })
  if (out.invoiceEvent == null) {
    throw new HttpError(409, `NFS-e cancelada no fisco (irreversível), mas o cancelamento local foi recusado: ${out.refused ?? 'motivo não informado'} — pendência gravada na transmissão`,
      [{ field: 'fiscal', message: out.refused ?? 'Efeito pendente' }], ErrorCodes.FISCAL_EFFECT_PENDING)
  }
  return { invoiceId, attempt: tx.attempt, atAuthority: true, invoiceEvent: out.invoiceEvent, transmissionEvent: out.event, warnings }
}

// ---------------------------------------------------------------------------
// E. Consulta ativa (throttled, uma passada por institution)
// ---------------------------------------------------------------------------

export interface RefreshRunReport {
  checked: number; changed: number
  errors: { invoiceId: number; code: string | null; message: string }[]
  stoppedEarly: boolean
}

/** Erro do EMISSOR, não da nota (R2-3, D-N30, LOW-A): o mesmo critério do lote — a passada pára, ninguém é "olhado". */
const stopsTheRun = (err: unknown): boolean =>
  err instanceof HttpError && !!err.code && EMITTER_FAILURE_CODES.has(err.code)

/** Erro que vai se repetir na próxima corrida (4xx/502 nosso ou do fisco) — não é contenção nem indisponibilidade. */
const isPersistentRefreshFailure = (err: unknown): boolean =>
  err instanceof HttpError && !stopsTheRun(err) && err.code !== ErrorCodes.RESOURCE_BUSY
  && !isLockWaitTimeout(err) && !isDeadlock(err) && err.statusCode !== 503

const runningRefresh = new Map<string, Promise<RefreshRunReport>>()

export async function refreshOpenServiceTransmissions(
  schemaName: string, institutionId: number, userId: number | null,
  opts: { minMinutes?: number; limit?: number; budgetMs?: number } = {}
): Promise<RefreshRunReport> {
  const key = `${schemaName}:${institutionId}`
  const running = runningRefresh.get(key)
  if (running) return running                       // duas telas abertas = UMA passada
  const run = runRefresh(schemaName, institutionId, userId, opts).finally(() => { runningRefresh.delete(key) })
  runningRefresh.set(key, run)
  return run
}

async function runRefresh(
  schemaName: string, institutionId: number, userId: number | null,
  opts: { minMinutes?: number; limit?: number; budgetMs?: number }
): Promise<RefreshRunReport> {
  const deadline = Date.now() + (opts.budgetMs ?? REFRESH_BUDGET_MS)
  const report: RefreshRunReport = { checked: 0, changed: 0, errors: [], stoppedEarly: false }
  // D-N21: vivas (minMinutes), autorizadas (24 h) e C com efeito pendente (15 min) — teto de 8 por passada
  const list = await listLiveTransmissionsToRefresh(schemaName, institutionId, opts.minMinutes ?? REFRESH_MIN_MINUTES, opts.limit ?? REFRESH_MAX_PER_RUN)
  for (const tx of list) {
    if (Date.now() >= deadline) { report.stoppedEarly = true; break }
    try {
      report.checked += 1
      const r = await refreshServiceTransmission(schemaName, institutionId, userId, tx.invoiceId, 'Q', { attempt: tx.attempt })
      if (r.changed) report.changed += 1
    } catch (err) {
      report.errors.push({ invoiceId: tx.invoiceId, code: err instanceof HttpError ? err.code ?? null : null, message: errMsg(err) })
      if (stopsTheRun(err)) { report.stoppedEarly = true; break }
      // falha PERSISTENTE também conta como "tentamos olhar" — senão monopoliza o rodízio
      if (isPersistentRefreshFailure(err)) {
        try { await touchQueriedAt(pool, schemaName, institutionId, tx.invoiceId, tx.attempt) }
        catch (touchErr) { logger.warn('Consulta ativa: não marcou last_queried_at', { institutionId, invoiceId: tx.invoiceId, err: errMsg(touchErr) }) }
      }
    }
  }
  return report
}

// ---------------------------------------------------------------------------
// Leituras para a tela "No fisco" e para o DANFSe
// ---------------------------------------------------------------------------

export type ServiceFiscalState = 'none' | 'in_flight' | 'authorized' | 'rejected' | 'failed' | 'cancelled' | 'cancel_in_flight'

export interface ServiceFiscalView {
  invoiceId:       number
  state:           ServiceFiscalState
  transmissions:   TransmissionRow[]
  events:          TransmissionEventRow[]
  pendingEffects:  number
  xmlAvailable:    boolean
  danfseAvailable: boolean
}

export function fiscalStateOf(tx: TransmissionRow | null): ServiceFiscalState {
  if (!tx) return 'none'
  switch (tx.lastKind) {
    case 'A':
    case 'N': return 'authorized'              // D-N17: N = o pedido de cancelamento não consta; segue autorizada
    case 'R': return 'rejected'
    case 'F': return 'failed'
    case 'C': return 'cancelled'
    case 'K': return 'cancel_in_flight'
    default:  return 'in_flight'
  }
}

/** Resumo fiscal de uma nota para LISTAS (selo por linha): situação + ambiente + nº da NFS-e da vigente. */
export interface ServiceFiscalSummary {
  state:       ServiceFiscalState
  environment: TransmissionEnvironment | null
  nfseNumber:  string | null
}

/**
 * Situação fiscal de VÁRIAS notas numa leitura (lista de OS faturadas). Mesma vigente
 * (D-N26/D-N27) e mesmo `fiscalStateOf` da seção "No fisco" — a lista nunca diverge
 * do detalhe. Nota sem tentativa = 'none'.
 */
export async function getServiceFiscalSummaries(
  schemaName: string, institutionId: number, invoiceIds: number[]
): Promise<Map<number, ServiceFiscalSummary>> {
  const current = await currentTransmissionsOf(schemaName, institutionId, invoiceIds)
  const out = new Map<number, ServiceFiscalSummary>()
  for (const id of invoiceIds) {
    const tx = current.get(id) ?? null
    out.set(id, { state: fiscalStateOf(tx), environment: tx?.environment ?? null, nfseNumber: tx?.nfseNumber ?? null })
  }
  return out
}

export async function getServiceFiscalView(schemaName: string, institutionId: number, invoiceId: number): Promise<ServiceFiscalView> {
  const s = assertSchema(schemaName)
  const { transmissions, events } = await listServiceTransmissions(s, institutionId, invoiceId)
  const latest = currentOf(transmissions)                 // D-N26: quem detém a chave, senão a última
  const pendingEffects = events.filter(e => e.kind === 'C' && e.invoiceEvent == null).length
  let xmlAvailable = false
  const withKey = [...transmissions].reverse().find(t => t.accessKey) ?? null
  if (withKey?.accessKey) {
    try {
      xmlAvailable = !!findFiscalXml(await emitterCnpj(institutionId), nfseFileName(withKey.accessKey), [withKey.dhProc, withKey.createdAt], withKey.environment)   // L4
    } catch { xmlAvailable = false }
  }
  return { invoiceId, state: fiscalStateOf(latest), transmissions, events, pendingEffects, xmlAvailable, danfseAvailable: xmlAvailable }
}

/** XML da NFS-e autorizada (ou cancelada — o documento existiu) em disco; 404 se não há. */
export async function readNfseXml(schemaName: string, institutionId: number, invoiceId: number): Promise<{ accessKey: string; xml: string; cancelled: boolean }> {
  const s = assertSchema(schemaName)
  const tx = await latestTransmission(pool, s, institutionId, invoiceId)
  const withKey = tx?.accessKey ? tx : (await listServiceTransmissions(s, institutionId, invoiceId)).transmissions.reverse().find(t => t.accessKey) ?? null
  if (!withKey?.accessKey) {
    throw new HttpError(404, `Nota ${invoiceId} sem NFS-e autorizada no fisco`, undefined, ErrorCodes.FISCAL_NFSE_NOT_FOUND)
  }
  const file = findFiscalXml(await emitterCnpj(institutionId), nfseFileName(withKey.accessKey), [withKey.dhProc, withKey.createdAt], withKey.environment)   // L4
  if (!file) {
    throw new HttpError(404, `XML da NFS-e ${withKey.accessKey} não está em disco — consulte a nota para regravar`, undefined, ErrorCodes.FISCAL_NFSE_NOT_FOUND)
  }
  // A8: cancelada = a voz vigente de quem DETÉM a chave é C (o arquivo não sabe do cancelamento)
  return { accessKey: withKey.accessKey, xml: fs.readFileSync(file, 'utf8'), cancelled: fiscalStateOf(withKey) === 'cancelled' }
}
