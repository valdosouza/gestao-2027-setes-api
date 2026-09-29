import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'

/**
 * SQL das peças B (transmissão do DPS) e C (voz do fisco) do RAMO DE SERVIÇO —
 * migration 058 (Onda 3 NFS-e, conceitos B/C do §3 do prompt). Só a composição
 * `@shared/invoice-transmission` escreve aqui; o módulo billing lê pelo
 * `listServiceTransmissions` para a tela "No fisco". Molde: a apresentação do
 * boleto (`@shared/bank-slip-registration/registration.repository.ts`).
 *
 * Quando a NF-e executar (D-E20 a), `branches/merchandise.ts` ganha o repositório
 * irmão — as colunas diferem por fato (chave nossa × chave do fisco, recibo),
 * a forma e a política não.
 */

type Q = PoolConnection | typeof pool

/**
 * S enviado · A autorizada · R rejeitada · C cancelada · K cancelamento em voo ·
 * F falha explícita · N pedido de cancelamento NÃO consta no fisco (D-N17 —
 * voz da consulta depois de um K: a NFS-e segue autorizada, o cancelamento pode
 * ser pedido de novo).
 */
import { TransmissionEventKind, FINAL_TRANSMISSION_KINDS, AUTHORIZED_KINDS } from './transmission-kinds'
export { TransmissionEventKind, FINAL_TRANSMISSION_KINDS, AUTHORIZED_KINDS }
export type TransmissionSource = 'P' | 'Q'
export type TransmissionEnvironment = 'H' | 'P'

export interface TransmissionRow {
  institutionId:  number
  invoiceId:      number
  attempt:        number
  environment:    TransmissionEnvironment
  dpsId:          string | null
  accessKey:      string | null
  nfseNumber:     string | null
  dhProc:         string | null
  createdAt:      string | null
  /** Idade da reserva em minutos, calculada NO BANCO (MEDIUM-2 do gate: nunca Date.now() contra string do MySQL). */
  ageMinutes:     number | null
  /** "NÓS olhamos o fisco" (rodízio/throttle); null = nunca. */
  lastQueriedAt:  string | null
  /** D-N27: evento E da NOTA (vida) a que esta tentativa pertence; null = anterior à migration 061 sem E localizável. */
  invoiceEvent:   number | null
  lastEvent:      number | null
  lastKind:       TransmissionEventKind | null
  lastCode:       string | null
  lastMessage:    string | null
  lastDh:         string | null
  lastEventAt:    string | null
  /** Idade do último evento em minutos, NO BANCO (D-N28: carência do K antes de virar N). */
  lastEventAgeMinutes: number | null
}

export interface TransmissionEventRow {
  attempt:       number
  event:         number
  kind:          TransmissionEventKind
  authorityCode: string | null
  message:       string | null
  dh:            string | null
  source:        TransmissionSource
  invoiceEvent:  number | null
  userId:        number | null
  createdAt:     string | null
}

const TX_SELECT = (s: string) => `
  SELECT t.tb_institution_id AS institutionId, t.tb_invoice_id AS invoiceId, t.attempt, t.environment,
         t.dps_id AS dpsId, t.access_key AS accessKey, t.nfse_number AS nfseNumber, t.invoice_event AS invoiceEvent,
         DATE_FORMAT(t.dh_proc, '%Y-%m-%d %H:%i:%s') AS dhProc,
         DATE_FORMAT(t.created_at, '%Y-%m-%d %H:%i:%s') AS createdAt,
         TIMESTAMPDIFF(MINUTE, t.created_at, NOW()) AS ageMinutes,
         DATE_FORMAT(t.last_queried_at, '%Y-%m-%d %H:%i:%s') AS lastQueriedAt,
         le.event AS lastEvent, le.kind AS lastKind, le.authority_code AS lastCode, le.message AS lastMessage,
         DATE_FORMAT(le.dh, '%Y-%m-%d %H:%i:%s') AS lastDh,
         DATE_FORMAT(le.created_at, '%Y-%m-%d %H:%i:%s') AS lastEventAt,
         TIMESTAMPDIFF(MINUTE, le.created_at, NOW()) AS lastEventAgeMinutes
    FROM \`${s}\`.tb_invoice_service_transmission t
    LEFT JOIN \`${s}\`.tb_invoice_service_transmission_event le
      ON le.tb_institution_id = t.tb_institution_id AND le.tb_invoice_id = t.tb_invoice_id
     AND le.terminal = t.terminal AND le.attempt = t.attempt AND le.deleted = 'N'
     AND le.event = (SELECT MAX(x.event) FROM \`${s}\`.tb_invoice_service_transmission_event x
                      WHERE x.tb_institution_id = t.tb_institution_id AND x.tb_invoice_id = t.tb_invoice_id
                        AND x.terminal = t.terminal AND x.attempt = t.attempt AND x.deleted = 'N')`

