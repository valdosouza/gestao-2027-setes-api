import { PoolConnection } from 'mysql2/promise'
import { HttpError } from '@shared/errors/http-error'

/**
 * Peça da NOTA FISCAL (prompt_cancelamento_nota.md — D3/D4/D5/D17 + parecer
 * setes-conceito, 2026-09-08). A nota é um DOCUMENTO com história: cada
 * fato é um evento append-only em tb_invoice_event e o estado é DERIVADO
 * do último evento (irmã de @shared/check e @shared/bank-slip).
 *
 *   E emitida   — nasce AQUI, no faturamento (issueInvoice), nunca no módulo
 *   C cancelada — gravado pela composição invoice-cancel.ts
 *   reservados T A R D I (transmissão SEFAZ) — nunca 'X' (X é estorno na casa)
 *
 * Identidade da nota = o pedido (PK de tb_invoice = id do pedido, decisão
 * das notas mercadoria × serviço). Com D3 (pendente cancelada = soft-delete)
 * e D5 (pedido refaturável), o cabeçalho é REVIVIDO por upsert na segunda
 * vida — por isso o evento E guarda o SNAPSHOT do fato (número/série/
 * modelo/valor). `tb_invoice.status` é ESPELHO escrito aqui ('0' = pronta,
 * não transmitida), nunca lido para decidir.
 */

export type InvoiceEventKind = 'E' | 'C'
export type InvoiceState = 'issued' | 'cancelled'

/** Estado derivado do último evento. Sem evento (nota sincronizada) = emitida. */
export function stateFromLastEvent(kind: string | null | undefined): InvoiceState {
  return kind === 'C' ? 'cancelled' : 'issued'
}

/** SQL do último evento de uma nota (subquery reutilizável nas listas). */
export const LAST_INVOICE_EVENT_KIND_SQL = (s: string, alias = 'i') =>
  `(SELECT ev.kind FROM \`${s}\`.tb_invoice_event ev
     WHERE ev.tb_institution_id = ${alias}.tb_institution_id
       AND ev.tb_invoice_id = ${alias}.id AND ev.terminal = ${alias}.terminal
       AND ev.deleted = 'N'
     ORDER BY ev.event DESC LIMIT 1)`

export interface InvoiceSnapshot {
  number: string | null
  serie: string | null
  model: string | null
  value: number | null
}

export interface InvoiceEventInput {
  kind: InvoiceEventKind
  dtRecord: string
  note?: string | null
  originEvent?: number | null
  snapshot?: InvoiceSnapshot | null
}

/** Próximo evento (MAX+1 por nota, FOR UPDATE) + INSERT. Devolve o nº do evento. */
export async function insertInvoiceEvent(
  conn: PoolConnection, s: string, institutionId: number, invoiceId: number,
  userId: number | null, e: InvoiceEventInput
): Promise<number> {
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(event), 0) + 1 AS nextEvent
       FROM \`${s}\`.tb_invoice_event
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 FOR UPDATE`,
    [institutionId, invoiceId]
  )
  const event = Number(mx[0].nextEvent)
  await conn.query(
    `INSERT INTO \`${s}\`.tb_invoice_event
       (tb_institution_id, tb_invoice_id, terminal, event, kind, dt_record,
        number, serie, model, value, origin_event, note, tb_user_id,
        created_at, updated_at, deleted)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
    [institutionId, invoiceId, event, e.kind, e.dtRecord,
     e.snapshot?.number ?? null, e.snapshot?.serie ?? null,
     e.snapshot?.model ?? null, e.snapshot?.value ?? null,
     e.originEvent ?? null, e.note ? e.note.slice(0, 255) : null, userId]
  )
  return event
}

export interface LockedInvoice {
  id: number
  number: string | null
  serie: string | null
  model: string | null
  value: number
  status: string
  lastEvent: number | null
  lastKind: string | null
}

/** Nota viva (deleted='N') FOR UPDATE + último evento. 404 INVOICE_NOT_FOUND. */
export async function lockInvoice(
  conn: PoolConnection, s: string, institutionId: number, invoiceId: number
): Promise<LockedInvoice> {
  const [rows] = await conn.query<any[]>(
    `SELECT id, number, serie, model, value, status
       FROM \`${s}\`.tb_invoice
      WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N' FOR UPDATE`,
    [invoiceId, institutionId]
  )
  if (!rows[0]) {
    throw new HttpError(404, `Nota do pedido ${invoiceId} não encontrada`, undefined, 'INVOICE_NOT_FOUND')
  }
  const [last] = await conn.query<any[]>(
    `SELECT event, kind FROM \`${s}\`.tb_invoice_event
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND deleted = 'N'
      ORDER BY event DESC LIMIT 1 FOR UPDATE`,
    [institutionId, invoiceId]
  )
  return {
    id: Number(rows[0].id), number: rows[0].number ?? null, serie: rows[0].serie ?? null,
    model: rows[0].model ?? null, value: Number(rows[0].value ?? 0), status: String(rows[0].status ?? ''),
    lastEvent: last[0] ? Number(last[0].event) : null, lastKind: last[0]?.kind ?? null,
  }
}

