import { PoolConnection } from 'mysql2/promise'
import { assertSchema } from '@shared/db/schema'
import { HttpError } from '@shared/errors/http-error'
import {
  settleBatchTx, reverseOnePayment, SettleTitleInput,
} from '@shared/financial-settlement/settlement-batch'

/**
 * Peça compartilhada do BOLETO EMITIDO (migration 039 —
 * Infra-IA/prompts/prompt_boleto_emitido.md D1–D11). Boleto = instrumento
 * de cobrança de 1..N títulos perante um banco: cabeçalho IMUTÁVEL (taxas e
 * instruções CONGELADAS da carteira na emissão) + vínculo boleto↔título +
 * HISTÓRIA append-only (E emitido · L liquidado · C cancelado · X estornado).
 * Estado = derivado do ÚLTIMO evento — nunca coluna. Tudo transaction-aware
 * (1º parâmetro conn); consumida pelo módulo `bank-slips` e pelo billing
 * (emissão automática — D18 do contrato financeiro).
 *
 * O que morreu do legado: BLT_CODQTC (vínculo + nosso número + código da
 * baixa num inteiro) → vínculo = tb_bank_slip_title; código da baixa =
 * settled_code do settleBatchTx (1 código para N títulos, rateado por
 * título); nosso número = sequência da carteira (D3).
 */

export type BankSlipEventKind = 'E' | 'L' | 'C' | 'X'
export type BankSlipState = 'open' | 'settled' | 'cancelled'
/** M manual (tela) / R retorno CNAB (canal) / A automático — emissão pelo
 *  faturamento (D-B4, Rodada 2) OU futuro canal API; distingue a origem na
 *  história sem exigir kind novo. */
export type BankSlipSource = 'M' | 'R' | 'A'

export interface ChargeAgreementRow {
  id: number
  bankAccountId: number
  chargeKindId: number | null
  accept: string | null
  aliqDiscount: number | null
  aliqInterest: number | null
  aliqLate: number | null
  valueLateMin: number | null
  valueFine: number | null
  aliqFine: number | null
  valueRate: number | null
  instruction: string | null
  protest: string | null
  dayProtest: number | null
  ourNumberNext: number | null
}

export interface BankSlipTitleRef {
  orderId: number
  parcel: number
}

export interface IssueBankSlipInput {
  agreementId: number
  titles: BankSlipTitleRef[]
  /** Obrigatório no agrupado; no individual default = vencimento do título. */
  dtExpiration?: string | null
  source?: BankSlipSource
}

export interface IssueBankSlipResult {
  id: number
  ourNumber: string
  documentNumber: string
  value: number
  dtExpiration: string
  titles: number
}

export interface SettleBankSlipInput {
  slipId: number
  paidValue: number
  dtPayment: string
  source?: BankSlipSource
  bankCode?: string | null
  bankMessage?: string | null
}