/**
 * D-N27 (MEDIUM-1 do socrático): a transmissão pertence a uma VIDA da nota (o evento E que a
 * emitiu). Cancelar e refaturar o MESMO id (revive, D3) abre vida nova: as tentativas da vida
 * anterior deixam de ser "desta nota" para tela, XML, DANFSe e decisores. Linhas sem
 * `invoice_event` (anteriores à 061 sem E localizável) continuam visíveis.
 */
const LIFE_WHERE = (s: string) => `
     AND (t.invoice_event IS NULL OR t.invoice_event >= COALESCE(
           (SELECT MAX(ev.event) FROM \`${s}\`.tb_invoice_event ev
             WHERE ev.tb_institution_id = t.tb_institution_id AND ev.tb_invoice_id = t.tb_invoice_id
               AND ev.terminal = t.terminal AND ev.kind = 'E' AND ev.deleted = 'N'), 0))`

function mapTx(r: any): TransmissionRow {
  return {
    institutionId: Number(r.institutionId), invoiceId: Number(r.invoiceId), attempt: Number(r.attempt),
    environment: r.environment === 'P' ? 'P' : 'H', dpsId: r.dpsId ?? null, accessKey: r.accessKey ?? null,
    nfseNumber: r.nfseNumber ?? null, dhProc: r.dhProc ?? null, createdAt: r.createdAt ?? null,
    ageMinutes: r.ageMinutes == null ? null : Number(r.ageMinutes), lastQueriedAt: r.lastQueriedAt ?? null,
    invoiceEvent: r.invoiceEvent == null ? null : Number(r.invoiceEvent),
    lastEvent: r.lastEvent == null ? null : Number(r.lastEvent), lastKind: r.lastKind ?? null,
    lastCode: r.lastCode ?? null, lastMessage: r.lastMessage ?? null, lastDh: r.lastDh ?? null,
    lastEventAt: r.lastEventAt ?? null,
    lastEventAgeMinutes: r.lastEventAgeMinutes == null ? null : Number(r.lastEventAgeMinutes),
  }
}

/** Transmissão VIGENTE = última tentativa cujo último evento NÃO é final (ou sem evento = em voo). */
export function isLiveTransmission(tx: TransmissionRow | null): boolean {
  return !!tx && !FINAL_TRANSMISSION_KINDS.has(tx.lastKind ?? '')
}

/** Ramo AUTORIZADO vigente = última tentativa cujo último evento é A ou N (D-N17). */
export function isAuthorized(tx: TransmissionRow | null): boolean {
  return !!tx && AUTHORIZED_KINDS.has(tx.lastKind ?? '')
}

/** Uma tentativa específica (a que CUNHOU o dps_id, por exemplo — MEDIUM-1). */
export async function getTransmission(
  q: Q, schemaName: string, institutionId: number, invoiceId: number, attempt: number, forUpdate = false
): Promise<TransmissionRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `${TX_SELECT(s)}
      WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = 0 AND t.attempt = ? AND t.deleted = 'N'${forUpdate ? ' FOR UPDATE' : ''}`,
    [institutionId, invoiceId, attempt]
  )
  return rows[0] ? mapTx(rows[0]) : null
}

