import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { ChannelEnvironment } from '@shared/bank-channel'

/**
 * SQL das peças B (apresentação) e C (voz do banco) — migration 055. Só a
 * composição `bank-slip-registration.ts` chama daqui; o módulo `bank-slips` lê
 * pelo `listSlipRegistrations` para a tela.
 */

type Q = PoolConnection | typeof pool

export type RegistrationEventKind = 'S' | 'G' | 'R' | 'M' | 'A' | 'P' | 'C' | 'V' | 'F' | 'K'
export type RegistrationSource = 'W' | 'Q' | 'P'

/** Apresentação ENCERRADA: o banco não vai dizer mais nada útil sobre ela. */
export const FINAL_REGISTRATION_KINDS: ReadonlySet<string> = new Set(['R', 'C', 'V', 'F'])

export interface RegistrationRow {
  institutionId:  number
  slipId:         number
  attempt:        number
  environment:    ChannelEnvironment
  requestCode:    string | null
  bankOurNumber:  string | null
  digitableLine:  string | null
  barcode:        string | null
  pixCopyPaste:   string | null
  pixTxid:        string | null
  createdAt:      string | null
  /** Último evento da apresentação (null = envio em andamento/interrompido). */
  lastEvent:      number | null
  lastKind:       RegistrationEventKind | null
  lastBankStatus: string | null
  lastDtBankStatus: string | null
  lastEventAt:    string | null
}

export interface RegistrationEventRow {
  attempt:      number
  event:        number
  kind:         RegistrationEventKind
  bankStatus:   string | null
  dtBankStatus: string | null
  source:       RegistrationSource
  paidValue:    number | null
  paidBy:       'B' | 'X' | null
  slipEvent:    number | null
  message:      string | null
  userId:       number | null
  createdAt:    string | null
}

const REG_SELECT = (s: string) => `
  SELECT r.tb_institution_id AS institutionId, r.tb_bank_slip_id AS slipId, r.attempt, r.environment,
         r.request_code AS requestCode, r.bank_our_number AS bankOurNumber, r.digitable_line AS digitableLine,
         r.barcode, r.pix_copy_paste AS pixCopyPaste, r.pix_txid AS pixTxid,
         DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i:%s') AS createdAt,
         le.event AS lastEvent, le.kind AS lastKind, le.bank_status AS lastBankStatus,
         DATE_FORMAT(le.dt_bank_status, '%Y-%m-%d %H:%i:%s') AS lastDtBankStatus,
         DATE_FORMAT(le.created_at, '%Y-%m-%d %H:%i:%s') AS lastEventAt
    FROM \`${s}\`.tb_bank_slip_registration r
    LEFT JOIN \`${s}\`.tb_bank_slip_registration_event le
      ON le.tb_institution_id = r.tb_institution_id AND le.tb_bank_slip_id = r.tb_bank_slip_id
     AND le.attempt = r.attempt AND le.deleted = 'N'
     AND le.event = (SELECT MAX(x.event) FROM \`${s}\`.tb_bank_slip_registration_event x
                      WHERE x.tb_institution_id = r.tb_institution_id AND x.tb_bank_slip_id = r.tb_bank_slip_id
                        AND x.attempt = r.attempt AND x.deleted = 'N')`

function mapReg(r: any): RegistrationRow {
  return {
    institutionId: Number(r.institutionId), slipId: Number(r.slipId), attempt: Number(r.attempt),
    environment: r.environment === 'P' ? 'P' : 'S', requestCode: r.requestCode ?? null,
    bankOurNumber: r.bankOurNumber ?? null, digitableLine: r.digitableLine ?? null, barcode: r.barcode ?? null,
    pixCopyPaste: r.pixCopyPaste ?? null, pixTxid: r.pixTxid ?? null, createdAt: r.createdAt ?? null,
    lastEvent: r.lastEvent == null ? null : Number(r.lastEvent), lastKind: r.lastKind ?? null,
    lastBankStatus: r.lastBankStatus ?? null, lastDtBankStatus: r.lastDtBankStatus ?? null,
    lastEventAt: r.lastEventAt ?? null,
  }
}

/** Apresentação vigente = última tentativa cujo último evento NÃO é final (ou sem evento = em andamento). */
export function isLive(reg: RegistrationRow | null): boolean {
  return !!reg && !FINAL_REGISTRATION_KINDS.has(reg.lastKind ?? '')
}

