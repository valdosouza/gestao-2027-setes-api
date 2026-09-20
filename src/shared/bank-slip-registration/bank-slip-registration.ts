import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { HttpError, FieldError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { runIsolated } from '@shared/db/savepoint'
import {
  lockSlip, stateFromLastEvent, settleBankSlip, cancelBankSlip, LockedSlip,
} from '@shared/bank-slip'
import {
  openBankChannel, OpenedChannel, ChargePayer, ChargeStatus, BankHttpError, ChannelEnvironment,
} from '@shared/bank-channel'
import { getEntityFiscalFull } from '@shared/entity'
import {
  RegistrationRow, RegistrationEventKind, RegistrationSource, isLive,
  latestRegistration, insertRegistration, setRequestCode, fillBankData,
  insertRegistrationEvent, setRegistrationEventEffect, findRegistrationByRequestCode,
  listLiveRegistrationsToRefresh, listInFlightRegistrations,
} from './registration.repository'

/**
 * COMPOSIÇÃO @shared/bank-slip-registration (Onda 2 da fase Primeiro Cliente,
 * D-I1…D-I19): bank-slip + bank-channel + settlement. Três conceitos, três
 * peças (migration 055) — e o boleto interno NÃO muda de forma: só recebe
 * EFEITOS (L/C com source 'A') produzidos aqui.
 *
 *  A. registerBankSlip     — apresenta o boleto ao banco (attempt N)
 *  B. refreshRegistration  — consulta o banco e grava a VOZ dele (idempotente)
 *  C. applyBankStatus      — a ÚNICA porta de efeitos (RECEBIDO → L; CANCELADO/
 *                            EXPIRADO → C; o resto só fato)
 *  D. cancelRegistered     — banco PRIMEIRO, fail-closed
 *  E. refreshOpen/reconcile — consulta ativa throttled + órfãos por seuNumero
 *
 * Regras de transação: a chamada ao banco fica FORA da transação (nunca um lock
 * segurado esperando o Inter); tudo que grava roda sob `lockSlip` (FOR UPDATE)
 * — dois webhooks simultâneos serializam no boleto; o efeito roda em SAVEPOINT:
 * se a nossa regra recusar a baixa, o fato do banco fica gravado com
 * `slip_event` NULL e vira pendência legível (D-I10).
 */

export const BANK_STATUS_TO_KIND: Record<string, RegistrationEventKind> = {
  EM_PROCESSAMENTO: 'S', A_RECEBER: 'G', RECEBIDO: 'R', MARCADO_RECEBIDO: 'M',
  ATRASADO: 'A', PROTESTO: 'P', CANCELADO: 'C', EXPIRADO: 'V', FALHA_EMISSAO: 'F',
}

/** Minutos que um envio pode ficar "em andamento" antes de ser tratado como interrompido. */
export const IN_FLIGHT_MINUTES = 10
/** Consulta ativa: não reconsulta apresentação vista há menos de N minutos (rate limit do sandbox: 10/min). */
export const REFRESH_MIN_MINUTES = 5
export const REFRESH_MAX_PER_RUN = 8

// ---------------------------------------------------------------------------
// Pagador — da cadeia da entidade, na hora do envio (nunca coluna)
// ---------------------------------------------------------------------------

async function slipCustomerEntityId(schemaName: string, institutionId: number, slipId: number): Promise<number | null> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT COALESCE(osl.tb_customer_id, osv.tb_customer_id, ofn.tb_entity_id) AS entityId
       FROM \`${s}\`.tb_bank_slip_title t
       LEFT JOIN \`${s}\`.tb_order_sale osl
         ON osl.id = t.tb_order_id AND osl.tb_institution_id = t.tb_institution_id AND osl.terminal = t.terminal
       LEFT JOIN \`${s}\`.tb_order_service osv
         ON osv.id = t.tb_order_id AND osv.tb_institution_id = t.tb_institution_id AND osv.terminal = t.terminal
       LEFT JOIN \`${s}\`.tb_order_financial ofn
         ON ofn.id = t.tb_order_id AND ofn.tb_institution_id = t.tb_institution_id AND ofn.terminal = t.terminal
      WHERE t.tb_institution_id = ? AND t.tb_bank_slip_id = ? AND t.deleted = 'N'
      ORDER BY t.tb_order_id, t.parcel LIMIT 1`,
    [institutionId, slipId]
  )
  return rows[0]?.entityId == null ? null : Number(rows[0].entityId)
}

