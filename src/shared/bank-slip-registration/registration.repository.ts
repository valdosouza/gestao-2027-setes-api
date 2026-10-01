import { institutionZoneFor, withZoneWall, legacyWallBeforeCutover } from '@shared/time-zone'
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

export type RegistrationEventKind = 'S' | 'G' | 'R' | 'M' | 'A' | 'P' | 'C' | 'V' | 'F' | 'K' | 'E'
export type RegistrationSource = 'W' | 'Q' | 'P'

/**
 * Apresentação ENCERRADA: o banco não vai dizer mais nada útil sobre ela.
 * 'E' (efeito reaplicado — ato manual da D-I25/Q-I1) só nasce DEPOIS de um
 * R/C/V com efeito recusado; encerra como a voz que reaplica.
 */
export const FINAL_REGISTRATION_KINDS: ReadonlySet<string> = new Set(['R', 'C', 'V', 'F', 'E'])
/** Vozes do banco que produzem EFEITO no boleto (D-I7) — só elas podem ficar pendentes. */
export const EFFECT_KINDS: ReadonlySet<string> = new Set(['R', 'C', 'V'])
/** SQL da pendência: voz com efeito e sem `slip_event` (D-I10) — usado na lista e no detalhe. */
export const PENDING_EFFECT_WHERE = `deleted = 'N' AND kind IN ('R','C','V') AND slip_event IS NULL`

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
  /** Última vez que NÓS consultamos o banco (migration 056) — rodízio/throttle; null = nunca. */
  lastQueriedAt:  string | null
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
         DATE_FORMAT(r.last_queried_at, '%Y-%m-%d %H:%i:%s') AS lastQueriedAt,
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
    lastQueriedAt: r.lastQueriedAt ?? null,
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

/** Pendências do boleto: vozes R/C/V (qualquer tentativa) cujo efeito a nossa regra recusou e ninguém reaplicou. */
export async function countPendingEffects(
  q: Q, schemaName: string, institutionId: number, slipId: number
): Promise<number> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `SELECT COUNT(*) AS n FROM \`${s}\`.tb_bank_slip_registration_event
      WHERE tb_institution_id = ? AND tb_bank_slip_id = ? AND ${PENDING_EFFECT_WHERE}`,
    [institutionId, slipId]
  )
  return Number(rows?.[0]?.n ?? 0)
}

/** Uma tentativa específica (a reaplicação do efeito mira o evento de UMA apresentação, não a última). */
export async function getRegistration(
  q: Q, schemaName: string, institutionId: number, slipId: number, attempt: number, forUpdate = false
): Promise<RegistrationRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `${REG_SELECT(s)}
      WHERE r.tb_institution_id = ? AND r.tb_bank_slip_id = ? AND r.attempt = ? AND r.deleted = 'N'${forUpdate ? ' FOR UPDATE' : ''}`,
    [institutionId, slipId, attempt]
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
  // Q-TZ1: tela recebe os instantes na hora do ESTABELECIMENTO (banco em UTC)
  const zone = await institutionZoneFor(s, institutionId)
  const regKeys = ['createdAt', 'lastQueriedAt', 'lastDtBankStatus', 'lastEventAt'] as const
  const evKeys = ['dtBankStatus', 'createdAt'] as const
  return {
    registrations: regs.map(mapReg).map(r => withZoneWall(r, regKeys, zone)),
    events: (events as RegistrationEventRow[]).map(e => withZoneWall(e, evKeys, zone)),
  }
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
    [data.bankOurNumber?.slice(0, 11) ?? null, data.digitableLine?.slice(0, 47) ?? null, data.barcode?.slice(0, 44) ?? null,
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
 * consultadas há mais tempo primeiro (nunca consultadas na frente), e só quem
 * não foi consultado há `minMinutes` — pela marca `last_queried_at` (migration
 * 056), NÃO pelo último evento: consulta sem novidade não gera evento, e filtrar
 * pelo evento reconsultava sempre os mesmos 8 e nunca chegava ao 9º (HIGH-2 do
 * gate socrático da Onda 2). Evita bater no rate limit do sandbox (10/min).
 */
export async function listLiveRegistrationsToRefresh(
  schemaName: string, institutionId: number, minMinutes: number, limit: number
): Promise<RegistrationRow[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `${REG_SELECT(s)}
      WHERE r.tb_institution_id = ? AND r.deleted = 'N' AND r.request_code IS NOT NULL
        AND (le.kind IS NULL OR le.kind NOT IN ('R','C','V','F','E'))
        AND (r.last_queried_at IS NULL OR r.last_queried_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))
      ORDER BY (r.last_queried_at IS NULL) DESC, r.last_queried_at ASC, r.tb_bank_slip_id ASC
      LIMIT ?`,
    [institutionId, minMinutes, limit]
  )
  return rows.map(mapReg)
}