/**
 * MEDIUM-1: a chave achada por GET /dps/{id} pertence à tentativa que CUNHOU o
 * dps_id — a mais antiga com esse Id ainda sem access_key (o nDPS é reusado em
 * toda tentativa, então o Id se repete; a NFS-e só existe uma vez). R3-1: se alguma
 * tentativa desse Id JÁ detém a chave, é ELA (idempotente — nunca a mesma chave em duas
 * linhas, UNIQUE); quem chamou e não é ela é órfã e a composição a encerra.
 */
export async function findTransmissionByDpsId(
  q: Q, schemaName: string, institutionId: number, invoiceId: number, dpsId: string
): Promise<TransmissionRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `${TX_SELECT(s)}
      WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = 0 AND t.deleted = 'N' AND t.dps_id = ?${LIFE_WHERE(s)}
      ORDER BY (t.access_key IS NOT NULL) DESC, t.attempt ASC LIMIT 1`,
    [institutionId, invoiceId, dpsId]
  )
  return rows[0] ? mapTx(rows[0]) : null
}

/**
 * A transmissão VIGENTE da nota — leitor ÚNICO de todos os decisores (plano de cancelamento,
 * gate do transmit, cancelamento no fisco, consulta, tela). D-N26 (HIGH-1 do socrático): a NFS-e
 * existe UMA vez por nota, e a chave pousa na tentativa que CUNHOU o Id (MEDIUM-1) — que pode
 * NÃO ser a última (ex.: 1 em voo → F por 404 eventual, 2 reusa o nDPS → R, consulta acha a NFS-e
 * → A na 1). A verdade fiscal é "quem DETÉM a chave" (A/N/C/K); sem chave, a última tentativa.
 * Sempre dentro da vida vigente da nota (D-N27).
 */
export async function latestTransmission(
  q: Q, schemaName: string, institutionId: number, invoiceId: number, forUpdate = false
): Promise<TransmissionRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `${TX_SELECT(s)}
      WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = 0 AND t.deleted = 'N'${LIFE_WHERE(s)}
      ORDER BY (t.access_key IS NOT NULL) DESC, t.attempt DESC LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [institutionId, invoiceId]
  )
  return rows[0] ? mapTx(rows[0]) : null
}

export async function listServiceTransmissions(
  schemaName: string, institutionId: number, invoiceId: number
): Promise<{ transmissions: TransmissionRow[]; events: TransmissionEventRow[] }> {
  const s = assertSchema(schemaName)
  const [txs] = await pool.query<any[]>(
    `${TX_SELECT(s)} WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = 0 AND t.deleted = 'N'${LIFE_WHERE(s)} ORDER BY t.attempt`,
    [institutionId, invoiceId]
  )
  // M1 (D-N27, metade dos EVENTOS): a vida da nota vale para o evento pela transmissão dele
  const [events] = await pool.query<any[]>(
    `SELECT e.attempt, e.event, e.kind, e.authority_code AS authorityCode, e.message,
            DATE_FORMAT(e.dh, '%Y-%m-%d %H:%i:%s') AS dh, e.source, e.invoice_event AS invoiceEvent,
            e.tb_user_id AS userId, DATE_FORMAT(e.created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
       FROM \`${s}\`.tb_invoice_service_transmission_event e
       JOIN \`${s}\`.tb_invoice_service_transmission t
         ON t.tb_institution_id = e.tb_institution_id AND t.tb_invoice_id = e.tb_invoice_id AND t.terminal = e.terminal AND t.attempt = e.attempt
      WHERE e.tb_institution_id = ? AND e.tb_invoice_id = ? AND e.terminal = 0 AND e.deleted = 'N' AND t.deleted = 'N'${LIFE_WHERE(s)}
      ORDER BY e.attempt, e.event`,
    [institutionId, invoiceId]
  )
  return { transmissions: txs.map(mapTx), events: events as TransmissionEventRow[] }
}