export interface SettleBankSlipResult {
  settledCode: number
  statementId: number
  event: number
  titles: number
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
/** Teto do DECIMAL(10,2) — o banco sem STRICT truncaria em silêncio. */
export const MAX_MONEY = 99999999.99

/** Estado derivado do último evento (X reabre: o boleto segue registrado). */
export function stateFromLastEvent(kind: string | null | undefined): BankSlipState {
  if (kind === 'L') return 'settled'
  if (kind === 'C') return 'cancelled'
  return 'open'
}

/** SQL do último evento de um boleto (subquery reutilizável nas listas). */
export const LAST_EVENT_KIND_SQL = (s: string, slipAlias = 'bs') =>
  `(SELECT ev.kind FROM \`${s}\`.tb_bank_slip_event ev
     WHERE ev.tb_institution_id = ${slipAlias}.tb_institution_id
       AND ev.tb_bank_slip_id = ${slipAlias}.id AND ev.deleted = 'N'
     ORDER BY ev.event DESC LIMIT 1)`

/** Carteiras ATIVAS (D8) da institution — o gate 0/1/n do faturamento conta estas. */
export async function listActiveAgreements(
  conn: PoolConnection, schemaName: string, institutionId: number
): Promise<ChargeAgreementRow[]> {
  const s = assertSchema(schemaName)
  const [rows] = await conn.query<any[]>(
    `SELECT a.id, a.tb_bank_account_id AS bankAccountId,
            a.tb_bank_charge_kind_id AS chargeKindId, a.accept,
            a.aliq_discount AS aliqDiscount, a.aliq_interest AS aliqInterest,
            a.aliq_late AS aliqLate, a.value_late_min AS valueLateMin,
            a.value_fine AS valueFine, a.aliq_fine AS aliqFine, a.value_rate AS valueRate,
            CONVERT(a.instruction USING utf8mb4) AS instruction,
            a.protest, a.day_protest AS dayProtest, a.our_number_next AS ourNumberNext
       FROM \`${s}\`.tb_bank_charge_agreement a
      WHERE a.tb_institution_id = ? AND a.active = 'S' AND a.deleted = 'N'
      ORDER BY a.id`,
    [institutionId]
  )
  return rows.map(normalizeAgreement)
}

function normalizeAgreement(r: any): ChargeAgreementRow {
  const num = (v: any) => (v == null ? null : Number(v))
  return {
    id: Number(r.id), bankAccountId: Number(r.bankAccountId),
    chargeKindId: num(r.chargeKindId), accept: r.accept ?? null,
    aliqDiscount: num(r.aliqDiscount), aliqInterest: num(r.aliqInterest),
    aliqLate: num(r.aliqLate), valueLateMin: num(r.valueLateMin),
    valueFine: num(r.valueFine), aliqFine: num(r.aliqFine), valueRate: num(r.valueRate),
    instruction: r.instruction == null ? null : String(r.instruction),
    protest: r.protest ?? null, dayProtest: num(r.dayProtest),
    ourNumberNext: num(r.ourNumberNext),
  }
}

interface LockedTitle {
  orderId: number
  parcel: number
  customerId: number | null
  operation: string
  dtExpiration: string | null
  balance: number
  paymentTypeId: number
}

/** Título travado (FOR UPDATE) com saldo e cliente derivado da cadeia da ordem. */
async function lockTitle(
  conn: PoolConnection, s: string, institutionId: number, ref: BankSlipTitleRef
): Promise<LockedTitle> {
  const [rows] = await conn.query<any[]>(
    `SELECT f.tb_order_id AS orderId, f.parcel, f.tag_value AS tagValue,
            f.tb_payment_types_id AS paymentTypeId,
            DATE_FORMAT(f.dt_expiration, '%Y-%m-%d') AS dtExpiration,
            b.operation,
            COALESCE(osl.tb_customer_id, osv.tb_customer_id, ofn.tb_entity_id) AS customerId,
            (SELECT COALESCE(SUM(p.paid_value), 0)
               FROM \`${s}\`.tb_financial_payment p
              WHERE p.tb_institution_id = f.tb_institution_id
                AND p.tb_order_id = f.tb_order_id AND p.terminal = f.terminal
                AND p.parcel = f.parcel AND p.status = 'N' AND p.deleted = 'N') AS paidSum
       FROM \`${s}\`.tb_financial f
       INNER JOIN \`${s}\`.tb_financial_bills b
          ON b.tb_institution_id = f.tb_institution_id AND b.tb_order_id = f.tb_order_id
         AND b.terminal = f.terminal AND b.parcel = f.parcel AND b.deleted = 'N'
       LEFT JOIN \`${s}\`.tb_order_sale osl
          ON osl.id = f.tb_order_id AND osl.tb_institution_id = f.tb_institution_id
         AND osl.terminal = f.terminal
       LEFT JOIN \`${s}\`.tb_order_service osv
          ON osv.id = f.tb_order_id AND osv.tb_institution_id = f.tb_institution_id
         AND osv.terminal = f.terminal
       LEFT JOIN \`${s}\`.tb_order_financial ofn
          ON ofn.id = f.tb_order_id AND ofn.tb_institution_id = f.tb_institution_id
         AND ofn.terminal = f.terminal
      WHERE f.tb_institution_id = ? AND f.tb_order_id = ? AND f.terminal = 0
        AND f.parcel = ? AND f.deleted = 'N' FOR UPDATE`,
    [institutionId, ref.orderId, ref.parcel]
  )
  if (!rows[0]) {
    throw new HttpError(404, `Título ${ref.orderId}/${ref.parcel} não encontrado`,
      undefined, 'TITLE_NOT_FOUND')
  }
  const r = rows[0]
  return {
    orderId: Number(r.orderId), parcel: Number(r.parcel),
    customerId: r.customerId == null ? null : Number(r.customerId),
    operation: String(r.operation ?? 'C'), dtExpiration: r.dtExpiration ?? null,
    balance: round2(Math.max(0, Number(r.tagValue) - Number(r.paidSum))),
    paymentTypeId: Number(r.paymentTypeId),
  }
}

/** Existe boleto VIGENTE (último evento ≠ L/C) cobrando este título? */
async function hasOpenSlip(
  conn: PoolConnection, s: string, institutionId: number, ref: BankSlipTitleRef
): Promise<number | null> {
  // Leitura TRAVANTE (FOR UPDATE) depois do lock do título: sob REPEATABLE
  // READ uma leitura simples veria o snapshot anterior e dois usuários (ou
  // billing × tela, carteiras diferentes) criariam 2 boletos vigentes para
  // 1 título (gate socrático 2026-09-04).
  const [rows] = await conn.query<any[]>(
    `SELECT bs.id, ${LAST_EVENT_KIND_SQL(s)} AS lastKind
       FROM \`${s}\`.tb_bank_slip_title t
       INNER JOIN \`${s}\`.tb_bank_slip bs
          ON bs.id = t.tb_bank_slip_id AND bs.tb_institution_id = t.tb_institution_id
         AND bs.deleted = 'N'
      WHERE t.tb_institution_id = ? AND t.tb_order_id = ? AND t.terminal = 0
        AND t.parcel = ? AND t.deleted = 'N' FOR UPDATE`,
    [institutionId, ref.orderId, ref.parcel]
  )
  const open = rows.find(r => stateFromLastEvent(r.lastKind) === 'open')
  return open ? Number(open.id) : null
}

async function nextEvent(
  conn: PoolConnection, s: string, institutionId: number, slipId: number
): Promise<number> {
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(event), 0) + 1 AS nextEvent
       FROM \`${s}\`.tb_bank_slip_event
      WHERE tb_institution_id = ? AND tb_bank_slip_id = ? FOR UPDATE`,
    [institutionId, slipId]
  )
  return Number(mx[0].nextEvent)
}