/** Já existe esta fala (kind, dt) na tentativa? Idempotência por TODOS os eventos, não só o último (A3). */
export async function hasRegistrationEvent(
  q: Q, schemaName: string, institutionId: number, slipId: number, attempt: number,
  kind: RegistrationEventKind, dtBankStatus: string | null
): Promise<boolean> {
  // Q-TZ1/Q-TZ3 (transição): a voz é gravada como INSTANTE UTC desde 2026-09-30; antes era
  // a hora de PAREDE de Brasília. A idempotência casa as DUAS formas — sem isso a mesma voz
  // já gravada antes da troca viraria um 2º evento (ex.: 2ª liquidação do mesmo boleto).
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `SELECT COUNT(*) AS n FROM \`${s}\`.tb_bank_slip_registration_event
      WHERE tb_institution_id = ? AND tb_bank_slip_id = ? AND attempt = ? AND deleted = 'N'
        AND kind = ? AND ${dtBankStatus === null ? 'dt_bank_status IS NULL' : 'dt_bank_status IN (?, ?)'}`,
    dtBankStatus === null ? [institutionId, slipId, attempt, kind]
      : [institutionId, slipId, attempt, kind, dtBankStatus, legacyWallBeforeCutover(dtBankStatus) ?? dtBankStatus]
  )
  return Number(rows?.[0]?.n ?? 0) > 0
}

/** Marca "nós olhamos o banco" (com ou sem novidade) — o fato que sustenta o rodízio. */
export async function touchQueriedAt(
  q: Q, schemaName: string, institutionId: number, slipId: number, attempt: number
): Promise<void> {
  const s = assertSchema(schemaName)
  await q.query(
    `UPDATE \`${s}\`.tb_bank_slip_registration SET last_queried_at = NOW()
      WHERE tb_institution_id = ? AND tb_bank_slip_id = ? AND attempt = ?`,
    [institutionId, slipId, attempt]
  )
}

/** Códigos do banco JÁ conhecidos por este boleto (todas as tentativas) — a reconciliação nunca os adota de novo. */
export async function listSlipRequestCodes(
  schemaName: string, institutionId: number, slipId: number
): Promise<string[]> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT request_code AS requestCode FROM \`${s}\`.tb_bank_slip_registration
      WHERE tb_institution_id = ? AND tb_bank_slip_id = ? AND request_code IS NOT NULL`,
    [institutionId, slipId]
  )
  return rows.map(r => String(r.requestCode))
}

/** Um evento da voz do banco (para a reaplicação do efeito — D-I25). Sob o lock do boleto quando forUpdate. */
export async function getRegistrationEvent(
  q: Q, schemaName: string, institutionId: number, slipId: number, attempt: number, event: number, forUpdate = false
): Promise<RegistrationEventRow | null> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `SELECT attempt, event, kind, bank_status AS bankStatus,
            DATE_FORMAT(dt_bank_status, '%Y-%m-%d %H:%i:%s') AS dtBankStatus, source,
            paid_value AS paidValue, paid_by AS paidBy, slip_event AS slipEvent, message,
            tb_user_id AS userId, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
       FROM \`${s}\`.tb_bank_slip_registration_event
      WHERE tb_institution_id = ? AND tb_bank_slip_id = ? AND attempt = ? AND event = ? AND deleted = 'N'${forUpdate ? ' FOR UPDATE' : ''}`,
    [institutionId, slipId, attempt, event]
  )
  const r = rows[0]
  if (!r) return null
  return {
    attempt: Number(r.attempt), event: Number(r.event), kind: r.kind, bankStatus: r.bankStatus ?? null,
    dtBankStatus: r.dtBankStatus ?? null, source: r.source, paidValue: r.paidValue == null ? null : Number(r.paidValue),
    paidBy: r.paidBy ?? null, slipEvent: r.slipEvent == null ? null : Number(r.slipEvent), message: r.message ?? null,
    userId: r.userId == null ? null : Number(r.userId), createdAt: r.createdAt ?? null,
  }
}

/**
 * Apresentações VIVAS (em voo ou com voz não final) dos boletos de UMA conta —
 * opcionalmente só as congeladas num ambiente. É o que prende o canal: não se
 * exclui o canal nem se muda o ambiente com cobrança viva no banco (D-I26/D-I27).
 */
export async function countLiveRegistrationsForAccount(
  q: Q, schemaName: string, institutionId: number, bankAccountId: number, environment?: ChannelEnvironment
): Promise<number> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `SELECT COUNT(*) AS n
       FROM \`${s}\`.tb_bank_slip_registration r
       INNER JOIN \`${s}\`.tb_bank_slip bs
          ON bs.id = r.tb_bank_slip_id AND bs.tb_institution_id = r.tb_institution_id AND bs.deleted = 'N'
       LEFT JOIN \`${s}\`.tb_bank_slip_registration_event le
         ON le.tb_institution_id = r.tb_institution_id AND le.tb_bank_slip_id = r.tb_bank_slip_id
        AND le.attempt = r.attempt AND le.deleted = 'N'
        AND le.event = (SELECT MAX(x.event) FROM \`${s}\`.tb_bank_slip_registration_event x
                         WHERE x.tb_institution_id = r.tb_institution_id AND x.tb_bank_slip_id = r.tb_bank_slip_id
                           AND x.attempt = r.attempt AND x.deleted = 'N')
      WHERE r.tb_institution_id = ? AND r.deleted = 'N' AND bs.tb_bank_account_id = ?
        AND (? IS NULL OR r.environment = ?)
        AND (le.kind IS NULL OR le.kind NOT IN ('R','C','V','F','E'))`,
    [institutionId, bankAccountId, environment ?? null, environment ?? null]
  )
  return Number(rows?.[0]?.n ?? 0)
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