/** A vigente dentro de uma lista já lida (mesma regra do `latestTransmission`: quem detém a chave, senão a última). */
export function currentOf(transmissions: TransmissionRow[]): TransmissionRow | null {
  const keyed = [...transmissions].reverse().find(t => !!t.accessKey)
  return keyed ?? transmissions[transmissions.length - 1] ?? null
}

/** Reserva a tentativa N+1 (dps_id/access_key NULL = envio em andamento). Sob lock da nota. */
export async function insertTransmission(
  conn: PoolConnection, schemaName: string, institutionId: number, invoiceId: number,
  environment: TransmissionEnvironment, userId: number, invoiceEvent: number | null = null
): Promise<number> {
  const s = assertSchema(schemaName)
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(attempt), 0) + 1 AS next FROM \`${s}\`.tb_invoice_service_transmission
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 FOR UPDATE`,
    [institutionId, invoiceId]
  )
  const attempt = Number(mx[0].next)
  await conn.query(
    `INSERT INTO \`${s}\`.tb_invoice_service_transmission
       (tb_institution_id, tb_invoice_id, terminal, attempt, environment, invoice_event, tb_user_id, created_at, updated_at, deleted)
     VALUES (?, ?, 0, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
    [institutionId, invoiceId, attempt, environment, invoiceEvent, userId]
  )
  return attempt
}

/** O Id do DPS é NOSSO (nasce no envio) — gravado uma vez, antes de falar com o fisco. */
export async function setDpsId(
  conn: PoolConnection, schemaName: string, institutionId: number, invoiceId: number, attempt: number, dpsId: string
): Promise<void> {
  const s = assertSchema(schemaName)
  await conn.query(
    `UPDATE \`${s}\`.tb_invoice_service_transmission SET dps_id = ?, updated_at = NOW()
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND attempt = ? AND dps_id IS NULL`,
    [dpsId, institutionId, invoiceId, attempt]
  )
}

/** WRITE-ONCE (D-I6 espelhada): só preenche o que ainda é NULL — chave/número/dhProc do fisco. */
export async function fillAuthorityData(
  conn: PoolConnection, schemaName: string, institutionId: number, invoiceId: number, attempt: number,
  data: { accessKey?: string | null; nfseNumber?: string | null; dhProc?: string | null }
): Promise<void> {
  const s = assertSchema(schemaName)
  await conn.query(
    `UPDATE \`${s}\`.tb_invoice_service_transmission
        SET access_key  = COALESCE(access_key, ?),
            nfse_number = COALESCE(nfse_number, ?),
            dh_proc     = COALESCE(dh_proc, ?),
            updated_at = NOW()
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND attempt = ?`,
    [data.accessKey?.slice(0, 50) ?? null, data.nfseNumber?.slice(0, 13) ?? null, data.dhProc ?? null,
     institutionId, invoiceId, attempt]
  )
}

export interface TransmissionEventInput {
  kind:          TransmissionEventKind
  authorityCode?: string | null
  message?:      string | null
  dh?:           string | null      // 'YYYY-MM-DD HH:MM:SS'
  source:        TransmissionSource
  invoiceEvent?: number | null
}