interface EventInput {
  kind: BankSlipEventKind
  dtRecord: string
  source: BankSlipSource
  settledCode?: number | null
  bankAccountId?: number | null
  paidValue?: number | null
  bankCode?: string | null
  bankMessage?: string | null
  originEvent?: number | null
  note?: string | null
}

async function insertEvent(
  conn: PoolConnection, s: string, institutionId: number, slipId: number,
  userId: number, e: EventInput
): Promise<number> {
  const event = await nextEvent(conn, s, institutionId, slipId)
  await conn.query(
    `INSERT INTO \`${s}\`.tb_bank_slip_event
       (tb_institution_id, tb_bank_slip_id, event, kind, dt_record, source,
        settled_code, tb_bank_account_id, paid_value, bank_code, bank_message,
        origin_event, note, tb_user_id, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
    [institutionId, slipId, event, e.kind, e.dtRecord, e.source,
     e.settledCode ?? null, e.bankAccountId ?? null, e.paidValue ?? null,
     e.bankCode ?? null, e.bankMessage ?? null, e.originEvent ?? null,
     e.note ? String(e.note).slice(0, 255) : null, userId]
  )
  return event
}

function todayIso(): string {
  const d = new Date()
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')].join('-')
}

/**
 * EMISSÃO (evento E): valida carteira ativa, títulos a RECEBER abertos do
 * MESMO cliente sem boleto vigente (D9), congela taxas/instruções da
 * carteira, reserva o nosso número (D3: sequência da carteira; sem faixa =
 * id) e grava cabeçalho + vínculos + evento E. NÃO toca tb_financial* —
 * "destinado a boleto" é derivado do vínculo com boleto aberto.
 */
export async function issueBankSlip(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, input: IssueBankSlipInput
): Promise<IssueBankSlipResult> {
  const s = assertSchema(schemaName)
  if (input.titles.length === 0) {
    throw new HttpError(400, 'Informe ao menos um título',
      [{ field: 'titles', message: 'Obrigatório' }], 'BANK_SLIP_NO_TITLES')
  }
  const keys = new Set(input.titles.map(t => `${t.orderId}-${t.parcel}`))
  if (keys.size !== input.titles.length) {
    throw new HttpError(400, 'Título repetido no boleto',
      [{ field: 'titles', message: 'Repetido' }], 'BANK_SLIP_DUPLICATE_TITLE')
  }

  const [agr] = await conn.query<any[]>(
    `SELECT a.id, a.tb_bank_account_id AS bankAccountId,
            a.tb_bank_charge_kind_id AS chargeKindId, a.accept,
            a.aliq_discount AS aliqDiscount, a.aliq_interest AS aliqInterest,
            a.aliq_late AS aliqLate, a.value_late_min AS valueLateMin,
            a.value_fine AS valueFine, a.aliq_fine AS aliqFine, a.value_rate AS valueRate,
            CONVERT(a.instruction USING utf8mb4) AS instruction,
            a.protest, a.day_protest AS dayProtest, a.our_number_next AS ourNumberNext,
            a.active
       FROM \`${s}\`.tb_bank_charge_agreement a
      WHERE a.id = ? AND a.tb_institution_id = ? AND a.deleted = 'N' FOR UPDATE`,
    [input.agreementId, institutionId]
  )
  if (!agr[0]) {
    throw new HttpError(404, 'Carteira de cobrança não encontrada',
      [{ field: 'agreementId', message: 'Não encontrada' }], 'AGREEMENT_NOT_FOUND')
  }
  if (agr[0].active !== 'S') {
    throw new HttpError(409, 'Carteira de cobrança inativa',
      [{ field: 'agreementId', message: 'Inativa' }], 'AGREEMENT_INACTIVE')
  }
  const agreement = normalizeAgreement(agr[0])

  const [acc] = await conn.query<any[]>(
    `SELECT 1 FROM \`${s}\`.tb_bank_account
      WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [agreement.bankAccountId, institutionId]
  )
  if (acc.length === 0) {
    throw new HttpError(409, 'Conta corrente da carteira não existe',
      [{ field: 'agreementId', message: 'Conta da carteira excluída' }], 'BANK_NOT_FOUND')
  }

  const locked: LockedTitle[] = []
  for (const ref of input.titles) {
    const t = await lockTitle(conn, s, institutionId, ref)
    if (t.operation === 'D') {
      throw new HttpError(409, `Título ${t.orderId}/${t.parcel} é a pagar — boleto só cobra recebíveis`,
        undefined, 'TITLE_NOT_RECEIVABLE')
    }
    if (t.balance <= 0) {
      throw new HttpError(409, `Título ${t.orderId}/${t.parcel} já está quitado`,
        undefined, 'TITLE_SETTLED')
    }
    const openSlip = await hasOpenSlip(conn, s, institutionId, ref)
    if (openSlip !== null) {
      throw new HttpError(409, `Título ${t.orderId}/${t.parcel} já tem o boleto ${openSlip} vigente`,
        undefined, 'TITLE_HAS_OPEN_SLIP')
    }
    locked.push(t)
  }
  const customers = new Set(locked.map(t => t.customerId ?? 0))
  if (locked.length > 1 && customers.size > 1) {
    throw new HttpError(409, 'Boleto agrupado só com títulos do MESMO cliente',
      [{ field: 'titles', message: 'Clientes diferentes' }], 'BANK_SLIP_MIXED_CUSTOMERS')
  }

  let dtExpiration = input.dtExpiration ?? null
  if (!dtExpiration) {
    if (locked.length > 1) {
      throw new HttpError(400, 'Boleto agrupado exige vencimento informado',
        [{ field: 'dtExpiration', message: 'Obrigatório' }], 'BANK_SLIP_EXPIRATION_REQUIRED')
    }
    dtExpiration = locked[0].dtExpiration ?? todayIso()
  }
  const value = round2(locked.reduce((acc, t) => acc + t.balance, 0))

  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM \`${s}\`.tb_bank_slip
      WHERE tb_institution_id = ? FOR UPDATE`,
    [institutionId]
  )
  const id = Number(mx[0].nextId)

  // D3: nosso número = sequência da carteira; sem faixa (NULL) = id do boleto
  let ourNumber = String(id)
  if (agreement.ourNumberNext != null) {
    ourNumber = String(agreement.ourNumberNext)
    await conn.query(
      `UPDATE \`${s}\`.tb_bank_charge_agreement
          SET our_number_next = our_number_next + 1, updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ?`,
      [agreement.id, institutionId]
    )
  }
  const documentNumber = locked.length === 1
    ? `${locked[0].orderId}-${locked[0].parcel}`
    : String(id)

  const discountValue = agreement.aliqDiscount && agreement.aliqDiscount > 0
    ? round2(value * agreement.aliqDiscount / 100) : null

  await conn.query(
    `INSERT INTO \`${s}\`.tb_bank_slip
       (id, tb_institution_id, tb_bank_charge_agreement_id, tb_bank_account_id,
        tb_bank_charge_kind_id, our_number, document_number, dt_emission, dt_expiration,
        value, accept, aliq_discount, discount_value, dt_discount_until,
        aliq_interest, aliq_late, value_late_min, aliq_fine, value_fine, value_rate,
        instruction, protest_days, protest_day_kind, negativation_days,
        tb_user_id, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL,
             ?, NOW(), NOW(), 'N')`,
    [id, institutionId, agreement.id, agreement.bankAccountId, agreement.chargeKindId,
     ourNumber, documentNumber, dtExpiration, value, agreement.accept,
     agreement.aliqDiscount, discountValue, discountValue != null ? dtExpiration : null,
     agreement.aliqInterest, agreement.aliqLate, agreement.valueLateMin,
     agreement.aliqFine, agreement.valueFine, agreement.valueRate,
     agreement.instruction,
     agreement.protest === 'S' ? agreement.dayProtest : null,
     agreement.protest === 'S' ? 'C' : null,
     userId]
  )
  for (const t of locked) {
    await conn.query(
      `INSERT INTO \`${s}\`.tb_bank_slip_title
         (tb_institution_id, tb_bank_slip_id, tb_order_id, terminal, parcel, value,
          created_at, updated_at, deleted)
       VALUES (?, ?, ?, 0, ?, ?, NOW(), NOW(), 'N')`,
      [institutionId, id, t.orderId, t.parcel, t.balance]
    )
  }
  await insertEvent(conn, s, institutionId, id, userId, {
    kind: 'E', dtRecord: todayIso(), source: input.source ?? 'M',
    bankAccountId: agreement.bankAccountId, paidValue: null,
  })

  return { id, ourNumber, documentNumber, value, dtExpiration, titles: locked.length }
}

