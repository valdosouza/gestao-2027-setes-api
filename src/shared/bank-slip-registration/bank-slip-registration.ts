import { todayFor, todayIn, institutionZoneFor, toZoneWall, toUtcDb, DEFAULT_TIME_ZONE, legacyWallBeforeCutover } from '@shared/time-zone'
import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { HttpError, FieldError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { runIsolated } from '@shared/db/savepoint'
import { isDeadlock, isLockWaitTimeout } from '@shared/db/contention'
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
  listLiveRegistrationsToRefresh, listInFlightRegistrations, touchQueriedAt, listSlipRequestCodes,
  hasRegistrationEvent, FINAL_REGISTRATION_KINDS, EFFECT_KINDS, getRegistration, getRegistrationEvent,
  countPendingEffects,
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
 *  F. reapplyEffect        — ato MANUAL sobre um R/C/V com efeito recusado (D-I25)
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
/** Orçamento TOTAL de uma passada da consulta ativa — é a requisição de quem abriu a tela (MED-3 do gate). */
export const REFRESH_BUDGET_MS = 20_000

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
/** Voz do fisco/banco ('…T13:45:10-03:00', 'Z' ou só a data) → INSTANTE UTC para gravar
 *  (Q-TZ1). Sem offset = hora oficial de Brasília (o terceiro fala na hora dele). */
export function toDbDateTime(v: string | null | undefined): string | null {
  return toUtcDb(v, DEFAULT_TIME_ZONE)
}
const dateOnly = (v: string | null | undefined): string | null => v ? v.slice(0, 10) : null
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
  // 0. tudo que é NOSSO e pode faltar falha ANTES de reservar e antes do banco.
  // Socrático da Rodada 2: R recusado deixa o boleto 'open' com uma apresentação
  // FINAL — sem esta guarda, "Registrar" de novo criava uma 2ª cobrança viva no
  // banco para dinheiro JÁ recebido. A pendência se resolve pelo ato manual
  // (D-I25), nunca por nova apresentação.
  const pending = await countPendingEffects(pool, schemaName, institutionId, slipId)
  if (pending > 0) {
    throw new HttpError(409, `Boleto ${slipId} tem ${pending} voz(es) do banco com efeito pendente — reaplique ou resolva a pendência antes de nova apresentação`,
      undefined, 'BANK_SLIP_EFFECT_PENDING')
  }
  // Smoke do sandbox (2026-09-21): o banco recusa `dataVencimento` anterior a hoje (400) —
  // o vencimento é NOSSO e imutável no boleto, então falha aqui, com o campo, antes do
  // pagador, do canal e da reserva (evita uma tentativa F só para ouvir o óbvio).
  // Q-TZ9: o banco julga pelo AGORA real, não pelo relógio congelado da operação
  if (header.dtExpiration < await todayFor(schemaName, institutionId, undefined, new Date())) {
    throw new HttpError(422, `Vencimento ${header.dtExpiration} anterior a hoje — o banco não registra boleto vencido; cancele e emita outro com vencimento futuro`,
      [{ field: 'dtExpiration', message: 'Anterior a hoje' }], 'BANK_SLIP_EXPIRATION_PAST')
  }
  const payer = await buildPayer(schemaName, institutionId, slipId)
  const opened = await openBankChannel(schemaName, institutionId, header.bankAccountId)
  if (header.ourNumber.length > 15) {
    throw new HttpError(422, `Nosso número ${header.ourNumber} excede 15 caracteres (limite do seuNumero)`,
      [{ field: 'ourNumber', message: 'Máximo 15' }], 'BANK_SLIP_REFERENCE_TOO_LONG')
  }

  // 0b. tentativa INTERROMPIDA há mais de 10 min: pergunta ao banco ANTES de dar por
  // falha (HIGH-3 do gate socrático: marcar F sem consultar e reenviar o MESMO
  // seuNumero podia deixar duas cobranças vivas no Inter, e a que pagasse não teria
  // por onde entrar). Achou = apresentação retroativa (S) → cai no 409 abaixo;
  // não achou = F; banco fora = este registro falha aqui (fail-closed, D-I8).
  // Também quando a última tentativa foi dada por FALHA sem código do banco (F de
  // 4xx, ou F das versões anteriores desta peça que fechavam timeout em F — A1 do
  // gate adversarial): antes de apresentar DE NOVO, um GET por seuNumero garante que
  // o banco não tem uma cobrança viva que nós desconhecemos.
  const latest0 = await latestRegistration(pool, schemaName, institutionId, slipId)
  if (latest0 && !latest0.requestCode && (isInterruptedInFlight(latest0) || latest0.lastKind === 'F')) {
    // o canal aberto é o ATUAL; a tentativa antiga tem o ambiente CONGELADO (S→P): a
    // pergunta vai ao ambiente dela, senão "não achou" seria mentira
    const sameEnv = opened.channel.environment === latest0.environment
    await reconcileInFlightRegistration(schemaName, institutionId, userId, latest0, header, sameEnv ? opened : undefined)
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
        // reservada sem evento: envio em andamento (ou interrompido e reconciliado por
        // outra requisição neste exato instante — quem chega depois só aguarda)
        throw new HttpError(409, 'Registro deste boleto no banco já está em andamento — aguarde e atualize',
          undefined, 'BANK_SLIP_REGISTRATION_IN_PROGRESS')
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
    // 3a. desfecho AMBÍGUO (timeout/5xx/limite, ou 2xx sem código legível): o banco
    // PODE ter registrado — a reserva fica em voo para a reconciliação por seuNumero
    // (D-I13; A1 do gate adversarial). Só recusa EXPLÍCITA (4xx do banco) vira F.
    if (isAmbiguousBankOutcome(err)) throw err
    // recusa explícita: a tentativa recusada também é história (F)
    await withSlipTx('apresentação recusada', institutionId, slipId, async conn => {
      const s = assertSchema(schemaName)
      await lockSlip(conn, s, institutionId, slipId)
      await insertRegistrationEvent(conn, schemaName, institutionId, slipId, attempt, userId, {
        kind: 'F', source: 'P', message: errMsg(err),
      })
    })
    throw err
  }

  // 3b. aceite: código + evento S (o fato: o banco aceitou — grava mesmo que o boleto
  // tenha mudado de estado no intervalo; a apresentação NUNCA fica sem código)
  const stillOpen = await withSlipTx('apresentação aceita', institutionId, slipId, async conn => {
    const s = assertSchema(schemaName)
    const slip = await lockSlip(conn, s, institutionId, slipId)
    await setRequestCode(conn, schemaName, institutionId, slipId, attempt, requestCode)
    await insertRegistrationEvent(conn, schemaName, institutionId, slipId, attempt, userId, {
      kind: 'S', source: 'P', bankStatus: 'EM_PROCESSAMENTO', message: `codigoSolicitacao ${requestCode}`,
    })
    return stateFromLastEvent(slip.lastKind) === 'open'
  })
  if (!stillOpen) {
    // A2 do gate adversarial: boleto cancelado/liquidado por outro fluxo entre a reserva
    // e o aceite — não pode sobrar cobrança VIVA no banco para um boleto que não está
    // aberto aqui. Pede o cancelamento ao banco e registra K; se o banco falhar, a
    // apresentação segue viva e visível (a voz seguinte cai em "efeito recusado").
    try {
      await opened.adapter.cancel(opened.ctx, requestCode, 'Boleto encerrado durante o registro')
      await withSlipTx('cancelamento da apresentação órfã', institutionId, slipId, async conn => {
        const s = assertSchema(schemaName)
        await lockSlip(conn, s, institutionId, slipId)
        await insertRegistrationEvent(conn, schemaName, institutionId, slipId, attempt, userId, {
          kind: 'K', source: 'P', message: 'Boleto deixou de estar aberto durante o registro — cancelamento solicitado ao banco',
        })
      })
    } catch (err) {
      logger.error('Apresentação aceita para boleto que não está mais aberto — cancelamento no banco falhou', { institutionId, slipId, attempt, requestCode, err: errMsg(err) })
    }
    throw new HttpError(409, `Boleto ${slipId} deixou de estar em aberto durante o registro — cobrança cancelada no banco`, undefined, 'BANK_SLIP_NOT_OPEN')
  }
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

/** Recusa de REGRA nossa (HttpError 4xx) × falha transitória/de programa (tudo o mais). */
function isRuleRefusal(err: unknown): boolean {
  if (isLockWaitTimeout(err) || isDeadlock(err)) return false
  if (!(err instanceof HttpError)) return false
  if (err.code === 'RESOURCE_BUSY') return false
  return err.statusCode >= 400 && err.statusCode < 500
}

/** O banco pode ter aceitado sem nos dizer: rede/timeout/5xx/429 (bankStatus 0 ou ≥ 500) ou 2xx sem JSON. */
function isAmbiguousBankOutcome(err: unknown): boolean {
  if (!(err instanceof BankHttpError)) return !(err instanceof HttpError)   // erro de programa/rede cru = ambíguo
  if (err.code === 'BANK_UNAVAILABLE' || err.code === 'BANK_RATE_LIMITED') return true
  return err.bankStatus >= 200 && err.bankStatus < 300
}

function inFlightAgeMinutes(reg: RegistrationRow): number {
  // Q-TZ1 (M10): created_at vem do banco em UTC — lido como UTC (era hora local do processo)
  return reg.createdAt ? (Date.now() - new Date(`${reg.createdAt.replace(' ', 'T')}Z`).getTime()) / 60_000 : Infinity
}

/** Reservada, sem código, sem evento, há mais de IN_FLIGHT_MINUTES: envio interrompido (crash/timeout). */
function isInterruptedInFlight(reg: RegistrationRow): boolean {
  return isLive(reg) && reg.lastKind === null && !reg.requestCode && inFlightAgeMinutes(reg) >= IN_FLIGHT_MINUTES
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
        dtPayment: dateOnly(status.statusAt) ?? await todayFor(schemaName, institutionId, conn, new Date()), source: 'A',   // Q-TZ9: dia em que o banco falou
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
    const unchanged = (bankStatus: string) => ({ slipId, attempt: reg.attempt, changed: false, kind, bankStatus, slipEvent: null, effectRefused: null })
    // A5 do gate adversarial: a consulta foi feita para a tentativa `reg0`; se outra
    // nasceu nesse intervalo, a voz é de uma apresentação que já não é a vigente —
    // nada é gravado na nova (a consulta ativa da vigente traz a voz certa).
    if (reg.attempt !== reg0.attempt || reg.requestCode !== reg0.requestCode) return unchanged(status.status)
    // "nós olhamos o banco" — com ou sem novidade (HIGH-2: sustenta o rodízio da consulta ativa)
    await touchQueriedAt(conn, schemaName, institutionId, slipId, reg.attempt)
    // A3 do gate adversarial: voz ATRASADA (consulta que leu A_RECEBER antes de outra
    // que já gravou RECEBIDO) não regride apresentação ENCERRADA — nem grava G depois
    // de R (o UNIQUE (kind, dt) então estourava a cada consulta seguinte → 500).
    if (reg.lastKind && FINAL_REGISTRATION_KINDS.has(reg.lastKind) && kind !== reg.lastKind) return unchanged(status.status)
    // write-once: preenche o que chegou (mesmo sem evento novo)
    if (status.digitableLine || status.barcode || status.pixCopyPaste || status.bankOurNumber) {
      await fillBankData(conn, schemaName, institutionId, slipId, reg.attempt, {
        bankOurNumber: status.bankOurNumber, digitableLine: status.digitableLine, barcode: status.barcode,
        pixCopyPaste: status.pixCopyPaste, pixTxid: status.pixTxid,
      })
    }
    // idempotência: mesma situação e mesma data → nada a dizer (último evento OU qualquer
    // evento da tentativa — o UNIQUE de idempotência é cinto, não porta: A3)
    // Q-TZ3 (transição): a última voz pode estar gravada na hora de PAREDE antiga — casa as duas formas
    const sameDt = (reg.lastDtBankStatus ?? null) === (dt ?? null)
      || (dt !== null && reg.lastDtBankStatus === legacyWallBeforeCutover(dt))
    if (reg.lastKind === kind && sameDt) return unchanged(status.status)
    if (await hasRegistrationEvent(conn, schemaName, institutionId, slipId, reg.attempt, kind, dt)) return unchanged(status.status)
    const event = await insertRegistrationEvent(conn, schemaName, institutionId, slipId, reg.attempt, userId, {
      kind, bankStatus: status.status, dtBankStatus: dt, source,
      paidValue: status.paidValue, paidBy: status.paidBy === 'PIX' ? 'X' : status.paidBy === 'BOLETO' ? 'B' : null,
    })
    let refused: string | null = null
    let transient: unknown = null
    const slipEvent = await runIsolated(conn, 'bank_status_effect', 'Efeito da voz do banco',
      async () => {
        try { return await applyBankStatus(conn, schemaName, institutionId, userId ?? 0, slip, reg, status, kind) }
        catch (e) { if (isRuleRefusal(e)) refused = errMsg(e); else transient = e; throw e }
      }, { institutionId, slipId, attempt: reg.attempt, status: status.status })
    // HIGH-1 do gate: só RECUSA DE REGRA vira "efeito recusado" (fato + pendência, D-I10).
    // Contenção (lock wait/deadlock) ou erro de programa desfaz a transação INTEIRA — o
    // fato não é gravado, e a próxima consulta vê a mesma situação e tenta o efeito de novo.
    // (Antes, o R ficava gravado com slip_event NULL e a idempotência por (kind, dt)
    // nunca mais tentava a baixa: título pago no banco, aberto aqui para sempre.)
    if (transient) throw transient
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
  let reg = await latestRegistration(pool, schemaName, institutionId, slipId)
  // A2 do gate adversarial: reserva EM VOO (POST ao banco sem resposta ainda) — cancelar
  // "às cegas" deixava cobrança viva no banco para boleto C aqui. Interrompida há mais de
  // 10 min: reconcilia primeiro; recente: aguarde.
  if (reg && isInterruptedInFlight(reg)) {
    await reconcileInFlightRegistration(schemaName, institutionId, userId, reg, header)
    reg = await latestRegistration(pool, schemaName, institutionId, slipId)
  }
  if (reg && isLive(reg) && reg.lastKind === null && !reg.requestCode) {
    throw new HttpError(409, 'Registro deste boleto no banco está em andamento — aguarde e atualize antes de cancelar',
      undefined, 'BANK_SLIP_REGISTRATION_IN_PROGRESS')
  }
  let live = reg && isLive(reg) && reg.requestCode ? reg : null
  if (live) {
    // A4 do gate adversarial: estado LOCAL antes de qualquer ato no banco — boleto já
    // liquidado/cancelado aqui não dispara pedido irreversível para uma requisição que
    // vai falhar (leitura sob lock, transação só de leitura)
    const state = await withSlipTx('estado do boleto antes de cancelar', institutionId, slipId, async conn =>
      stateFromLastEvent((await lockSlip(conn, assertSchema(schemaName), institutionId, slipId)).lastKind))
    if (state !== 'open') {
      throw new HttpError(409, `Boleto ${slipId} não está em aberto (${state}) — nada a cancelar`, undefined, 'BANK_SLIP_NOT_OPEN')
    }
    // MED-2 do gate: CONSULTA antes de pedir — o cliente pode ter pago desde a última
    // consulta. Pago → o efeito (L source A) já foi aplicado pela consulta e o
    // cancelamento é recusado; encerrado no banco (C/V/F) → não há o que pedir lá.
    const seen = await refreshRegistration(schemaName, institutionId, userId, slipId, 'Q')
    if (seen.kind && FINAL_REGISTRATION_KINDS.has(seen.kind)) {
      if (seen.kind === 'R') {
        throw new HttpError(409, `Banco informou ${seen.bankStatus} para o boleto ${slipId} — pago, nada a cancelar`
          + (seen.slipEvent == null ? ' (efeito recusado aqui: veja as pendências do boleto)' : ''), undefined, 'BANK_SLIP_NOT_OPEN')
      }
      // C/V: a própria consulta já cancelou o boleto aqui (source A) — é ESSE o cancelamento
      // (L1 do re-score: repetir cancelBankSlip 'M' num boleto já C devolvia 409 indevido)
      if (seen.slipEvent != null) return { slipEvent: seen.slipEvent, bankNotified: false, attempt: live.attempt }
      live = null                                                 // F, ou efeito recusado: cancela só local
    }
  }
  if (live) {
    const opened = await openForRegistration(schemaName, institutionId, header.bankAccountId, live)
    // 202 = pedido ACEITO; a confirmação (CANCELADO) chega pela consulta (Q-I4 aberta:
    // gravar C aqui no aceite × só na confirmação). Falhou/indisponível → nada muda aqui.
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
// F. Reaplicar efeito recusado — ato MANUAL (D-I25 / Q-I1)
// ---------------------------------------------------------------------------

export interface ReapplyEffectResult {
  slipId: number; attempt: number; event: number
  /** Evento E gravado na apresentação (o ATO). */
  reapplyEvent: number
  /** Evento L/C produzido no boleto (ou o já existente, quando o estado já era o que o banco disse). */
  slipEvent: number
}

/**
 * O banco disse R/C/V, a NOSSA regra recusou o efeito na hora (D-I10: fato gravado,
 * `slip_event` NULL, pendência visível). Corrigida a causa (caixa aberto, boleto
 * reaberto...), o operador REAPLICA: a mesma porta de efeitos (`applyBankStatus`)
 * recebe a voz gravada — nunca uma nova consulta, nunca um R duplicado (a
 * idempotência por (kind, dt) impede o 2º R; por isso a reaplicação é evento
 * PRÓPRIO 'E', final como a voz que reaplica). Recusa de novo → 409 legível e
 * NADA gravado (transação inteira desfeita). Nunca automático nesta onda.
 */
export async function reapplyRegistrationEffect(
  schemaName: string, institutionId: number, userId: number, slipId: number, attempt: number, event: number
): Promise<ReapplyEffectResult> {
  return withSlipTx('reaplicação do efeito', institutionId, slipId, async conn => {
    const s = assertSchema(schemaName)
    const slip = await lockSlip(conn, s, institutionId, slipId)
    const reg = await getRegistration(conn, schemaName, institutionId, slipId, attempt, true)
    if (!reg) throw new HttpError(404, `Apresentação ${attempt} do boleto ${slipId} não encontrada`, undefined, 'BANK_SLIP_REGISTRATION_EVENT_NOT_FOUND')
    const ev = await getRegistrationEvent(conn, schemaName, institutionId, slipId, attempt, event, true)
    if (!ev) throw new HttpError(404, `Evento ${event} da apresentação ${attempt} não encontrado`, undefined, 'BANK_SLIP_REGISTRATION_EVENT_NOT_FOUND')
    if (!EFFECT_KINDS.has(ev.kind)) {
      throw new HttpError(409, `Evento ${event} (${ev.bankStatus ?? ev.kind}) não produz efeito no boleto — só RECEBIDO, CANCELADO e EXPIRADO`,
        [{ field: 'event', message: 'Sem efeito a reaplicar' }], 'BANK_SLIP_EFFECT_NOT_PENDING')
    }
    if (ev.slipEvent != null) {
      throw new HttpError(409, `Efeito do evento ${event} já está aplicado (evento ${ev.slipEvent} do boleto)`,
        [{ field: 'event', message: 'Já aplicado' }], 'BANK_SLIP_EFFECT_NOT_PENDING')
    }
    // a voz GRAVADA vira a situação — sem consultar o banco de novo
    const status: ChargeStatus = {
      requestCode: reg.requestCode ?? '', reference: null, status: ev.bankStatus ?? ev.kind,
      statusAt: ev.dtBankStatus ? ev.dtBankStatus.replace(' ', 'T') : null, amount: null,
      paidValue: ev.paidValue, paidBy: ev.paidBy === 'X' ? 'PIX' : ev.paidBy === 'B' ? 'BOLETO' : null,
      bankOurNumber: null, digitableLine: null, barcode: null, pixCopyPaste: null, pixTxid: null, cancelReason: null,
    }
    // recusa de regra PROPAGA (409 com o motivo) e desfaz tudo — sem SAVEPOINT aqui de propósito
    const slipEvent = await applyBankStatus(conn, schemaName, institutionId, userId, slip, reg, status, ev.kind)
    if (slipEvent == null) throw new HttpError(500, `Reaplicação do evento ${event} não produziu efeito`)
    const reapplyEvent = await insertRegistrationEvent(conn, schemaName, institutionId, slipId, attempt, userId, {
      kind: 'E', source: 'P', bankStatus: ev.bankStatus, slipEvent,
      message: `Efeito do evento ${event} (${ev.bankStatus ?? ev.kind}) reaplicado manualmente`,
    })
    await setRegistrationEventEffect(conn, schemaName, institutionId, slipId, attempt, event, slipEvent,
      `Efeito reaplicado (evento ${reapplyEvent})`)
    logger.info('Efeito da voz do banco reaplicado', { institutionId, slipId, attempt, event, reapplyEvent, slipEvent })
    return { slipId, attempt, event, reapplyEvent, slipEvent }
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

const stopsTheRun = (err: unknown): boolean =>
  err instanceof BankHttpError && (err.code === 'BANK_UNAVAILABLE' || err.code === 'BANK_RATE_LIMITED')

/** Erro que vai se repetir na próxima corrida (4xx/502 nosso ou do banco) — não é contenção nem indisponibilidade. */
const isPersistentRefreshFailure = (err: unknown): boolean =>
  err instanceof HttpError && !stopsTheRun(err) && err.code !== 'RESOURCE_BUSY'
  && !isLockWaitTimeout(err) && !isDeadlock(err) && err.statusCode !== 503

/** Uma varredura por institution de cada vez: duas telas abertas = UMA passada (MED-3). */
const runningRefresh = new Map<string, Promise<RefreshRunReport>>()

export async function refreshOpenRegistrations(
  schemaName: string, institutionId: number, userId: number | null,
  opts: { minMinutes?: number; limit?: number; budgetMs?: number } = {}
): Promise<RefreshRunReport> {
  const key = `${schemaName}:${institutionId}`
  const running = runningRefresh.get(key)
  if (running) return running
  const run = runRefresh(schemaName, institutionId, userId, opts).finally(() => { runningRefresh.delete(key) })
  runningRefresh.set(key, run)
  return run
}

async function runRefresh(
  schemaName: string, institutionId: number, userId: number | null,
  opts: { minMinutes?: number; limit?: number; budgetMs?: number }
): Promise<RefreshRunReport> {
  const deadline = Date.now() + (opts.budgetMs ?? REFRESH_BUDGET_MS)
  const report: RefreshRunReport = { checked: 0, changed: 0, reconciled: 0, errors: [], stoppedEarly: false }
  report.reconciled = await reconcileInFlightRegistrations(schemaName, institutionId, userId, report, deadline)
  if (report.stoppedEarly) return report
  const list = await listLiveRegistrationsToRefresh(schemaName, institutionId, opts.minMinutes ?? REFRESH_MIN_MINUTES, opts.limit ?? REFRESH_MAX_PER_RUN)
  for (const reg of list) {
    // orçamento TOTAL: banco lento (14 s sem erro) não pode segurar a tela por minutos
    if (Date.now() >= deadline) { report.stoppedEarly = true; break }
    try {
      report.checked += 1
      const r = await refreshRegistration(schemaName, institutionId, userId, reg.slipId, 'Q')
      if (r.changed) report.changed += 1
    } catch (err) {
      const code = err instanceof HttpError ? err.code ?? null : null
      report.errors.push({ slipId: reg.slipId, code, message: errMsg(err) })
      // banco fora/limite: insistir nas outras só piora (D-I8 fail-closed; rate limit 10/min)
      if (stopsTheRun(err)) { report.stoppedEarly = true; break }
      // M2 do re-score (Q-I10 como assunção): falha PERSISTENTE desta apresentação antes da
      // voz do banco (canal inativo, segredo do sandbox removido, situação desconhecida 502)
      // também conta como "tentamos olhar" — senão ela monopoliza a cabeça do rodízio para
      // sempre e a starvation da HIGH-2 volta. Transitório (lock/deadlock/RESOURCE_BUSY)
      // preserva a marca: a próxima corrida deve tentar de novo.
      if (isPersistentRefreshFailure(err)) {
        try { await touchQueriedAt(pool, schemaName, institutionId, reg.slipId, reg.attempt) }
        catch (touchErr) { logger.warn('Consulta ativa: não marcou last_queried_at após falha persistente', { institutionId, slipId: reg.slipId, err: errMsg(touchErr) }) }
      }
    }
  }
  return report
}

/**
 * D-I13: envio interrompido → procura no banco por seuNumero; achou = apresentação
 * retroativa (código + S, e a situação atual entra como voz); não achou = F.
 * Erros PROPAGAM (quem chama decide: a rotina anota, o registro falha fechado).
 */
export async function reconcileInFlightRegistration(
  schemaName: string, institutionId: number, userId: number | null, reg: RegistrationRow,
  header?: SlipHeader, opened?: OpenedChannel
): Promise<boolean> {
  const h = header ?? await readSlipHeader(schemaName, institutionId, reg.slipId)
  const o = opened ?? await openForRegistration(schemaName, institutionId, h.bankAccountId, reg)
  // Q-TZ1 (M11): created_at é instante UTC — a janela de busca no banco começa no DIA da zona
  const zone = await institutionZoneFor(schemaName, institutionId)
  const today = todayIn(zone)
  const from = (toZoneWall(reg.createdAt, zone) ?? today).slice(0, 10)
  const found = (await o.adapter.findByReference(o.ctx, h.ourNumber, from, today)) ?? []
  // MED-1 do gate: o banco lista TODAS as cobranças com este seuNumero, inclusive as
  // de tentativas anteriores (FALHA_EMISSAO, canceladas) — código já conhecido nunca é
  // adotado de novo (daria ER_DUP_ENTRY e a tentativa ficaria em voo para sempre).
  const known = new Set(await listSlipRequestCodes(schemaName, institutionId, reg.slipId))
  const candidates = found.filter(f => !!f.requestCode && !known.has(f.requestCode))
  const match = candidates.length === 0 ? null
    : candidates.reduce((best, f) => (String(f.statusAt ?? '') >= String(best.statusAt ?? '') ? f : best))
  await withSlipTx('reconciliação de órfão', institutionId, reg.slipId, async conn => {
    const s = assertSchema(schemaName)
    await lockSlip(conn, s, institutionId, reg.slipId)
    if (match) {
      await setRequestCode(conn, schemaName, institutionId, reg.slipId, reg.attempt, match.requestCode)
      await insertRegistrationEvent(conn, schemaName, institutionId, reg.slipId, reg.attempt, userId, {
        kind: 'S', source: 'Q', bankStatus: 'EM_PROCESSAMENTO', message: `Reconciliado por seuNumero: ${match.requestCode}`,
      })
    } else if (reg.lastKind === null) {
      // só a tentativa SEM evento ganha o F; uma já dada por F não repete a história
      await insertRegistrationEvent(conn, schemaName, institutionId, reg.slipId, reg.attempt, userId, {
        kind: 'F', source: 'Q', message: 'Sem resposta do banco e nenhuma cobrança nova com este seuNumero — envio interrompido',
      })
    }
  })
  if (match) await refreshRegistration(schemaName, institutionId, userId, reg.slipId, 'Q', { status: match })
  return !!match
}

/** Varredura dos órfãos (rotina): anota erros no relatório; banco fora/limite ou orçamento estourado param cedo. */
export async function reconcileInFlightRegistrations(
  schemaName: string, institutionId: number, userId: number | null, report?: RefreshRunReport, deadline = Infinity
): Promise<number> {
  const stuck = await listInFlightRegistrations(schemaName, institutionId, IN_FLIGHT_MINUTES, 10)
  let reconciled = 0
  for (const reg of stuck) {
    if (Date.now() >= deadline) { if (report) report.stoppedEarly = true; break }
    try {
      if (await reconcileInFlightRegistration(schemaName, institutionId, userId, reg)) reconciled += 1
    } catch (err) {
      report?.errors.push({ slipId: reg.slipId, code: err instanceof HttpError ? err.code ?? null : null, message: errMsg(err) })
      if (stopsTheRun(err)) { if (report) report.stoppedEarly = true; break }
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