/**
 * Número MAX+1 por MODELO + SÉRIE (decisão R4-Q3) — D4: ignora notas com
 * `deleted='S'` (pendente cancelada libera o número; só reaproveita de fato
 * se a cancelada era a última — igual ao legado; número no meio vira
 * buraco para a inutilização da fase de transmissão).
 */
export async function nextInvoiceNumber(
  conn: PoolConnection, s: string, institutionId: number, model: string, serie: string
): Promise<string> {
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(number_seq), 0) + 1 AS nextNumber
       FROM \`${s}\`.tb_invoice
      WHERE tb_institution_id = ? AND model = ? AND serie = ? AND deleted = 'N' FOR UPDATE`,
    [institutionId, model, serie]
  )
  return String(mx[0].nextNumber)
}

export interface InvoiceMerchandiseInput {
  baseIcms: number
  icms: number
  baseIcmsSt: number
  icmsSt: number
  ipi: number
  totalValue: number
  freight: number
  expenses: number
  discount: number
  quantity: number
}

export interface IssueInvoiceInput {
  orderId: number
  recipientEntityId: number
  model: string
  serie: string
  totalValue: number
  noteText: string | null
  /** Ramo de mercadoria — presença = existe (natureza da nota por ramo). */
  merchandise: InvoiceMerchandiseInput | null
  /** Ramo de serviço — total dos itens 'S'; null = sem ramo. */
  serviceTotal: number | null
  /** Data do fato (E); default hoje (local). */
  dtRecord?: string
}

export interface IssuedInvoice {
  invoiceNumber: string
  event: number
}

/**
 * Emite a nota: cabeçalho (upsert com REVIVE — D3/D5), ramos por PRESENÇA
 * (upsert; ramo ausente nesta vida vira 'S'), evento E com snapshot.
 * Roda DENTRO da transação do faturamento (o chamador já travou o pedido).
 */
export async function issueInvoice(
  conn: PoolConnection, s: string, institutionId: number, userId: number,
  input: IssueInvoiceInput
): Promise<IssuedInvoice> {
  const invoiceNumber = await nextInvoiceNumber(conn, s, institutionId, input.model, input.serie)
  await conn.query(
    `INSERT INTO \`${s}\`.tb_invoice
       (id, tb_institution_id, terminal, issuer, number, serie,
        tb_entity_id, dt_emission, value, model, status, note, created_at, updated_at, deleted)
     VALUES (?, ?, 0, ?, ?, ?, ?, CURDATE(), ?, ?, '0', ?, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE
       issuer = VALUES(issuer), number = VALUES(number), serie = VALUES(serie),
       tb_entity_id = VALUES(tb_entity_id), dt_emission = CURDATE(), value = VALUES(value),
       model = VALUES(model), status = '0', note = VALUES(note), deleted = 'N', updated_at = NOW()`,
    [input.orderId, institutionId, institutionId, invoiceNumber, input.serie,
     input.recipientEntityId, input.totalValue, input.model, input.noteText || null]
  )
  if (input.merchandise) {
    const m = input.merchandise
    await conn.query(
      `INSERT INTO \`${s}\`.tb_invoice_merchandise
         (id, tb_institution_id, terminal, base_icms_value, icms_value,
          base_icms_st_value, icms_st_value, ipi_value, total_value,
          freight_value, insurance_value, expenses_value, discount_value,
          total_qtty, indPres, created_at, updated_at, deleted)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE
         base_icms_value = VALUES(base_icms_value), icms_value = VALUES(icms_value),
         base_icms_st_value = VALUES(base_icms_st_value), icms_st_value = VALUES(icms_st_value),
         ipi_value = VALUES(ipi_value), total_value = VALUES(total_value),
         freight_value = VALUES(freight_value), insurance_value = 0,
         expenses_value = VALUES(expenses_value), discount_value = VALUES(discount_value),
         total_qtty = VALUES(total_qtty), indPres = 0, deleted = 'N', updated_at = NOW()`,
      [input.orderId, institutionId, m.baseIcms, m.icms, m.baseIcmsSt, m.icmsSt, m.ipi,
       m.totalValue, m.freight, m.expenses, m.discount, m.quantity]
    )
  } else {
    await conn.query(
      `UPDATE \`${s}\`.tb_invoice_merchandise SET deleted = 'S', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
      [input.orderId, institutionId]
    )
  }
  if (input.serviceTotal != null) {
    await conn.query(
      `INSERT INTO \`${s}\`.tb_invoice_service
         (id, tb_institution_id, terminal, total_value, created_at, updated_at, deleted)
       VALUES (?, ?, 0, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE total_value = VALUES(total_value), deleted = 'N', updated_at = NOW()`,
      [input.orderId, institutionId, input.serviceTotal]
    )
  } else {
    await conn.query(
      `UPDATE \`${s}\`.tb_invoice_service SET deleted = 'S', updated_at = NOW()
        WHERE id = ? AND tb_institution_id = ? AND terminal = 0 AND deleted = 'N'`,
      [input.orderId, institutionId]
    )
  }
  const event = await insertInvoiceEvent(conn, s, institutionId, input.orderId, userId, {
    kind: 'E', dtRecord: input.dtRecord ?? localTodayIso(),
    snapshot: { number: invoiceNumber, serie: input.serie, model: input.model, value: input.totalValue },
  })
  return { invoiceNumber, event }
}

export function localTodayIso(): string {
  const d = new Date()
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')].join('-')
}