export async function latestRegistration(
  q: Q, schemaName: string, institutionId: number, slipId: number, forUpdate = false
): Promise<RegistrationRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `${REG_SELECT(s)}
      WHERE r.tb_institution_id = ? AND r.tb_bank_slip_id = ? AND r.deleted = 'N'
      ORDER BY r.attempt DESC LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [institutionId, slipId]
  )
  return rows[0] ? mapReg(rows[0]) : null
}

export async function listSlipRegistrations(
  schemaName: string, institutionId: number, slipId: number
): Promise<{ registrations: RegistrationRow[]; events: RegistrationEventRow[] }> {
  const s = assertSchema(schemaName)
  const [regs] = await pool.query<any[]>(
    `${REG_SELECT(s)} WHERE r.tb_institution_id = ? AND r.tb_bank_slip_id = ? AND r.deleted = 'N' ORDER BY r.attempt`,
    [institutionId, slipId]
  )
  const [events] = await pool.query<any[]>(
    `SELECT attempt, event, kind, bank_status AS bankStatus,
            DATE_FORMAT(dt_bank_status, '%Y-%m-%d %H:%i:%s') AS dtBankStatus, source,
            paid_value AS paidValue, paid_by AS paidBy, slip_event AS slipEvent, message,
            tb_user_id AS userId, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
       FROM \`${s}\`.tb_bank_slip_registration_event
      WHERE tb_institution_id = ? AND tb_bank_slip_id = ? AND deleted = 'N'
      ORDER BY attempt, event`,
    [institutionId, slipId]
  )
  return { registrations: regs.map(mapReg), events: events as RegistrationEventRow[] }
}

export async function findRegistrationByRequestCode(
  schemaName: string, institutionId: number, requestCode: string
): Promise<RegistrationRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `${REG_SELECT(s)} WHERE r.tb_institution_id = ? AND r.request_code = ? AND r.deleted = 'N' LIMIT 1`,
    [institutionId, requestCode]
  )
  return rows[0] ? mapReg(rows[0]) : null
}

/** Reserva a tentativa N+1 (request_code NULL = envio em andamento). Sob lock do boleto. */
export async function insertRegistration(
  conn: PoolConnection, schemaName: string, institutionId: number, slipId: number,
  environment: ChannelEnvironment, userId: number
): Promise<number> {
  const s = assertSchema(schemaName)
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(attempt), 0) + 1 AS next FROM \`${s}\`.tb_bank_slip_registration
      WHERE tb_institution_id = ? AND tb_bank_slip_id = ? FOR UPDATE`,
    [institutionId, slipId]
  )
  const attempt = Number(mx[0].next)
  await conn.query(
    `INSERT INTO \`${s}\`.tb_bank_slip_registration
       (tb_institution_id, tb_bank_slip_id, attempt, environment, request_code, tb_user_id, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, NULL, ?, NOW(), NOW(), 'N')`,
    [institutionId, slipId, attempt, environment, userId]
  )
  return attempt
}

export async function setRequestCode(
  conn: PoolConnection, schemaName: string, institutionId: number, slipId: number, attempt: number, requestCode: string
): Promise<void> {
  const s = assertSchema(schemaName)
  await conn.query(
    `UPDATE \`${s}\`.tb_bank_slip_registration SET request_code = ?, updated_at = NOW()
      WHERE tb_institution_id = ? AND tb_bank_slip_id = ? AND attempt = ? AND request_code IS NULL`,
    [requestCode, institutionId, slipId, attempt]
  )
}

/** WRITE-ONCE (D-I6): só preenche o que ainda é NULL — nunca reescreve. */
export async function fillBankData(
  conn: PoolConnection, schemaName: string, institutionId: number, slipId: number, attempt: number,
  data: { bankOurNumber?: string | null; digitableLine?: string | null; barcode?: string | null; pixCopyPaste?: string | null; pixTxid?: string | null }
): Promise<void> {
  const s = assertSchema(schemaName)
  await conn.query(
    `UPDATE \`${s}\`.tb_bank_slip_registration
        SET bank_our_number = COALESCE(bank_our_number, ?),
            digitable_line  = COALESCE(digitable_line, ?),
            barcode         = COALESCE(barcode, ?),
            pix_copy_paste  = COALESCE(pix_copy_paste, ?),
            pix_txid        = COALESCE(pix_txid, ?),
            updated_at = NOW()
      WHERE tb_institution_id = ? AND tb_bank_slip_id = ? AND attempt = ?`,
    [data.bankOurNumber ?? null, data.digitableLine?.slice(0, 47) ?? null, data.barcode?.slice(0, 44) ?? null,
     data.pixCopyPaste ?? null, data.pixTxid?.slice(0, 35) ?? null, institutionId, slipId, attempt]
  )
}