/** Append-only; o nº do evento é MAX+1 sob o lock da nota (quem chama já travou). */
export async function insertTransmissionEvent(
  conn: PoolConnection, schemaName: string, institutionId: number, invoiceId: number, attempt: number,
  userId: number | null, e: TransmissionEventInput
): Promise<number> {
  const s = assertSchema(schemaName)
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(event), 0) + 1 AS next FROM \`${s}\`.tb_invoice_service_transmission_event
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND attempt = ? FOR UPDATE`,
    [institutionId, invoiceId, attempt]
  )
  const event = Number(mx[0].next)
  await conn.query(
    `INSERT INTO \`${s}\`.tb_invoice_service_transmission_event
       (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, message, dh, source,
        invoice_event, tb_user_id, created_at, updated_at, deleted)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
    [institutionId, invoiceId, attempt, event, e.kind, e.authorityCode?.slice(0, 10) ?? null,
     e.message ? String(e.message).slice(0, 255) : null, e.dh ?? null, e.source, e.invoiceEvent ?? null, userId]
  )
  return event
}

export async function setTransmissionEventEffect(
  conn: PoolConnection, schemaName: string, institutionId: number, invoiceId: number, attempt: number,
  event: number, invoiceEvent: number | null, message: string | null
): Promise<void> {
  const s = assertSchema(schemaName)
  await conn.query(
    `UPDATE \`${s}\`.tb_invoice_service_transmission_event
        SET invoice_event = ?, message = COALESCE(?, message), updated_at = NOW()
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND attempt = ? AND event = ?`,
    [invoiceEvent, message ? message.slice(0, 255) : null, institutionId, invoiceId, attempt, event]
  )
}

/** Já existe esta fala (kind, dh) na tentativa? Idempotência por TODOS os eventos. */
export async function hasTransmissionEvent(
  q: Q, schemaName: string, institutionId: number, invoiceId: number, attempt: number,
  kind: TransmissionEventKind, dh: string | null
): Promise<boolean> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `SELECT COUNT(*) AS n FROM \`${s}\`.tb_invoice_service_transmission_event
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND attempt = ? AND deleted = 'N'
        AND kind = ? AND ${dh === null ? 'dh IS NULL' : 'dh = ?'}`,
    dh === null ? [institutionId, invoiceId, attempt, kind] : [institutionId, invoiceId, attempt, kind, dh]
  )
  return Number(rows?.[0]?.n ?? 0) > 0
}

/** Última fala de um KIND nesta tentativa (HIGH-3a: um C por transmissão, qualquer dh). */
export async function findTransmissionEventByKind(
  q: Q, schemaName: string, institutionId: number, invoiceId: number, attempt: number,
  kind: TransmissionEventKind, forUpdate = false
): Promise<TransmissionEventRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `SELECT attempt, event, kind, authority_code AS authorityCode, message,
            DATE_FORMAT(dh, '%Y-%m-%d %H:%i:%s') AS dh, source, invoice_event AS invoiceEvent,
            tb_user_id AS userId, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
       FROM \`${s}\`.tb_invoice_service_transmission_event
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND attempt = ? AND deleted = 'N' AND kind = ?
      ORDER BY event DESC LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [institutionId, invoiceId, attempt, kind]
  )
  if (!rows[0]) return null
  const r = rows[0]
  return { ...r, attempt: Number(r.attempt), event: Number(r.event), invoiceEvent: r.invoiceEvent == null ? null : Number(r.invoiceEvent) } as TransmissionEventRow
}

/** A fala (kind, dh) desta tentativa, se existe — para saber se o EFEITO dela ficou pendente. */
export async function findTransmissionEvent(
  q: Q, schemaName: string, institutionId: number, invoiceId: number, attempt: number,
  kind: TransmissionEventKind, dh: string | null, forUpdate = false
): Promise<TransmissionEventRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `SELECT attempt, event, kind, authority_code AS authorityCode, message,
            DATE_FORMAT(dh, '%Y-%m-%d %H:%i:%s') AS dh, source, invoice_event AS invoiceEvent,
            tb_user_id AS userId, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
       FROM \`${s}\`.tb_invoice_service_transmission_event
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND attempt = ? AND deleted = 'N'
        AND kind = ? AND ${dh === null ? 'dh IS NULL' : 'dh = ?'}
      ORDER BY event DESC LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    dh === null ? [institutionId, invoiceId, attempt, kind] : [institutionId, invoiceId, attempt, kind, dh]
  )
  if (!rows[0]) return null
  const r = rows[0]
  return { ...r, attempt: Number(r.attempt), event: Number(r.event), invoiceEvent: r.invoiceEvent == null ? null : Number(r.invoiceEvent) } as TransmissionEventRow
}

/** Vozes C do fisco cujo efeito local (cancelInvoice) ficou pendente — D-I10 espelhada. */
export async function countPendingEffects(
  q: Q, schemaName: string, institutionId: number, invoiceId: number
): Promise<number> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `SELECT COUNT(*) AS n FROM \`${s}\`.tb_invoice_service_transmission_event e
       JOIN \`${s}\`.tb_invoice_service_transmission t
         ON t.tb_institution_id = e.tb_institution_id AND t.tb_invoice_id = e.tb_invoice_id AND t.terminal = e.terminal AND t.attempt = e.attempt
      WHERE e.tb_institution_id = ? AND e.tb_invoice_id = ? AND e.terminal = 0 AND e.deleted = 'N' AND t.deleted = 'N'
        AND e.kind = 'C' AND e.invoice_event IS NULL${LIFE_WHERE(s)}`,
    [institutionId, invoiceId]
  )
  return Number(rows?.[0]?.n ?? 0)
}