interface LockedSlip {
  id: number
  bankAccountId: number
  ourNumber: string
  value: number
  discountValue: number
  dtDiscountUntil: string | null
  lastKind: string | null
  lastEvent: number | null
  lastSettledCode: number | null
}

async function lockSlip(
  conn: PoolConnection, s: string, institutionId: number, slipId: number
): Promise<LockedSlip> {
  const [rows] = await conn.query<any[]>(
    `SELECT bs.id, bs.tb_bank_account_id AS bankAccountId, bs.our_number AS ourNumber,
            bs.value, bs.discount_value AS discountValue,
            DATE_FORMAT(bs.dt_discount_until, '%Y-%m-%d') AS dtDiscountUntil
       FROM \`${s}\`.tb_bank_slip bs
      WHERE bs.id = ? AND bs.tb_institution_id = ? AND bs.deleted = 'N' FOR UPDATE`,
    [slipId, institutionId]
  )
  if (!rows[0]) throw new HttpError(404, `Boleto ${slipId} não encontrado`, undefined, 'BANK_SLIP_NOT_FOUND')
  const [last] = await conn.query<any[]>(
    `SELECT event, kind, settled_code AS settledCode
       FROM \`${s}\`.tb_bank_slip_event
      WHERE tb_institution_id = ? AND tb_bank_slip_id = ? AND deleted = 'N'
      ORDER BY event DESC LIMIT 1 FOR UPDATE`,
    [institutionId, slipId]
  )
  return {
    id: Number(rows[0].id), bankAccountId: Number(rows[0].bankAccountId),
    ourNumber: String(rows[0].ourNumber), value: Number(rows[0].value),
    discountValue: Number(rows[0].discountValue) || 0,
    dtDiscountUntil: rows[0].dtDiscountUntil ?? null,
    lastKind: last[0]?.kind ?? null,
    lastEvent: last[0] ? Number(last[0].event) : null,
    lastSettledCode: last[0]?.settledCode == null ? null : Number(last[0].settledCode),
  }
}