export interface RegistrationEventInput {
  kind:         RegistrationEventKind
  bankStatus?:  string | null
  dtBankStatus?: string | null      // 'YYYY-MM-DD HH:MM:SS'
  source:       RegistrationSource
  paidValue?:   number | null
  paidBy?:      'B' | 'X' | null
  slipEvent?:   number | null
  message?:     string | null
}

/** Append-only; o nº do evento é MAX+1 sob o lock do boleto (quem chama já travou). */
export async function insertRegistrationEvent(
  conn: PoolConnection, schemaName: string, institutionId: number, slipId: number, attempt: number,
  userId: number | null, e: RegistrationEventInput
): Promise<number> {
  const s = assertSchema(schemaName)
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(event), 0) + 1 AS next FROM \`${s}\`.tb_bank_slip_registration_event
      WHERE tb_institution_id = ? AND tb_bank_slip_id = ? AND attempt = ? FOR UPDATE`,
    [institutionId, slipId, attempt]
  )
  const event = Number(mx[0].next)
  await conn.query(
    `INSERT INTO \`${s}\`.tb_bank_slip_registration_event
       (tb_institution_id, tb_bank_slip_id, attempt, event, kind, bank_status, dt_bank_status, source,
        paid_value, paid_by, slip_event, message, tb_user_id, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
    [institutionId, slipId, attempt, event, e.kind, e.bankStatus?.slice(0, 30) ?? null, e.dtBankStatus ?? null,
     e.source, e.paidValue ?? null, e.paidBy ?? null, e.slipEvent ?? null,
     e.message ? String(e.message).slice(0, 255) : null, userId]
  )
  return event
}

export async function setRegistrationEventEffect(
  conn: PoolConnection, schemaName: string, institutionId: number, slipId: number, attempt: number,
  event: number, slipEvent: number | null, message: string | null
): Promise<void> {
  const s = assertSchema(schemaName)
  await conn.query(
    `UPDATE \`${s}\`.tb_bank_slip_registration_event
        SET slip_event = ?, message = COALESCE(?, message), updated_at = NOW()
      WHERE tb_institution_id = ? AND tb_bank_slip_id = ? AND attempt = ? AND event = ?`,
    [slipEvent, message ? message.slice(0, 255) : null, institutionId, slipId, attempt, event]
  )
}

/**
 * Apresentações VIVAS com código, para a consulta ativa (D-I9, throttle): as
 * mais antigas primeiro; `minMinutes` desde o último evento evita bater no
 * rate limit do sandbox (10/min) a cada abertura de tela.
 */
export async function listLiveRegistrationsToRefresh(
  schemaName: string, institutionId: number, minMinutes: number, limit: number
): Promise<RegistrationRow[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `${REG_SELECT(s)}
      WHERE r.tb_institution_id = ? AND r.deleted = 'N' AND r.request_code IS NOT NULL
        AND (le.kind IS NULL OR le.kind NOT IN ('R','C','V','F'))
        AND (le.created_at IS NULL OR le.created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))
      ORDER BY le.created_at ASC, r.tb_bank_slip_id ASC
      LIMIT ?`,
    [institutionId, minMinutes, limit]
  )
  return rows.map(mapReg)
}

/** Envios INTERROMPIDOS (D-I13): reservados sem código nem evento há mais de N minutos. */
export async function listInFlightRegistrations(
  schemaName: string, institutionId: number, olderThanMinutes: number, limit: number
): Promise<RegistrationRow[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `${REG_SELECT(s)}
      WHERE r.tb_institution_id = ? AND r.deleted = 'N' AND r.request_code IS NULL AND le.event IS NULL
        AND r.created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
      ORDER BY r.created_at ASC LIMIT ?`,
    [institutionId, olderThanMinutes, limit]
  )
  return rows.map(mapReg)
}
