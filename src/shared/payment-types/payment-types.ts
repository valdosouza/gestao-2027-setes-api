import { PoolConnection } from 'mysql2/promise'
import { assertSchema } from '@shared/db/schema'
import { HttpError } from '@shared/errors/http-error'

/**
 * Peça `@shared/payment-types`: leitura do VÍNCULO institution × forma de
 * pagamento (tb_institution_has_payment_types, schema do cliente) junto do
 * catálogo central (setes_central.tb_payment_types). Promovida do SQL inline
 * da OS (parecer 2026-09-06, M2) para que negociação, OS e faturamento
 * validem "forma habilitada" pela MESMA regra.
 */

type Queryable = Pick<PoolConnection, 'query'>

export interface EnabledPaymentType {
  id: number
  description: string
  /** E espécie · X PIX · Q cheque · B boleto · A carteira · C cartão · O outros (decisão 32). */
  kind: string
  /** Limite de parcelas que a institution CONCEDE nesta forma (vínculo). */
  maxParcels: number
}

/** Catálogo CENTRAL (descrição + kind) dos ids pedidos — sem olhar o vínculo:
 *  exibição e decisão por kind (cheque) valem mesmo para forma desabilitada depois. */
export async function getCatalogPaymentTypes(
  db: Queryable, ids: number[]
): Promise<Map<number, { id: number; description: string; kind: string }>> {
  const out = new Map<number, { id: number; description: string; kind: string }>()
  const unique = [...new Set(ids.filter(id => Number.isInteger(id) && id > 0))]
  if (unique.length === 0) return out
  const [rows] = await db.query<any[]>(
    `SELECT id, description, kind FROM setes_central.tb_payment_types
      WHERE id IN (${unique.map(() => '?').join(',')})`,
    unique
  )
  for (const r of rows) out.set(Number(r.id), { id: Number(r.id), description: String(r.description), kind: String(r.kind) })
  return out
}

/** Formas VINCULADAS e habilitadas (enable='S', deleted='N') dentre os ids pedidos. */
export async function getEnabledPaymentTypes(
  db: Queryable, schemaName: string, institutionId: number, ids: number[]
): Promise<Map<number, EnabledPaymentType>> {
  const out = new Map<number, EnabledPaymentType>()
  const unique = [...new Set(ids.filter(id => Number.isInteger(id) && id > 0))]
  if (unique.length === 0) return out
  const s = assertSchema(schemaName)
  const [rows] = await db.query<any[]>(
    `SELECT pt.id, pt.description, pt.kind, ihpt.max_parcels AS maxParcels
       FROM \`${s}\`.tb_institution_has_payment_types ihpt
       JOIN setes_central.tb_payment_types pt ON pt.id = ihpt.tb_payment_types_id
      WHERE ihpt.tb_institution_id = ? AND ihpt.deleted = 'N' AND ihpt.\`enable\` = 'S'
        AND ihpt.tb_payment_types_id IN (${unique.map(() => '?').join(',')})`,
    [institutionId, ...unique]
  )
  for (const r of rows) {
    out.set(Number(r.id), {
      id: Number(r.id), description: String(r.description), kind: String(r.kind),
      maxParcels: Number(r.maxParcels ?? 1),
    })
  }
  return out
}

/** Lookup: TODAS as formas vinculadas e habilitadas da institution (filtro por descrição). */
export async function listEnabledPaymentTypes(
  db: Queryable, schemaName: string, institutionId: number, filter = ''
): Promise<EnabledPaymentType[]> {
  const s = assertSchema(schemaName)
  const like = filter.trim() ? `%${filter.trim().replace(/[%_\\]/g, m => `\\${m}`)}%` : null
  const [rows] = await db.query<any[]>(
    `SELECT pt.id, pt.description, pt.kind, ihpt.max_parcels AS maxParcels
       FROM \`${s}\`.tb_institution_has_payment_types ihpt
       JOIN setes_central.tb_payment_types pt ON pt.id = ihpt.tb_payment_types_id
      WHERE ihpt.tb_institution_id = ? AND ihpt.deleted = 'N' AND ihpt.\`enable\` = 'S'
        AND (? IS NULL OR pt.description LIKE ?)
      ORDER BY pt.description LIMIT 100`,
    [institutionId, like, like]
  )
  return rows.map(r => ({
    id: Number(r.id), description: String(r.description), kind: String(r.kind),
    maxParcels: Number(r.maxParcels ?? 1),
  }))
}

/**
 * Todas as formas pedidas precisam estar vinculadas/habilitadas — 400
 * PAYMENT_TYPE_UNAVAILABLE (mesmo código da OS) apontando o campo.
 * Devolve o mapa para o chamador reaproveitar (kind, maxParcels).
 */
export async function assertPaymentTypesEnabled(
  db: Queryable, schemaName: string, institutionId: number, ids: number[],
  field = 'paymentTypeId'
): Promise<Map<number, EnabledPaymentType>> {
  const map = await getEnabledPaymentTypes(db, schemaName, institutionId, ids)
  const missing = [...new Set(ids)].filter(id => !map.has(id))
  if (missing.length > 0) {
    throw new HttpError(400, 'Forma de pagamento não vinculada/habilitada',
      [{ field, message: `Forma indisponível: ${missing.join(', ')}` }],
      'PAYMENT_TYPE_UNAVAILABLE')
  }
  return map
}
