import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { assertSchema } from '@shared/db/schema'
import { isSubstitutionCancel, isFiscalRecord } from 'fiscal-api/reading'
import { lockInvoice, LAST_INVOICE_EVENT_KIND_SQL } from './invoice'
import { readInvoiceFiscal, fiscalRecordKey } from './invoice-fiscal-effect'

/**
 * PEÇA "manter a nota" — D-F67/D-F72/D-F73/D-F74 (Rodada 13 das APIs fiscais, Valdo 2026-10-10; parecer do guardião:
 * prompt_apis_fiscais_isoladas.md §8.R12/§21.7). Quando o fisco cancela a NFS-e por SUBSTITUIÇÃO (e105102 — feito fora
 * do produto, no portal), existe uma NFS-e substituta que o ERP não conhece: o efeito local NÃO é automático (D-F64).
 * O humano decide — cancelar a nota (`cancelInvoice`, que liga a voz) OU mantê-la. "Manter" é FATO da NOTA
 * (`tb_invoice_cancel_waiver`, migration 067), não da voz: a voz é do fisco, a decisão é de uma pessoa.
 *
 * Regras: só para a voz C vigente com código 105102 (D-F74 — os demais cancelamentos não se dispensam) e só em PRODUÇÃO
 * (D-F80: homologação não tem valor jurídico — cancela-se a nota); nota viva e não cancelada; motivo obrigatório (D-F73);
 * idempotente por (nota, chave) — repetir devolve `alreadyWaived`. A dispensa é HISTÓRIA (D-F81): a linha fica; os leitores
 * só a apresentam como decisão vigente enquanto a nota está viva (`findCurrentCancelWaiver`).
 * Roda sob a transação do CHAMADOR (o módulo envolve com `withDeadlockRetry`). F2a, etapa A3: a voz é LIDA pela porta
 * `@shared/fiscal-voice` (views do `fiscal_api`) DEPOIS da trava da nota (`lockInvoice` = 1º comando — D-F121) e escopada pela vida
 * que ela devolve (D-F119/D-F126); decide pelos predicados do núcleo (`isSubstitutionCancel`, `isFiscalRecord`) — nunca por coluna
 * crua. "Efeito já aplicado" = a NOTA cancelada (evento C — D-F28: sem vínculo gravado na voz). A dispensa em si não trava linha:
 * a trava da NOTA já serializa (L3).
 */

export interface CancelWaiver {
  accessKey: string
  reason:    string
  userId:    number
  createdAt: string | null
}

export interface CancelWaiverResult {
  orderId:       number
  accessKey:     string
  createdAt:     string | null
  alreadyWaived: boolean
}

type Q = PoolConnection | typeof pool

/** A decisão "manter a nota" desta chave (viva), se existe. */
export async function findCancelWaiver(
  q: Q, schemaName: string, institutionId: number, invoiceId: number, accessKey: string, forUpdate = false
): Promise<CancelWaiver | null> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `SELECT access_key AS accessKey, reason, tb_user_id AS userId, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
       FROM \`${s}\`.tb_invoice_cancel_waiver
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND access_key = ? AND deleted = 'N'
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [institutionId, invoiceId, accessKey]
  )
  if (!rows?.[0]) return null
  const r = rows[0]
  return { accessKey: String(r.accessKey), reason: String(r.reason), userId: Number(r.userId), createdAt: r.createdAt ?? null }
}

/**
 * D-F81 (= Q-F88 (a)): a decisão "manter a nota" VIGENTE — a da chave, com a nota viva (cabeçalho vivo e último evento ≠ C).
 * Nota cancelada depois de mantida: a linha fica como história, mas nenhuma tela a mostra como decisão.
 */
export async function findCurrentCancelWaiver(
  q: Q, schemaName: string, institutionId: number, invoiceId: number, accessKey: string
): Promise<CancelWaiver | null> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query<any[]>(
    `SELECT w.access_key AS accessKey, w.reason, w.tb_user_id AS userId, DATE_FORMAT(w.created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
       FROM \`${s}\`.tb_invoice_cancel_waiver w
       JOIN \`${s}\`.tb_invoice i
         ON i.id = w.tb_invoice_id AND i.tb_institution_id = w.tb_institution_id AND i.terminal = w.terminal AND i.deleted = 'N'
      WHERE w.tb_institution_id = ? AND w.tb_invoice_id = ? AND w.terminal = 0 AND w.access_key = ? AND w.deleted = 'N'
        AND COALESCE(${LAST_INVOICE_EVENT_KIND_SQL(s, 'i')}, '-') <> 'C'
      LIMIT 1`,
    [institutionId, invoiceId, accessKey]
  )
  if (!rows?.[0]) return null
  const r = rows[0]
  return { accessKey: String(r.accessKey), reason: String(r.reason), userId: Number(r.userId), createdAt: r.createdAt ?? null }
}