/** Marca "nós olhamos o fisco" (com ou sem novidade) — sustenta o rodízio da consulta. */
export async function touchQueriedAt(
  q: Q, schemaName: string, institutionId: number, invoiceId: number, attempt: number
): Promise<void> {
  const s = assertSchema(schemaName)
  await q.query(
    `UPDATE \`${s}\`.tb_invoice_service_transmission SET last_queried_at = NOW()
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND attempt = ?`,
    [institutionId, invoiceId, attempt]
  )
}

/** D-N21: vigilância das autorizadas (cancelamento feito fora de nós) e retentativa do efeito pendente. */
export const REFRESH_AUTHORIZED_HOURS = 24
export const REFRESH_PENDING_EFFECT_MINUTES = 15

/**
 * Transmissões que a consulta ativa deve olhar (throttle por `last_queried_at`,
 * as nunca consultadas primeiro — molde da Onda 2):
 *   - VIVAS (em voo / S / K): a cada `minMinutes`;
 *   - AUTORIZADAS (A/N): a cada 24 h (D-N21 — o fisco pode ter cancelado sem nós);
 *   - C com efeito local PENDENTE (invoice_event NULL): a cada 15 min (retenta o efeito).
 */
export async function listLiveTransmissionsToRefresh(
  schemaName: string, institutionId: number, minMinutes: number, limit: number,
  opts: { authorizedHours?: number; pendingMinutes?: number } = {}
): Promise<TransmissionRow[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `${TX_SELECT(s)}
      WHERE t.tb_institution_id = ? AND t.terminal = 0 AND t.deleted = 'N' AND t.dps_id IS NOT NULL${LIFE_WHERE(s)}
        AND (
          ((le.kind IS NULL OR le.kind IN ('S','K'))
             AND (t.last_queried_at IS NULL OR t.last_queried_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)))
          OR (le.kind IN ('A','N')
             AND (t.last_queried_at IS NULL OR t.last_queried_at < DATE_SUB(NOW(), INTERVAL ? HOUR)))
          OR (le.kind = 'C' AND le.invoice_event IS NULL
             AND (t.last_queried_at IS NULL OR t.last_queried_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)))
        )
      ORDER BY (t.last_queried_at IS NULL) DESC, t.last_queried_at ASC, t.tb_invoice_id ASC
      LIMIT ?`,
    [institutionId, minMinutes, opts.authorizedHours ?? REFRESH_AUTHORIZED_HOURS, opts.pendingMinutes ?? REFRESH_PENDING_EFFECT_MINUTES, limit]
  )
  return rows.map(mapTx)
}

/**
 * Notas do ramo de serviço SEM transmissão vigente/autorizada (lote "Transmitir
 * pendentes"). LOW-3: reserva em voo (sem evento) NÃO é pendente de transmissão
 * — o COALESCE trata "sem evento" como viva.
 */