/**
 * LIQUIDAÇÃO MANUAL (evento L — D5/D7): 1 baixa para os N títulos sob UM
 * settled_code (settleBatchTx) na conta CONGELADA do boleto, statement com
 * doc_reference = nosso número; paidValue rateado por título na proporção
 * do vínculo, sobra (juros/multa recebidos) vai como interest_value no
 * último título; tarifa NÃO entra (conciliação do extrato — D5a).
 */
export async function settleBankSlip(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, input: SettleBankSlipInput
): Promise<SettleBankSlipResult> {
  const s = assertSchema(schemaName)
  // gate adversarial 2026-09-04: 0.004 arredondava a 0 e liquidava "de
  // graça"; 1e12 era truncado em silêncio pelo DECIMAL(10,2) sem STRICT
  const paidValue = round2(input.paidValue)
  if (!(paidValue >= 0.01) || paidValue > MAX_MONEY) {
    throw new HttpError(400, 'Valor recebido inválido (mínimo 0,01; máximo 99.999.999,99)',
      [{ field: 'paidValue', message: 'Inválido' }], 'BANK_SLIP_INVALID_VALUE')
  }
  const slip = await lockSlip(conn, s, institutionId, input.slipId)
  if (stateFromLastEvent(slip.lastKind) !== 'open') {
    throw new HttpError(409, `Boleto ${slip.id} não está em aberto`, undefined, 'BANK_SLIP_NOT_OPEN')
  }

  // D-B2 (Rodada 2, 2026-09-04): recusa pagamento ABAIXO do mínimo — face
  // menos o desconto CONGELADO, só válido até dt_discount_until (o banco
  // não concede desconto fora do prazo negociado na emissão). Checado ANTES
  // dos vínculos: não depende deles e falha mais cedo.
  const discountApplies = slip.discountValue > 0 &&
    (slip.dtDiscountUntil == null || input.dtPayment <= slip.dtDiscountUntil)
  const minAllowed = round2(slip.value - (discountApplies ? slip.discountValue : 0))
  if (paidValue < minAllowed) {
    throw new HttpError(409,
      `Valor recebido (${paidValue.toFixed(2)}) abaixo do mínimo aceito (${minAllowed.toFixed(2)})`,
      [{ field: 'paidValue', message: 'Abaixo do mínimo' }], 'BANK_SLIP_BELOW_MINIMUM')
  }

  const [links] = await conn.query<any[]>(
    `SELECT tb_order_id AS orderId, parcel, value
       FROM \`${s}\`.tb_bank_slip_title
      WHERE tb_institution_id = ? AND tb_bank_slip_id = ? AND deleted = 'N'
      ORDER BY tb_order_id, parcel`,
    [institutionId, slip.id]
  )
  if (links.length === 0) throw new HttpError(409, 'Boleto sem títulos', undefined, 'BANK_SLIP_NO_TITLES')

  // rateio do valor RECEBIDO (líquido — convenção da casa: paid_value = o
  // que entrou, e o statement soma os paid_value) na proporção do vínculo,
  // resíduo de centavos no último; a sobra sobre o valor de face vai
  // informada como juros no último título (gate adversarial: antes os
  // juros ficavam fora do extrato). Pagamento MENOR que a face deixa
  // resíduo no título (Q-B2 da rodada).
  const extra = round2(Math.max(0, paidValue - slip.value))
  const titles: SettleTitleInput[] = []
  let distributed = 0
  links.forEach((l, i) => {
    const share = i === links.length - 1
      ? round2(paidValue - distributed)
      : round2(paidValue * Number(l.value) / slip.value)
    distributed = round2(distributed + share)
    titles.push({
      orderId: Number(l.orderId), parcel: Number(l.parcel),
      interestValue: i === links.length - 1 ? extra : 0,
      lateValue: 0, discountAliquot: 0, paidValue: share,
    })
  })

  // D-B1: a liquidação do PRÓPRIO boleto é a exceção autorizada da guarda
  // "título com boleto vigente não baixa por outro meio" (settlement-batch).
  const batch = await settleBatchTx(conn, {
    titles, bankAccountId: slip.bankAccountId, dtPayment: input.dtPayment,
    history: `RECEBIMENTO BOLETO ${slip.ourNumber}`, docReference: slip.ourNumber,
    allowedBankSlipId: slip.id,
  }, schemaName, institutionId, userId)

  const event = await insertEvent(conn, s, institutionId, slip.id, userId, {
    kind: 'L', dtRecord: input.dtPayment, source: input.source ?? 'M',
    settledCode: batch.settledCode, bankAccountId: slip.bankAccountId,
    paidValue, bankCode: input.bankCode ?? null,
    bankMessage: input.bankMessage ?? null,
  })
  return { settledCode: batch.settledCode, statementId: batch.statementId, event, titles: titles.length }
}