const notApplicable = (message: string) =>
  new HttpError(409, message, [{ field: 'fiscal', message }], ErrorCodes.INVOICE_CANCEL_WAIVER_NOT_APPLICABLE)

export async function waiveSubstitutedCancel(
  conn: PoolConnection, schemaName: string, institutionId: number, userId: number, input: { orderId: number; reason: string }
): Promise<CancelWaiverResult> {
  const s = assertSchema(schemaName)
  const reason = String(input.reason ?? '').trim()
  if (!reason) {
    throw new HttpError(400, 'Motivo para manter a nota é obrigatório', [{ field: 'reason', message: 'Obrigatório' }], ErrorCodes.INVOICE_REASON_REQUIRED)
  }
  const invoice = await lockInvoice(conn, s, institutionId, input.orderId)
  if (invoice.lastKind === 'C') throw notApplicable(`Nota ${invoice.number ?? input.orderId} já está cancelada — nada a manter`)
  const { current: tx } = await readInvoiceFiscal(conn, institutionId, input.orderId, invoice.lifeEvent)
  if (!tx || !isSubstitutionCancel(tx)) {
    throw notApplicable('A NFS-e vigente desta nota não foi cancelada por SUBSTITUIÇÃO no fisco (e105102) — manter a nota só vale para esse caso')
  }
  // D-F80 (= Q-F87 (a)): homologação não tem valor jurídico (Q-CA5b) — a saída é cancelar a nota (cancelável localmente)
  if (!isFiscalRecord(tx)) {
    throw notApplicable('NFS-e de HOMOLOGAÇÃO não tem valor jurídico — cancele a nota (cancelável localmente) em vez de mantê-la')
  }
  // a chave é a IDENTIDADE do documento registrado — lida só depois do fato (F2A3-SOC-08; registro sem chave falha alto)
  const accessKey = fiscalRecordKey(tx) as string
  const existing = await findCancelWaiver(conn, s, institutionId, input.orderId, accessKey)   // L3: a trava da NOTA serializa
  if (existing) return { orderId: input.orderId, accessKey: existing.accessKey, createdAt: existing.createdAt, alreadyWaived: true }
  // soft delete reservado: uma linha morta da mesma chave REVIVE com a decisão nova
  await conn.query(
    `INSERT INTO \`${s}\`.tb_invoice_cancel_waiver
       (tb_institution_id, tb_invoice_id, terminal, access_key, reason, tb_user_id, created_at, updated_at, deleted)
     VALUES (?, ?, 0, ?, ?, ?, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE reason = VALUES(reason), tb_user_id = VALUES(tb_user_id),
       created_at = NOW(), updated_at = NOW(), deleted = 'N'`,
    [institutionId, input.orderId, accessKey, reason.slice(0, 255), userId]
  )
  const saved = await findCancelWaiver(conn, s, institutionId, input.orderId, accessKey)
  return { orderId: input.orderId, accessKey, createdAt: saved?.createdAt ?? null, alreadyWaived: false }
}