/**
 * D-I17: cliente sem os dados que o banco exige → 422 com o CAMPO apontado
 * (dado cadastral se corrige no cliente, não no boleto). Nunca "registrar com
 * o que há".
 */
export async function buildPayer(schemaName: string, institutionId: number, slipId: number): Promise<ChargePayer> {
  const entityId = await slipCustomerEntityId(schemaName, institutionId, slipId)
  if (entityId == null) {
    throw new HttpError(422, 'Boleto sem cliente identificável (títulos sem pedido)', undefined, 'BANK_PAYER_INCOMPLETE')
  }
  const full = await getEntityFiscalFull(entityId)
  if (!full) throw new HttpError(422, `Cliente ${entityId} não encontrado`, undefined, 'BANK_PAYER_INCOMPLETE')
  const missing: FieldError[] = []
  const document = (full.person?.cpf ?? full.company?.cnpj ?? '').replace(/\D/g, '')
  const personType: 'F' | 'J' | null = full.person ? 'F' : full.company ? 'J' : null
  if (!personType || !document) missing.push({ field: 'payer.document', message: 'Cliente sem CPF/CNPJ' })
  const name = (full.entity.nameCompany ?? full.entity.nickTrade ?? '').trim()
  if (!name) missing.push({ field: 'payer.name', message: 'Cliente sem nome' })
  const addr = full.addresses.find(a => a.main === 'S') ?? full.addresses[0]
  if (!addr) missing.push({ field: 'payer.address', message: 'Cliente sem endereço' })
  const street = addr ? [addr.street, addr.nmbr].filter(Boolean).join(', ').trim() : ''
  if (addr && !street) missing.push({ field: 'payer.street', message: 'Endereço sem logradouro' })
  if (addr && !addr.cityName) missing.push({ field: 'payer.city', message: 'Endereço sem cidade' })
  const zip = (addr?.zipCode ?? '').replace(/\D/g, '')
  if (addr && zip.length !== 8) missing.push({ field: 'payer.zipCode', message: 'CEP inválido (8 dígitos)' })
  let uf = ''
  if (addr) {
    const [st] = await pool.query<any[]>(`SELECT abbreviation FROM setes_central.tb_state WHERE id = ?`, [addr.tbStateId])
    uf = String(st[0]?.abbreviation ?? '').toUpperCase()
    if (uf.length !== 2) missing.push({ field: 'payer.state', message: 'Endereço sem UF' })
  }
  if (missing.length) {
    throw new HttpError(422, 'Cadastro do cliente incompleto para registrar o boleto no banco — complete os dados do cliente',
      missing, 'BANK_PAYER_INCOMPLETE')
  }
  return {
    document, personType: personType!, name, street,
    neighborhood: addr!.neighborhood ?? null, city: addr!.cityName!, state: uf, zipCode: zip,
  }
}

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

/** Data/hora do banco (date ou date-time ISO) → 'YYYY-MM-DD HH:MM:SS' local do banco (sem converter fuso). */
export function toDbDateTime(v: string | null | undefined): string | null {
  if (!v) return null
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(v)
  if (!m) return null
  return `${m[1]} ${m[2] ?? '00'}:${m[3] ?? '00'}:${m[4] ?? '00'}`
}
const dateOnly = (v: string | null | undefined): string | null => v ? v.slice(0, 10) : null
const localTodayIso = () => {
  const d = new Date()
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 255)