/** CANCELAMENTO (evento C — D6/D10): só boleto aberto; libera os títulos para reemissão. */
export async function cancelBankSlip(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, slipId: number, note?: string | null
): Promise<number> {
  const s = assertSchema(schemaName)
  const slip = await lockSlip(conn, s, institutionId, slipId)
  if (stateFromLastEvent(slip.lastKind) !== 'open') {
    throw new HttpError(409, `Boleto ${slip.id} não está em aberto`, undefined, 'BANK_SLIP_NOT_OPEN')
  }
  return insertEvent(conn, s, institutionId, slip.id, userId, {
    kind: 'C', dtRecord: todayIso(), source: 'M', note: note ?? null,
  })
}

/**
 * ESTORNO da liquidação (evento X — D10): só quando o ÚLTIMO evento é L;
 * inverte todos os payments vigentes do settled_code (reverseOnePayment —
 * satélites do código inclusos) e reabre o boleto (X → open).
 */
export async function reverseBankSlipSettlement(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, slipId: number, reason: string
): Promise<{ event: number; reversed: number; settledCode: number | null }> {
  const s = assertSchema(schemaName)
  const slip = await lockSlip(conn, s, institutionId, slipId)
  if (slip.lastKind !== 'L' || slip.lastSettledCode == null) {
    throw new HttpError(409, `Boleto ${slip.id} não está liquidado (ou já tem evento posterior)`,
      undefined, 'BANK_SLIP_NOT_SETTLED')
  }
  // gate adversarial 2026-09-04: título com resíduo já pode ter OUTRO boleto
  // vigente — estornar reabriria este e deixaria dois vigentes sobre o mesmo
  // título; recusa até cancelar o outro.
  const [links] = await conn.query<any[]>(
    `SELECT tb_order_id AS orderId, parcel FROM \`${s}\`.tb_bank_slip_title
      WHERE tb_institution_id = ? AND tb_bank_slip_id = ? AND deleted = 'N'`,
    [institutionId, slip.id]
  )
  for (const l of links) {
    const other = await hasOpenSlip(conn, s, institutionId, { orderId: Number(l.orderId), parcel: Number(l.parcel) })
    if (other !== null && other !== slip.id) {
      throw new HttpError(409,
        `Título ${l.orderId}/${l.parcel} já tem o boleto ${other} vigente — cancele-o antes de estornar`,
        undefined, 'BANK_SLIP_TITLE_REISSUED')
    }
  }
  const [pays] = await conn.query<any[]>(
    `SELECT tb_order_id AS orderId, parcel, event
       FROM \`${s}\`.tb_financial_payment
      WHERE tb_institution_id = ? AND settled_code = ? AND status = 'N' AND deleted = 'N'
      ORDER BY tb_order_id, parcel, event FOR UPDATE`,
    [institutionId, slip.lastSettledCode]
  )
  let reversalCode: number | null = null
  for (const p of pays) {
    const core = await reverseOnePayment(conn, schemaName, institutionId, userId,
      Number(p.orderId), Number(p.parcel), Number(p.event),
      `Estorno boleto ${slip.ourNumber}: ${reason}`.slice(0, 100))
    reversalCode = core.settledCode
  }
  const event = await insertEvent(conn, s, institutionId, slip.id, userId, {
    kind: 'X', dtRecord: todayIso(), source: 'M', settledCode: reversalCode,
    originEvent: slip.lastEvent, note: reason,
  })
  return { event, reversed: pays.length, settledCode: reversalCode }
}