export async function listPendingServiceInvoices(
  schemaName: string, institutionId: number, limit: number
): Promise<{ invoiceId: number; number: string; dtEmission: string }[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT i.id AS invoiceId, i.number, DATE_FORMAT(i.dt_emission, '%Y-%m-%d') AS dtEmission
       FROM \`${s}\`.tb_invoice i
       JOIN \`${s}\`.tb_invoice_service sv
         ON sv.id = i.id AND sv.tb_institution_id = i.tb_institution_id AND sv.terminal = i.terminal AND sv.deleted = 'N'
      WHERE i.tb_institution_id = ? AND i.terminal = 0 AND i.deleted = 'N' AND i.issuer = i.tb_institution_id
        AND NOT EXISTS (
          SELECT 1 FROM \`${s}\`.tb_invoice_service_transmission t
           WHERE t.tb_institution_id = i.tb_institution_id AND t.tb_invoice_id = i.id AND t.terminal = i.terminal AND t.deleted = 'N'${LIFE_WHERE(s)}
             AND COALESCE((SELECT le.kind FROM \`${s}\`.tb_invoice_service_transmission_event le
                   WHERE le.tb_institution_id = t.tb_institution_id AND le.tb_invoice_id = t.tb_invoice_id
                     AND le.terminal = t.terminal AND le.attempt = t.attempt AND le.deleted = 'N'
                   ORDER BY le.event DESC LIMIT 1), '-') IN ('A','N','S','K','-') )
      ORDER BY i.dt_emission, i.id
      LIMIT ?`,
    [institutionId, limit]
  )
  return rows.map(r => ({ invoiceId: Number(r.invoiceId), number: String(r.number), dtEmission: String(r.dtEmission) }))
}

/**
 * Número do DPS — D-N18 (HIGH-2 do gate): o contador vive no EMISSOR
 * (`tb_establishment_issuer.dps_last_number`, linha SE), nunca em MAX(dps_number)
 * do ramo: a nota cancelada é soft-deletada e o revive zera `dps_number`, então o
 * MAX "esquecia" números já usados no fisco. UPDATE +1 na linha (já travada FOR
 * UPDATE pelo `openIssuer` da reserva, após `lockInstitutionCounters`) e devolve
 * o novo valor. Trocar a `serie` do emissor NÃO zera o contador: a numeração é
 * contínua e o Id do DPS inclui a série — não há colisão.
 */
export async function nextDpsNumber(conn: PoolConnection, schemaName: string, institutionId: number): Promise<number> {
  const s = assertSchema(schemaName)
  const [r] = await conn.query<any>(
    `UPDATE \`${s}\`.tb_establishment_issuer SET dps_last_number = dps_last_number + 1, updated_at = NOW()
      WHERE tb_institution_id = ? AND model = 'SE' AND deleted = 'N'`,
    [institutionId]
  )
  if (!r || Number(r.affectedRows ?? 0) === 0) throw new Error('Emissor SE sem linha para cunhar o nDPS (habilitação ausente)')
  const [rows] = await conn.query<any[]>(
    `SELECT dps_last_number AS n FROM \`${s}\`.tb_establishment_issuer
      WHERE tb_institution_id = ? AND model = 'SE' AND deleted = 'N'`,
    [institutionId]
  )
  return Number(rows[0].n)
}

/** write-once do nDPS no ramo (D-N3): só quando ainda NULL. */
export async function setDpsNumber(
  conn: PoolConnection, schemaName: string, institutionId: number, invoiceId: number, dpsNumber: number
): Promise<void> {
  const s = assertSchema(schemaName)
  await conn.query(
    `UPDATE \`${s}\`.tb_invoice_service SET dps_number = ?, updated_at = NOW()
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND dps_number IS NULL`,
    [dpsNumber, invoiceId, institutionId]
  )
}