interface SlipHeader {
  id: number; bankAccountId: number; ourNumber: string; value: number; dtExpiration: string
  aliqInterest: number | null; aliqFine: number | null; aliqDiscount: number | null; dtDiscountUntil: string | null
  instruction: string | null
}

async function readSlipHeader(schemaName: string, institutionId: number, slipId: number): Promise<SlipHeader> {
  const s = assertSchema(schemaName)
  const [rows] = await pool.query<any[]>(
    `SELECT id, tb_bank_account_id AS bankAccountId, our_number AS ourNumber, value,
            DATE_FORMAT(dt_expiration, '%Y-%m-%d') AS dtExpiration, aliq_interest AS aliqInterest,
            aliq_fine AS aliqFine, aliq_discount AS aliqDiscount,
            DATE_FORMAT(dt_discount_until, '%Y-%m-%d') AS dtDiscountUntil,
            CONVERT(instruction USING utf8mb4) AS instruction
       FROM \`${s}\`.tb_bank_slip WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [slipId, institutionId]
  )
  if (!rows[0]) throw new HttpError(404, `Boleto ${slipId} não encontrado`, undefined, 'BANK_SLIP_NOT_FOUND')
  const r = rows[0]
  return {
    id: Number(r.id), bankAccountId: Number(r.bankAccountId), ourNumber: String(r.ourNumber), value: Number(r.value),
    dtExpiration: String(r.dtExpiration), aliqInterest: r.aliqInterest == null ? null : Number(r.aliqInterest),
    aliqFine: r.aliqFine == null ? null : Number(r.aliqFine), aliqDiscount: r.aliqDiscount == null ? null : Number(r.aliqDiscount),
    dtDiscountUntil: r.dtDiscountUntil ?? null, instruction: r.instruction ?? null,
  }
}

async function withSlipTx<T>(
  label: string, institutionId: number, slipId: number,
  fn: (conn: PoolConnection) => Promise<T>
): Promise<T> {
  return withDeadlockRetry(label, { institutionId, slipId }, 3, async () => {
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

// ---------------------------------------------------------------------------
// A. Apresentar ao banco
// ---------------------------------------------------------------------------

export interface RegisterResult { slipId: number; attempt: number; requestCode: string; environment: ChannelEnvironment }

export async function registerBankSlip(
  schemaName: string, institutionId: number, userId: number, slipId: number
): Promise<RegisterResult> {
  const header = await readSlipHeader(schemaName, institutionId, slipId)
  // 0. tudo que é NOSSO e pode faltar falha ANTES de reservar e antes do banco
  const payer = await buildPayer(schemaName, institutionId, slipId)
  const opened = await openBankChannel(schemaName, institutionId, header.bankAccountId)
  if (header.ourNumber.length > 15) {
    throw new HttpError(422, `Nosso número ${header.ourNumber} excede 15 caracteres (limite do seuNumero)`,
      [{ field: 'ourNumber', message: 'Máximo 15' }], 'BANK_SLIP_REFERENCE_TOO_LONG')
  }

  // 1. RESERVA sob o lock do boleto: aberto, sem apresentação vigente
  const attempt = await withSlipTx('reserva da apresentação', institutionId, slipId, async conn => {
    const s = assertSchema(schemaName)
    const slip = await lockSlip(conn, s, institutionId, slipId)
    if (stateFromLastEvent(slip.lastKind) !== 'open') {
      throw new HttpError(409, `Boleto ${slipId} não está em aberto`, undefined, 'BANK_SLIP_NOT_OPEN')
    }
    const latest = await latestRegistration(conn, schemaName, institutionId, slipId, true)
    if (latest && isLive(latest)) {
      if (latest.lastKind === null) {
        // reservada sem evento: envio em andamento ou interrompido (crash)
        const ageMin = latest.createdAt ? (Date.now() - new Date(latest.createdAt.replace(' ', 'T')).getTime()) / 60_000 : Infinity
        if (ageMin < IN_FLIGHT_MINUTES) {
          throw new HttpError(409, 'Registro deste boleto no banco já está em andamento — aguarde e atualize',
            undefined, 'BANK_SLIP_REGISTRATION_IN_PROGRESS')
        }
        await insertRegistrationEvent(conn, schemaName, institutionId, slipId, latest.attempt, userId, {
          kind: 'F', source: 'P', message: 'Envio interrompido sem resposta do banco — reconciliar por seuNumero',
        })
      } else {
        throw new HttpError(409, `Boleto ${slipId} já está registrado no banco (tentativa ${latest.attempt}, ${latest.lastBankStatus ?? latest.lastKind})`,
          undefined, 'BANK_SLIP_ALREADY_REGISTERED')
      }
    }
    return insertRegistration(conn, schemaName, institutionId, slipId, opened.channel.environment, userId)
  })

  // 2. o BANCO — fora de qualquer transação
  let requestCode: string
  try {
    const messages = header.instruction ? header.instruction.split(/\r?\n/).filter(Boolean) : []
    const r = await opened.adapter.register(opened.ctx, {
      reference: header.ourNumber, amount: header.value, dueDate: header.dtExpiration, payer, messages,
      finePercent: header.aliqFine, interestMonthly: header.aliqInterest,
      discountPercent: header.aliqDiscount,
      discountDays: header.aliqDiscount && header.dtDiscountUntil
        ? Math.max(0, Math.round((Date.parse(header.dtExpiration) - Date.parse(header.dtDiscountUntil)) / 86_400_000)) : null,
    })
    requestCode = r.requestCode
  } catch (err) {
    // 3a. recusa/indisponibilidade: a tentativa recusada também é história (F)
    await withSlipTx('apresentação recusada', institutionId, slipId, async conn => {
      const s = assertSchema(schemaName)
      await lockSlip(conn, s, institutionId, slipId)
      await insertRegistrationEvent(conn, schemaName, institutionId, slipId, attempt, userId, {
        kind: 'F', source: 'P', message: errMsg(err),
      })
    })
    throw err
  }

  // 3b. aceite: código + evento S
  await withSlipTx('apresentação aceita', institutionId, slipId, async conn => {
    const s = assertSchema(schemaName)
    await lockSlip(conn, s, institutionId, slipId)
    await setRequestCode(conn, schemaName, institutionId, slipId, attempt, requestCode)
    await insertRegistrationEvent(conn, schemaName, institutionId, slipId, attempt, userId, {
      kind: 'S', source: 'P', bankStatus: 'EM_PROCESSAMENTO', message: `codigoSolicitacao ${requestCode}`,
    })
  })
  logger.info('Boleto apresentado ao banco', { institutionId, slipId, attempt, requestCode })
  return { slipId, attempt, requestCode, environment: opened.channel.environment }
}

// ---------------------------------------------------------------------------
// B/C. Consultar e aplicar a voz do banco
// ---------------------------------------------------------------------------

export interface RefreshResult {
  slipId: number; attempt: number; changed: boolean
  kind: RegistrationEventKind | null; bankStatus: string
  /** Evento L/C produzido no boleto (null = sem efeito ou efeito recusado). */
  slipEvent: number | null
  effectRefused: string | null
}

export function kindForBankStatus(status: string): RegistrationEventKind {
  const k = BANK_STATUS_TO_KIND[status]
  if (!k) {
    throw new HttpError(502, `Banco devolveu situação desconhecida '${status}' — contrato mudou, verificar`,
      undefined, 'BANK_STATUS_UNKNOWN')
  }
  return k
}

/**
 * A ÚNICA porta de efeitos (D-I7). Devolve o evento do boleto produzido, ou o
 * já existente quando o estado do boleto já era o que o banco disse (link), ou
 * null quando não há efeito. Lança quando a nossa regra RECUSA — quem chama
 * roda em SAVEPOINT e grava a pendência.
 */
export async function applyBankStatus(
  conn: PoolConnection, schemaName: string, institutionId: number, userId: number,
  slip: LockedSlip, reg: RegistrationRow, status: ChargeStatus, kind: RegistrationEventKind
): Promise<number | null> {
  const state = stateFromLastEvent(slip.lastKind)
  switch (kind) {
    case 'R': {
      if (state === 'settled') return slip.lastEvent           // já liquidado (link)
      if (state !== 'open') throw new HttpError(409, `Boleto ${slip.id} está ${state} — recebido no banco sem liquidar aqui`, undefined, 'BANK_SLIP_NOT_OPEN')
      const r = await settleBankSlip(conn, schemaName, institutionId, userId, {
        slipId: slip.id, paidValue: status.paidValue ?? slip.value,
        dtPayment: dateOnly(status.statusAt) ?? localTodayIso(), source: 'A',
        bankMessage: `${status.paidBy ?? 'BANCO'} ${reg.requestCode ?? ''}`.trim().slice(0, 100),
      })
      return r.event
    }
    case 'C':
    case 'V': {
      if (state === 'cancelled') return slip.lastEvent
      if (state !== 'open') throw new HttpError(409, `Boleto ${slip.id} está ${state} — banco informou ${status.status}`, undefined, 'BANK_SLIP_NOT_OPEN')
      const note = kind === 'V' ? `Expirado no banco (${status.status})` : `Cancelado no banco${status.cancelReason ? ': ' + status.cancelReason : ''}`
      return cancelBankSlip(conn, schemaName, institutionId, userId, slip.id, note, 'A')
    }
    default:
      return null                                               // S/G/M/A/P/F: só fato
  }
}

async function openForRegistration(schemaName: string, institutionId: number, bankAccountId: number, reg: RegistrationRow): Promise<OpenedChannel> {
  return openBankChannel(schemaName, institutionId, bankAccountId, { environment: reg.environment })
}

/** Consulta o banco (fora da transação) e grava a voz dele (dentro, sob o lock do boleto). */
export async function refreshRegistration(
  schemaName: string, institutionId: number, userId: number | null, slipId: number,
  source: Exclude<RegistrationSource, 'P'>, opts: { status?: ChargeStatus } = {}
): Promise<RefreshResult> {
  const header = await readSlipHeader(schemaName, institutionId, slipId)
  const reg0 = await latestRegistration(pool, schemaName, institutionId, slipId)
  if (!reg0) throw new HttpError(409, `Boleto ${slipId} nunca foi apresentado ao banco`, undefined, 'BANK_SLIP_NOT_REGISTERED')
  if (!reg0.requestCode) {
    return { slipId, attempt: reg0.attempt, changed: false, kind: reg0.lastKind, bankStatus: 'EM_ANDAMENTO', slipEvent: null, effectRefused: null }
  }
  const status = opts.status ?? await (async () => {
    const opened = await openForRegistration(schemaName, institutionId, header.bankAccountId, reg0)
    return opened.adapter.query(opened.ctx, reg0.requestCode!)
  })()
  const kind = kindForBankStatus(status.status)
  const dt = toDbDateTime(status.statusAt)

  return withSlipTx('voz do banco', institutionId, slipId, async conn => {
    const s = assertSchema(schemaName)
    const slip = await lockSlip(conn, s, institutionId, slipId)
    const reg = (await latestRegistration(conn, schemaName, institutionId, slipId, true))!
    // write-once: preenche o que chegou (mesmo sem evento novo)
    if (status.digitableLine || status.barcode || status.pixCopyPaste || status.bankOurNumber) {
      await fillBankData(conn, schemaName, institutionId, slipId, reg.attempt, {
        bankOurNumber: status.bankOurNumber, digitableLine: status.digitableLine, barcode: status.barcode,
        pixCopyPaste: status.pixCopyPaste, pixTxid: status.pixTxid,
      })
    }
    // idempotência: mesma situação e mesma data → nada a dizer
    if (reg.lastKind === kind && (reg.lastDtBankStatus ?? null) === (dt ?? null)) {
      return { slipId, attempt: reg.attempt, changed: false, kind, bankStatus: status.status, slipEvent: null, effectRefused: null }
    }
    const event = await insertRegistrationEvent(conn, schemaName, institutionId, slipId, reg.attempt, userId, {
      kind, bankStatus: status.status, dtBankStatus: dt, source,
      paidValue: status.paidValue, paidBy: status.paidBy === 'PIX' ? 'X' : status.paidBy === 'BOLETO' ? 'B' : null,
    })
    let refused: string | null = null
    const slipEvent = await runIsolated(conn, 'bank_status_effect', 'Efeito da voz do banco',
      async () => {
        try { return await applyBankStatus(conn, schemaName, institutionId, userId ?? 0, slip, reg, status, kind) }
        catch (e) { refused = errMsg(e); throw e }
      }, { institutionId, slipId, attempt: reg.attempt, status: status.status })
    if (slipEvent != null || refused) {
      await setRegistrationEventEffect(conn, schemaName, institutionId, slipId, reg.attempt, event,
        slipEvent ?? null, refused ? `Efeito recusado: ${refused}` : null)
    }
    return { slipId, attempt: reg.attempt, changed: true, kind, bankStatus: status.status, slipEvent: slipEvent ?? null, effectRefused: refused }
  })
}

// ---------------------------------------------------------------------------
// D. Cancelar — banco primeiro, fail-closed (D-I8)
// ---------------------------------------------------------------------------

export interface CancelRegisteredResult { slipEvent: number; bankNotified: boolean; attempt: number | null }

export async function cancelRegisteredBankSlip(
  schemaName: string, institutionId: number, userId: number, slipId: number, note: string | null
): Promise<CancelRegisteredResult> {
  const header = await readSlipHeader(schemaName, institutionId, slipId)
  const reg = await latestRegistration(pool, schemaName, institutionId, slipId)
  const live = reg && isLive(reg) && reg.requestCode ? reg : null
  if (live) {
    const opened = await openForRegistration(schemaName, institutionId, header.bankAccountId, live)
    // 202 = pedido ACEITO; a confirmação (CANCELADO) chega pela consulta. Falhou/indisponível → nada muda aqui.
    await opened.adapter.cancel(opened.ctx, live.requestCode!, (note ?? 'Cancelado pelo emissor').slice(0, 50))
  }
  return withSlipTx('cancelamento do boleto registrado', institutionId, slipId, async conn => {
    const slipEvent = await cancelBankSlip(conn, schemaName, institutionId, userId, slipId, note ?? null, 'M')
    if (live) {
      await insertRegistrationEvent(conn, schemaName, institutionId, slipId, live.attempt, userId, {
        kind: 'K', source: 'P', slipEvent, message: `Cancelamento solicitado ao banco${note ? ': ' + note : ''}`,
      })
    }
    return { slipEvent, bankNotified: !!live, attempt: live?.attempt ?? null }
  })
}

// ---------------------------------------------------------------------------
// E. Consulta ativa (throttled) + reconciliação de órfãos
// ---------------------------------------------------------------------------

export interface RefreshRunReport {
  checked: number; changed: number; reconciled: number
  errors: { slipId: number; code: string | null; message: string }[]
  stoppedEarly: boolean
}

export async function refreshOpenRegistrations(
  schemaName: string, institutionId: number, userId: number | null,
  opts: { minMinutes?: number; limit?: number } = {}
): Promise<RefreshRunReport> {
  const report: RefreshRunReport = { checked: 0, changed: 0, reconciled: 0, errors: [], stoppedEarly: false }
  report.reconciled = await reconcileInFlightRegistrations(schemaName, institutionId, userId, report)
  const list = await listLiveRegistrationsToRefresh(schemaName, institutionId, opts.minMinutes ?? REFRESH_MIN_MINUTES, opts.limit ?? REFRESH_MAX_PER_RUN)
  for (const reg of list) {
    try {
      report.checked += 1
      const r = await refreshRegistration(schemaName, institutionId, userId, reg.slipId, 'Q')
      if (r.changed) report.changed += 1
    } catch (err) {
      const code = err instanceof HttpError ? err.code ?? null : null
      report.errors.push({ slipId: reg.slipId, code, message: errMsg(err) })
      // banco fora/limite: insistir nas outras só piora (D-I8 fail-closed; rate limit 10/min)
      if (err instanceof BankHttpError && (err.code === 'BANK_UNAVAILABLE' || err.code === 'BANK_RATE_LIMITED')) {
        report.stoppedEarly = true; break
      }
    }
  }
  return report
}

/** D-I13: envio interrompido → procura no banco por seuNumero; achou = apresentação retroativa; não achou = F. */
export async function reconcileInFlightRegistrations(
  schemaName: string, institutionId: number, userId: number | null, report?: RefreshRunReport
): Promise<number> {
  const stuck = await listInFlightRegistrations(schemaName, institutionId, IN_FLIGHT_MINUTES, 10)
  let reconciled = 0
  for (const reg of stuck) {
    try {
      const header = await readSlipHeader(schemaName, institutionId, reg.slipId)
      const opened = await openForRegistration(schemaName, institutionId, header.bankAccountId, reg)
      const from = (reg.createdAt ?? localTodayIso()).slice(0, 10)
      const found = await opened.adapter.findByReference(opened.ctx, header.ourNumber, from, localTodayIso())
      const match = found.find(f => !!f.requestCode)
      await withSlipTx('reconciliação de órfão', institutionId, reg.slipId, async conn => {
        const s = assertSchema(schemaName)
        await lockSlip(conn, s, institutionId, reg.slipId)
        if (match) {
          await setRequestCode(conn, schemaName, institutionId, reg.slipId, reg.attempt, match.requestCode)
          await insertRegistrationEvent(conn, schemaName, institutionId, reg.slipId, reg.attempt, userId, {
            kind: 'S', source: 'Q', bankStatus: 'EM_PROCESSAMENTO', message: `Reconciliado por seuNumero: ${match.requestCode}`,
          })
        } else {
          await insertRegistrationEvent(conn, schemaName, institutionId, reg.slipId, reg.attempt, userId, {
            kind: 'F', source: 'Q', message: 'Sem resposta do banco e nenhuma cobrança com este seuNumero — envio interrompido',
          })
        }
      })
      if (match) { reconciled += 1; await refreshRegistration(schemaName, institutionId, userId, reg.slipId, 'Q', { status: match }) }
    } catch (err) {
      report?.errors.push({ slipId: reg.slipId, code: err instanceof HttpError ? err.code ?? null : null, message: errMsg(err) })
    }
  }
  return reconciled
}

// ---------------------------------------------------------------------------
// Webhook (D-I9/D-I15): gatilho, nunca verdade
// ---------------------------------------------------------------------------

export interface WebhookRunReport { received: number; matched: number; changed: number; unknown: string[] }

/** Cada item do callback só identifica a apresentação; o estado vem da CONSULTA. */
export async function handleWebhookItems(
  schemaName: string, institutionId: number, requestCodes: string[]
): Promise<WebhookRunReport> {
  const report: WebhookRunReport = { received: requestCodes.length, matched: 0, changed: 0, unknown: [] }
  for (const code of [...new Set(requestCodes)].filter(Boolean)) {
    const reg = await findRegistrationByRequestCode(schemaName, institutionId, code)
    if (!reg) { report.unknown.push(code); continue }
    report.matched += 1
    try {
      const r = await refreshRegistration(schemaName, institutionId, null, reg.slipId, 'W')
      if (r.changed) report.changed += 1
    } catch (err) {
      logger.warn('Webhook: consulta da apresentação falhou', { institutionId, slipId: reg.slipId, code, err: errMsg(err) })
    }
  }
  return report
}