export interface AutoIssueInput {
  orderId: number
  parcels: { parcel: number; paymentTypeId: number }[]
}

export type AutoIssueReason = 'NO_AGREEMENT' | 'MULTIPLE_AGREEMENTS' | 'NO_BANK_SLIP_PARCELS'

export interface AutoIssueResult {
  issued: number
  reason?: AutoIssueReason
  slipIds: number[]
}

/**
 * Gancho do FATURAMENTO (D18 do contrato financeiro / D9 do boleto): com a
 * config `auto_bank_slip` ligada, conta as carteiras ATIVAS — 0: nada; 1:
 * emite 1 boleto POR PARCELA cuja forma é kind='B'; 2..n: nada (a tela de
 * Boletos emite depois — Q20=b). Nunca bloqueia a nota (chamado dentro do
 * SAVEPOINT do billing).
 */
export async function tryIssueBankSlipsOnBilling(
  conn: PoolConnection, schemaName: string, institutionId: number,
  userId: number, input: AutoIssueInput
): Promise<AutoIssueResult> {
  const agreements = await listActiveAgreements(conn, schemaName, institutionId)
  if (agreements.length === 0) return { issued: 0, reason: 'NO_AGREEMENT', slipIds: [] }
  if (agreements.length > 1) return { issued: 0, reason: 'MULTIPLE_AGREEMENTS', slipIds: [] }

  const typeIds = [...new Set(input.parcels.map(p => p.paymentTypeId))]
  const [kinds] = await conn.query<any[]>(
    `SELECT id, kind FROM setes_central.tb_payment_types WHERE id IN (?) AND deleted = 'N'`,
    [typeIds]
  )
  const slipKinds = new Set(kinds.filter(k => k.kind === 'B').map(k => Number(k.id)))
  const parcels = input.parcels.filter(p => slipKinds.has(p.paymentTypeId))
  if (parcels.length === 0) return { issued: 0, reason: 'NO_BANK_SLIP_PARCELS', slipIds: [] }

  const slipIds: number[] = []
  for (const p of parcels) {
    const r = await issueBankSlip(conn, schemaName, institutionId, userId, {
      agreementId: agreements[0].id,
      titles: [{ orderId: input.orderId, parcel: p.parcel }],
      source: 'A', // D-B4: emissão automática do faturamento
    })
    slipIds.push(r.id)
  }
  return { issued: slipIds.length, slipIds }
}
